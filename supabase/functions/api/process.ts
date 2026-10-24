import { createClient } from "@supabase/supabase-js";
import { extractMemory } from "./llm.ts";

const EMBED_BATCH = 32;
const CHUNK_TARGET = 1200; // characters
const CHUNK_MAX = 1800;
const EMBED_TIMEOUT_MS = 60_000;

// Chunks are written with the service role (clients have read-only RLS on
// memory_chunks), so this client must never be handed to request handlers.
function adminClient() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
}

// Paragraph-first chunking: pack whole paragraphs up to CHUNK_TARGET, and only
// fall back to sentence splitting for a single paragraph over CHUNK_MAX.
export function chunkText(text: string): string[] {
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const pieces: string[] = [];
  for (const p of paragraphs) {
    if (p.length <= CHUNK_MAX) {
      pieces.push(p);
      continue;
    }
    let buf = "";
    for (const s of p.split(/(?<=[.!?।])\s+/)) {
      if (buf && buf.length + s.length + 1 > CHUNK_TARGET) {
        pieces.push(buf);
        buf = "";
      }
      buf = buf ? `${buf} ${s}` : s;
      while (buf.length > CHUNK_MAX) { // no sentence boundaries: hard split
        pieces.push(buf.slice(0, CHUNK_MAX));
        buf = buf.slice(CHUNK_MAX);
      }
    }
    if (buf) pieces.push(buf);
  }

  const chunks: string[] = [];
  let cur = "";
  for (const piece of pieces) {
    if (cur && cur.length + piece.length + 2 > CHUNK_TARGET) {
      chunks.push(cur);
      cur = "";
    }
    cur = cur ? `${cur}\n\n${piece}` : piece;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

export function inferenceHeaders(extra: Record<string, string> = {}) {
  return {
    "Content-Type": "application/json",
    "X-Inference-Key": Deno.env.get("INFERENCE_API_KEY") ?? "",
    ...extra,
  };
}

export async function embed(texts: string[]): Promise<{ model: string; embeddings: number[][] }> {
  const res = await fetch(`${Deno.env.get("INFERENCE_URL")}/embed`, {
    method: "POST",
    headers: inferenceHeaders(),
    body: JSON.stringify({ texts }),
    signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`embed failed: ${res.status} ${await res.text()}`);
  return await res.json();
}

// Chunks and embeds a memory's text. A memory always has its text by the time it exists (the
// transcript is reviewed and saved by the user first), so this never needs the audio.
//
// Safe to call any number of times: the claim below lets only one run proceed, and a run that
// died mid-way (function killed, restart) is picked up again once it is stale. A "ready" memory
// is left alone unless `force` is set (re-embedding after switching backends).
export async function processMemory(
  memoryId: string,
  opts: { extract?: boolean; force?: boolean } = {},
): Promise<void> {
  const db = adminClient();

  const { data: claimed, error: claimError } = await db.rpc("claim_memory_processing", {
    p_id: memoryId,
    p_allow_ready: opts.force ?? false,
  });
  if (claimError) {
    console.error("claim failed", memoryId, claimError.message);
    return;
  }
  const memory = (claimed as Record<string, any>[] | null)?.[0];
  if (!memory) return; // already done, or another run holds it

  try {
    if (!memory.content.trim()) throw new Error("memory has no text");

    // Structured fields are a nicety on top of retrieval: if the LLM is down or returns junk the
    // memory is still searchable. Skipped when the client already supplied them from review.
    if ((opts.extract ?? true) && !memory.category) {
      try {
        const x = await extractMemory(memory.content);
        await db.from("memories").update({
          title: memory.title ?? x.title,
          category: x.category,
          outcome: x.outcome,
          summary: x.summary,
          happened: x.happened,
          thinking: x.thinking,
          learned: x.learned,
          tags: x.tags,
          analysis: x.analysis,
        }).eq("id", memory.id);
      } catch (e) {
        console.error("extraction failed", memory.id, e);
      }
    }

    const chunks = chunkText(memory.content);
    const rows = [];
    for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
      const batch = chunks.slice(i, i + EMBED_BATCH);
      const { model, embeddings } = await embed(batch);
      batch.forEach((content, j) =>
        rows.push({
          memory_id: memory.id,
          user_id: memory.user_id,
          chunk_index: i + j,
          content,
          // pgvector accepts its text form through PostgREST
          embedding: JSON.stringify(embeddings[j]),
          embedding_model: model,
        })
      );
    }

    await db.from("memory_chunks").delete().eq("memory_id", memory.id);
    const { error: insertError } = await db.from("memory_chunks").insert(rows);
    if (insertError) throw new Error(insertError.message);

    await db.from("memories").update({ processing_status: "ready" }).eq("id", memory.id);
  } catch (e) {
    console.error("processMemory failed", memory.id, e);
    await db.from("memories").update({
      processing_status: "failed",
      processing_error: e instanceof Error ? e.message : String(e),
    }).eq("id", memory.id);
  }
}
