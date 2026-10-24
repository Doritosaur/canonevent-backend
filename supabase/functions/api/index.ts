import { Hono } from "hono";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { deleteObject, objectExists, presignGet, presignPut } from "./r2.ts";
import { embed, inferenceHeaders, processMemory } from "./process.ts";
import { answerFromMemories, extractMemory, uniqueByMemory } from "./llm.ts";
import { isUsefulTranscript } from "./transcript.ts";

// Run after the response is sent; the edge runtime keeps the worker alive.
declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };

type Env = {
  Variables: { userId: string; db: SupabaseClient };
};

const app = new Hono<Env>().basePath("/api");

// ---------------------------------------------------------------------------
// Auth: every route below runs as the caller, so RLS enforces ownership.
// user_id is always derived from the verified token, never from the request.
// ---------------------------------------------------------------------------

app.get("/health", (c) => c.json({ status: "ok" }));

app.use("*", async (c, next) => {
  const authorization = c.req.header("Authorization");
  if (!authorization?.startsWith("Bearer ")) {
    return c.json({ error: "missing bearer token" }, 401);
  }
  const db = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authorization } } },
  );
  const { data, error } = await db.auth.getUser(authorization.slice(7));
  if (error || !data.user) return c.json({ error: "invalid token" }, 401);
  c.set("userId", data.user.id);
  c.set("db", db);
  await next();
});

// ---------------------------------------------------------------------------
// Memories
// ---------------------------------------------------------------------------

const AUDIO_EXTENSIONS: Record<string, string> = {
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/aac": "aac",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/webm": "webm",
  "audio/ogg": "ogg",
};

const MIN_AUDIO_BYTES = 2048; // anything smaller is silence or a stray tap
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const TRANSCRIBE_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// Transcription and extraction. Nothing here is stored: the audio is handed to the inference
// service and discarded, and the result goes back to the client for the user to review. A
// memory (and its audio) only exists once the user saves it.
// ---------------------------------------------------------------------------

// Starts a transcription job from a raw audio body. Poll GET /transcriptions/:id.
app.post("/transcriptions", async (c) => {
  const type = (c.req.header("Content-Type") ?? "").split(";")[0].trim().toLowerCase();
  if (!(type in AUDIO_EXTENSIONS)) return c.json({ error: "unsupported audio type" }, 415);

  const audio = await c.req.arrayBuffer();
  if (audio.byteLength < MIN_AUDIO_BYTES) return c.json({ error: "empty_recording" }, 422);
  if (audio.byteLength > MAX_AUDIO_BYTES) return c.json({ error: "recording too large" }, 413);

  let res: Response;
  try {
    res = await fetch(`${Deno.env.get("INFERENCE_URL")}/transcribe`, {
      method: "POST",
      headers: inferenceHeaders({ "Content-Type": type, "X-User-Id": c.get("userId") }),
      body: audio,
      signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS),
    });
  } catch (e) {
    console.error("transcribe unreachable", e);
    return c.json({ error: "transcription_unavailable" }, 502);
  }
  if (res.status === 422) return c.json({ error: "empty_recording" }, 422);
  if (!res.ok) {
    console.error("transcribe start failed", res.status, await res.text());
    return c.json({ error: "transcription_unavailable" }, 502);
  }
  return c.json(await res.json(), 202);
});

app.get("/transcriptions/:id", async (c) => {
  let res: Response;
  try {
    res = await fetch(`${Deno.env.get("INFERENCE_URL")}/transcribe/${encodeURIComponent(c.req.param("id"))}`, {
      headers: inferenceHeaders({ "X-User-Id": c.get("userId") }),
      signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS),
    });
  } catch (e) {
    console.error("transcribe poll unreachable", e);
    return c.json({ error: "transcription_unavailable" }, 502);
  }
  if (res.status === 404) return c.json({ error: "unknown job" }, 404);
  if (!res.ok) return c.json({ error: "transcription_unavailable" }, 502);

  const job = await res.json();
  // "Useful" is decided here, once, so every client agrees on what is worth saving.
  if (job.status === "done") return c.json({ ...job, useful: isUsefulTranscript(job.transcript ?? "") });
  return c.json(job);
});

