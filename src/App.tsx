import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { beginImport, beginResume, type ImportProgressInfo } from "./lib/bookImport";
import {
  ensureBookSections,
  estimateStorageUsage,
  getActiveBook,
  getChunk,
  getCover,
  getMeta,
  getSections,
  putMeta,
  updateBook,
  type BookRecord,
  type ImportStage,
  type SectionRecord,
} from "./lib/db";
import { findSectionForChunk } from "./lib/sectionLookup";
import { estimateRemainingLabel } from "./lib/timeEstimate";
import { SpeechController, type PlaybackStatus } from "./lib/speechController";
import { useVoices } from "./lib/useVoices";

const MIN_RATE = 0.75;
const MAX_RATE = 2;

const STAGE_LABELS: Record<ImportStage, string> = {
  opening: "Abriendo archivo…",
  metadata: "Leyendo metadatos…",
  structure: "Detectando estructura…",
  extracting: "Extrayendo texto…",
  worker: "Preparando lector…",
  persisting: "Guardando…",
  done: "Listo",
};

interface LastSettings {
  rate: number;
  voiceURI: string | null;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

export default function App() {
  const [book, setBook] = useState<BookRecord | null>(null);
  const [sections, setSections] = useState<SectionRecord[]>([]);
  const [coverUrl, setCoverUrl] = useState<string | null>(null);
  const [currentText, setCurrentText] = useState("");
  const [index, setIndex] = useState(0);
  const [status, setStatus] = useState<PlaybackStatus>("idle");
  const [rate, setRate] = useState(1);
  const [voiceURI, setVoiceURI] = useState<string | null>(null);
  const [importProgress, setImportProgress] = useState<ImportProgressInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [showChapters, setShowChapters] = useState(false);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [storageUsage, setStorageUsage] = useState<{ usage: number; quota: number } | undefined>(undefined);

  const voices = useVoices();
  const autoPickedVoice = useRef(false);
  const bookIdRef = useRef<string | null>(null);
  const currentSectionIndexRef = useRef<number | null>(null);
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

  const applyBook = useCallback((b: BookRecord) => {
    bookIdRef.current = b.id;
    setBook(b);
  }, []);

  // Restore (or resume importing) the active book, and last-used settings, on first load.
  useEffect(() => {
    (async () => {
      const [existingBook, lastSettings] = await Promise.all([getActiveBook(), getMeta<LastSettings>("lastSettings")]);

      if (existingBook) {
        await ensureBookSections(existingBook.id); // backfill for Phase 1 books, no-op otherwise
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
            percent: existingBook.importProgress,
            playable: existingBook.totalChunks > 0,
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

  // Sections list — refreshed when the known section count changes or import finishes.
  useEffect(() => {
    if (!book) return;
    void getSections(book.id).then(setSections);
  }, [book?.id, book?.totalSections, book?.importStatus]);

  // Cover thumbnail.
  useEffect(() => {
    if (!book?.hasCover) {
      setCoverUrl(null);
      return;
    }
    let cancelled = false;
    let objectUrl: string | null = null;
    void getCover(book.id).then((record) => {
      if (cancelled || !record) return;
      objectUrl = URL.createObjectURL(record.blob);
      setCoverUrl(objectUrl);
    });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [book?.id, book?.hasCover]);

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

  const currentSection = useMemo(() => findSectionForChunk(sections, index), [sections, index]);

  // Persist currentSection only when it actually changes (not on every chunk).
  useEffect(() => {
    if (!currentSection || !bookIdRef.current) return;
    if (currentSectionIndexRef.current === currentSection.index) return;
    currentSectionIndexRef.current = currentSection.index;
    void updateBook(bookIdRef.current, { currentSection: currentSection.index });
  }, [currentSection]);

  const goToSection = useCallback(
    (section: SectionRecord) => {
      if (section.firstChunkIndex === null || section.firstChunkIndex === undefined) return;
      controller.goToChunk(section.firstChunkIndex);
      setShowChapters(false);
    },
    [controller],
  );

  const goToAdjacentSection = useCallback(
    (delta: 1 | -1) => {
      if (!currentSection) return;
      const pos = sections.findIndex((s) => s.index === currentSection.index);
      const target = sections[pos + delta];
      if (target) goToSection(target);
    },
    [currentSection, sections, goToSection],
  );

  const openDiagnostics = useCallback(() => {
    void estimateStorageUsage().then(setStorageUsage);
    setShowDiagnostics(true);
  }, []);

  const handleFileChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = "";
      if (!file) return;

      setError(null);
      setBusy(true);
      setImportProgress({ page: 0, totalPages: null, chunksSoFar: 0, percent: null, playable: false });
      setSections([]);
      setCoverUrl(null);

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
            <input type="file" accept=".pdf,.epub,.txt,.md,.docx" onChange={handleFileChange} disabled={busy} hidden />
          </label>
          {error && <p className="error">{error}</p>}
        </div>
      )}

      {book && (
        <Reader
          book={book}
          sections={sections}
          currentSection={currentSection}
          coverUrl={coverUrl}
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
          showChapters={showChapters}
          onOpenChapters={() => setShowChapters(true)}
          onCloseChapters={() => setShowChapters(false)}
          onSelectSection={goToSection}
          onAdjacentSection={goToAdjacentSection}
          showDiagnostics={showDiagnostics}
          onOpenDiagnostics={openDiagnostics}
          onCloseDiagnostics={() => setShowDiagnostics(false)}
          storageUsage={storageUsage}
        />
      )}
    </div>
  );
}

interface ReaderProps {
  book: BookRecord;
  sections: SectionRecord[];
  currentSection: SectionRecord | undefined;
  coverUrl: string | null;
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
  showChapters: boolean;
  onOpenChapters: () => void;
  onCloseChapters: () => void;
  onSelectSection: (section: SectionRecord) => void;
  onAdjacentSection: (delta: 1 | -1) => void;
  showDiagnostics: boolean;
  onOpenDiagnostics: () => void;
  onCloseDiagnostics: () => void;
  storageUsage: { usage: number; quota: number } | undefined;
}

function Reader({
  book,
  sections,
  currentSection,
  coverUrl,
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
  showChapters,
  onOpenChapters,
  onCloseChapters,
  onSelectSection,
  onAdjacentSection,
  showDiagnostics,
  onOpenDiagnostics,
  onCloseDiagnostics,
  storageUsage,
}: ReaderProps) {
  const total = book.totalChunks;
  const bookProgress = total > 1 ? Math.round((index / (total - 1)) * 100) : 0;
  const importing = book.importStatus === "importing";

  const sectionProgress = useMemo(() => {
    if (!currentSection || currentSection.firstChunkIndex === null || currentSection.lastChunkIndex === null) return null;
    const span = Math.max(currentSection.lastChunkIndex - currentSection.firstChunkIndex, 1);
    return Math.round(((index - currentSection.firstChunkIndex) / span) * 100);
  }, [currentSection, index]);

  const remainingLabel = useMemo(
    () => estimateRemainingLabel(book.wordCount, book.totalChunks, index, rate),
    [book.wordCount, book.totalChunks, index, rate],
  );

  return (
    <div className="reader">
      <div className="book-header">
        {coverUrl && <img className="cover-thumb" src={coverUrl} alt="" />}
        <div className="book-header-text">
          <h2 className="title">{book.title}</h2>
          {book.author && <p className="author">{book.author}</p>}
          {currentSection?.title && <p className="chapter-label">{currentSection.title}</p>}
        </div>
      </div>

      {importProgress && (
        <div className="import-progress">
          <p className="import-progress-label">
            Procesando {book.title}… {STAGE_LABELS[book.importStage]}
            {importProgress.totalPages ? ` · ${book.format === "pdf" ? "Página" : "Sección"} ${importProgress.page} de ${importProgress.totalPages}` : ""}
            {importProgress.percent !== null ? ` · ${importProgress.percent}%` : ""}
          </p>
          <div className="progress-track">
            <div className="progress-fill" style={{ width: `${importProgress.percent ?? 0}%` }} />
          </div>
          {importProgress.playable && <p className="notice">Ya puedes comenzar a escuchar mientras terminamos de procesarlo.</p>}
        </div>
      )}

      <div className="current-text">{currentText || (importing ? "Preparando el texto…" : "")}</div>

      {status === "buffering" && <p className="notice">Cargando…</p>}

      {!ttsSupported && (
        <p className="notice">Este navegador no soporta lectura en voz alta. Puedes seguir el texto igualmente.</p>
      )}

      <div className="transport">
        <button className="icon-button" aria-label="Retroceder" onClick={() => controller.skip(-1)} disabled={index <= 0}>
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

        <button className="icon-button" aria-label="Adelantar" onClick={() => controller.skip(1)} disabled={index >= total - 1}>
          ⏩
        </button>
      </div>

      <button className="stop-link" onClick={() => controller.stop()}>
        ⏹ Detener
      </button>

      <button className="chapters-button" onClick={onOpenChapters} disabled={sections.length === 0}>
        📖 Capítulos {sections.length > 0 ? `(${sections.length})` : ""}
      </button>

      <div className="progress-row">
        <div className="progress-track">
          <div className="progress-fill" style={{ width: `${bookProgress}%` }} />
        </div>
        <span className="progress-label">
          {currentSection?.title ? `${sectionProgress ?? bookProgress}% del capítulo · ` : ""}
          Libro {bookProgress}%
          {remainingLabel ? ` · Quedan ${remainingLabel}` : ""}
        </span>
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
        <input type="file" accept=".pdf,.epub,.txt,.md,.docx" onChange={onFileChange} disabled={busy || importing} hidden />
      </label>

      <button className="text-link" onClick={onOpenDiagnostics}>
        Diagnóstico
      </button>

      {showChapters && (
        <ChaptersPanel
          sections={sections}
          currentSection={currentSection}
          onClose={onCloseChapters}
          onSelect={onSelectSection}
          onAdjacent={onAdjacentSection}
        />
      )}

      {showDiagnostics && <DiagnosticsPanel book={book} sections={sections} storageUsage={storageUsage} onClose={onCloseDiagnostics} />}
    </div>
  );
}

interface ChaptersPanelProps {
  sections: SectionRecord[];
  currentSection: SectionRecord | undefined;
  onClose: () => void;
  onSelect: (section: SectionRecord) => void;
  onAdjacent: (delta: 1 | -1) => void;
}

function ChaptersPanel({ sections, currentSection, onClose, onSelect, onAdjacent }: ChaptersPanelProps) {
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-header">
          <h3>Capítulos</h3>
          <div className="sheet-header-actions">
            <button className="icon-button small" aria-label="Capítulo anterior" onClick={() => onAdjacent(-1)}>
              ⏮
            </button>
            <button className="icon-button small" aria-label="Capítulo siguiente" onClick={() => onAdjacent(1)}>
              ⏭
            </button>
            <button className="icon-button small" aria-label="Cerrar" onClick={onClose}>
              ✕
            </button>
          </div>
        </div>
        <div className="sheet-list">
          {sections.map((s) => {
            const isCurrent = currentSection?.index === s.index;
            const isRead = !isCurrent && currentSection !== undefined && s.index < currentSection.index;
            return (
              <button key={s.index} className={`sheet-item${isCurrent ? " current" : ""}`} onClick={() => onSelect(s)}>
                <span className="sheet-item-marker">{isCurrent ? "▶" : isRead ? "✓" : ""}</span>
                <span className="sheet-item-title">{s.title ?? "Libro completo"}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

interface DiagnosticsPanelProps {
  book: BookRecord;
  sections: SectionRecord[];
  storageUsage: { usage: number; quota: number } | undefined;
  onClose: () => void;
}

function DiagnosticsPanel({ book, sections, storageUsage, onClose }: DiagnosticsPanelProps) {
  const progress = book.totalChunks > 1 ? Math.round((book.currentChunk / (book.totalChunks - 1)) * 100) : 0;
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-header">
          <h3>Diagnóstico del libro</h3>
          <button className="icon-button small" aria-label="Cerrar" onClick={onClose}>
            ✕
          </button>
        </div>
        <dl className="diagnostics-list">
          <dt>Formato</dt>
          <dd>{book.format.toUpperCase()}</dd>
          <dt>Tamaño</dt>
          <dd>{formatBytes(book.size)}</dd>
          {book.format === "pdf" && (
            <>
              <dt>Páginas</dt>
              <dd>{book.totalPages ?? "—"}</dd>
            </>
          )}
          <dt>Secciones</dt>
          <dd>{sections.length}</dd>
          <dt>Chunks</dt>
          <dd>{book.totalChunks.toLocaleString("es")}</dd>
          <dt>Importación</dt>
          <dd>{book.importStatus === "done" ? "completa" : book.importStatus === "importing" ? "en curso" : "error"}</dd>
          <dt>Texto</dt>
          <dd>{book.wordCount.toLocaleString("es")} palabras</dd>
          <dt>Progreso</dt>
          <dd>{progress}%</dd>
          {storageUsage && (
            <>
              <dt>Almacenamiento</dt>
              <dd>
                ~{formatBytes(storageUsage.usage)} de {formatBytes(storageUsage.quota)}
              </dd>
            </>
          )}
        </dl>
      </div>
    </div>
  );
}
