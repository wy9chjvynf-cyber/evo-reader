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
import { isEvoSpeechPluginAvailable, isNativeIosBridgeAvailable } from "./lib/nativeIosSpeechEngine";
import { SpeechController, type PlaybackStatus } from "./lib/speechController";
import type { SpeechVoice } from "./lib/speechEngine";
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

// Presentation-only cleanup of filename-derived titles (e.g. "Capitulo_2_La_normalidad_muriendo"
// -> "La normalidad muriendo"). Never touches the stored value.
function humanizeTitle(raw: string): string {
  const spaced = raw.replace(/[_-]+/g, " ").trim();
  const withoutPrefix = spaced.replace(/^(cap[ií]tulo|chapter|parte|part|secci[oó]n|section)\s+\d+\s*/i, "");
  return withoutPrefix.trim() || raw;
}

const VOICE_QUALITY_RANK: Record<string, number> = { premium: 0, enhanced: 1, default: 2 };

// Display-only: groups by language, then surfaces the best-quality voices
// first within each — never changes which voice.id is actually selected.
function sortVoicesForDisplay(list: SpeechVoice[]): SpeechVoice[] {
  return [...list].sort((a, b) => {
    if (a.lang !== b.lang) return a.lang.localeCompare(b.lang);
    const rankA = a.personal ? -1 : (VOICE_QUALITY_RANK[a.quality ?? "default"] ?? 2);
    const rankB = b.personal ? -1 : (VOICE_QUALITY_RANK[b.quality ?? "default"] ?? 2);
    if (rankA !== rankB) return rankA - rankB;
    return a.name.localeCompare(b.name);
  });
}

// Only appends a quality/personal badge when the engine actually reported it
// (NativeIosSpeechEngine) — Web Speech voices never get a fabricated label.
function voiceLabel(v: SpeechVoice): string {
  const base = `${v.name} (${v.lang})`;
  if (v.personal) return `${base} · Personal`;
  if (v.quality === "premium") return `${base} · Premium`;
  if (v.quality === "enhanced") return `${base} · Enhanced`;
  return base;
}

// Diagnostic-only: counts voices by quality as actually reported by the
// active engine — never inferred from name/identifier text.
function summarizeVoicesByQuality(voices: SpeechVoice[]) {
  const counts = { default: 0, enhanced: 0, premium: 0 };
  let personal = 0;
  for (const v of voices) {
    counts[v.quality ?? "default"] += 1;
    if (v.personal) personal += 1;
  }
  return { total: voices.length, ...counts, personal };
}

function IconSkipBack() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <path d="M6 6v12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M19 6 9 12l10 6V6Z" fill="currentColor" />
    </svg>
  );
}

function IconSkipForward() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <path d="M18 6v12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M5 6l10 6-10 6V6Z" fill="currentColor" />
    </svg>
  );
}

function IconPlay() {
  return (
    <svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor" aria-hidden="true">
      <path d="M8 5v14l11-7-11-7Z" />
    </svg>
  );
}

function IconPause() {
  return (
    <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor" aria-hidden="true">
      <rect x="6" y="5" width="4.5" height="14" rx="1.5" />
      <rect x="13.5" y="5" width="4.5" height="14" rx="1.5" />
    </svg>
  );
}

function IconStop() {
  return (
    <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" aria-hidden="true">
      <rect x="5" y="5" width="14" height="14" rx="2" />
    </svg>
  );
}

