import * as pdfjsLib from "pdfjs-dist";
import type { PDFPageProxy, PDFDocumentLoadingTask } from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.mjs?url";
import { splitIntoChunks } from "./chunk";
import { findHeadingNearTop } from "./chapterHeuristics";
import { countWords } from "./sectionBuilder";
import { commitPdfPage, getBook, type SectionRecord } from "./db";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
export const PDF_LIMITS = { fileBytes: 256 * 1024 * 1024, rangeBytes: 64 * 1024, fetchedBytes: 32 * 1024 * 1024, pageCharacters: 256 * 1024, epochPages: 32, timeoutMs: 30_000 };
export interface PdfImportProgress { page: number; totalPages: number; chunksSoFar: number }
export interface OpenSectionState { index: number; title: string | null; firstChunkIndex: number; sourceStart: number }
interface PdfImportOptions {
  startPage: number; startChunkIndex: number; nextSectionIndex: number; openSection: OpenSectionState | null;
  onProgress: (progress: PdfImportProgress) => void | Promise<void>;
  signal?: AbortSignal;
}

/** One outstanding disk read, no full-file arrayBuffer and no speculative fetching. */
class BlobRanges extends pdfjsLib.PDFDataRangeTransport {
  private stopped = false;
  private queue = Promise.resolve();
  private fetched = 0;
  private blob: Blob;
  private fail: (error: Error) => void;
  constructor(blob: Blob, fail: (error: Error) => void) { super(blob.size, null, true); this.blob = blob; this.fail = fail; }
  requestDataRange(begin: number, end: number) {
    this.queue = this.queue.then(async () => {
      if (this.stopped) return;
      const length = end - begin;
      this.fetched += length;
      if (length > 8 * 1024 * 1024 || this.fetched > PDF_LIMITS.fetchedBytes) throw new Error(`PDF demasiado complejo: supera el límite de lectura por bloque. Divide el archivo; el avance queda guardado.`);
      // PDF.js requires a complete response for each requested interval; splitting
      // one response drops its tail and can trigger full-file corruption recovery.
      const bytes = new Uint8Array(await this.blob.slice(begin, end).arrayBuffer());
      if (!this.stopped) this.onDataRange(begin, bytes);
    }).catch(error => { this.abort(); this.fail(error); });
  }
  abort() { this.stopped = true; }
}

