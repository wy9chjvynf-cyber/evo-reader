import { useCallback, useEffect, useState } from "react";
import { createSpeechEngine, type SpeechVoice } from "./speechEngine";

export interface UseVoicesResult {
  voices: SpeechVoice[];
  /** Forces a fresh voice query (engines that don't need this, like
   *  WebSpeechEngine, simply re-read their already-current list). */
  refreshVoices: () => void;
}

export function useVoices(): UseVoicesResult {
  const [engine] = useState(() => createSpeechEngine());
  const [voices, setVoices] = useState<SpeechVoice[]>(() => engine.getVoices());

  useEffect(() => {
    const update = () => setVoices(engine.getVoices());
    update(); // voices may load asynchronously after mount, but some browsers already have them
    return engine.onVoicesChanged(update);
  }, [engine]);

  const refreshVoices = useCallback(() => {
    engine.refreshVoices?.();
    setVoices(engine.getVoices());
  }, [engine]);

  return { voices, refreshVoices };
}
