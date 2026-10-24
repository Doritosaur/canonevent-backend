// A transcript worth saving: more than a stray syllable or a speech-to-text hallucination on
// silence. Counted in letters (any script) so Hindi and other Indic text isn't penalised.
const MIN_LETTERS = 8;
const MIN_WORDS = 2;

export function isUsefulTranscript(transcript: string): boolean {
  const text = transcript.trim();
  if (!text) return false;
  const letters = (text.match(/\p{L}/gu) ?? []).length;
  const words = text.split(/\s+/).filter((w) => /\p{L}/u.test(w)).length;
  return letters >= MIN_LETTERS && words >= MIN_WORDS;
}
