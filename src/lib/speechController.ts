export type PlaybackStatus = "idle" | "playing" | "paused";

interface SpeechControllerCallbacks {
  onIndexChange: (index: number) => void;
  onStatusChange: (status: PlaybackStatus) => void;
}

/**
 * Speaks a list of text chunks one at a time via window.speechSynthesis.
 *
 * Pause/resume is implemented as cancel + re-speak-from-index rather than the
 * native pause()/resume(), because native pause/resume is unreliable on
 * mobile Safari/Chrome (utterances can get silently stuck). The cost is that
 * resuming restarts the current sentence instead of the exact word, which is
 * an acceptable tradeoff for reliability.
 *
 * Each speak() call is tagged with a sequence number. Callbacks (onend,
 * onerror) check their own sequence against the controller's current one and
 * no-op if it has moved on — this is what lets us tell a genuine completion
 * apart from an event arriving for an utterance we already canceled.
 */
export class SpeechController {
  private chunks: string[] = [];
  private index = 0;
  private rate = 1;
  private voice: SpeechSynthesisVoice | null = null;
  private status: PlaybackStatus = "idle";
  private sequence = 0;
  private callbacks: SpeechControllerCallbacks;

  constructor(callbacks: SpeechControllerCallbacks) {
    this.callbacks = callbacks;
  }

  setChunks(chunks: string[], startIndex = 0) {
    this.stop();
    this.chunks = chunks;
    this.index = Math.min(Math.max(startIndex, 0), Math.max(chunks.length - 1, 0));
    this.setStatus("idle");
    this.callbacks.onIndexChange(this.index);
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
    if (this.chunks.length === 0) return;
    if (this.index >= this.chunks.length) this.index = 0;
    this.speakFrom(this.index);
  }

  pause() {
    if (this.status !== "playing") return;
    this.sequence += 1;
    window.speechSynthesis.cancel();
    this.setStatus("paused");
  }

  stop() {
    this.sequence += 1;
    window.speechSynthesis.cancel();
    this.index = 0;
    this.setStatus("idle");
    this.callbacks.onIndexChange(this.index);
  }

  skip(delta: number) {
    const wasPlaying = this.status === "playing";
    if (wasPlaying) {
      this.sequence += 1;
      window.speechSynthesis.cancel();
    }
    this.index = Math.min(Math.max(this.index + delta, 0), Math.max(this.chunks.length - 1, 0));
    this.callbacks.onIndexChange(this.index);
    if (wasPlaying) {
      this.speakFrom(this.index);
    } else {
      this.setStatus("paused");
    }
  }

  private setStatus(status: PlaybackStatus) {
    this.status = status;
    this.callbacks.onStatusChange(status);
  }

  private speakFrom(index: number) {
    if (index < 0 || index >= this.chunks.length) {
      this.setStatus("idle");
      return;
    }
    this.index = index;
    this.callbacks.onIndexChange(index);
    this.setStatus("playing");

    this.sequence += 1;
    const seq = this.sequence;

    const utterance = new SpeechSynthesisUtterance(this.chunks[index]);
    utterance.rate = this.rate;
    if (this.voice) utterance.voice = this.voice;

    const advance = () => {
      if (seq !== this.sequence) return; // superseded by a cancel/pause/skip
      const next = index + 1;
      if (next >= this.chunks.length) {
        this.stop();
      } else {
        this.speakFrom(next);
      }
    };

    utterance.onend = advance;
    utterance.onerror = advance;

    window.speechSynthesis.speak(utterance);
  }
}
