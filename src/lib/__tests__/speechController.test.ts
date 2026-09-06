// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SpeechController } from "../speechController";

class FakeUtterance {
  rate = 1;
  voice: SpeechSynthesisVoice | null = null;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  text: string;
  constructor(text: string) {
    this.text = text;
  }
}

function installFakeSpeechSynthesis() {
  const speak = vi.fn((utterance: FakeUtterance) => {
    setTimeout(() => utterance.onend?.(), 0); // resolves like a real (fast) utterance
  });
  const cancel = vi.fn();
  // @ts-expect-error test stub, not the real constructor
  window.SpeechSynthesisUtterance = FakeUtterance;
  // @ts-expect-error test stub
  window.speechSynthesis = { speak, cancel };
  return { speak, cancel };
}

describe("SpeechController", () => {
  beforeEach(() => {
    installFakeSpeechSynthesis();
  });

  it("plays chunks in order, reporting index/text/status as it goes", async () => {
    // Only two chunks exist; the third fetch resolves to undefined and parks
    // the controller in "buffering" instead of racing a third speak() call.
    const texts = ["uno", "dos"];
    const indexChanges: number[] = [];
    const statuses: string[] = [];
    const shown: (string | undefined)[] = [];
    const { speak } = installFakeSpeechSynthesis();

    const controller = new SpeechController({
      onIndexChange: (i) => indexChanges.push(i),
      onStatusChange: (s) => statuses.push(s),
      onChunkText: (t) => shown.push(t),
      getChunkText: async (i) => texts[i],
    });

    controller.setBook(texts.length, 0);
    controller.play();

    await new Promise((r) => setTimeout(r, 30)); // let chunk 0 -> chunk 1 play out
    controller.pause();

    expect(indexChanges).toEqual(expect.arrayContaining([0, 1]));
    expect(shown).toEqual(expect.arrayContaining(["uno", "dos"]));
    expect(speak).toHaveBeenCalledTimes(2);
    expect(statuses).toContain("playing");
  });

  it("does not fetch or speak a chunk that's out of the current cache/skip bounds", () => {
    const controller = new SpeechController({
      onIndexChange: () => {},
      onStatusChange: () => {},
      onChunkText: () => {},
      getChunkText: async () => "x",
    });
    controller.setBook(3, 0);
    controller.skip(-1); // already at 0, should clamp instead of going negative
    expect(controller.getIndex()).toBe(0);
    controller.skip(10); // clamp to last known index
    expect(controller.getIndex()).toBe(2);
  });

  it("buffers when a chunk isn't imported yet, then plays it once available", async () => {
    let available = false;
    const statuses: string[] = [];
    const { speak } = installFakeSpeechSynthesis();

    const controller = new SpeechController({
      onIndexChange: () => {},
      onStatusChange: (s) => statuses.push(s),
      onChunkText: () => {},
      getChunkText: async (i) => (i === 0 && available ? "listo" : undefined),
    });

    controller.setBook(0, 0); // import hasn't produced any chunks yet
    controller.play();

    await new Promise((r) => setTimeout(r, 50));
    expect(statuses).toContain("buffering");
    expect(speak).not.toHaveBeenCalled();

    available = true; // "import" just committed chunk 0
    await new Promise((r) => setTimeout(r, 500)); // within one retry interval

    expect(speak).toHaveBeenCalledTimes(1);
  });

  it("goToChunk jumps directly to an arbitrary index (chapter navigation) and updates the display", async () => {
    const texts = ["a", "b", "c", "d", "e"];
    const indexChanges: number[] = [];
    const shown: (string | undefined)[] = [];
    const controller = new SpeechController({
      onIndexChange: (i) => indexChanges.push(i),
      onStatusChange: () => {},
      onChunkText: (t) => shown.push(t),
      getChunkText: async (i) => texts[i],
    });

    controller.setBook(texts.length, 0);
    controller.goToChunk(3); // e.g. a section's firstChunkIndex, selected from the chapters panel
    await new Promise((r) => setTimeout(r, 10));

    expect(controller.getIndex()).toBe(3);
    expect(indexChanges).toContain(3);
    expect(shown).toContain("d");
  });

  it("goToChunk while playing cancels the current utterance and speaks from the new index", async () => {
    // Chunk 0's fetch is deliberately blocked until released, so goToChunk(4)
    // is called while still "buffering" on chunk 0 — deterministic, no
    // reliance on winning a race against how fast fake utterances cascade.
    const texts = ["a", "b", "c", "d", "e"];
    const { speak, cancel } = installFakeSpeechSynthesis();
    let releaseFirstFetch = () => {};
    const firstFetchGate = new Promise<void>((resolve) => {
      releaseFirstFetch = resolve;
    });

    const controller = new SpeechController({
      onIndexChange: () => {},
      onStatusChange: () => {},
      onChunkText: () => {},
      getChunkText: async (i) => {
        if (i === 0) await firstFetchGate;
        return texts[i];
      },
    });

    controller.setBook(texts.length, 0);
    controller.play(); // synchronously reaches "buffering" on chunk 0, then awaits the blocked fetch
    controller.goToChunk(4); // jump while that fetch is still pending

    releaseFirstFetch(); // let the now-superseded chunk 0 fetch resolve — must be ignored
    await new Promise((r) => setTimeout(r, 20));

    expect(cancel).toHaveBeenCalled();
    expect(controller.getIndex()).toBe(4);
    expect(speak).toHaveBeenLastCalledWith(expect.objectContaining({ text: "e" }));
  });

  it("pause/resume via skip does not leave the controller stuck mid-cancel", () => {
    const statuses: string[] = [];
    const controller = new SpeechController({
      onIndexChange: () => {},
      onStatusChange: (s) => statuses.push(s),
      onChunkText: () => {},
      getChunkText: async () => "x",
    });
    controller.setBook(5, 0);
    controller.play();
    controller.pause();
    expect(statuses).toContain("paused");
    controller.stop();
    expect(controller.getIndex()).toBe(0);
    expect(statuses.at(-1)).toBe("idle");
  });
});
