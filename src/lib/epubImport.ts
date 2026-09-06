import JSZip from "jszip";
import { splitIntoChunks } from "./chunk";
import { countWords, type DocumentSegment } from "./sectionBuilder";
import { putChunksBatch, putSection, updateBook, type ChunkRecord } from "./db";
import { resizeImageBlobToJpeg } from "./coverImage";

export interface EpubMetadata {
  title: string | null;
  author: string | null;
  language: string | null;
}

interface ManifestItem {
  href: string; // resolved, zip-relative path
  mediaType: string;
  properties: string[];
}

interface TocEntry {
  title: string;
  level: number;
  href: string; // resolved path, no fragment
  fragment: string | null;
}

interface EpubStructure {
  zip: JSZip;
  metadata: EpubMetadata;
  manifest: Map<string, ManifestItem>;
  spineHrefs: string[];
  tocEntries: TocEntry[];
  coverHref: string | null;
}

const devLog = import.meta.env.DEV ? console.debug : () => {};

function resolveRelativePath(baseDir: string, href: string): string {
  const clean = href.split("#")[0];
  const base = `https://epub.local/${baseDir ? `${baseDir}/` : ""}`;
  const url = new URL(clean, base);
  return decodeURIComponent(url.pathname.replace(/^\//, ""));
}

function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

async function zipEntry(zip: JSZip, path: string) {
  const normalized = path.replace(/^\//, "");
  const file = zip.file(normalized) ?? zip.file(path);
  if (!file) throw new Error(`EPUB: no se encontró "${path}" dentro del paquete.`);
  return file;
}

function parseXml(text: string): Document {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.querySelector("parsererror")) throw new Error("EPUB: XML mal formado.");
  return doc;
}

function firstText(doc: Document | Element, tagNames: string[]): string | null {
  for (const name of tagNames) {
    const el = doc.getElementsByTagName(name)[0];
    const text = el?.textContent?.trim();
    if (text) return text;
  }
  return null;
}

/** Reads container.xml + the OPF + TOC (nav.xhtml or .ncx) — small files, fast. */
async function parseEpubStructure(zip: JSZip): Promise<EpubStructure> {
  const containerXml = await (await zipEntry(zip, "META-INF/container.xml")).async("string");
  const containerDoc = parseXml(containerXml);
  const rootfile = containerDoc.getElementsByTagName("rootfile")[0];
  const opfPath = rootfile?.getAttribute("full-path");
  if (!opfPath) throw new Error("EPUB: container.xml no declara el archivo OPF.");

  const opfText = await (await zipEntry(zip, opfPath)).async("string");
  const opfDoc = parseXml(opfText);
  const opfDir = dirname(opfPath);

  const metadata: EpubMetadata = {
    title: firstText(opfDoc, ["dc:title", "title"]),
    author: firstText(opfDoc, ["dc:creator", "creator"]),
    language: firstText(opfDoc, ["dc:language", "language"]),
  };

  const manifest = new Map<string, ManifestItem>();
  for (const item of Array.from(opfDoc.getElementsByTagName("item"))) {
    const id = item.getAttribute("id");
    const href = item.getAttribute("href");
    if (!id || !href) continue;
    manifest.set(id, {
      href: resolveRelativePath(opfDir, href),
      mediaType: item.getAttribute("media-type") ?? "",
      properties: (item.getAttribute("properties") ?? "").split(/\s+/).filter(Boolean),
    });
  }

  const spineEl = opfDoc.getElementsByTagName("spine")[0];
  const spineHrefs: string[] = [];
  for (const itemref of Array.from(spineEl?.getElementsByTagName("itemref") ?? [])) {
    const idref = itemref.getAttribute("idref");
    const item = idref ? manifest.get(idref) : undefined;
    if (item) spineHrefs.push(item.href);
  }

  // Cover: EPUB3 properties="cover-image", else EPUB2 <meta name="cover" content="id">.
  let coverHref: string | null = null;
  for (const item of manifest.values()) {
    if (item.properties.includes("cover-image")) {
      coverHref = item.href;
      break;
    }
  }
  if (!coverHref) {
    for (const meta of Array.from(opfDoc.getElementsByTagName("meta"))) {
      if (meta.getAttribute("name") === "cover") {
        const id = meta.getAttribute("content");
        if (id && manifest.has(id)) coverHref = manifest.get(id)!.href;
        break;
      }
    }
  }

  const tocEntries = await resolveToc(zip, manifest, spineEl, opfDir);

  return { zip, metadata, manifest, spineHrefs, tocEntries, coverHref };
}

async function resolveToc(
  zip: JSZip,
  manifest: Map<string, ManifestItem>,
  spineEl: Element | undefined,
  opfDir: string,
): Promise<TocEntry[]> {
  const navItem = [...manifest.values()].find((i) => i.properties.includes("nav"));
  if (navItem) {
    try {
      return await parseNavToc(zip, navItem.href);
    } catch {
      devLog("[epubImport] nav.xhtml TOC parse failed, falling back to NCX if present");
    }
  }

  const ncxId = spineEl?.getAttribute("toc");
  const ncxItem = ncxId ? manifest.get(ncxId) : [...manifest.values()].find((i) => i.mediaType.includes("ncx"));
  if (ncxItem) {
    try {
      return await parseNcxToc(zip, ncxItem.href);
    } catch {
      devLog("[epubImport] toc.ncx parse failed");
    }
  }

  void opfDir;
  return [];
}

async function parseNavToc(zip: JSZip, navHref: string): Promise<TocEntry[]> {
  const html = await (await zipEntry(zip, navHref)).async("string");
  const doc = new DOMParser().parseFromString(html, "text/html");
  const navDir = dirname(navHref);

  const tocNav =
    Array.from(doc.querySelectorAll("nav")).find((n) => n.getAttribute("epub:type") === "toc" || n.getAttribute("role") === "doc-toc") ??
    doc.querySelector("nav");
  if (!tocNav) return [];

  const entries: TocEntry[] = [];
  function walk(list: Element, level: number) {
    for (const li of Array.from(list.children).filter((c) => c.tagName.toLowerCase() === "li")) {
      const a = li.querySelector(":scope > a, :scope > span");
      const href = a?.getAttribute("href");
      const title = a?.textContent?.trim();
      if (href && title) {
        const [path, fragment] = href.split("#");
        entries.push({ title, level, href: resolveRelativePath(navDir, path), fragment: fragment ?? null });
      }
      const nestedList = li.querySelector(":scope > ol, :scope > ul");
      if (nestedList) walk(nestedList, level + 1);
    }
  }
  const topList = tocNav.querySelector("ol, ul");
  if (topList) walk(topList, 1);
  return entries;
}

async function parseNcxToc(zip: JSZip, ncxHref: string): Promise<TocEntry[]> {
  const xml = await (await zipEntry(zip, ncxHref)).async("string");
  const doc = parseXml(xml);
  const ncxDir = dirname(ncxHref);

  const entries: TocEntry[] = [];
  function walk(navPoint: Element, level: number) {
    for (const point of Array.from(navPoint.children).filter((c) => c.tagName === "navPoint")) {
      const title = point.getElementsByTagName("text")[0]?.textContent?.trim();
      const src = point.getElementsByTagName("content")[0]?.getAttribute("src");
      if (title && src) {
        const [path, fragment] = src.split("#");
        entries.push({ title, level, href: resolveRelativePath(ncxDir, path), fragment: fragment ?? null });
      }
      walk(point, level + 1);
    }
  }
  const navMap = doc.getElementsByTagName("navMap")[0];
  if (navMap) walk(navMap, 1);
  return entries;
}

const HEADING_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);

/**
 * Plain text of an element with paragraph breaks preserved — plain
 * `.textContent` runs every descendant text node together with no separator
 * at all (e.g. adjacent <p> tags collapse into one run-on word), so this
 * walks text nodes individually and joins them with newlines instead.
 */
function extractPlainText(root: Node): string {
  const parts: string[] = [];
  function walk(node: Node) {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent?.trim();
      if (text) parts.push(text);
      return;
    }
    for (const child of Array.from(node.childNodes)) walk(child);
  }
  walk(root);
  return parts.join("\n");
}

