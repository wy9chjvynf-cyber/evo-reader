// @vitest-environment jsdom
//
// mammoth's Node build expects {buffer|path|file}, not the {arrayBuffer} the
// app passes it — that shape is only accepted by mammoth's *browser* build,
// which Vite's real build correctly resolves via mammoth's package.json
// "browser" field (verified by hand against a real .docx, and by loading
// real DOCX files with headings in an actual browser during manual testing
// this phase). Vitest's Node-based test runner doesn't apply that same
// browser-field remapping to mammoth's *internal* relative requires, so
// convertToHtml is mocked here with the exact HTML shape mammoth produces
// for these inputs — verified against real mammoth output — to test the
// part that's actually EvoReader's own code: walking that HTML into
// sections.
import { describe, expect, it, vi } from "vitest";

vi.mock("mammoth", () => ({
  default: {
    convertToHtml: vi.fn(async ({ arrayBuffer }: { arrayBuffer: ArrayBuffer }) => ({
      value: new TextDecoder().decode(arrayBuffer),
    })),
  },
}));

const { extractDocxSegments } = await import("../docxImport");

function fileFromHtml(name: string, html: string): File {
  return new File([new TextEncoder().encode(html)], name, {
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
}

describe("extractDocxSegments", () => {
  it("splits at h1/h2 into sections, preserving order and text", async () => {
    const html =
      "<h1>TIERRA</h1><p>Novela de prueba.</p>" +
      "<h1>Capítulo 1 — El regreso</h1><p>Primer párrafo del capítulo uno.</p><p>Segundo párrafo del capítulo uno.</p>" +
      "<h2>Un apartado</h2><p>Detalle del apartado.</p>" +
      "<h1>Capítulo 2 — La casa</h1><p>Texto del capítulo dos.</p>";

    const segments = await extractDocxSegments(fileFromHtml("libro.docx", html));

    expect(segments.map((s) => s.title)).toEqual(["TIERRA", "Capítulo 1 — El regreso", "Un apartado", "Capítulo 2 — La casa"]);
    expect(segments.map((s) => s.level)).toEqual([1, 1, 2, 1]);
    expect(segments[1].text).toBe("Primer párrafo del capítulo uno.\nSegundo párrafo del capítulo uno.");
    expect(segments[3].text).toBe("Texto del capítulo dos.");
    for (const s of segments) expect(s.text).not.toContain("Capítulo");
  });

  it("falls back to one whole-document section when there are no headings, without losing text", async () => {
    const html = "<p>TIERRA</p><p>Primer párrafo sin encabezados.</p><p>Segundo párrafo sin encabezados.</p>";

    const segments = await extractDocxSegments(fileFromHtml("libro.docx", html));

    expect(segments).toHaveLength(1);
    expect(segments[0].title).toBeNull();
    expect(segments[0].sourceType).toBe("whole");
    expect(segments[0].text).toBe("TIERRA\nPrimer párrafo sin encabezados.\nSegundo párrafo sin encabezados.");
  });
});
