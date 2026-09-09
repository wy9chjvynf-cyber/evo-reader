// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSpeechEngine } from "../speechEngine";
import { WebSpeechEngine } from "../webSpeechEngine";

class FakeUtterance {
  rate = 1;
  voice: SpeechSynthesisVoice | null = null;
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  text: string;
  constructor(text: string) {
    this.text = text;
  }
}

function fakeVoice(overrides: Partial<SpeechSynthesisVoice>): SpeechSynthesisVoice {
  return {
    voiceURI: "voice-uri",
    name: "Fake Voice",
    lang: "es-ES",
    localService: true,
    default: false,
    ...overrides,
  } as SpeechSynthesisVoice;
}

function installFakeSpeechSynthesis(voices: SpeechSynthesisVoice[] = []) {
  const speak = vi.fn();
  const cancel = vi.fn();
  const getVoices = vi.fn(() => voices);
  const addEventListener = vi.fn();
  const removeEventListener = vi.fn();
  // @ts-expect-error test stub, not the real constructor
  window.SpeechSynthesisUtterance = FakeUtterance;
  // @ts-expect-error test stub
  window.speechSynthesis = { speak, cancel, getVoices, addEventListener, removeEventListener };
  return { speak, cancel, getVoices, addEventListener, removeEventListener };
}

