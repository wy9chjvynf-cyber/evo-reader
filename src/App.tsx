import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";
import { beginImport, beginResume, type ImportProgressInfo } from "./lib/bookImport";
import { getActiveBook, getChunk, getMeta, putMeta, updateBook, type BookRecord } from "./lib/db";
import { SpeechController, type PlaybackStatus } from "./lib/speechController";
import { useVoices } from "./lib/useVoices";

const MIN_RATE = 0.75;
const MAX_RATE = 2;

interface LastSettings {
  rate: number;
  voiceURI: string | null;
}

export default function App() {
  const [book, setBook] = useState<BookRecord | null>(null);
  const [currentText, setCurrentText] = useState("");
  const [index, setIndex] = useState(0);
  const [status, setStatus] = useState<PlaybackStatus>("idle");
  const [rate, setRate] = useState(1);
  const [voiceURI, setVoiceURI] = useState<string | null>(null);
  const [importProgress, setImportProgress] = useState<ImportProgressInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  const voices = useVoices();
  const autoPickedVoice = useRef(false);
  const bookIdRef = useRef<string | null>(null);
  const [ttsSupported] = useState(() => SpeechController.isSupported());
  const [controller] = useState(
    () =>
      new SpeechController({
        onIndexChange: (i) => {
          setIndex(i);
          if (bookIdRef.current) void updateBook(bookIdRef.current, { currentChunk: i });
        },
        onStatusChange: (s) => setStatus(s),
        onChunkText: (text) => setCurrentText(text ?? ""),
        getChunkText: async (i) => {
          if (!bookIdRef.current) return undefined;
          const chunk = await getChunk(bookIdRef.current, i);
          return chunk?.text;
        },
      }),
  );

  const applyBook = useCallback(
    (b: BookRecord) => {
      bookIdRef.current = b.id;
      setBook(b);
    },
    [],
  );

  // Restore (or resume importing) the active book, and last-used settings, on first load.
  useEffect(() => {
    (async () => {
      const [existingBook, lastSettings] = await Promise.all([getActiveBook(), getMeta<LastSettings>("lastSettings")]);

      if (existingBook) {
        applyBook(existingBook);
        setRate(existingBook.rate);
        setVoiceURI(existingBook.voiceURI);
        if (existingBook.voiceURI) autoPickedVoice.current = true;
        controller.setBook(existingBook.totalChunks, existingBook.currentChunk);

        if (existingBook.importStatus === "importing") {
          setImportProgress({
            page: existingBook.importedUntil,
            totalPages: existingBook.totalPages,
            chunksSoFar: existingBook.totalChunks,
            percent:
              existingBook.totalPages && existingBook.totalPages > 0
                ? Math.round((existingBook.importedUntil / existingBook.totalPages) * 100)
                : null,
          });
          beginResume(existingBook, {
            onProgress: (b, p) => {
              applyBook(b);
              controller.setTotalChunks(b.totalChunks);
              setImportProgress(p);
            },
            onDone: (b) => {
              applyBook(b);
              controller.setTotalChunks(b.totalChunks);
              setImportProgress(null);
            },
            onError: (message) => {
              setError(message);
              setImportProgress(null);
            },
          });
        }
      } else if (lastSettings) {
        setRate(lastSettings.rate);
        setVoiceURI(lastSettings.voiceURI);
        if (lastSettings.voiceURI) autoPickedVoice.current = true;
      }

      setReady(true);
    })();
  }, [applyBook, controller]);

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
    void putMeta("lastSettings", { rate, voiceURI });
    if (bookIdRef.current) void updateBook(bookIdRef.current, { rate, voiceURI });
  }, [ready, rate, voiceURI]);

  const handleFileChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = "";
      if (!file) return;

      setError(null);
      setBusy(true);
      setImportProgress({ page: 0, totalPages: null, chunksSoFar: 0, percent: null });

      beginImport(file, {
        onCreated: (b) => {
          applyBook(b);
          controller.setBook(0, 0);
          setBusy(false);
        },
        onProgress: (b, p) => {
          applyBook(b);
          controller.setTotalChunks(b.totalChunks);
          setImportProgress(p);
        },
        onDone: (b) => {
          applyBook(b);
          controller.setTotalChunks(b.totalChunks);
          setImportProgress(null);
        },
        onError: (message) => {
          setError(message);
          setBusy(false);
          setImportProgress(null);
        },
      });
    },
    [applyBook, controller],
  );

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
            {busy ? "Cargando…" : "Cargar libro"}
            <input type="file" accept=".pdf,.txt,.docx" onChange={handleFileChange} disabled={busy} hidden />
          </label>
          {error && <p className="error">{error}</p>}
        </div>
      )}

      {book && (
        <Reader
          book={book}
          index={index}
          currentText={currentText}
          status={status}
          rate={rate}
          voiceURI={voiceURI}
          voices={voices}
          importProgress={importProgress}
          busy={busy}
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
  book: BookRecord;
  index: number;
  currentText: string;
  status: PlaybackStatus;
  rate: number;
  voiceURI: string | null;
  voices: SpeechSynthesisVoice[];
  importProgress: ImportProgressInfo | null;
  busy: boolean;
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
  currentText,
  status,
  rate,
  voiceURI,
  voices,
  importProgress,
  busy,
  error,
  onRateChange,
  onVoiceChange,
  onFileChange,
  controller,
  ttsSupported,
}: ReaderProps) {
  const total = book.totalChunks;
  const progress = total > 1 ? Math.round((index / (total - 1)) * 100) : 0;
  const importing = book.importStatus === "importing";

  return (
    <div className="reader">
      <h2 className="title">{book.title}</h2>

      {importProgress && (
        <div className="import-progress">
          <p className="import-progress-label">
            Procesando libro…{" "}
            {importProgress.totalPages ? `Página ${importProgress.page} de ${importProgress.totalPages}` : ""}
            {importProgress.percent !== null ? ` · ${importProgress.percent}%` : ""}
          </p>
          <div className="progress-track">
            <div className="progress-fill" style={{ width: `${importProgress.percent ?? 0}%` }} />
          </div>
        </div>
      )}

      <div className="current-text">
        {currentText || (importing ? "Preparando el texto…" : "")}
      </div>

      {status === "buffering" && <p className="notice">Cargando…</p>}

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
          onClick={() => (status === "playing" || status === "buffering" ? controller.pause() : controller.play())}
          disabled={!ttsSupported || total === 0}
        >
          {status === "playing" || status === "buffering" ? "⏸" : "▶"}
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
        {busy ? "Cargando…" : "Cargar otro libro"}
        <input type="file" accept=".pdf,.txt,.docx" onChange={onFileChange} disabled={busy || importing} hidden />
      </label>
    </div>
  );
}
