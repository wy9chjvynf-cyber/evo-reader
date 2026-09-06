/**
 * Conservative chapter-heading detection shared by the PDF and TXT
 * importers. Precision over recall: a line only counts as a heading when it
 * is short and matches a known chapter/prologue/epilogue pattern in
 * isolation — never a heuristic that fires on arbitrary short lines, since a
 * false positive here fragments a book into bogus "chapters" forever.
 */

const NUMBER_WORD =
  "UNO|DOS|TRES|CUATRO|CINCO|SEIS|SIETE|OCHO|NUEVE|DIEZ|ONCE|DOCE|TRECE|CATORCE|QUINCE|" +
  "PRIMERO|SEGUNDO|TERCERO|CUARTO|QUINTO|SEXTO|S[EÉ]PTIMO|OCTAVO|NOVENO|D[EÉ]CIMO";
const ROMAN_OR_NUMBER = `[IVXLCDM]+|\\d+|${NUMBER_WORD}`;

const CHAPTER_WORD_RE = new RegExp(`^(CAP[IÍ]TULO|CAPITULO|PARTE)\\b\\s*(${ROMAN_OR_NUMBER})?\\s*[-:—.]?\\s*(.*)$`, "i");
const STANDALONE_TITLE_RE = /^(PR[OÓ]LOGO|EP[IÍ]LOGO|INTRODUCCI[OÓ]N|EPILOGO|PROLOGO)\s*$/i;

const MAX_HEADING_LINE_LENGTH = 80;
const MAX_TITLE_CONTINUATION_LENGTH = 40;

export interface HeadingMatch {
  /** Cleaned-up title, e.g. "Capítulo 1 — El regreso" or "Prólogo". */
  title: string;
  /** True when the matched line had no trailing title text of its own (may need the next line). */
  needsNextLine: boolean;
}

/** Does this single line, on its own, look like a chapter/section heading? */
export function matchHeadingLine(rawLine: string): HeadingMatch | null {
  const line = rawLine.trim();
  if (!line || line.length > MAX_HEADING_LINE_LENGTH) return null;

  if (STANDALONE_TITLE_RE.test(line)) {
    return { title: capitalizeWords(line), needsNextLine: false };
  }

  const chapterMatch = line.match(CHAPTER_WORD_RE);
  if (chapterMatch) {
    const [, word, number, rest] = chapterMatch;
    const label = [capitalizeWords(word), number?.toUpperCase()].filter(Boolean).join(" ");
    const trailing = rest?.trim();
    if (trailing) {
      return { title: `${label} — ${trailing}`, needsNextLine: false };
    }
    return { title: label, needsNextLine: true };
  }

  return null;
}

/**
 * Looks at a page/document's lines (in order) for a heading near the top.
 * Only the first `lookahead` lines are considered — real chapter titles sit
 * at the start of a chapter, not buried mid-page — which also keeps this
 * cheap to run on every page during import.
 */
export function findHeadingNearTop(lines: string[], lookahead = 5): { title: string; consumedLines: number } | null {
  for (let i = 0; i < Math.min(lines.length, lookahead); i++) {
    const match = matchHeadingLine(lines[i]);
    if (!match) continue;
    if (!match.needsNextLine) return { title: match.title, consumedLines: 1 };

    // Only absorb the next line as a title continuation (e.g. "Capítulo 7" +
    // "La casa") when it looks like a short title fragment, not a sentence of
    // actual body prose — otherwise we'd both mislabel the chapter and eat
    // its first sentence out of the narrated text.
    const next = lines[i + 1]?.trim();
    if (next && next.length <= MAX_TITLE_CONTINUATION_LENGTH && !/[.!?,;]$/.test(next) && !matchHeadingLine(next)) {
      return { title: `${match.title} — ${next}`, consumedLines: 2 };
    }
    return { title: match.title, consumedLines: 1 };
  }
  return null;
}

function capitalizeWords(s: string): string {
  return s
    .toLowerCase()
    .split(" ")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}