function IconChapters() {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">
      <path d="M4 6h16M4 12h16M4 18h10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function IconChevronRight() {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" fill="none" aria-hidden="true">
      <path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconChevronDown() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" aria-hidden="true">
      <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
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

  const { voices, refreshVoices } = useVoices();
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
      setVoiceURI(spanish.id);
    }
  }, [voices]);

  useEffect(() => {
    controller.setRate(rate);
  }, [controller, rate]);

  useEffect(() => {
    const voice = voices.find((v) => v.id === voiceURI) ?? null;
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
          onRefreshVoices={refreshVoices}
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
  voices: SpeechVoice[];
  onRefreshVoices: () => void;
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
  onRefreshVoices,
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

  const isNativeEngine = isNativeIosBridgeAvailable();
  const voiceQualitySummary = useMemo(() => summarizeVoicesByQuality(voices), [voices]);
  const spanishVoices = useMemo(
    () => (isNativeEngine ? voices.filter((v) => v.lang.toLowerCase().startsWith("es")) : []),
    [isNativeEngine, voices],
  );

  const chapterEyebrow = currentSection?.title ? "Capítulo actual" : "Índice";
  const chapterHeadline =
    currentSection?.title ?? (sections.length > 0 ? `${sections.length} secciones` : "Sin capítulos");

  return (
    <div className="reader">
      <header className="book-header">
        {coverUrl && <img className="cover-thumb" src={coverUrl} alt="" />}
        <div className="book-header-text">
          <h2 className="title">{humanizeTitle(book.title)}</h2>
          {book.author && <p className="author">{book.author}</p>}
          {currentSection?.title && <p className="chapter-line">{currentSection.title}</p>}
        </div>
      </header>

      <div className="header-progress-track" aria-hidden="true">
        <div className="header-progress-fill" style={{ width: `${bookProgress}%` }} />
      </div>

      <section className="reading-stage">
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

        <div className={`current-text${status === "playing" ? " is-playing" : ""}`}>
          {currentText || (importing ? "Preparando el texto…" : "")}
        </div>

        {status === "buffering" && <p className="notice">Cargando…</p>}

        {!ttsSupported && (
          <p className="notice">Este navegador no soporta lectura en voz alta. Puedes seguir el texto igualmente.</p>
        )}
      </section>

      <section className="player">
        <button type="button" className="player-chapters-trigger" onClick={onOpenChapters} disabled={sections.length === 0}>
          <span className="player-chapters-icon">
            <IconChapters />
          </span>
          <span className="player-chapters-text">
            <span className="player-chapters-eyebrow">{chapterEyebrow}</span>
            <span className="player-chapters-title">{chapterHeadline}</span>
          </span>
          <IconChevronRight />
        </button>

        <div className="player-progress">
          <div className="progress-track">
            <div className="progress-fill" style={{ width: `${sectionProgress ?? bookProgress}%` }} />
          </div>
          <div className="player-progress-meta">
            <span>{sectionProgress ?? bookProgress}% del capítulo</span>
            <span>
              Libro {bookProgress}%{remainingLabel ? ` · ${remainingLabel} restantes` : ""}
            </span>
          </div>
        </div>

        <div className="transport">
          <button className="transport-button" aria-label="Retroceder" onClick={() => controller.skip(-1)} disabled={index <= 0}>
            <IconSkipBack />
          </button>

          <button
            className="play-button"
            aria-label={status === "playing" ? "Pausar" : "Reproducir"}
            onClick={() => (status === "playing" || status === "buffering" ? controller.pause() : controller.play())}
            disabled={!ttsSupported || total === 0}
          >
            {status === "playing" || status === "buffering" ? <IconPause /> : <IconPlay />}
          </button>

          <button className="transport-button" aria-label="Adelantar" onClick={() => controller.skip(1)} disabled={index >= total - 1}>
            <IconSkipForward />
          </button>
        </div>

        <button className="stop-button" onClick={() => controller.stop()}>
          <IconStop />
          <span>Detener</span>
        </button>
      </section>

      <details className="more-panel">
        <summary>
          <span>Ajustes y opciones</span>
          <IconChevronDown />
        </summary>
        <div className="more-panel-body">
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
                {sortVoicesForDisplay(voices).map((v) => (
                  <option key={v.id} value={v.id}>
                    {voiceLabel(v)}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="voice-diagnostics">
            <div className="voice-diagnostics-header">
              <span className="voice-diagnostics-title">Diagnóstico de voz</span>
              <button type="button" className="text-link" onClick={onRefreshVoices}>
                Actualizar voces
              </button>
            </div>
            <dl className="diagnostics-list">
              <dt>Motor</dt>
              <dd>{isNativeEngine ? "Native iOS" : "Web"}</dd>
              <dt>EvoSpeech disponible</dt>
              <dd>{isEvoSpeechPluginAvailable() ? "sí" : "no"}</dd>
              <dt>Total de voces</dt>
              <dd>{voiceQualitySummary.total}</dd>
              <dt>Default</dt>
              <dd>{voiceQualitySummary.default}</dd>
              <dt>Enhanced</dt>
              <dd>{voiceQualitySummary.enhanced}</dd>
              <dt>Premium</dt>
              <dd>{voiceQualitySummary.premium}</dd>
              <dt>Personal</dt>
              <dd>{voiceQualitySummary.personal}</dd>
            </dl>

            {isNativeEngine && (
              <div className="voice-diagnostics-es">
                <p className="diagnostics-voice-title">Voces es-* ({spanishVoices.length})</p>
                {spanishVoices.map((v) => (
                  <div key={v.id} className="voice-diagnostics-item">
                    <p className="diagnostics-voice-line">{v.name}</p>
                    <p className="diagnostics-voice-line">{v.lang}</p>
                    <p className="diagnostics-voice-line">{v.quality ?? "default"}</p>
                    <p className="diagnostics-voice-line">{v.id}</p>
                    <p className="diagnostics-voice-line">personal: {v.personal ? "true" : "false"}</p>
                  </div>
                ))}
              </div>
            )}
          </div>

          {error && <p className="error">{error}</p>}

          <label className="load-button secondary">
            {busy ? "Cargando…" : "Cargar otro libro"}
            <input type="file" accept=".pdf,.epub,.txt,.md,.docx" onChange={onFileChange} disabled={busy || importing} hidden />
          </label>

          <button className="text-link" onClick={onOpenDiagnostics}>
            Diagnóstico
          </button>
        </div>
      </details>

      {showChapters && (
        <ChaptersPanel
          sections={sections}
          currentSection={currentSection}
          onClose={onCloseChapters}
          onSelect={onSelectSection}
          onAdjacent={onAdjacentSection}
        />
      )}

      {showDiagnostics && (
        <DiagnosticsPanel book={book} sections={sections} storageUsage={storageUsage} onClose={onCloseDiagnostics} />
      )}
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
