import * as pdfjsLib from "pdfjs-dist";
import type { PDFPageProxy } from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.mjs?url";
import { splitIntoChunks } from "./chunk";
import { findHeadingNearTop } from "./chapterHeuristics";
import { resizeImageBlobToJpeg } from "./coverImage";
import { countWords } from "./sectionBuilder";
import { putChunksBatch, putSection, updateBook, type ChunkRecord } from "./db";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

export interface PdfImportProgress {
  page: number;
  totalPages: number;
  chunksSoFar: number;
}

/** The section currently being written to — passed in when resuming, so we keep appending to it instead of starting a new one. */
export interface OpenSectionState {
  index: number;
  title: string | null;
  firstChunkIndex: number;
  sourceStart: number;
}

interface PdfImportOptions {
  /** 1-based page to start from — > 1 when resuming an interrupted import. */
  startPage: number;
  startChunkIndex: number;
  /** Index to assign to the *next* newly-detected chapter. */
  nextSectionIndex: number;
  /** The section currently open (unclosed) when resuming; null to start fresh at page 1. */
  openSection: OpenSectionState | null;
  onProgress: (progress: PdfImportProgress) => void;
  onCover?: (blob: Blob) => void;
}

const devLog = import.meta.env.DEV ? console.debug : () => {};
const COVER_MAX_WIDTH = 300;

type TextContent = Awaited<ReturnType<PDFPageProxy["getTextContent"]>>;

function extractPageLines(content: TextContent): string[] {
  const lines: string[] = [];
  let current = "";
  for (const item of content.items) {
    if (!("str" in item)) continue;
    current += item.str;
    if ("hasEOL" in item && item.hasEOL) {
      lines.push(current);
      current = "";
    } else {
      current += " ";
    }
  }
  if (current.trim()) lines.push(current);
  return lines;
}

async function renderPageThumbnail(page: PDFPageProxy): Promise<Blob | null> {
  try {
    const unscaled = page.getViewport({ scale: 1 });
    const scale = COVER_MAX_WIDTH / unscaled.width;
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(viewport.width));
    canvas.height = Math.max(1, Math.round(viewport.height));
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    await page.render({ canvas, canvasContext: ctx, viewport }).promise;
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob((b) => resolve(b), "image/jpeg", 0.82));
    return blob ? await resizeImageBlobToJpeg(blob, COVER_MAX_WIDTH) : null;
  } catch {
    return null;
  }
}

/**
 * Processes a PDF page by page: extract -> detect a conservative
 * chapter-heading match -> chunk -> persist -> release. Never holds more
 * than one page's text in memory at a time, and commits after every page so
 * an interrupted import can resume from importedUntil+1.
 *
 * Chapter detection only ever looks at the first few lines of each page for
 * an isolated CAPÍTULO/PRÓLOGO/EPÍLOGO/INTRODUCCIÓN-style line (see
 * chapterHeuristics.ts) — precision over recall. A PDF with no such lines
 * anywhere ends up with exactly one "Libro completo" section, same as
 * before this feature existed.
 */
export async function importPdfIncremental(
  bookId: string,
  data: ArrayBuffer,
  opts: PdfImportOptions,
): Promise<{ totalPages: number; totalChunks: number; totalSections: number; wordCount: number }> {
  const doc = await pdfjsLib.getDocument({ data }).promise;
  const totalPages = doc.numPages;
  let chunkIndex = opts.startChunkIndex;
  let nextSectionIndex = opts.nextSectionIndex;
  let wordCount = 0;

  let open: OpenSectionState = opts.openSection ?? {
    index: nextSectionIndex++,
    title: null,
    firstChunkIndex: chunkIndex,
    sourceStart: opts.startPage,
  };

  const closeSection = async (sourceEnd: number) => {
    if (open.firstChunkIndex > chunkIndex - 1) return; // nothing was ever added to it — discard silently
    await putSection({
      bookId,
      index: open.index,
      title: open.title,
      level: 1,
      sourceType: "page",
      sourceStart: open.sourceStart,
      sourceEnd,
      firstChunkIndex: open.firstChunkIndex,
      lastChunkIndex: chunkIndex - 1,
      wordCount: 0,
    });
  };

  try {
    if (opts.startPage === 1 && opts.onCover) {
      const firstPage = await doc.getPage(1);
      const thumbnail = await renderPageThumbnail(firstPage);
      if (thumbnail) opts.onCover(thumbnail);
    }

    for (let pageNum = opts.startPage; pageNum <= totalPages; pageNum++) {
      const page = await doc.getPage(pageNum);
      const content = await page.getTextContent();
      const lines = extractPageLines(content);
      page.cleanup();

      const heading = findHeadingNearTop(lines);
      // Exclude the heading's own line(s) from the narrated body — it's
      // already shown/read as the section title, not as body content.
      const bodyLines = heading ? lines.slice(heading.consumedLines) : lines;
      const pageText = bodyLines.join(" ");

      if (heading) {
        await closeSection(pageNum - 1);
        open = { index: nextSectionIndex++, title: heading.title, firstChunkIndex: chunkIndex, sourceStart: pageNum };
      }

      const pageChunks = splitIntoChunks(pageText);
      const records: ChunkRecord[] = pageChunks.map((text, i) => ({
        bookId,
        index: chunkIndex + i,
        sectionIndex: open.index,
        sourcePage: pageNum,
        text,
      }));
      await putChunksBatch(records);
      chunkIndex += records.length;
      wordCount += countWords(pageText);

      // Keep the currently-open section's row up to date so a resume knows
      // where it started even if we're interrupted before it's closed.
      await putSection({
        bookId,
        index: open.index,
        title: open.title,
        level: 1,
        sourceType: "page",
        sourceStart: open.sourceStart,
        sourceEnd: pageNum,
        firstChunkIndex: open.firstChunkIndex,
        lastChunkIndex: null,
        wordCount: 0,
      });

      await updateBook(bookId, {
        importedUntil: pageNum,
        totalChunks: chunkIndex,
        totalSections: nextSectionIndex,
        totalPages,
        importProgress: Math.round((pageNum / totalPages) * 100),
      });

      opts.onProgress({ page: pageNum, totalPages, chunksSoFar: chunkIndex });
      devLog(`[pdfImport] page ${pageNum}/${totalPages}: +${records.length} chunks (total ${chunkIndex}), section "${open.title ?? "(sin título)"}"`);
    }

    await closeSection(totalPages);
  } finally {
    await doc.cleanup();
  }

  return { totalPages, totalChunks: chunkIndex, totalSections: nextSectionIndex, wordCount };
}
