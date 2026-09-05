const TARGET_LEN = 200;
const MAX_LEN = 280;

const SENTENCE_RE = /[^.!?\n]+(?:[.!?]+["')\]]*|\n+|$)/g;

function splitLongSentence(sentence: string): string[] {
  const words = sentence.split(" ");
  const pieces: string[] = [];
  let piece = "";
  for (const word of words) {
    const candidate = piece ? `${piece} ${word}` : word;
    if (candidate.length > MAX_LEN && piece) {
      pieces.push(piece);
      piece = word;
    } else {
      piece = candidate;
    }
  }
  if (piece) pieces.push(piece);
  return pieces;
}

/** Splits raw extracted text into speech-sized chunks (roughly sentence-sized). */
export function splitIntoChunks(text: string): string[] {
  const clean = text
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .trim();
  const rawSentences = clean.match(SENTENCE_RE) ?? [clean];

  const chunks: string[] = [];
  let current = "";

  for (const raw of rawSentences) {
    const sentence = raw.trim();
    if (!sentence) continue;

    if (sentence.length > MAX_LEN) {
      if (current) {
        chunks.push(current);
        current = "";
      }
      chunks.push(...splitLongSentence(sentence));
      continue;
    }

    const candidate = current ? `${current} ${sentence}` : sentence;
    if (candidate.length <= TARGET_LEN) {
      current = candidate;
    } else {
      if (current) chunks.push(current);
      current = sentence;
    }
  }

  if (current) chunks.push(current);
  return chunks.filter(Boolean);
}
