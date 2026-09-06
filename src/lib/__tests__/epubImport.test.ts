// @vitest-environment jsdom
// EPUB parsing needs DOMParser (jsdom). Note: jsdom's Blob loses its methods
// through fake-indexeddb's structuredClone-based cloning (see db.test.ts's
// sibling note), so these tests exercise importEpubIncremental directly and
// only ever touch a cover Blob as an in-memory callback value — never
// round-tripped through IndexedDB. The full pipeline (bookImport.ts's
// putFileBlob-based resumability included) is covered by manual real-browser
// testing instead; chunk/section persistence here uses putChunksBatch/
// putSection/getChunkRange, which are plain-object stores unaffected by the
// Blob issue.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearAllBooks, getChunkRange, getSections, putChunksBatch, putSection } from "../db";
import { importEpubIncremental } from "../epubImport";
import { buildTestEpub } from "../../test/fixtures";

// jsdom has no real <canvas> 2D context, so resizeImageBlobToJpeg (generic
// browser image-resizing, not EPUB-specific logic) can't run here — stub it
// to a passthrough so the test instead verifies the EPUB-specific part: that
// the right cover bytes were located in the package and handed off.
vi.mock("../coverImage", () => ({
  resizeImageBlobToJpeg: async (blob: Blob) => blob,
}));

describe("importEpubIncremental", () => {
  beforeEach(async () => {
    await clearAllBooks();
  });

  it("extracts metadata, preserves spine order, and creates one section per chapter", async () => {
    const data = await buildTestEpub({
      title: "TIERRA",
      author: "Autora de Prueba",
      language: "es",
      chapters: [
        { id: "c1", href: "text/c1.xhtml", title: "Capítulo 1 — El regreso", body: "Contenido del primer capítulo." },
        { id: "c2", href: "text/c2.xhtml", title: "Capítulo 2 — La casa", body: "Contenido del segundo capítulo." },
        { id: "c3", href: "text/c3.xhtml", title: "Capítulo 3 — El bosque", body: "Contenido del tercer capítulo." },
      ],
    });

    let metadata: { title: string | null; author: string | null; language: string | null } | undefined;
    const bookId = "epub-1";
    const result = await importEpubIncremental(bookId, data, {
      startSpineIndex: 0,
      startSectionIndex: 0,
      startChunkIndex: 0,
      onMetadata: (m) => {
        metadata = m;
      },
      onProgress: () => {},
    });

    expect(metadata).toEqual({ title: "TIERRA", author: "Autora de Prueba", language: "es" });
    expect(result.totalSections).toBe(3);
    expect(result.totalSpineItems).toBe(3);

    const sections = await getSections(bookId);
    expect(sections.map((s) => s.title)).toEqual(["Capítulo 1 — El regreso", "Capítulo 2 — La casa", "Capítulo 3 — El bosque"]);
    // Sections are contiguous and in spine order.
    for (let i = 1; i < sections.length; i++) {
      expect(sections[i].firstChunkIndex).toBe((sections[i - 1].lastChunkIndex ?? -1) + 1);
    }

    const chunks = await getChunkRange(bookId, 0, result.totalChunks - 1);
    expect(chunks).toHaveLength(result.totalChunks);
    // The chapter heading text must not also appear inside its own body chunk.
    for (const c of chunks) {
      expect(c.text).not.toContain("Capítulo");
    }
  });

  it("extracts the cover image when the manifest declares one", async () => {
    const data = await buildTestEpub({
      title: "Con portada",
      chapters: [{ id: "c1", href: "text/c1.xhtml", title: "Capítulo 1", body: "Texto." }],
      withCover: true,
    });

    let coverBlob: Blob | null | undefined;
    await importEpubIncremental("epub-cover", data, {
      startSpineIndex: 0,
      startSectionIndex: 0,
      startChunkIndex: 0,
      onMetadata: (_m, cover) => {
        coverBlob = cover;
      },
      onProgress: () => {},
    });

    expect(coverBlob).toBeTruthy();
    expect(coverBlob?.size).toBeGreaterThan(0);
  });

  it("has no cover when the EPUB declares none", async () => {
    const data = await buildTestEpub({
      title: "Sin portada",
      chapters: [{ id: "c1", href: "text/c1.xhtml", title: "Capítulo 1", body: "Texto." }],
    });

    let coverBlob: Blob | null | undefined = undefined;
    let sawMetadata = false;
    await importEpubIncremental("epub-no-cover", data, {
      startSpineIndex: 0,
      startSectionIndex: 0,
      startChunkIndex: 0,
      onMetadata: (_m, cover) => {
        coverBlob = cover;
        sawMetadata = true;
      },
      onProgress: () => {},
    });

    expect(sawMetadata).toBe(true);
    expect(coverBlob).toBeNull();
  });

  it("resumes from an interruption point without duplicating chunks or sections", async () => {
    const chapters = [
      { id: "c1", href: "text/c1.xhtml", title: "Capítulo 1", body: "Texto uno." },
      { id: "c2", href: "text/c2.xhtml", title: "Capítulo 2", body: "Texto dos." },
      { id: "c3", href: "text/c3.xhtml", title: "Capítulo 3", body: "Texto tres." },
      { id: "c4", href: "text/c4.xhtml", title: "Capítulo 4", body: "Texto cuatro." },
    ];
    const data = await buildTestEpub({ title: "Resumable", chapters });
    const bookId = "epub-resume";

    // Simulate a prior session that committed spine items 0-1 before being interrupted.
    await putSection({ bookId, index: 0, title: "Capítulo 1", level: 1, sourceType: "spine", sourceStart: 0, sourceEnd: 0, firstChunkIndex: 0, lastChunkIndex: 0, wordCount: 2 });
    await putChunksBatch([{ bookId, index: 0, sectionIndex: 0, sourcePage: null, text: "Texto uno." }]);
    await putSection({ bookId, index: 1, title: "Capítulo 2", level: 1, sourceType: "spine", sourceStart: 1, sourceEnd: 1, firstChunkIndex: 1, lastChunkIndex: 1, wordCount: 2 });
    await putChunksBatch([{ bookId, index: 1, sectionIndex: 1, sourcePage: null, text: "Texto dos." }]);

    const resumed = await importEpubIncremental(bookId, data, {
      startSpineIndex: 2,
      startSectionIndex: 2,
      startChunkIndex: 2,
      onProgress: () => {},
    });

    expect(resumed.totalSections).toBe(4);
    expect(resumed.totalChunks).toBe(4);

    const sections = await getSections(bookId);
    expect(sections.map((s) => s.index)).toEqual([0, 1, 2, 3]);
    expect(sections.map((s) => s.title)).toEqual(["Capítulo 1", "Capítulo 2", "Capítulo 3", "Capítulo 4"]);

    const chunks = await getChunkRange(bookId, 0, 10);
    expect(chunks.map((c) => c.index)).toEqual([0, 1, 2, 3]);
    expect(chunks.map((c) => c.text)).toEqual(["Texto uno.", "Texto dos.", "Texto tres.", "Texto cuatro."]);
  });
});
