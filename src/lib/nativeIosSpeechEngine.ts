import { App } from "@capacitor/app";
import { Capacitor, registerPlugin } from "@capacitor/core";
import type { SpeakOptions, SpeechEngine, SpeechEngineCapabilities, SpeechVoice } from "./speechEngine";

const PLUGIN_NAME = "EvoSpeech";

interface NativeVoice {
  identifier: string;
  name: string;
  language: string;
  quality?: "default" | "enhanced" | "premium";
  personal?: boolean;
}

interface EvoSpeechPlugin {
  isAvailable(): Promise<{ available: boolean }>;
  getVoices(): Promise<{ voices: NativeVoice[] }>;
  speak(options: { text: string; rate: number; voiceIdentifier?: string }): Promise<void>;
  cancel(): Promise<void>;
  addListener(eventName: "speechStart" | "speechEnd", listenerFunc: () => void): Promise<{ remove: () => void }>;
}

// Registered once at module scope, like any Capacitor plugin — safe to import
// on web too (it resolves to a stub that rejects every call there, which
// isNativeIosBridgeAvailable()/isSupported() route around before ever calling it).
const EvoSpeech = registerPlugin<EvoSpeechPlugin>(PLUGIN_NAME);

/** Real capability detection — never user-agent sniffing. False on web, and
 *  false on iOS too until the EvoSpeechPlugin native module actually links in. */
export function isNativeIosBridgeAvailable(): boolean {
  return Capacitor.getPlatform() === "ios" && Capacitor.isPluginAvailable(PLUGIN_NAME);
}

/**
 * EvoReader's UI rate (see MIN_RATE/MAX_RATE in App.tsx) ranges 0.75–2.0 with
 * 1.0 as "normal", matching Web Speech's SpeechSynthesisUtterance.rate scale.
 * AVSpeechUtterance.rate is a completely different, unrelated scale: 0.0–1.0,
 * with AVSpeechUtteranceDefaultSpeechRate (~0.5) as "normal". Copying the UI
 * number straight across would make 0.75 nearly silent and clamp everything
 * above 1.0 to the same maximum speed.
 *
 * Instead this scales proportionally around the shared "normal" points (UI's
 * 1.0 <-> native's ~0.5), then clamps to AVSpeechUtterance's valid range.
 */
const AV_SPEECH_DEFAULT_RATE = 0.5; // AVSpeechUtteranceDefaultSpeechRate
const AV_SPEECH_MIN_RATE = 0.0; // AVSpeechUtteranceMinimumSpeechRate
const AV_SPEECH_MAX_RATE = 1.0; // AVSpeechUtteranceMaximumSpeechRate

export function mapUiRateToNativeRate(uiRate: number): number {
  const scaled = uiRate * AV_SPEECH_DEFAULT_RATE;
  return Math.min(AV_SPEECH_MAX_RATE, Math.max(AV_SPEECH_MIN_RATE, scaled));
}

function toSpeechVoice(voice: NativeVoice): SpeechVoice {
  return {
    id: voice.identifier,
    name: voice.name,
    lang: voice.language,
    local: true, // every AVSpeechSynthesisVoice is on-device
    quality: voice.quality,
    personal: voice.personal,
  };
}

const CAPABILITIES: SpeechEngineCapabilities = {
  // SpeechController still cancels+re-speaks rather than relying on this —
  // native pause()/resume() wiring is a follow-up phase, not this one.
  reliablePauseResume: false,
  // The plugin configures AVAudioSession(.playback) and the app declares the
  // "audio" UIBackgroundMode, which is Apple's documented setup for narration
  // to keep playing while backgrounded. Now Playing / remote command center
  // controls are a separate, later phase — not implemented here.
  backgroundPlayback: true,
};

/**
 * SpeechEngine backed by the native EvoSpeech plugin (AVSpeechSynthesizer).
 * SpeechController talks to this exactly like WebSpeechEngine — same
 * contract, same one-utterance-at-a-time model — it has no idea Capacitor or
 * Swift are involved.
 */
export class NativeIosSpeechEngine implements SpeechEngine {
  readonly capabilities = CAPABILITIES;

  private cachedVoices: SpeechVoice[] = [];
  private voicesListeners = new Set<() => void>();
  private currentOnStart: (() => void) | null = null;
  private currentOnEnd: (() => void) | null = null;

  constructor() {
    // The plugin's events are global (one AVSpeechSynthesizer, one utterance
    // in flight at a time — matching SpeechController's own model), so the
    // most recently registered speak() callbacks are always the right ones
    // to invoke; no per-call correlation id is needed.
    void EvoSpeech.addListener("speechStart", () => this.currentOnStart?.());
    void EvoSpeech.addListener("speechEnd", () => this.currentOnEnd?.());

    // Re-fetch on init (below) and whenever the app comes back to the
    // foreground — e.g. the user just downloaded an Enhanced/Premium voice
    // in Settings and switched back. iOS suspends rather than relaunches on a
    // simple background/foreground cycle, so without this the cached list
    // from the original launch would never notice. Not polling: this fires
    // only on the app's own 'resume' lifecycle event, never on a timer.
    void App.addListener("resume", () => this.refreshVoices());

    this.refreshVoices();
  }

  /** Forces a fresh AVSpeechSynthesisVoice.speechVoices() query (the plugin
   *  never caches — see EvoSpeechPlugin.getVoices()) and notifies
   *  onVoicesChanged listeners once it resolves. Also reachable from the UI
   *  via the diagnostic "Actualizar voces" button. */
  refreshVoices(): void {
    void (async () => {
      try {
        const { voices } = await EvoSpeech.getVoices();
        this.cachedVoices = voices.map(toSpeechVoice);
        this.voicesListeners.forEach((listener) => listener());
      } catch {
        // Fail soft — keep whatever was cached before (possibly still empty).
      }
    })();
  }

  isSupported(): boolean {
    return isNativeIosBridgeAvailable();
  }

  speak(text: string, options: SpeakOptions): void {
    this.currentOnStart = options.onStart ?? null;
    this.currentOnEnd = options.onEnd;

    void EvoSpeech.speak({
      text,
      rate: mapUiRateToNativeRate(options.rate),
      voiceIdentifier: options.voice?.id,
    }).catch(() => {
      // AVSpeechSynthesizerDelegate has no "failed" callback (on-device
      // synthesis doesn't fail the way network-backed Web Speech can) — the
      // only failure mode here is the bridge call itself rejecting.
      options.onError();
    });
  }

  cancel(): void {
    void EvoSpeech.cancel();
  }

  getVoices(): SpeechVoice[] {
    // The native call is always async even though AVSpeechSynthesisVoice.speechVoices()
    // itself is synchronous on the Swift side, so this returns whatever's
    // cached so far (like Web Speech's own frequently-empty-until-loaded
    // getVoices()) and notifies onVoicesChanged once refreshVoices() resolves.
    return this.cachedVoices;
  }

  onVoicesChanged(listener: () => void): () => void {
    this.voicesListeners.add(listener);
    return () => this.voicesListeners.delete(listener);
  }
}
