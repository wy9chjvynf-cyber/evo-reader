import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";
import { splitIntoChunks } from "./lib/chunk";
import { SpeechController, type PlaybackStatus } from "./lib/speechController";
import {
  DEFAULT_SETTINGS,
  loadBook,
  loadProgress,
  loadSettings,
  saveBook,
  saveProgress,
  saveSettings,
  type StoredBook,
} from "./lib/storage";
import { extractText, titleFromFilename } from "./lib/textExtract";
import { useVoices } from "./lib/useVoices";

const MIN_RATE = 0.75;
const MAX_RATE = 2;

export default function App() {
  const [book, setBook] = useState<StoredBook | null>(null);
  const [index, setIndex] = useState(0);
  const [status, setStatus] = useState<PlaybackStatus>("idle");
  const [rate, setRate] = useState(DEFAULT_SETTINGS.rate);
  const [voiceURI, setVoiceURI] = useState<string | null>(DEFAULT_SETTINGS.voiceURI);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  const voices = useVoices();
  const autoPickedVoice = useRef(false);
  const [ttsSupported] = useState(() => SpeechController.isSupported());
  const [controller] = useState(
    () =>
      new SpeechController({
        onIndexChange: (i) => {
          setIndex(i);
          void saveProgress({ index: i });
        },
        onStatusChange: (s) => setStatus(s),
      }),
  );

  // Restore book + progress + settings on first load.
  useEffect(() => {
    (async () => {
      const [storedBook, storedProgress, storedSettings] = await Promise.all([
        loadBook(),
        loadProgress(),
        loadSettings(),
      ]);
      if (storedSettings) {
        setRate(storedSettings.rate);
        setVoiceURI(storedSettings.voiceURI);
        if (storedSettings.voiceURI) autoPickedVoice.current = true;
      }
      if (storedBook) {
        setBook(storedBook);
        const startIndex = storedProgress?.index ?? 0;
        setIndex(startIndex);
        controller.setChunks(storedBook.chunks, startIndex);
      }
      setReady(true);
    })();
  }, [controller]);

  // Default to a Spanish voice once voices are available, unless the user already chose one.
  useEffect(() => {
    if (autoPickedVoice.current || voices.length === 0) return;
    const spanish = voices.find((v) => v.lang.toLowerCase().startsWith("es"));
    if (spanish) {
      autoPickedVoice.current = true;
      setVoiceURI(spanish.voiceURI);
    }
  }, [voices]);

  useEffect(() => {
    controller.setRate(rate);
  }, [controller, rate]);

  useEffect(() => {
    const voice = voices.find((v) => v.voiceURI === voiceURI) ?? null;
    controller.setVoice(voice);
  }, [controller, voiceURI, voices]);

  useEffect(() => {
    if (!ready) return;
    void saveSettings({ rate, voiceURI });
  }, [ready, rate, voiceURI]);

  const handleFileChange = useCallback(async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    setLoading(true);
    setError(null);
    try {
      const text = await extractText(file);
      const chunks = splitIntoChunks(text);
      if (chunks.length === 0) {
        throw new Error("No se pudo extraer texto de este archivo.");
      }
      const title = titleFromFilename(file.name);
      const newBook: StoredBook = { title, chunks };
      await saveBook(newBook);
      await saveProgress({ index: 0 });
      setBook(newBook);
      controller.setChunks(chunks, 0);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error al leer el archivo.");
    } finally {
      setLoading(false);
    }
  }, [controller]);

  if (!ready) {
    return (
      <div className="screen">
        <h1 className="logo">EvoReader</h1>
      </div>
    );
  }

  return (
    <div className="screen">
      <h1 className="logo">EvoReader</h1>

      {!book && (
        <div className="empty-state">
          <label className="load-button">
            {loading ? "Cargando…" : "Cargar libro"}
            <input
              type="file"
              accept=".pdf,.txt,.docx"
              onChange={handleFileChange}
              disabled={loading}
              hidden
            />
          </label>
          {error && <p className="error">{error}</p>}
        </div>
      )}

      {book && (
        <Reader
          book={book}
          index={index}
          status={status}
          rate={rate}
          voiceURI={voiceURI}
          voices={voices}
          loading={loading}
          error={error}
          onRateChange={setRate}
          onVoiceChange={setVoiceURI}
          onFileChange={handleFileChange}
          controller={controller}
          ttsSupported={ttsSupported}
        />
      )}
    </div>
  );
}

interface ReaderProps {
  book: StoredBook;
  index: number;
  status: PlaybackStatus;
  rate: number;
  voiceURI: string | null;
  voices: SpeechSynthesisVoice[];
  loading: boolean;
  error: string | null;
  onRateChange: (rate: number) => void;
  onVoiceChange: (voiceURI: string) => void;
  onFileChange: (e: ChangeEvent<HTMLInputElement>) => void;
  controller: SpeechController;
  ttsSupported: boolean;
}

function Reader({
  book,
  index,
  status,
  rate,
  voiceURI,
  voices,
  loading,
  error,
  onRateChange,
  onVoiceChange,
  onFileChange,
  controller,
  ttsSupported,
}: ReaderProps) {
  const total = book.chunks.length;
  const progress = total > 1 ? Math.round((index / (total - 1)) * 100) : 0;
  const currentText = book.chunks[index] ?? "";

  return (
    <div className="reader">
      <h2 className="title">{book.title}</h2>

      <div className="current-text">{currentText}</div>

      {!ttsSupported && (
        <p className="notice">Este navegador no soporta lectura en voz alta. Puedes seguir el texto igualmente.</p>
      )}

      <div className="transport">
        <button
          className="icon-button"
          aria-label="Retroceder"
          onClick={() => controller.skip(-1)}
          disabled={index <= 0}
        >
          ⏪
        </button>

        <button
          className="play-button"
          aria-label={status === "playing" ? "Pausar" : "Reproducir"}
          onClick={() => (status === "playing" ? controller.pause() : controller.play())}
          disabled={!ttsSupported}
        >
          {status === "playing" ? "⏸" : "▶"}
        </button>

        <button
          className="icon-button"
          aria-label="Adelantar"
          onClick={() => controller.skip(1)}
          disabled={index >= total - 1}
        >
          ⏩
        </button>
      </div>

      <button className="stop-link" onClick={() => controller.stop()}>
        ⏹ Detener
      </button>

      <div className="progress-row">
        <div className="progress-track">
          <div className="progress-fill" style={{ width: `${progress}%` }} />
        </div>
        <span className="progress-label">Progreso {progress}%</span>
      </div>

      <div className="settings">
        <label className="setting">
          <span>Velocidad {rate.toFixed(2)}x</span>
          <input
            type="range"
            min={MIN_RATE}
            max={MAX_RATE}
            step={0.05}
            value={rate}
            onChange={(e) => onRateChange(Number(e.target.value))}
          />
        </label>

        <label className="setting">
          <span>Voz</span>
          <select value={voiceURI ?? ""} onChange={(e) => onVoiceChange(e.target.value)}>
            {voiceURI === null && <option value="">Predeterminada</option>}
            {voices.map((v) => (
              <option key={v.voiceURI} value={v.voiceURI}>
                {v.name} ({v.lang})
              </option>
            ))}
          </select>
        </label>
      </div>

      {error && <p className="error">{error}</p>}

      <label className="load-button secondary">
        {loading ? "Cargando…" : "Cargar otro libro"}
        <input
          type="file"
          accept=".pdf,.txt,.docx"
          onChange={onFileChange}
          disabled={loading}
          hidden
        />
      </label>
    </div>
  );
}
