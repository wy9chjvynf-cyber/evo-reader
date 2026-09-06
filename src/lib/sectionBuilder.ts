import { putChunksBatch, putSection, type SectionRecord } from "./db";
import { splitIntoChunks } from "./chunk";

export interface DocumentSegment {
  title: string | null;
  level: number;
  sourceType: SectionRecord["sourceType"];
  sourceStart: number | null;
  sourceEnd: number | null;
  text: string;
}

export function countWords(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

/**
 * Turns a linear list of (title, text) segments — DOCX headings, Markdown
 * headings, TXT chapter matches, or one segment per EPUB spine item — into
 * persisted sections + chunks. Shared by every format whose whole document
 * (or whole segment, for EPUB) is chunked in one shot, as opposed to PDF's
 * page-by-page streaming loop which tracks section state differently.
 */
export async function persistSegments(
  bookId: string,
  segments: DocumentSegment[],
  start: { sectionIndex: number; chunkIndex: number },
  onProgress?: (segmentsDone: number, totalSegments: number, chunksSoFar: number) => void,
): Promise<{ sectionIndex: number; chunkIndex: number; wordCount: number }> {
  let { sectionIndex, chunkIndex } = start;
  let wordCount = 0;

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    const chunks = splitIntoChunks(segment.text);
    const segmentWordCount = countWords(segment.text);
    wordCount += segmentWordCount;

    if (chunks.length > 0) {
      const firstChunkIndex = chunkIndex;
      await putChunksBatch(
        chunks.map((text, j) => ({
          bookId,
          index: chunkIndex + j,
          sectionIndex,
          sourcePage: segment.sourceStart,
          text,
        })),
      );
      chunkIndex += chunks.length;
      await putSection({
        bookId,
        index: sectionIndex,
        title: segment.title,
        level: segment.level,
        sourceType: segment.sourceType,
        sourceStart: segment.sourceStart,
        sourceEnd: segment.sourceEnd,
        firstChunkIndex,
        lastChunkIndex: chunkIndex - 1,
        wordCount: segmentWordCount,
      });
      sectionIndex += 1;
    }

    onProgress?.(i + 1, segments.length, chunkIndex);
  }

  return { sectionIndex, chunkIndex, wordCount };
}