// Structures a transcript into the fields the review screen shows. Stateless.
app.post("/extract", async (c) => {
  const parsed = z.object({ content: z.string().min(1).max(100_000) }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  try {
    return c.json({ fields: await extractMemory(parsed.data.content) });
  } catch (e) {
    console.error("extract failed", e);
    return c.json({ error: "extraction_unavailable" }, 502);
  }
});

// ---------------------------------------------------------------------------
// Memories
// ---------------------------------------------------------------------------

// What the review screen sends along with the (possibly edited) transcript.
const reviewedFields = {
  title: z.string().max(200).optional(),
  category: z.enum(["Money", "Career", "Health", "Relationships"]).optional(),
  outcome: z.enum(["bad", "mixed", "good"]).optional(),
  summary: z.string().max(5_000).optional(),
  happened: z.string().max(20_000).optional(),
  thinking: z.string().max(20_000).optional(),
  learned: z.string().max(20_000).optional(),
  tags: z.array(z.string().max(50)).max(20).optional(),
  analysis: z.string().max(20_000).optional(),
  occurred_at: z.string().datetime().optional(),
};

const createMemorySchema = z.discriminatedUnion("input_type", [
  z.object({
    input_type: z.literal("text"),
    id: z.string().uuid().optional(),
    content: z.string().trim().min(1).max(100_000),
    ...reviewedFields,
  }),
  z.object({
    input_type: z.literal("voice"),
    id: z.string().uuid().optional(),
    // The reviewed transcript. A voice memory without text is never created.
    content: z.string().trim().min(1).max(100_000),
    language: z.string().max(20).optional(),
    audio_content_type: z.string().refine((t) => t in AUDIO_EXTENSIONS, "unsupported audio type"),
    ...reviewedFields,
  }),
]);

// Create a memory from reviewed text. Pass a client-generated `id` to make retries idempotent.
// Voice memories also get a presigned R2 PUT URL (until their audio has arrived): the client
// uploads the recording there as the last step, then calls /memories/:id/confirm. The memory is
// fully usable before and without the audio.
app.post("/memories", async (c) => {
  const parsed = createMemorySchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const body = parsed.data;
  const voice = body.input_type === "voice" ? body : null;
  const db = c.get("db");
  const userId = c.get("userId");

  const id = body.id ?? crypto.randomUUID();
  const audioKey = voice ? `users/${userId}/memories/${id}.${AUDIO_EXTENSIONS[voice.audio_content_type]}` : null;

  const { data: existing } = await db.from("memories").select("*").eq("id", id).maybeSingle();
  let memory = existing;

  if (!memory) {
    const { data, error } = await db.from("memories").insert({
      id,
      input_type: body.input_type,
      title: body.title ?? null,
      content: body.content,
      language: voice?.language ?? null,
      transcription_provider: voice ? "sarvam:saaras:v4" : null,
      audio_key: audioKey,
      audio_content_type: voice?.audio_content_type ?? null,
      occurred_at: body.occurred_at ?? null,
      category: body.category ?? null,
      outcome: body.outcome ?? null,
      summary: body.summary ?? null,
      happened: body.happened ?? null,
      thinking: body.thinking ?? null,
      learned: body.learned ?? null,
      tags: body.tags ?? [],
      analysis: body.analysis ?? null,
    }).select("*").single();

    if (error) {
      // 23505: id already used (by another user, since our own select found nothing).
      if (error.code === "23505") return c.json({ error: "id already in use" }, 409);
      return c.json({ error: error.message }, 500);
    }
    memory = data;
  }

  // Retrying a create also retries processing that failed or died; the claim makes this safe.
  if (memory.processing_status !== "ready") EdgeRuntime.waitUntil(processMemory(memory.id));

  const needsUpload = memory.input_type === "voice" && memory.audio_key && !memory.audio_uploaded_at;
  const uploadUrl = needsUpload ? await presignPut(memory.audio_key, memory.audio_content_type) : null;

  return c.json({ memory, upload_url: uploadUrl }, existing ? 200 : 201);
});

// Called after the client has uploaded the audio: verifies the object is in R2 and records it.
app.post("/memories/:id/confirm", async (c) => {
  const db = c.get("db");
  const { data: memory } = await db.from("memories").select("*").eq("id", c.req.param("id")).maybeSingle();
  if (!memory) return c.json({ error: "not found" }, 404);
  if (memory.input_type !== "voice" || !memory.audio_key) {
    return c.json({ error: "not a voice memory" }, 400);
  }
  if (!(await objectExists(memory.audio_key))) {
    return c.json({ error: "audio not uploaded" }, 409);
  }
  if (memory.audio_uploaded_at) return c.json({ memory });

  const { data, error } = await db.from("memories").update({ audio_uploaded_at: new Date().toISOString() })
    .eq("id", memory.id).select("*").single();
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ memory: data });
});

