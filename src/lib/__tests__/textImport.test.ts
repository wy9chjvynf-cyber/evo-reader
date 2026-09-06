import { describe, expect, it } from "vitest";
import { buildMarkdownSegments, buildTxtSegments } from "../textImport";

describe("buildTxtSegments", () => {
  it("splits a chapter-marked document into sections in order", () => {
    const text = [
      "TIERRA",
      "",
      "PRÓLOGO",
      "",
      "Antes de que todo comenzara, el pueblo dormía junto al mar.",
      "",
      "CAPÍTULO 1",
      "",
      "Había una vez un relojero llamado Tomás.",
      "",
      "Capítulo 2",
      "",
      "Encontró un engranaje dorado.",
      "",
      "EPÍLOGO",
      "",
      "El reloj comenzó a andar hacia atrás.",
    ].join("\n");

    const segments = buildTxtSegments(text);

    expect(segments.map((s) => s.title)).toEqual([null, "Prólogo", "Capítulo 1", "Capítulo 2", "Epílogo"]);
    expect(segments[0].text).toBe("TIERRA");
    expect(segments[1].text).toBe("Antes de que todo comenzara, el pueblo dormía junto al mar.");
    expect(segments[4].text).toBe("El reloj comenzó a andar hacia atrás.");
  });

  it("falls back to a single whole-document section when there are no chapter markers", () => {
    const text = "Un texto plano sin ningún encabezado de capítulo, solo párrafos normales.";
    const segments = buildTxtSegments(text);
    expect(segments).toHaveLength(1);
    expect(segments[0].title).toBeNull();
    expect(segments[0].sourceType).toBe("whole");
    expect(segments[0].text).toBe(text);
  });

  it("does not treat an ordinary short line as a chapter heading", () => {
    const text = "Hola.\nUn día cualquiera.\nMás texto normal aquí.";
    const segments = buildTxtSegments(text);
    expect(segments).toHaveLength(1);
    expect(segments[0].sourceType).toBe("whole");
  });
});

describe("buildMarkdownSegments", () => {
  it("splits at # and ## headings, stripping markdown syntax from the body", () => {
    const text = [
      "# TIERRA",
      "",
      "Novela con **formato** y [enlaces](https://example.com).",
      "",
      "## Capítulo 1 — El regreso",
      "",
      "Texto del primer capítulo.",
      "",
      "## Capítulo 2 — La casa",
      "",
      "Texto del segundo capítulo.",
    ].join("\n");

    const segments = buildMarkdownSegments(text);

    expect(segments.map((s) => s.title)).toEqual(["TIERRA", "Capítulo 1 — El regreso", "Capítulo 2 — La casa"]);
    expect(segments.map((s) => s.level)).toEqual([1, 2, 2]);
    expect(segments[0].text).toBe("Novela con formato y enlaces.");
  });

  it("falls back to one section when there are no headings", () => {
    const segments = buildMarkdownSegments("Solo un párrafo **con formato**, sin encabezados.");
    expect(segments).toHaveLength(1);
    expect(segments[0].title).toBeNull();
    expect(segments[0].text).toBe("Solo un párrafo con formato, sin encabezados.");
  });
});
