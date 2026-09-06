import { describe, expect, it } from "vitest";
import { matchMarkdownHeading, stripMarkdownSyntax } from "../markdown";

describe("matchMarkdownHeading", () => {
  it("matches # ## ### with their level", () => {
    expect(matchMarkdownHeading("# TIERRA")).toEqual({ level: 1, title: "TIERRA" });
    expect(matchMarkdownHeading("## Capítulo 1 — El regreso")).toEqual({ level: 2, title: "Capítulo 1 — El regreso" });
    expect(matchMarkdownHeading("### Un apartado")).toEqual({ level: 3, title: "Un apartado" });
  });

  it("does not match a line that merely contains a #", () => {
    expect(matchMarkdownHeading("Esto no es #un encabezado")).toBeNull();
  });

  it("does not match plain text", () => {
    expect(matchMarkdownHeading("Texto normal.")).toBeNull();
  });

  it("strips trailing closing hashes", () => {
    expect(matchMarkdownHeading("## Capítulo 2 ##")).toEqual({ level: 2, title: "Capítulo 2" });
  });
});

describe("stripMarkdownSyntax", () => {
  it("removes bold/italic markers, keeping the text", () => {
    expect(stripMarkdownSyntax("Novela de prueba en **Markdown** con *énfasis*.")).toBe("Novela de prueba en Markdown con énfasis.");
  });

  it("converts links to their visible text", () => {
    expect(stripMarkdownSyntax("Visita [este enlace](https://example.com) para más.")).toBe("Visita este enlace para más.");
  });

  it("drops images entirely", () => {
    expect(stripMarkdownSyntax("Antes ![alt](img.png) después.")).toBe("Antes  después.");
  });

  it("strips inline code and blockquote/list markers", () => {
    expect(stripMarkdownSyntax("Usa `código` aquí.")).toBe("Usa código aquí.");
    expect(stripMarkdownSyntax("> una cita")).toBe("una cita");
    expect(stripMarkdownSyntax("- primer punto")).toBe("primer punto");
    expect(stripMarkdownSyntax("1. primer punto")).toBe("primer punto");
  });
});
