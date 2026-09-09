/**
 * Platform-neutral speech engine contract. Reader Core (SpeechController)
 * talks only to this interface — never to window.speechSynthesis or any
 * other platform API directly — so a future engine (native iOS bridge,
 * cloud TTS, ...) can be swapped in via createSpeechEngine() without
 * touching Reader Core.
 */
import { isNativeIosBridgeAvailable, NativeIosSpeechEngine } from "./nativeIosSpeechEngine";
import { WebSpeechEngine } from "./webSpeechEngine";

/** A voice, decoupled from any platform's native voice object. `id` is the
 *  stable identity Reader Core persists (e.g. in IndexedDB) across sessions —
 *  for WebSpeechEngine this is the browser's own voiceURI, so previously
 *  persisted selections keep resolving after this refactor. */
export interface SpeechVoice {
  id: string;
  name: string;
  lang: string;
  local: boolean;
  /** Only set when an engine can actually report it (e.g. NativeIosSpeechEngine
   *  from AVSpeechSynthesisVoiceQuality) — never fabricated for Web Speech. */
  quality?: "default" | "enhanced" | "premium";
  /** True only when the engine can positively identify an on-device Personal Voice. */
  personal?: boolean;
}

export interface SpeakOptions {
  rate: number;
  voice?: SpeechVoice | null;
  onEnd: () => void;
  onError: () => void;
  /** Not consumed by Reader Core today (chunk advance only needs onEnd/onError) — kept for engines/UI that want to know narration actually started. */
  onStart?: () => void;
}

/** What a given engine can actually guarantee — kept intentionally small;
 *  add fields only once something in Reader Core needs to branch on them. */
export interface SpeechEngineCapabilities {
  /** Native pause()/resume() is unreliable in Web Speech (utterances can get
   *  silently stuck on mobile Safari/Chrome), so Reader Core never relies on
   *  it — it always cancels and re-speaks from the current chunk instead. */
  reliablePauseResume: boolean;
  /** Whether narration keeps playing once the app/tab is backgrounded. */
  backgroundPlayback: boolean;
}

export interface SpeechEngine {
  readonly capabilities: SpeechEngineCapabilities;
  isSupported(): boolean;
  speak(text: string, options: SpeakOptions): void;
  /** Stops any in-progress utterance. Reader Core also uses this for "pause" — see capabilities.reliablePauseResume. */
  cancel(): void;
  getVoices(): SpeechVoice[];
  /** Subscribes to the engine's voice list changing (e.g. async voice loading). Returns an unsubscribe function. */
  onVoicesChanged(listener: () => void): () => void;
}

/**
 * Single point of engine selection. Picks NativeIosSpeechEngine only when the
 * real EvoSpeech native plugin is detected (Capacitor.isPluginAvailable —
 * never user-agent sniffing), so the web/PWA build automatically keeps using
 * WebSpeechEngine exactly as before.
 */
export function createSpeechEngine(): SpeechEngine {
  if (isNativeIosBridgeAvailable()) return new NativeIosSpeechEngine();
  return new WebSpeechEngine();
}