app.get("/memories/:id/audio", async (c) => {
  const db = c.get("db");
  const { data: memory } = await db.from("memories").select("audio_key, audio_uploaded_at")
    .eq("id", c.req.param("id")).maybeSingle();
  if (!memory?.audio_key || !memory.audio_uploaded_at) return c.json({ error: "not found" }, 404);
  return c.json({ url: await presignGet(memory.audio_key) });
});

// Re-chunk and re-embed. For one memory this retries one that failed or stalled and leaves a ready
// one alone unless {"force": true}. The bulk route is for re-embedding everything (e.g. after
// switching embedding backend), so it always forces. {"extract": false} skips the LLM extraction.
const reprocessSchema = z.object({ extract: z.boolean().default(true), force: z.boolean().default(false) });

app.post("/memories/reprocess", async (c) => {
  const parsed = reprocessSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const { data, error } = await c.get("db").from("memories").select("id").neq("content", "");
  if (error) return c.json({ error: error.message }, 500);
  const ids = (data ?? []).map((m) => m.id as string);
  // Sequential, so a big library doesn't flood the embedder.
  EdgeRuntime.waitUntil((async () => {
    for (const id of ids) await processMemory(id, { ...parsed.data, force: true });
  })());
  return c.json({ queued: ids.length }, 202);
});

app.post("/memories/:id/reprocess", async (c) => {
  const parsed = reprocessSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const { data: memory } = await c.get("db").from("memories").select("id").eq("id", c.req.param("id")).maybeSingle();
  if (!memory) return c.json({ error: "not found" }, 404);
  EdgeRuntime.waitUntil(processMemory(memory.id, parsed.data));
  return c.json({ queued: 1 }, 202);
});

// Edits from the review screen. content (the original transcript) is never editable here.
const patchMemorySchema = z.object({
  title: z.string().max(200),
  happened: z.string().max(20_000),
  thinking: z.string().max(20_000),
  learned: z.string().max(20_000),
  tags: z.array(z.string().max(50)).max(20),
}).partial().strict();

app.patch("/memories/:id", async (c) => {
  const parsed = patchMemorySchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const { data, error } = await c.get("db").from("memories").update(parsed.data)
    .eq("id", c.req.param("id")).select("*").maybeSingle();
  if (error) return c.json({ error: error.message }, 500);
  if (!data) return c.json({ error: "not found" }, 404);
  return c.json({ memory: data });
});

// Poll for processing result after create/confirm.
app.get("/memories/:id", async (c) => {
  const db = c.get("db");
  const { data: memory } = await db.from("memories").select("*").eq("id", c.req.param("id")).maybeSingle();
  if (!memory) return c.json({ error: "not found" }, 404);
  return c.json({ memory });
});

app.get("/memories", async (c) => {
  const db = c.get("db");
  const limit = Math.min(Number(c.req.query("limit") ?? 50) || 50, 100);
  const { data, error } = await db.from("memories").select("*, memory_updates(id, occurred_on, text)")
    .order("created_at", { ascending: false }).limit(limit);
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ memories: data });
});

// ---------------------------------------------------------------------------
// Search: embed the query, then hybrid (vector + keyword) retrieval via RLS-scoped RPC.
// ---------------------------------------------------------------------------

const searchSchema = z.object({
  query: z.string().min(1).max(2000),
  limit: z.number().int().min(1).max(50).default(10),
  date_from: z.string().datetime().optional(),
  date_to: z.string().datetime().optional(),
});

app.post("/search", async (c) => {
  const parsed = searchSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const { query, limit, date_from, date_to } = parsed.data;

  const { embeddings } = await embed([query]);
  const { data, error } = await c.get("db").rpc("hybrid_search", {
    query_embedding: JSON.stringify(embeddings[0]),
    query_text: query,
    match_count: limit,
    date_from: date_from ?? null,
    date_to: date_to ?? null,
  });
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ results: data });
});