/**
 * Plain text of one XHTML spine file, optionally split at TOC anchor ids
 * inside it. Whichever element marks a section's start (a fragment target,
 * or — when the TOC just points at the whole file — its first heading tag)
 * is excluded from the narrated body text: it's already shown as the
 * section title, so including it too would read it out twice.
 */
function extractSpineSegments(html: string, anchors: TocEntry[]): { title: string | null; text: string }[] {
  const doc = new DOMParser().parseFromString(html, "text/html");
  if (anchors.length === 0 || !doc.body) {
    return [{ title: null, text: doc.body ? extractPlainText(doc.body) : "" }];
  }

  const fragmentTargets = new Map(anchors.filter((a) => a.fragment).map((a) => [a.fragment as string, a.title]));
  let usedImplicitHeading = false;

  const segments: { title: string | null; text: string }[] = [];
  let currentTitle: string | null = fragmentTargets.size > 0 ? null : anchors[0].title;
  let buffer: string[] = [];

  const flush = () => {
    const text = buffer.join("\n").trim();
    if (text || currentTitle) segments.push({ title: currentTitle, text });
    buffer = [];
  };

  function sectionStartTitle(el: Element): string | null {
    const id = el.getAttribute("id");
    if (id && fragmentTargets.has(id)) {
      const title = fragmentTargets.get(id)!;
      fragmentTargets.delete(id);
      return title;
    }
    if (fragmentTargets.size === 0 && !usedImplicitHeading && HEADING_TAGS.has(el.tagName.toLowerCase())) {
      usedImplicitHeading = true;
      return anchors[0].title;
    }
    return null;
  }

  function walk(node: Node) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as Element;
      const startTitle = sectionStartTitle(el);
      if (startTitle !== null) {
        flush();
        currentTitle = startTitle;
        return; // this element IS the title — don't also read its text as body content
      }
    }
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent?.trim();
      if (text) buffer.push(text);
      return;
    }
    for (const child of Array.from(node.childNodes)) walk(child);
  }
  for (const child of Array.from(doc.body.childNodes)) walk(child);
  flush();

  return segments.length > 0 ? segments : [{ title: anchors[0]?.title ?? null, text: extractPlainText(doc.body) }];
}