describe("WebSpeechEngine", () => {
  beforeEach(() => {
    // @ts-expect-error reset between tests
    delete window.speechSynthesis;
    // @ts-expect-error reset between tests
    delete window.SpeechSynthesisUtterance;
  });

  describe("isSupported", () => {
    it("is false when speechSynthesis/SpeechSynthesisUtterance are missing", () => {
      const engine = new WebSpeechEngine();
      expect(engine.isSupported()).toBe(false);
    });

    it("is true once both are present", () => {
      installFakeSpeechSynthesis();
      const engine = new WebSpeechEngine();
      expect(engine.isSupported()).toBe(true);
    });
  });

  describe("getVoices — adapting web voices to the neutral model", () => {
    it("maps voiceURI/name/lang/localService to id/name/lang/local", () => {
      installFakeSpeechSynthesis([
        fakeVoice({ voiceURI: "es-uri", name: "Paulina", lang: "es-MX", localService: true }),
        fakeVoice({ voiceURI: "en-uri", name: "Samantha", lang: "en-US", localService: false }),
      ]);
      const engine = new WebSpeechEngine();

      expect(engine.getVoices()).toEqual([
        { id: "es-uri", name: "Paulina", lang: "es-MX", local: true },
        { id: "en-uri", name: "Samantha", lang: "en-US", local: false },
      ]);
    });

    it("fails soft (empty list) when speechSynthesis is unavailable", () => {
      const engine = new WebSpeechEngine();
      expect(engine.getVoices()).toEqual([]);
    });

    it("fails soft (empty list) when getVoices() throws", () => {
      // @ts-expect-error test stub
      window.speechSynthesis = {
        getVoices: () => {
          throw new Error("boom");
        },
      };
      const engine = new WebSpeechEngine();
      expect(engine.getVoices()).toEqual([]);
    });
  });

  describe("speak", () => {
    it("creates an utterance with the requested rate and resolved voice", () => {
      const targetVoice = fakeVoice({ voiceURI: "es-uri", name: "Paulina", lang: "es-MX" });
      const { speak } = installFakeSpeechSynthesis([targetVoice]);
      const engine = new WebSpeechEngine();

      engine.speak("hola mundo", {
        rate: 1.5,
        voice: { id: "es-uri", name: "Paulina", lang: "es-MX", local: true },
        onEnd: () => {},
        onError: () => {},
      });

      expect(speak).toHaveBeenCalledTimes(1);
      const utterance = speak.mock.calls[0][0] as FakeUtterance;
      expect(utterance.text).toBe("hola mundo");
      expect(utterance.rate).toBe(1.5);
      expect(utterance.voice).toBe(targetVoice);
    });

    it("leaves the native voice unset when the requested voice id can't be resolved", () => {
      const { speak } = installFakeSpeechSynthesis([]);
      const engine = new WebSpeechEngine();

      engine.speak("hola", {
        rate: 1,
        voice: { id: "missing", name: "Ghost", lang: "es-ES", local: true },
        onEnd: () => {},
        onError: () => {},
      });

      const utterance = speak.mock.calls[0][0] as FakeUtterance;
      expect(utterance.voice).toBeNull();
    });

    it("fires onStart/onEnd/onError through the platform utterance callbacks", () => {
      const { speak } = installFakeSpeechSynthesis();
      const engine = new WebSpeechEngine();
      const onStart = vi.fn();
      const onEnd = vi.fn();
      const onError = vi.fn();

      engine.speak("hola", { rate: 1, onStart, onEnd, onError });
      const utterance = speak.mock.calls[0][0] as FakeUtterance;

      utterance.onstart?.();
      utterance.onend?.();
      expect(onStart).toHaveBeenCalledTimes(1);
      expect(onEnd).toHaveBeenCalledTimes(1);
      expect(onError).not.toHaveBeenCalled();

      utterance.onerror?.();
      expect(onError).toHaveBeenCalledTimes(1);
    });

    it("reports onError instead of throwing when speechSynthesis is unavailable", () => {
      const engine = new WebSpeechEngine();
      const onError = vi.fn();

      engine.speak("hola", { rate: 1, onEnd: () => {}, onError });

      expect(onError).toHaveBeenCalledTimes(1);
    });
  });

  describe("cancel", () => {
    it("delegates to speechSynthesis.cancel()", () => {
      const { cancel } = installFakeSpeechSynthesis();
      new WebSpeechEngine().cancel();
      expect(cancel).toHaveBeenCalledTimes(1);
    });

    it("is a no-op (doesn't throw) when speechSynthesis is unavailable", () => {
      expect(() => new WebSpeechEngine().cancel()).not.toThrow();
    });
  });

  describe("onVoicesChanged", () => {
    it("subscribes via addEventListener and returns a matching unsubscribe", () => {
      const { addEventListener, removeEventListener } = installFakeSpeechSynthesis();
      const engine = new WebSpeechEngine();
      const listener = vi.fn();

      const unsubscribe = engine.onVoicesChanged(listener);
      expect(addEventListener).toHaveBeenCalledWith("voiceschanged", listener);

      unsubscribe();
      expect(removeEventListener).toHaveBeenCalledWith("voiceschanged", listener);
    });

    it("falls back to the onvoiceschanged property when addEventListener is unavailable", () => {
      // @ts-expect-error test stub without addEventListener, like some WebKit/iOS builds
      window.speechSynthesis = { onvoiceschanged: null };
      const engine = new WebSpeechEngine();
      const listener = vi.fn();

      const unsubscribe = engine.onVoicesChanged(listener);
      expect(window.speechSynthesis.onvoiceschanged).toBe(listener);

      unsubscribe();
      expect(window.speechSynthesis.onvoiceschanged).toBeNull();
    });

    it("returns a harmless no-op unsubscribe when speechSynthesis is unavailable", () => {
      const engine = new WebSpeechEngine();
      expect(() => engine.onVoicesChanged(() => {})()).not.toThrow();
    });
  });

  describe("capabilities", () => {
    it("never claims reliable pause/resume or background playback", () => {
      const engine = new WebSpeechEngine();
      expect(engine.capabilities.reliablePauseResume).toBe(false);
      expect(engine.capabilities.backgroundPlayback).toBe(false);
    });
  });
});

describe("createSpeechEngine", () => {
  it("selects WebSpeechEngine today", () => {
    expect(createSpeechEngine()).toBeInstanceOf(WebSpeechEngine);
  });
});