// ---------------------------------------------------------------------------
// Ask: retrieve relevant chunks, answer from them only, and keep the exchange so it shows up as a
// recent question. Each question is one conversation (a user message and the assistant's reply).
// ---------------------------------------------------------------------------

const MAX_MEMORIES_IN_CONTEXT = 6;
const MAX_CHUNKS_PER_MEMORY = 2;
const NOTHING_FOUND = "I couldn't find anything in your memories related to that yet.";

type StoredReply = { considerations?: string[]; related?: { memory_id: string; reason: string }[] };

// Re-attaches memories to the ids saved with an answer, dropping any deleted since it was given.
async function withMemories(db: SupabaseClient, stored: { memory_id: string; reason: string }[]) {
  // Answers saved before repeats were filtered out may still list a memory twice.
  const related = uniqueByMemory(stored);
  const ids = related.map((r) => r.memory_id);
  const { data: memories } = ids.length ? await db.from("memories").select("*").in("id", ids) : { data: [] };
  return related.flatMap((r) => {
    const memory = memories?.find((m) => m.id === r.memory_id);
    return memory ? [{ reason: r.reason, memory }] : [];
  });
}

async function loadConversation(db: SupabaseClient, id: string) {
  const { data: conversation } = await db.from("conversations").select("id, title, created_at")
    .eq("id", id).maybeSingle();
  if (!conversation) return null;
  const { data: messages } = await db.from("messages").select("role, content, meta").eq("conversation_id", id);
  const reply = messages?.find((m) => m.role === "assistant");
  if (!reply) return null; // the insert was interrupted before the answer was saved: treat as never asked
  const stored = (reply.meta ?? {}) as StoredReply;
  return {
    conversation_id: id,
    question: messages?.find((m) => m.role === "user")?.content ?? conversation.title ?? "",
    answer: reply.content as string,
    considerations: stored.considerations ?? [],
    related: await withMemories(db, stored.related ?? []),
    created_at: conversation.created_at as string,
  };
}

// Pass a client-generated `id` so a retried ask returns the saved answer instead of asking the LLM again.
app.post("/ask", async (c) => {
  const parsed = z.object({
    id: z.string().uuid().optional(),
    question: z.string().trim().min(1).max(2000),
  }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const { question } = parsed.data;
  const id = parsed.data.id ?? crypto.randomUUID();
  const db = c.get("db");

  const existing = await loadConversation(db, id);
  if (existing) return c.json(existing);

  const { embeddings } = await embed([question]);
  const { data: hits, error } = await db.rpc("hybrid_search", {
    query_embedding: JSON.stringify(embeddings[0]),
    query_text: question,
    match_count: 20,
  });
  if (error) return c.json({ error: error.message }, 500);

  // Cap chunks per memory so one long recording can't crowd out the rest.
  const byMemory = new Map<string, { title: string | null; date: string; chunks: string[] }>();
  for (const h of hits as any[]) {
    let m = byMemory.get(h.memory_id);
    if (!m) {
      if (byMemory.size >= MAX_MEMORIES_IN_CONTEXT) continue;
      m = { title: h.title, date: (h.occurred_at ?? h.created_at).slice(0, 10), chunks: [] };
      byMemory.set(h.memory_id, m);
    }
    if (m.chunks.length < MAX_CHUNKS_PER_MEMORY) m.chunks.push(h.content);
  }

  let reply: { answer: string; considerations: string[]; related: { memory_id: string; reason: string }[] };
  if (byMemory.size === 0) {
    reply = { answer: NOTHING_FOUND, considerations: [], related: [] };
  } else {
    try {
      reply = await answerFromMemories(
        question,
        [...byMemory].map(([memory_id, m]) => ({
          memory_id,
          title: m.title,
          date: m.date,
          content: m.chunks.join("\n…\n"),
        })),
      );
    } catch (e) {
      // Nothing is saved for a failed answer, so asking again with the same id simply tries again.
      console.error("answer failed", e);
      return c.json({ error: "answer_unavailable" }, 502);
    }
  }

  // Saving is best effort: the user still gets their answer if it can't be kept.
  const { error: conversationError } = await db.from("conversations").insert({ id, title: question.slice(0, 200) });
  if (conversationError && conversationError.code !== "23505") {
    console.error("save conversation failed", conversationError.message);
  } else if (!conversationError) {
    const { error: messagesError } = await db.from("messages").insert([
      { conversation_id: id, role: "user", content: question },
      {
        conversation_id: id,
        role: "assistant",
        content: reply.answer,
        meta: { considerations: reply.considerations, related: reply.related },
      },
    ]);
    if (messagesError) console.error("save messages failed", messagesError.message);
  }

  return c.json({
    conversation_id: id,
    question,
    answer: reply.answer,
    considerations: reply.considerations,
    related: await withMemories(db, reply.related),
    created_at: new Date().toISOString(),
  });
});

// Recent questions, newest first.
app.get("/conversations", async (c) => {
  const limit = Math.min(Number(c.req.query("limit") ?? 10) || 10, 50);
  const { data, error } = await c.get("db").from("conversations").select("id, title, created_at")
    .order("created_at", { ascending: false }).limit(limit);
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ conversations: data });
});

