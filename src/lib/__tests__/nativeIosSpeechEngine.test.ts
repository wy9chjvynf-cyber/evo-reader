import { beforeEach, describe, expect, it, vi } from "vitest";

let mockPlatform = "ios";
let mockPluginAvailable = true;

const listeners: Record<string, Array<() => void>> = {};

const pluginMock = {
  isAvailable: vi.fn(),
  getVoices: vi.fn(),
  speak: vi.fn(),
  cancel: vi.fn(),
  addListener: vi.fn((eventName: string, listener: () => void) => {
    (listeners[eventName] ??= []).push(listener);
    return Promise.resolve({ remove: () => {} });
  }),
};

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    getPlatform: () => mockPlatform,
    isPluginAvailable: () => mockPluginAvailable,
  },
  registerPlugin: () => pluginMock,
}));

const { createSpeechEngine } = await import("../speechEngine");
const { isNativeIosBridgeAvailable, mapUiRateToNativeRate, NativeIosSpeechEngine } = await import("../nativeIosSpeechEngine");
const { WebSpeechEngine } = await import("../webSpeechEngine");

function fireNativeEvent(name: string) {
  listeners[name]?.forEach((listener) => listener());
}

function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of Object.keys(listeners)) delete listeners[key];
  mockPlatform = "ios";
  mockPluginAvailable = true;
  pluginMock.getVoices.mockResolvedValue({ voices: [] });
  pluginMock.speak.mockResolvedValue(undefined);
  pluginMock.cancel.mockResolvedValue(undefined);
});

describe("isNativeIosBridgeAvailable — real capability detection, not UA sniffing", () => {
  it("is true only on iOS with the plugin actually registered", () => {
    expect(isNativeIosBridgeAvailable()).toBe(true);
  });

  it("is false on any other platform even if the plugin reports available", () => {
    mockPlatform = "web";
    expect(isNativeIosBridgeAvailable()).toBe(false);
  });

  it("is false on iOS if the native plugin isn't actually linked in", () => {
    mockPluginAvailable = false;
    expect(isNativeIosBridgeAvailable()).toBe(false);
  });
});

describe("createSpeechEngine — native vs web selection", () => {
  it("selects NativeIosSpeechEngine when the native bridge is available", () => {
    expect(createSpeechEngine()).toBeInstanceOf(NativeIosSpeechEngine);
  });

  it("falls back to WebSpeechEngine when the native bridge is not available", () => {
    mockPlatform = "web";
    expect(createSpeechEngine()).toBeInstanceOf(WebSpeechEngine);
  });
});

describe("mapUiRateToNativeRate — EvoReader UI scale (0.75-2.0) to AVSpeechUtterance (0.0-1.0)", () => {
  it("maps the UI's normal rate (1.0) to AVSpeechUtteranceDefaultSpeechRate (0.5)", () => {
    expect(mapUiRateToNativeRate(1)).toBeCloseTo(0.5);
  });

  it("scales proportionally at the UI's minimum and maximum", () => {
    expect(mapUiRateToNativeRate(0.75)).toBeCloseTo(0.375);
    expect(mapUiRateToNativeRate(2)).toBeCloseTo(1.0);
  });

  it("clamps to AVSpeechUtterance's valid 0-1 range for out-of-spec input", () => {
    expect(mapUiRateToNativeRate(10)).toBe(1.0);
    expect(mapUiRateToNativeRate(-5)).toBe(0.0);
  });
});

describe("NativeIosSpeechEngine", () => {
  it("adapts native voices (identifier/name/language/quality/personal) to the neutral SpeechVoice model", async () => {
    pluginMock.getVoices.mockResolvedValue({
      voices: [
        { identifier: "com.apple.voice.ana", name: "Ana", language: "es-ES", quality: "premium" },
        { identifier: "com.apple.voice.tom", name: "Tom", language: "en-US", quality: "enhanced", personal: true },
      ],
    });

    const engine = new NativeIosSpeechEngine();
    await flush();

    expect(engine.getVoices()).toEqual([
      { id: "com.apple.voice.ana", name: "Ana", lang: "es-ES", local: true, quality: "premium", personal: undefined },
      { id: "com.apple.voice.tom", name: "Tom", lang: "en-US", local: true, quality: "enhanced", personal: true },
    ]);
  });

  it("notifies onVoicesChanged once the async native fetch resolves, like Web Speech's own async voice loading", async () => {
    let resolveVoices: (value: { voices: unknown[] }) => void = () => {};
    pluginMock.getVoices.mockReturnValue(
      new Promise((resolve) => {
        resolveVoices = resolve;
      }),
    );

    const engine = new NativeIosSpeechEngine();
    const listener = vi.fn();
    engine.onVoicesChanged(listener);
    expect(engine.getVoices()).toEqual([]);
    expect(listener).not.toHaveBeenCalled();

    resolveVoices({ voices: [{ identifier: "a", name: "A", language: "es-ES" }] });
    await flush();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(engine.getVoices()).toHaveLength(1);
  });

  it("fails soft (keeps an empty list) when the native getVoices() call rejects", async () => {
    pluginMock.getVoices.mockRejectedValue(new Error("bridge down"));
    const engine = new NativeIosSpeechEngine();
    await flush();
    expect(engine.getVoices()).toEqual([]);
  });

  it("speak() maps rate and resolves the voice by native identifier before calling the plugin", () => {
    const engine = new NativeIosSpeechEngine();
    engine.speak("hola mundo", {
      rate: 1.5,
      voice: { id: "com.apple.voice.ana", name: "Ana", lang: "es-ES", local: true },
      onEnd: () => {},
      onError: () => {},
    });

    expect(pluginMock.speak).toHaveBeenCalledWith({
      text: "hola mundo",
      rate: mapUiRateToNativeRate(1.5),
      voiceIdentifier: "com.apple.voice.ana",
    });
  });

  it("speaks without a voiceIdentifier when no voice is requested", () => {
    const engine = new NativeIosSpeechEngine();
    engine.speak("hola", { rate: 1, onEnd: () => {}, onError: () => {} });
    expect(pluginMock.speak).toHaveBeenCalledWith({ text: "hola", rate: mapUiRateToNativeRate(1), voiceIdentifier: undefined });
  });

  it("forwards native speechStart/speechEnd events to the most recent speak() call's callbacks", async () => {
    const engine = new NativeIosSpeechEngine();
    await flush(); // let addListener's registration promises settle

    const onStart = vi.fn();
    const onEnd = vi.fn();
    engine.speak("hola", { rate: 1, onStart, onEnd, onError: () => {} });

    fireNativeEvent("speechStart");
    fireNativeEvent("speechEnd");

    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it("reports onError when the native speak() call itself rejects (AVSpeechSynthesizerDelegate has no failure event)", async () => {
    pluginMock.speak.mockRejectedValue(new Error("bridge down"));
    const engine = new NativeIosSpeechEngine();
    const onError = vi.fn();

    engine.speak("hola", { rate: 1, onEnd: () => {}, onError });
    await flush();

    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("cancel() delegates to the native plugin", () => {
    const engine = new NativeIosSpeechEngine();
    engine.cancel();
    expect(pluginMock.cancel).toHaveBeenCalledTimes(1);
  });

  it("isSupported() reflects real bridge availability, including it disappearing later", () => {
    const engine = new NativeIosSpeechEngine();
    expect(engine.isSupported()).toBe(true);
    mockPluginAvailable = false;
    expect(engine.isSupported()).toBe(false);
  });
});
