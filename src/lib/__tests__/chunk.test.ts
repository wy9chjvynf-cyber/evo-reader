import { describe, expect, it } from "vitest";
import { splitIntoChunks } from "../chunk";

describe("splitIntoChunks", () => {
  it("returns a single chunk for a short sentence", () => {
    expect(splitIntoChunks("Hola mundo.")).toEqual(["Hola mundo."]);
  });

  it("merges short sentences up to the target length", () => {
    const chunks = splitIntoChunks("Uno. Dos. Tres.");
    expect(chunks).toEqual(["Uno. Dos. Tres."]);
  });

  it("starts a new chunk once the target length would be exceeded", () => {
    const sentence = "Esta es una oración de longitud moderada para la prueba de fragmentación. ";
    const chunks = splitIntoChunks(sentence.repeat(10));
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(280);
  });

  it("splits a very long run-on sentence by words instead of exceeding MAX_LEN", () => {
    const longRun = "palabra ".repeat(80).trim(); // no punctuation anywhere
    const chunks = splitIntoChunks(longRun);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(280);
    // No words should have been dropped or duplicated.
    expect(chunks.join(" ").split(" ").length).toBe(longRun.split(" ").length);
  });

  it("never produces empty or whitespace-only chunks", () => {
    const chunks = splitIntoChunks("   \n\n  . . .   Texto real.  \n\n  ");
    expect(chunks.every((c) => c.trim().length > 0)).toBe(true);
  });

  it("collapses runs of whitespace", () => {
    const chunks = splitIntoChunks("Hola     mundo.\n\n\nOtra   línea.");
    expect(chunks.some((c) => /\s{2,}/.test(c))).toBe(false);
  });

  it("returns an empty array for empty input", () => {
    expect(splitIntoChunks("")).toEqual([]);
    expect(splitIntoChunks("   ")).toEqual([]);
  });
});
