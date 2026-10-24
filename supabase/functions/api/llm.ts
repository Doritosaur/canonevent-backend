import { z } from "zod";

// Reasoning models (Qwen3-style) may put <think>...</think> before the answer, and some
// models fence the JSON in a code block despite json_object mode. Take the outermost object.
function extractJson(text: string): string {
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error(`llm returned no JSON object: ${cleaned.slice(0, 200)}`);
  return cleaned.slice(start, end + 1);
}

const LLM_TIMEOUT_MS = Number(Deno.env.get("LLM_TIMEOUT_MS") ?? "90000");

// Extraction and answering don't benefit from chain-of-thought, and a reasoning model that thinks
// first can turn a 2-second call into minutes on local hardware. Set LLM_REASONING_EFFORT to
// override ("none" turns it off, supported by Ollama and some hosted APIs); it defaults to "none"
// for Ollama (port 11434) and is omitted elsewhere, since strict providers reject unknown params.
function reasoningEffort(): string | undefined {
  const configured = Deno.env.get("LLM_REASONING_EFFORT");
  if (configured !== undefined) return configured === "" ? undefined : configured;
  return Deno.env.get("LLM_BASE_URL")?.includes(":11434") ? "none" : undefined;
}

// Any OpenAI-compatible chat endpoint works: Groq, Together, or local Ollama
// (LLM_BASE_URL=http://host.docker.internal:11434/v1).
async function chatJson(system: string, user: string): Promise<unknown> {
  const effort = reasoningEffort();
  const res = await fetch(`${Deno.env.get("LLM_BASE_URL")}/chat/completions`, {
    signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${Deno.env.get("LLM_API_KEY") ?? ""}`,
    },
    body: JSON.stringify({
      model: Deno.env.get("LLM_MODEL"),
      temperature: 0.2,
      response_format: { type: "json_object" },
      ...(effort ? { reasoning_effort: effort } : {}),
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  if (!res.ok) throw new Error(`llm failed: ${res.status} ${await res.text()}`);
  const body = await res.json();
  const text: string = body.choices?.[0]?.message?.content ?? "";
  return JSON.parse(extractJson(text));
}

// ---------------------------------------------------------------------------
// Extraction: transcript -> structured memory
// ---------------------------------------------------------------------------

const extractionSchema = z.object({
  title: z.string().max(120),
  category: z.enum(["Money", "Career", "Health", "Relationships"]),
  outcome: z.enum(["bad", "mixed", "good"]),
  summary: z.string(),
  happened: z.string(),
  thinking: z.string(),
  learned: z.string(),
  tags: z.array(z.string()).max(8),
  analysis: z.string(),
});
export type Extraction = z.infer<typeof extractionSchema>;

const EXTRACT_SYSTEM = `You turn a person's spoken or written note about a decision into a structured record.
Use only what the note says; never invent facts. Write in the first person, in the note's own voice.
Reply with one JSON object with exactly these keys:
- title: short title, max 8 words
- category: one of "Money", "Career", "Health", "Relationships"
- outcome: "bad", "mixed" or "good" as best the note indicates (use "mixed" if unclear)
- summary: one sentence
- happened: what happened
- thinking: what the person was thinking or assuming at the time
- learned: the lesson, if the note states or implies one, else ""
- tags: up to 5 short tags
- analysis: one or two sentences naming any pattern in the decision-making`;

export async function extractMemory(content: string): Promise<Extraction> {
  return extractionSchema.parse(await chatJson(EXTRACT_SYSTEM, content));
}

// ---------------------------------------------------------------------------
// Ask your past self
// ---------------------------------------------------------------------------

const answerSchema = z.object({
  answer: z.string(),
  considerations: z.array(z.string()).max(5),
  related: z.array(z.object({ memory_id: z.string(), reason: z.string() })).max(5),
});
export type PastSelfAnswer = z.infer<typeof answerSchema>;

const ASK_SYSTEM = `You help a person reflect using only their own past decision notes, given as excerpts with ids.
Answer the question from those excerpts. If they don't contain relevant evidence, say so plainly instead of guessing.
Be specific and cite patterns across the notes. Do not give generic advice unconnected to the notes.
Reply with one JSON object with exactly these keys:
- answer: 2-4 sentences
- considerations: up to 3 short questions or checks the person should weigh now
- related: the notes that actually informed the answer, as objects { "memory_id": <an id from the excerpts>, "reason": <2-4 word label> }.
  List each note at most once, at most 3 in all, and none if no note is relevant. Fewer is better than repeating a note.`;

/** Keeps the first mention of each memory. */
export function uniqueByMemory<T extends { memory_id: string }>(related: T[]): T[] {
  const seen = new Set<string>();
  return related.filter((r) => !seen.has(r.memory_id) && !!seen.add(r.memory_id));
}

export async function answerFromMemories(
  question: string,
  excerpts: { memory_id: string; title: string | null; date: string; content: string }[],
): Promise<PastSelfAnswer> {
  const context = excerpts
    .map((e) => `[id: ${e.memory_id}] ${e.title ?? "Untitled"} (${e.date})\n${e.content}`)
    .join("\n\n---\n\n");
  const parsed = answerSchema.parse(
    await chatJson(ASK_SYSTEM, `Notes:\n\n${context}\n\nQuestion: ${question}`),
  );
  // Drop ids the model made up, and any note it listed more than once (a model with a single note
  // in context will happily fill all three slots with it).
  const valid = new Set(excerpts.map((e) => e.memory_id));
  return { ...parsed, related: uniqueByMemory(parsed.related.filter((r) => valid.has(r.memory_id))) };
}