export interface EpubImportProgress {
  spineIndex: number;
  totalSpineItems: number;
  chunksSoFar: number;
}

interface EpubImportOptions {
  startSpineIndex: number;
  startSectionIndex: number;
  startChunkIndex: number;
  /** null until the very first pass has produced a title (title only needs setting once). */
  onMetadata?: (metadata: EpubMetadata, coverBlob: Blob | null) => void;
  onProgress: (progress: EpubImportProgress) => void;
}

/**
 * Processes an EPUB spine item by spine item: extract its HTML, split at any
 * TOC anchors inside it, chunk, persist, release — mirrors pdfImport.ts's
 * page-by-page loop so a large EPUB never needs its whole text in memory at
 * once, and an interrupted import can resume from the next spine item.
 */
export async function importEpubIncremental(
  bookId: string,
  data: ArrayBuffer,
  opts: EpubImportOptions,
): Promise<{ totalSections: number; totalChunks: number; totalSpineItems: number; wordCount: number; metadata: EpubMetadata }> {
  const zip = await JSZip.loadAsync(data);
  const structure = await parseEpubStructure(zip);
  const totalSpineItems = structure.spineHrefs.length;
  if (totalSpineItems === 0) throw new Error("EPUB: no se encontró un spine con contenido legible.");

  let coverBlob: Blob | null = null;
  if (opts.startSpineIndex === 0 && structure.coverHref) {
    try {
      const raw = await (await zipEntry(zip, structure.coverHref)).async("blob");
      coverBlob = await resizeImageBlobToJpeg(raw, 400);
    } catch {
      devLog("[epubImport] cover extraction failed, continuing without one");
    }
  }
  opts.onMetadata?.(structure.metadata, coverBlob);

  let sectionIndex = opts.startSectionIndex;
  let chunkIndex = opts.startChunkIndex;
  let wordCount = 0;

  for (let spineIndex = opts.startSpineIndex; spineIndex < totalSpineItems; spineIndex++) {
    const href = structure.spineHrefs[spineIndex];
    const html = await (await zipEntry(zip, href)).async("string");
    const anchorsHere = structure.tocEntries.filter((t) => t.href === href);
    const rawSegments = extractSpineSegments(html, anchorsHere);

    for (const raw of rawSegments) {
      const chunks = splitIntoChunks(raw.text);
      if (chunks.length === 0) continue;
      const firstChunkIndex = chunkIndex;
      const records: ChunkRecord[] = chunks.map((text, i) => ({
        bookId,
        index: chunkIndex + i,
        sectionIndex,
        sourcePage: null,
        text,
      }));
      await putChunksBatch(records);
      chunkIndex += chunks.length;
      wordCount += countWords(raw.text);
      await putSection({
        bookId,
        index: sectionIndex,
        title: raw.title,
        level: 1,
        sourceType: "spine",
        sourceStart: spineIndex,
        sourceEnd: spineIndex,
        firstChunkIndex,
        lastChunkIndex: chunkIndex - 1,
        wordCount: countWords(raw.text),
      });
      sectionIndex += 1;
    }

    await updateBook(bookId, {
      importedUntil: spineIndex + 1,
      totalChunks: chunkIndex,
      totalSections: sectionIndex,
      totalPages: totalSpineItems,
    });
    opts.onProgress({ spineIndex: spineIndex + 1, totalSpineItems, chunksSoFar: chunkIndex });
    devLog(`[epubImport] spine ${spineIndex + 1}/${totalSpineItems}: total chunks ${chunkIndex}, sections ${sectionIndex}`);
  }

  return { totalSections: sectionIndex, totalChunks: chunkIndex, totalSpineItems, wordCount, metadata: structure.metadata };
}

export type { DocumentSegment };
