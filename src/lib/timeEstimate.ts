/** Rough average narration speed at 1x, in words per minute — good enough for an approximate estimate. */
const BASE_WORDS_PER_MINUTE = 150;

export function estimateRemainingLabel(wordCount: number, totalChunks: number, currentChunk: number, rate: number): string | null {
  if (wordCount <= 0 || totalChunks <= 0 || rate <= 0) return null;
  const fractionDone = Math.min(Math.max(currentChunk / totalChunks, 0), 1);
  const remainingWords = wordCount * (1 - fractionDone);
  const minutes = remainingWords / (BASE_WORDS_PER_MINUTE * rate);
  return formatMinutes(minutes);
}

function formatMinutes(minutes: number): string {
  const totalMinutes = Math.max(0, Math.round(minutes));
  if (totalMinutes < 1) return "menos de 1 min";
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h === 0) return `~${m} min`;
  if (m === 0) return `~${h} h`;
  return `~${h} h ${m} min`;
}