async function pageLines(page: PDFPageProxy): Promise<string[]> {
  const reader = page.streamTextContent().getReader();
  const lines: string[] = [];
  let line = "", size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      for (const item of value.items) {
        if (!("str" in item)) continue;
        size += item.str.length + 1;
        if (size > PDF_LIMITS.pageCharacters) throw new Error("Página con demasiado texto (máximo 256 Ki caracteres). Avance guardado.");
        line += item.str + " ";
        if (item.hasEOL) { lines.push(line.trim()); line = ""; }
      }
    }
    if (line.trim()) lines.push(line.trim());
    return lines;
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export async function importPdfIncremental(bookId: string, source: Blob, opts: PdfImportOptions) {
  if (source.size > PDF_LIMITS.fileBytes) throw new Error("PDF de más de 256 MB: divide el documento antes de importarlo.");
  let chunkIndex = opts.startChunkIndex, nextSectionIndex = opts.nextSectionIndex;
  const previous = await getBook(bookId);
  let wordCount = previous?.wordCount ?? 0, emptyPages = previous?.emptyPages ?? 0, damagedPages = previous?.damagedPages ?? 0;
  let open = opts.openSection;
  let totalPages = previous?.totalPages ?? 0;
  let pageNum = opts.startPage;
  let task: PDFDocumentLoadingTask | undefined;
  let worker: pdfjsLib.PDFWorker | undefined;
  let transientRetries = 0;
  let transport: BlobRanges | undefined;
  const aborted = () => { if (opts.signal?.aborted) throw new Error("Importación cancelada. Puedes reanudar desde el último avance guardado."); };
  const section = (state: OpenSectionState, end: number, last: number | null): SectionRecord => ({ ...state, bookId, level: 1, sourceType: "page", sourceEnd: end, lastChunkIndex: last, wordCount: 0 });
  do {
    aborted();
    let fail!: (error: Error) => void;
    const failure = new Promise<never>((_, reject) => { fail = reject; });
    // Observed even between operations (e.g. while committing to IndexedDB).
    void failure.catch(() => {});
    const cancel = () => fail(new Error("Importación cancelada. Puedes reanudar desde el último avance guardado."));
    opts.signal?.addEventListener("abort", cancel, { once: true });
    const bounded = async <T,>(operation: Promise<T>): Promise<T> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { return await Promise.race([operation, failure, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("El PDF tardó demasiado. Reintenta desde el avance guardado.")), PDF_LIMITS.timeoutMs); })]); }
      finally { clearTimeout(timer); }
    };
    try {
      transport = new BlobRanges(source, fail);
      worker = new pdfjsLib.PDFWorker();
      await bounded(worker.promise);
      if (typeof Worker !== "undefined" && !(worker.port instanceof Worker)) throw new Error("No se pudo iniciar el procesamiento en segundo plano. Recarga la aplicación.");
      task = pdfjsLib.getDocument({ worker, stopAtErrors: true, range: transport, rangeChunkSize: PDF_LIMITS.rangeBytes, disableAutoFetch: true, disableStream: true });
      const doc = await bounded(task.promise);
      totalPages = doc.numPages;
      const epochEnd = Math.min(totalPages, pageNum + PDF_LIMITS.epochPages - 1);
      for (; pageNum <= epochEnd; pageNum++) {
        aborted();
        let page: PDFPageProxy | undefined, lines: string[] = [], damaged = false;
        try {
          page = await bounded(doc.getPage(pageNum));
          lines = await bounded(pageLines(page));
        } catch (error) {
          // Only explicit parser corruption is skippable; never silently skip quota, timeout or cancellation.
          if (error instanceof Error && (error.name === "FormatError" || (error.name === "UnknownErrorException" && /^FormatError:/.test(String((error as Error & { details?: string }).details))))) damaged = true;
          else throw error;
        } finally { page?.cleanup(); }
        aborted();
        const heading = findHeadingNearTop(lines);
        const text = (heading ? lines.slice(heading.consumedLines) : lines).join(" ");
        const chunks = splitIntoChunks(text);
        const sections: SectionRecord[] = [];
        if (heading && open && chunkIndex > open.firstChunkIndex) {
          sections.push(section(open, pageNum - 1, chunkIndex - 1)); open = null;
        }
        if (!open && chunks.length) open = { index: nextSectionIndex++, title: heading?.title ?? null, firstChunkIndex: chunkIndex, sourceStart: pageNum };
        const records = chunks.map((text, i) => ({ bookId, index: chunkIndex + i, sectionIndex: open!.index, sourcePage: pageNum, text }));
        chunkIndex += records.length; wordCount += countWords(text);
        if (damaged) damagedPages++; else if (!text.trim()) emptyPages++;
        if (open) sections.push(section(open, pageNum, pageNum === totalPages ? chunkIndex - 1 : null));
        await commitPdfPage(bookId, records, sections, { importedUntil: pageNum, totalChunks: chunkIndex, totalSections: nextSectionIndex, totalPages, wordCount, emptyPages, damagedPages, importStage: "extracting", importProgress: Math.round(pageNum / totalPages * 100) });
        await opts.onProgress({ page: pageNum, totalPages, chunksSoFar: chunkIndex });
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    } catch (error) {
      if (!opts.signal?.aborted && error instanceof Error && /tardó demasiado/.test(error.message) && transientRetries++ < 1) {
        // Retry once with a new worker at the last fully committed page.
        const checkpoint = await getBook(bookId);
        pageNum = (checkpoint?.importedUntil ?? 0) + 1;
        continue;
      }
      throw error;
    } finally {
      transport?.abort();
      opts.signal?.removeEventListener("abort", cancel);
      // Terminate worker every epoch; PDF.js retains parsed objects and range bytes until destruction.
      let destroyTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([task?.destroy().catch(() => {}), new Promise<void>(resolve => { destroyTimer = setTimeout(resolve, 1000); })]);
      } finally { clearTimeout(destroyTimer); worker?.destroy(); }
      task = undefined; worker = undefined;
    }
  } while (!totalPages || pageNum <= totalPages);
  if (!chunkIndex) throw new Error("No se encontró texto: PDF escaneado, vacío o dañado. Necesita OCR; no se envía a servicios externos.");
  return { totalPages, totalChunks: chunkIndex, totalSections: nextSectionIndex, wordCount };
}