app.get("/conversations/:id", async (c) => {
  const conversation = await loadConversation(c.get("db"), c.req.param("id"));
  if (!conversation) return c.json({ error: "not found" }, 404);
  return c.json(conversation);
});

app.delete("/conversations/:id", async (c) => {
  const { data, error } = await c.get("db").from("conversations").delete().eq("id", c.req.param("id")).select("id");
  if (error) return c.json({ error: error.message }, 500);
  if (!data?.length) return c.json({ error: "not found" }, 404);
  return c.body(null, 204);
});

// ---------------------------------------------------------------------------
// Outcome updates ("how did it turn out?")
// ---------------------------------------------------------------------------

app.get("/memories/:id/updates", async (c) => {
  const { data, error } = await c.get("db").from("memory_updates").select("*")
    .eq("memory_id", c.req.param("id")).order("occurred_on");
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ updates: data });
});

app.post("/memories/:id/updates", async (c) => {
  const parsed = z.object({
    text: z.string().min(1).max(10_000),
    occurred_on: z.string().date().optional(),
  }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

  const { data, error } = await c.get("db").from("memory_updates").insert({
    memory_id: c.req.param("id"),
    text: parsed.data.text,
    ...(parsed.data.occurred_on ? { occurred_on: parsed.data.occurred_on } : {}),
  }).select("*").single();
  if (error) return c.json({ error: error.message }, error.code === "23503" ? 404 : 500);
  return c.json({ update: data }, 201);
});

// Delete everything the caller owns ("delete all my data"): memories, their audio, and asked questions. RLS scopes both the select and the
// delete to the caller; done in pages so a large library neither hits the row cap nor the URL limit.
app.delete("/memories", async (c) => {
  const db = c.get("db");
  let deleted = 0;
  for (;;) {
    const { data, error } = await db.from("memories").select("id, audio_key").limit(200);
    if (error) return c.json({ error: error.message, deleted }, 500);
    if (!data?.length) break;

    const { error: deleteError } = await db.from("memories").delete().in("id", data.map((m) => m.id));
    if (deleteError) return c.json({ error: deleteError.message, deleted }, 500);
    deleted += data.length;

    const results = await Promise.allSettled(
      data.filter((m) => m.audio_key).map((m) => deleteObject(m.audio_key)),
    );
    for (const r of results) if (r.status === "rejected") console.error("R2 delete failed", r.reason);
  }

  // Asked questions and their answers quote the memories, so they go too (messages cascade).
  const { error: conversationsError } = await db.from("conversations").delete().gte("created_at", "1970-01-01");
  if (conversationsError) return c.json({ error: conversationsError.message, deleted }, 500);
  return c.json({ deleted });
});

// Deleting the row cascades to chunks; the R2 object must be removed here
// because Postgres can't reach R2.
app.delete("/memories/:id", async (c) => {
  const db = c.get("db");
  const { data: memory } = await db.from("memories").select("audio_key").eq("id", c.req.param("id")).maybeSingle();
  if (!memory) return c.json({ error: "not found" }, 404);

  const { error } = await db.from("memories").delete().eq("id", c.req.param("id"));
  if (error) return c.json({ error: error.message }, 500);

  if (memory.audio_key) {
    try {
      await deleteObject(memory.audio_key);
    } catch (e) {
      console.error("R2 delete failed", memory.audio_key, e);
    }
  }
  return c.body(null, 204);
});

Deno.serve(app.fetch);
