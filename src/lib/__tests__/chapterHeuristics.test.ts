import { describe, expect, it } from "vitest";
import { findHeadingNearTop, matchHeadingLine } from "../chapterHeuristics";

describe("matchHeadingLine", () => {
  it("matches common CAPÍTULO variants", () => {
    expect(matchHeadingLine("CAPÍTULO 1")?.title).toBe("Capítulo 1");
    expect(matchHeadingLine("Capitulo 1")?.title).toBe("Capitulo 1");
    expect(matchHeadingLine("CAPÍTULO I")?.title).toBe("Capítulo I");
    expect(matchHeadingLine("Capítulo Uno")?.title).toBe("Capítulo UNO");
    expect(matchHeadingLine("CAPÍTULO PRIMERO")?.title).toBe("Capítulo PRIMERO");
  });

  it("matches a chapter word with an inline title on the same line", () => {
    const match = matchHeadingLine("Capítulo 1 — El regreso");
    expect(match?.title).toBe("Capítulo 1 — El regreso");
    expect(match?.needsNextLine).toBe(false);
  });

  it("flags needsNextLine when the chapter word has no trailing title", () => {
    const match = matchHeadingLine("Capítulo 7");
    expect(match?.needsNextLine).toBe(true);
  });

  it("matches standalone PRÓLOGO/EPÍLOGO/INTRODUCCIÓN", () => {
    expect(matchHeadingLine("PRÓLOGO")?.title).toBe("Prólogo");
    expect(matchHeadingLine("EPÍLOGO")?.title).toBe("Epílogo");
    expect(matchHeadingLine("Introducción")?.title).toBe("Introducción");
  });

  it("does not match ordinary prose, even if it mentions a chapter", () => {
    expect(matchHeadingLine("En el capítulo anterior, Tomás había encontrado un engranaje dorado que cambiaría todo.")).toBeNull();
  });

  it("does not match long lines even if they start with a chapter word", () => {
    const longLine = "Capítulo " + "x".repeat(100);
    expect(matchHeadingLine(longLine)).toBeNull();
  });

  it("does not match empty or whitespace-only lines", () => {
    expect(matchHeadingLine("")).toBeNull();
    expect(matchHeadingLine("   ")).toBeNull();
  });
});

describe("findHeadingNearTop", () => {
  it("finds a heading among the first lines and reports how many lines it consumed", () => {
    const lines = ["CAPÍTULO 1", "El relojero Tomás siguió reparando mecanismos antiguos."];
    const result = findHeadingNearTop(lines);
    expect(result?.title).toBe("Capítulo 1");
    expect(result?.consumedLines).toBe(1);
  });

  it("combines a bare chapter line with a short title on the next line", () => {
    const lines = ["Capítulo 7", "La casa", "El relojero Tomás siguió reparando mecanismos antiguos."];
    const result = findHeadingNearTop(lines);
    expect(result?.title).toBe("Capítulo 7 — La casa");
    expect(result?.consumedLines).toBe(2);
  });

  it("ignores headings beyond the lookahead window", () => {
    const lines = ["Texto normal.", "Más texto.", "Más texto.", "Más texto.", "Más texto.", "CAPÍTULO 1"];
    expect(findHeadingNearTop(lines, 5)).toBeNull();
  });

  it("returns null for a page with no heading at all", () => {
    const lines = ["El relojero Tomás siguió reparando mecanismos antiguos.", "Otra línea de la misma página."];
    expect(findHeadingNearTop(lines)).toBeNull();
  });
});
