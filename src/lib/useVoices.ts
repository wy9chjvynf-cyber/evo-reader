import { useEffect, useState } from "react";

function getVoicesSafely(): SpeechSynthesisVoice[] {
  try {
    return window.speechSynthesis?.getVoices() ?? [];
  } catch {
    return [];
  }
}

export function useVoices(): SpeechSynthesisVoice[] {
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>(getVoicesSafely);

  useEffect(() => {
    const synth = window.speechSynthesis;
    if (!synth) return;

    const update = () => setVoices(getVoicesSafely());
    update();

    // Some WebKit/iOS builds don't implement addEventListener on
    // SpeechSynthesis; fall back to the onvoiceschanged property instead of
    // letting the call throw.
    if (typeof synth.addEventListener === "function") {
      synth.addEventListener("voiceschanged", update);
      return () => synth.removeEventListener("voiceschanged", update);
    }
    if ("onvoiceschanged" in synth) {
      synth.onvoiceschanged = update;
      return () => {
        if (synth.onvoiceschanged === update) synth.onvoiceschanged = null;
      };
    }
  }, []);

  return voices;
}
