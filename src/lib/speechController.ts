export type PlaybackStatus = "idle" | "playing" | "paused" | "buffering";

interface SpeechControllerDeps {
  onIndexChange: (index: number) => void;
  onStatusChange: (status: PlaybackStatus) => void;
  /** Called whenever the text for the current index is resolved, for display. */
  onChunkText: (text: string | undefined) => void;
  /** Fetches one chunk's text from wherever it's stored; undefined = not persisted (yet). */
  getChunkText: (index: number) => Promise<string | undefined>;
}

function getSynth(): SpeechSynthesis | undefined {
  return typeof window !== "undefined" ? window.speechSynthesis : undefined;
}

const CACHE_WINDOW = 6;
const MAX_BUFFER_RETRIES = 25;
const BUFFER_RETRY_MS = 400;

/**
 * Speaks a book's chunks one at a time via window.speechSynthesis, fetching
 * each chunk's text on demand (plus a small one-ahead prefetch) instead of
 * holding the whole book's text in memory — a book can have tens of
 * thousands of chunks, and PDF import can still be filling in later ones
 * while narration is already underway.
 *
 * "buffering" status covers both waiting for the next chunk to actually
 * exist yet (import still catching up — this is what lets Play start before
 * a big PDF finishes importing) and the brief moment any chunk fetch takes.
 * If a chunk never shows up after MAX_BUFFER_RETRIES, that's treated as the
 * real end of the book.
 *
 * Pause/resume is implemented as cancel + re-speak-from-index rather than the
 * native pause()/resume(), because native pause/resume is unreliable on
 * mobile Safari/Chrome (utterances can get silently stuck). Each speak()
 * call is tagged with a sequence number so a stale event from a canceled
 * utterance can't be mistaken for a genuine completion.
 */
export class SpeechController {
  private totalChunks = 0;
  private index = 0;
  private rate = 1;
  private voice: SpeechSynthesisVoice | null = null;
  private status: PlaybackStatus = "idle";
  private sequence = 0;
  private cache = new Map<number, string>();
  private deps: SpeechControllerDeps;

  constructor(deps: SpeechControllerDeps) {
    this.deps = deps;
  }

  static isSupported(): boolean {
    return typeof window !== "undefined" && !!window.speechSynthesis && typeof window.SpeechSynthesisUtterance === "function";
  }

  /** Loads a (possibly still-importing) book: totalChunks is the best-known count so far. */
  setBook(totalChunks: number, startIndex = 0) {
    this.sequence += 1;
    getSynth()?.cancel();
    this.totalChunks = totalChunks;
    this.cache.clear();
    this.index = Math.min(Math.max(startIndex, 0), Math.max(totalChunks - 1, 0));
    this.setStatus("idle");
    this.deps.onIndexChange(this.index);
    void this.showCurrent();
  }

  /** Called as import progresses, so skip()/play() bounds and the progress bar stay current. */
  setTotalChunks(totalChunks: number) {
    this.totalChunks = totalChunks;
    // The current index's text may have just become available (e.g. import
    // finished while the user hadn't pressed Play yet) — refresh the display.
    if (this.status === "idle") void this.showCurrent();
  }

  setRate(rate: number) {
    this.rate = rate;
  }

  setVoice(voice: SpeechSynthesisVoice | null) {
    this.voice = voice;
  }

  getStatus() {
    return this.status;
  }

  getIndex() {
    return this.index;
  }

  play() {
    if (!SpeechController.isSupported()) return;
    if (this.totalChunks > 0 && this.index >= this.totalChunks) this.index = 0;
    void this.speakFrom(this.index);
  }

  pause() {
    if (this.status !== "playing" && this.status !== "buffering") return;
    this.sequence += 1;
    getSynth()?.cancel();
    this.setStatus("paused");
  }

  stop() {
    this.sequence += 1;
    getSynth()?.cancel();
    this.index = 0;
    this.setStatus("idle");
    this.deps.onIndexChange(0);
    void this.showCurrent();
  }

  skip(delta: number) {
    this.goToChunk(this.index + delta);
  }

  /** Jumps to an arbitrary chunk — used for chapter navigation ("goToSection" at the App layer resolves a section to its firstChunkIndex and calls this). */
  goToChunk(index: number) {
    const wasActive = this.status === "playing" || this.status === "buffering";
    if (wasActive) {
      this.sequence += 1;
      getSynth()?.cancel();
    }
    const max = Math.max(this.totalChunks - 1, 0);
    this.index = Math.min(Math.max(index, 0), max);
    this.deps.onIndexChange(this.index);
    if (wasActive) {
      void this.speakFrom(this.index);
    } else {
      this.setStatus("paused");
      void this.showCurrent();
    }
  }

  private setStatus(status: PlaybackStatus) {
    this.status = status;
    this.deps.onStatusChange(status);
  }

  private async getChunkCached(index: number): Promise<string | undefined> {
    const cached = this.cache.get(index);
    if (cached !== undefined) return cached;
    const text = await this.deps.getChunkText(index);
    if (text !== undefined) {
      this.cache.set(index, text);
      if (this.cache.size > CACHE_WINDOW) {
        const oldest = [...this.cache.keys()].sort((a, b) => a - b)[0];
        this.cache.delete(oldest);
      }
    }
    return text;
  }

  /** Fetches and reports the text for the current index without speaking (idle/paused display). */
  private async showCurrent() {
    const idx = this.index;
    const text = await this.getChunkCached(idx);
    if (this.index !== idx) return; // moved on meanwhile
    this.deps.onChunkText(text);
  }

  private async speakFrom(index: number, attempt = 0) {
    this.sequence += 1;
    const seq = this.sequence;

    this.setStatus("buffering");
    const text = await this.getChunkCached(index);
    if (seq !== this.sequence) return; // superseded by a cancel/pause/skip while awaiting

    if (text === undefined) {
      if (attempt >= MAX_BUFFER_RETRIES) {
        this.stop(); // genuinely nothing more to read
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, BUFFER_RETRY_MS));
      if (seq !== this.sequence) return;
      void this.speakFrom(index, attempt + 1);
      return;
    }

    // Only now that content is confirmed does this become "the current
    // chunk" — reporting it earlier could momentarily point past the known
    // end of the book while a buffering attempt is still in flight.
    this.index = index;
    this.deps.onIndexChange(index);
    this.deps.onChunkText(text);
    void this.getChunkCached(index + 1); // best-effort prefetch, doesn't block speaking

    const synth = getSynth();
    if (!synth) {
      this.setStatus("idle");
      return;
    }

    this.setStatus("playing");
    try {
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = this.rate;
      if (this.voice) utterance.voice = this.voice;

      const advance = () => {
        if (seq !== this.sequence) return;
        void this.speakFrom(index + 1);
      };
      utterance.onend = advance;
      utterance.onerror = advance;
      synth.speak(utterance);
    } catch {
      this.setStatus("idle");
    }
  }
}
