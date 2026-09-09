import { useEffect, useState } from "react";
import { createSpeechEngine, type SpeechVoice } from "./speechEngine";

export function useVoices(): SpeechVoice[] {
  const [engine] = useState(() => createSpeechEngine());
  const [voices, setVoices] = useState<SpeechVoice[]>(() => engine.getVoices());

  useEffect(() => {
    const update = () => setVoices(engine.getVoices());
    update(); // voices may load asynchronously after mount, but some browsers already have them
    return engine.onVoicesChanged(update);
  }, [engine]);

  return voices;
}
