import type { SpeakOptions, SpeechEngine, SpeechEngineCapabilities, SpeechVoice } from "./speechEngine";

/** The only place in EvoReader that touches window.speechSynthesis / SpeechSynthesisUtterance directly. */
function getSynth(): SpeechSynthesis | undefined {
  return typeof window !== "undefined" ? window.speechSynthesis : undefined;
}

function toSpeechVoice(voice: SpeechSynthesisVoice): SpeechVoice {
  return { id: voice.voiceURI, name: voice.name, lang: voice.lang, local: voice.localService };
}

const CAPABILITIES: SpeechEngineCapabilities = {
  reliablePauseResume: false,
  backgroundPlayback: false,
};

export class WebSpeechEngine implements SpeechEngine {
  readonly capabilities = CAPABILITIES;

  isSupported(): boolean {
    return typeof window !== "undefined" && !!window.speechSynthesis && typeof window.SpeechSynthesisUtterance === "function";
  }

  speak(text: string, options: SpeakOptions): void {
    const synth = getSynth();
    if (!synth) {
      options.onError();
      return;
    }

    try {
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = options.rate;
      if (options.voice) {
        const native = synth.getVoices().find((v) => v.voiceURI === options.voice!.id);
        if (native) utterance.voice = native;
      }
      if (options.onStart) utterance.onstart = options.onStart;
      utterance.onend = options.onEnd;
      utterance.onerror = options.onError;
      synth.speak(utterance);
    } catch {
      options.onError();
    }
  }

  cancel(): void {
    getSynth()?.cancel();
  }

  getVoices(): SpeechVoice[] {
    try {
      return (getSynth()?.getVoices() ?? []).map(toSpeechVoice);
    } catch {
      return [];
    }
  }

  onVoicesChanged(listener: () => void): () => void {
    const synth = getSynth();
    if (!synth) return () => {};

    // Some WebKit/iOS builds don't implement addEventListener on
    // SpeechSynthesis; fall back to the onvoiceschanged property instead of
    // letting the call throw.
    if (typeof synth.addEventListener === "function") {
      synth.addEventListener("voiceschanged", listener);
      return () => synth.removeEventListener("voiceschanged", listener);
    }
    if ("onvoiceschanged" in synth) {
      synth.onvoiceschanged = listener;
      return () => {
        if (synth.onvoiceschanged === listener) synth.onvoiceschanged = null;
      };
    }
    return () => {};
  }
}
