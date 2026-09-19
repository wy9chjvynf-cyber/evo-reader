import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { cancelImport, runImport, runResume, type ImportProgressInfo } from "./lib/bookImport";
import { cleanupImportOrphans, ensureBookSections, estimateStorageUsage, getActiveBook, getAllBooks, getBook, getChunk, getCover, getMeta, getSections, putMeta, updateBook, type BookRecord, type ImportStage, type SectionRecord, } from "./lib/db";
import { findSectionForChunk } from "./lib/sectionLookup";
import { isEvoSpeechPluginAvailable, isNativeIosBridgeAvailable } from "./lib/nativeIosSpeechEngine";
import { SpeechController, type PlaybackStatus } from "./lib/speechController";
import type { SpeechVoice } from "./lib/speechEngine";
import { useVoices } from "./lib/useVoices";
import { AppShell } from './components/AppShell';
import { Library } from './components/Library';
import { EvoPlayer } from './components/EvoPlayer';
import { Sheet, type View, type ReaderTheme } from './components/DesignSystem';
import { DEFAULT_UI, normalizeUI, readUICheckpoint, writeUICheckpoint, type UIPreferences } from './lib/uiPreferences';
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
    if (bytes < 1024)
        return `${bytes} B`;
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
        if (a.lang !== b.lang)
            return a.lang.localeCompare(b.lang);
        const rankA = a.personal ? -1 : (VOICE_QUALITY_RANK[a.quality ?? "default"] ?? 2);
        const rankB = b.personal ? -1 : (VOICE_QUALITY_RANK[b.quality ?? "default"] ?? 2);
        if (rankA !== rankB)
            return rankA - rankB;
        return a.name.localeCompare(b.name);
    });
}
// Only appends a quality/personal badge when the engine actually reported it
// (NativeIosSpeechEngine) — Web Speech voices never get a fabricated label.
function voiceLabel(v: SpeechVoice): string {
    const base = `${v.name} (${v.lang})`;
    if (v.personal)
        return `${base} · Personal`;
    if (v.quality === "premium")
        return `${base} · Premium`;
    if (v.quality === "enhanced")
        return `${base} · Enhanced`;
    return base;
}
// Diagnostic-only: counts voices by quality as actually reported by the
// active engine — never inferred from name/identifier text.
function summarizeVoicesByQuality(voices: SpeechVoice[]) {
    const counts = { default: 0, enhanced: 0, premium: 0 };
    let personal = 0;
    for (const v of voices) {
        counts[v.quality ?? "default"] += 1;
        if (v.personal)
            personal += 1;
    }
    return { total: voices.length, ...counts, personal };
}
export default function App() {
    const [ui, setUI] = useState<UIPreferences>(() => readUICheckpoint() ?? DEFAULT_UI);
    const [books, setBooks] = useState<BookRecord[]>([]);
    const switching = useRef(false);
    const fileInput = useRef<HTMLInputElement>(null);
    const restoreStarted = useRef(false);
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
    const [storageUsage, setStorageUsage] = useState<{
        usage: number;
        quota: number;
    } | undefined>(undefined);
    const { voices, refreshVoices } = useVoices();
    const autoPickedVoice = useRef(false);
    const bookIdRef = useRef<string | null>(null);
    const currentSectionIndexRef = useRef<number | null>(null);
    const [ttsSupported] = useState(() => SpeechController.isSupported());
    const [controller] = useState(() => new SpeechController({
        onIndexChange: (i) => {
            setIndex(i);
            if (bookIdRef.current)
                void updateBook(bookIdRef.current, { currentChunk: i });
        },
        onStatusChange: (s) => setStatus(s),
        onChunkText: (text) => setCurrentText(text ?? ""),
        getChunkText: async (i) => {
            if (!bookIdRef.current)
                return undefined;
            const chunk = await getChunk(bookIdRef.current, i);
            return chunk?.text;
        },
    }));
    const applyBook = useCallback((b: BookRecord) => {
        bookIdRef.current = b.id;
        setBook(b);
        setBooks(previous => [...previous.filter(item => item.id !== b.id), b]);
    }, []);
    // Restore (or resume importing) the active book, and last-used settings, on first load.
    useEffect(() => {
        if (restoreStarted.current)
            return;
        restoreStarted.current = true;
        (async () => {
            await cleanupImportOrphans().catch(() => {});
            const storedUI = await getMeta('ui.v3');
            setUI(readUICheckpoint() ?? normalizeUI(storedUI));
            const [existingBook, lastSettings] = await Promise.all([getActiveBook(), getMeta<LastSettings>("lastSettings")]);
            setBooks(await getAllBooks());
            if (existingBook) {
                await ensureBookSections(existingBook.id); // backfill for Phase 1 books, no-op otherwise
                applyBook(existingBook);
                setRate(existingBook.rate);
                setVoiceURI(existingBook.voiceURI);
                if (existingBook.voiceURI)
                    autoPickedVoice.current = true;
                controller.setBook(existingBook.totalChunks, existingBook.currentChunk);
                if (existingBook.importStatus === "importing") {
                    setImportProgress({
                        page: existingBook.importedUntil,
                        totalPages: existingBook.totalPages,
                        chunksSoFar: existingBook.totalChunks,
                        percent: existingBook.importProgress,
                        playable: existingBook.totalChunks > 0,
                    });
                    void runResume(existingBook, {
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
                            setBook(previous => previous ? { ...previous, importStatus: 'error' } : previous);
                void getAllBooks().then(setBooks);
                        },
                    }).catch(() => { });
                }
            }
            else if (lastSettings) {
                setRate(lastSettings.rate);
                setVoiceURI(lastSettings.voiceURI);
                if (lastSettings.voiceURI)
                    autoPickedVoice.current = true;
            }
            setReady(true);
        })();
    }, [applyBook, controller]);
    useEffect(() => {
        if (ready) {
            writeUICheckpoint(ui);
            void putMeta('ui.v3', ui);
        }
    }, [ready, ui]);
    const navigate = (view: View) => setUI(p => ({ ...p, view }));
    // Sections list — refreshed when the known section count changes or import finishes.
    useEffect(() => {
        if (!book)
            return;
        let cancelled = false;
        void getSections(book.id).then(result => { if (!cancelled)
            setSections(result); });
        return () => { cancelled = true; };
    }, [book?.id, book?.totalSections, book?.importStatus]);
    // Cover thumbnail.
    useEffect(() => {
        if (!book?.hasCover) {
            setCoverUrl(null);
            return;
        }
        setCoverUrl(null);
        let cancelled = false;
        let objectUrl: string | null = null;
        void getCover(book.id).then((record) => {
            if (cancelled || !record)
                return;
            objectUrl = URL.createObjectURL(record.blob);
            setCoverUrl(objectUrl);
        });
        return () => {
            cancelled = true;
            if (objectUrl)
                URL.revokeObjectURL(objectUrl);
        };
    }, [book?.id, book?.hasCover]);
    // Default to a Spanish voice once voices are available, unless the user already chose one.
    useEffect(() => {
        if (autoPickedVoice.current || voices.length === 0)
            return;
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
        if (!ready)
            return;
        void putMeta("lastSettings", { rate, voiceURI });
        if (bookIdRef.current)
            void updateBook(bookIdRef.current, { rate, voiceURI });
    }, [ready, rate, voiceURI]);
    const currentSection = useMemo(() => findSectionForChunk(sections, index), [sections, index]);
    // Persist currentSection only when it actually changes (not on every chunk).
    useEffect(() => {
        if (!currentSection || !bookIdRef.current)
            return;
        if (currentSectionIndexRef.current === currentSection.index)
            return;
        currentSectionIndexRef.current = currentSection.index;
        void updateBook(bookIdRef.current, { currentSection: currentSection.index });
    }, [currentSection]);
    const goToSection = useCallback((section: SectionRecord) => {
        if (section.firstChunkIndex === null || section.firstChunkIndex === undefined)
            return;
        controller.goToChunk(section.firstChunkIndex);
        setShowChapters(false);
    }, [controller]);
    const goToAdjacentSection = useCallback((delta: 1 | -1) => {
        if (!currentSection)
            return;
        const pos = sections.findIndex((s) => s.index === currentSection.index);
        const target = sections[pos + delta];
        if (target)
            goToSection(target);
    }, [currentSection, sections, goToSection]);
    const openDiagnostics = useCallback(() => {
        void estimateStorageUsage().then(setStorageUsage);
        setShowDiagnostics(true);
    }, []);
    const importFile = useCallback((file: File) => {
        controller.pause();
        currentSectionIndexRef.current = null;
        setCurrentText("");
        setError(null);
        setBusy(true);
        setImportProgress({ page: 0, totalPages: null, chunksSoFar: 0, percent: null, playable: false });
        setSections([]);
        setCoverUrl(null);
        void runImport(file, {
            onCreated: (b) => {
                applyBook(b);
                void putMeta("activeBookId", b.id);
                controller.setBook(b.totalChunks, b.currentChunk);
                setBusy(false);
                setUI(p => ({ ...p, view: 'reader' }));
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
                setBook(previous => previous ? { ...previous, importStatus: 'error' } : previous);
                void getAllBooks().then(setBooks);
            },
        }).catch(err => { setBusy(false); setImportProgress(null); setError(previous => previous ?? (err instanceof Error ? err.message : 'No se pudo importar el libro.')); });
    }, [applyBook, controller]);
    const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        e.target.value = '';
        if (!file || busy || book?.importStatus === 'importing')
            return;
        if (!/\.(pdf|epub|docx|txt|md|markdown)$/i.test(file.name)) {
            setError('Formato no soportado. Usa PDF, EPUB, DOCX, TXT o Markdown.');
            return;
        }
        importFile(file);
    };
    const retryImport = () => {
        if (!book || busy) return;
        setBusy(true); setError(null);
        void runResume(book, {
            onProgress: (b, p) => { applyBook(b); controller.setTotalChunks(b.totalChunks); setImportProgress(p); },
            onDone: b => { applyBook(b); controller.setTotalChunks(b.totalChunks); setImportProgress(null); },
            onError: message => { setError(message); setImportProgress(null); },
        }).catch(e => setError(e.message)).finally(() => {
            setBusy(false);
            void getBook(book.id).then(b => { if (b) applyBook(b); });
        });
    };
    const importBusy = busy || book?.importStatus === 'importing';
    const selectBook = async (id: string) => {
        if (importBusy || switching.current) return;
        switching.current = true;
        controller.pause();
        try {
            const selected = await getBook(id);
            if (!selected) { setError('No se pudo abrir el libro.'); return; }
            await ensureBookSections(id);
            await putMeta('activeBookId', id);
            const opened = await updateBook(id, {lastOpenedAt: Date.now()});
            setSections([]); setCurrentText(''); setCoverUrl(null);
            currentSectionIndexRef.current = null;
            applyBook(opened ?? selected);
            setRate(selected.rate); setVoiceURI(selected.voiceURI);
            controller.setRate(selected.rate);
            controller.setVoice(voices.find(v => v.id === selected.voiceURI) ?? null);
            controller.setBook(selected.totalChunks, selected.currentChunk);
            setError(selected.errorMessage ?? null);
            setUI(p => ({...p, view: 'reader'}));
        } finally { switching.current = false; }
    };
    const editBook = async (id: string, patch: Partial<BookRecord>) => {
        const updated = await updateBook(id, patch);
        if (!updated) { setError('No se pudo guardar el cambio.'); return; }
        setBooks(previous => previous.map(b => b.id === id ? updated : b));
    };
    return (<AppShell view={ui.view} onNavigate={navigate} hasBook={!!book}>
      <input ref={fileInput} className="sr-only" tabIndex={-1} aria-label="Archivo del libro" type="file" accept=".pdf,.epub,.txt,.md,.markdown,.docx" onChange={handleFileChange} disabled={importBusy || !ready}/>
      {!ready && <p role="status">Recuperando tu lectura…</p>}
      {error && <p className="error global-notice" role="alert">{error}</p>}
      {ui.view === 'library' && <Library books={books} onSelect={selectBook} onEdit={editBook} book={book} index={index} coverUrl={coverUrl} chapter={currentSection?.title} onRead={() => navigate('reader')} onListen={() => { navigate('reader'); controller.play(); }} onImport={() => fileInput.current?.click()} busy={importBusy || !ready}/>}
      {ui.view === 'activity' && <section className="page-panel"><p className="eyebrow">TU ESPACIO PERSONAL</p><h1>Tu lectura.</h1><p>Cada página cuenta. Disfruta el camino.</p><div className="reading-stats"><div><strong>{books.length}</strong><span>Libros disponibles</span></div><div><strong>{book ? Math.round(index / Math.max(book.totalChunks - 1, 1) * 100) : 0}%</strong><span>Avance actual</span></div><div><strong>{book?.totalSections ?? 0}</strong><span>Secciones del libro</span></div></div><div className="quiet-card"><h2>Tu tiempo, sin prisa.</h2><p>La lectura y la escucha comparten tu posición guardada. El historial de horas llegará con las sesiones de lectura.</p>{book && <button className="primary-button" onClick={() => navigate('reader')}>Volver a mi libro →</button>}</div></section>}
      {ui.view === 'settings' && <section className="page-panel"><p className="eyebrow">A TU MANERA</p><h1>Ajustes.</h1><p>Un espacio cómodo para quedarte un capítulo más.</p><div className="quiet-card"><h2>Apariencia del lector</h2><div className="theme-picker">{(['paper', 'sepia', 'dark', 'oled'] as ReaderTheme[]).map((theme, i) => <button key={theme} data-theme={theme} aria-pressed={ui.theme === theme} onClick={() => setUI(p => ({ ...p, theme }))}>{['Blanco', 'Marfil', 'Oscuro', 'OLED'][i]}</button>)}</div><label className="setting">Tamaño del texto · {ui.fontSize}px<input type="range" min="18" max="32" value={ui.fontSize} onChange={e => setUI(p => ({ ...p, fontSize: Number(e.target.value) }))}/></label></div><div className="quiet-card"><h2>Tu biblioteca es privada</h2><p>Los archivos y tu posición se guardan en este dispositivo. Sin cuentas, suscripciones ni servicios de pago añadidos.</p><p className="fine-print">Conserva tus archivos originales: el sistema puede liberar datos del navegador si falta espacio.</p></div></section>}
      {ui.view === 'reader' && !book && <section className="page-panel"><h1>Abre tu próxima historia.</h1><p>Tu lector estará aquí cuando importes un libro.</p><button className="primary-button" onClick={() => fileInput.current?.click()} disabled={!ready || importBusy}>Importar libro</button></section>}

      {book?.format === 'pdf' && (importBusy || book.importStatus === 'error') && <div className="import-progress">
        {importBusy ? <button className="button secondary" onClick={cancelImport}>Cancelar importación</button> : <button className="button secondary" onClick={retryImport}>Reintentar importación</button>}
      </div>}
      {!!book?.emptyPages && <p className="notice">{book.emptyPages} páginas sin texto extraíble. El OCR no está incluido.</p>}
      {!!book?.damagedPages && <p role="alert">{book.damagedPages} páginas dañadas omitidas; el contenido está incompleto.</p>}
      {book && (<Reader view={ui.view} theme={ui.theme} fontSize={ui.fontSize} book={book} sections={sections} currentSection={currentSection} coverUrl={coverUrl} index={index} currentText={currentText} status={status} rate={rate} voiceURI={voiceURI} voices={voices} onRefreshVoices={refreshVoices} importProgress={importProgress} busy={busy} error={error} onRateChange={setRate} onVoiceChange={setVoiceURI} onFileChange={handleFileChange} controller={controller} ttsSupported={ttsSupported} showChapters={showChapters} onOpenChapters={() => setShowChapters(true)} onCloseChapters={() => setShowChapters(false)} onSelectSection={goToSection} onAdjacentSection={goToAdjacentSection} showDiagnostics={showDiagnostics} onOpenDiagnostics={openDiagnostics} onCloseDiagnostics={() => setShowDiagnostics(false)} storageUsage={storageUsage}/>)}
    </AppShell>);
}
interface ReaderProps {
    view: View;
    theme: ReaderTheme;
    fontSize: number;
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
    storageUsage: {
        usage: number;
        quota: number;
    } | undefined;
}
function Reader({ view, theme, fontSize, book, sections, currentSection, coverUrl, index, currentText, status, rate, voiceURI, voices, onRefreshVoices, importProgress, busy, error, onRateChange, onVoiceChange, onFileChange, controller, ttsSupported, showChapters, onOpenChapters, onCloseChapters, onSelectSection, onAdjacentSection, showDiagnostics, onOpenDiagnostics, onCloseDiagnostics, storageUsage, }: ReaderProps) {
    const [focused, setFocused] = useState(false);
    const total = book.totalChunks;
    const bookProgress = total > 1 ? Math.round((index / (total - 1)) * 100) : 0;
    const importing = book.importStatus === "importing";
    const isNativeEngine = isNativeIosBridgeAvailable();
    const voiceQualitySummary = useMemo(() => summarizeVoicesByQuality(voices), [voices]);
    const spanishVoices = useMemo(() => (isNativeEngine ? voices.filter((v) => v.lang.toLowerCase().startsWith("es")) : []), [isNativeEngine, voices]);
    return (<div className={`reader ${focused ? 'focus-mode' : ''}`}>
      {view === 'reader' && <div className="reader-canvas" data-theme={theme} style={{ '--reader-size': `${fontSize}px` } as import('react').CSSProperties}>
      <div className="reader-tools"><button className="subtle-button" onClick={onOpenChapters}>☰ Capítulos</button><button className="subtle-button" aria-pressed={focused} onClick={() => setFocused(!focused)}>{focused ? 'Mostrar controles' : 'Modo enfoque'}</button></div>
      <header className="book-header">
        {coverUrl && <img className="cover-thumb" src={coverUrl} alt=""/>}
        <div className="book-header-text">
          <h2 className="title">{humanizeTitle(book.title)}</h2>
          {book.author && <p className="author">{book.author}</p>}
          {currentSection?.title && <p className="chapter-line">{currentSection.title}</p>}
        </div>
      </header>

      <div className="header-progress-track" aria-hidden="true">
        <div className="header-progress-fill" style={{ width: `${bookProgress}%` }}/>
      </div>

      <section className="reading-stage">
        {importProgress && (<div className="import-progress">
            <p className="import-progress-label">
              Procesando {book.title}… {STAGE_LABELS[book.importStage]}
              {importProgress.totalPages ? ` · ${book.format === "pdf" ? "Página" : "Sección"} ${importProgress.page} de ${importProgress.totalPages}` : ""}
              {importProgress.percent !== null ? ` · ${importProgress.percent}%` : ""}
            </p>
            <div className="progress-track">
              <div className="progress-fill" style={{ width: `${importProgress.percent ?? 0}%` }}/>
            </div>
            {importProgress.playable && <p className="notice">Ya puedes comenzar a escuchar mientras terminamos de procesarlo.</p>}
          </div>)}

        <div className={`current-text${status === "playing" ? " is-playing" : ""}`}>
          {currentText || (importing ? "Preparando el texto…" : "")}
        </div>

        {status === "buffering" && <p className="notice">Cargando…</p>}

        {!ttsSupported && (<p className="notice">Este navegador no soporta lectura en voz alta. Puedes seguir el texto igualmente.</p>)}
      </section>

      <div className="reader-pagination"><button className="subtle-button" disabled={index <= 0} onClick={() => controller.skip(-1)}>← Anterior</button><span>{total ? index + 1 : 0} / {total} fragmentos</span><button className="subtle-button" disabled={index >= total - 1} onClick={() => controller.skip(1)}>Siguiente →</button></div>
      </div>}
      <EvoPlayer key={book.id} book={book} index={index} coverUrl={coverUrl} section={currentSection} status={status} controller={controller} supported={ttsSupported} rate={rate} onRate={onRateChange} voiceURI={voiceURI} voices={sortVoicesForDisplay(voices)} onVoice={onVoiceChange} onChapters={onOpenChapters}/>

      {view === 'settings' && <details className="more-panel" open>
        <summary>
          <span>Ajustes y opciones</span>

        </summary>
        <div className="more-panel-body">
          <div className="settings">
            <label className="setting">
              <span>Velocidad {rate.toFixed(2)}x</span>
              <input type="range" min={MIN_RATE} max={MAX_RATE} step={0.05} value={rate} onChange={(e) => onRateChange(Number(e.target.value))}/>
            </label>

            <label className="setting">
              <span>Voz</span>
              <select value={voiceURI ?? ""} onChange={(e) => onVoiceChange(e.target.value)}>
                {voiceURI === null && <option value="">Predeterminada</option>}
                {sortVoicesForDisplay(voices).map((v) => (<option key={v.id} value={v.id}>
                    {voiceLabel(v)}
                  </option>))}
              </select>
            </label>
          </div>

          <details className="voice-diagnostics"><summary>Diagnóstico avanzado de voz</summary>
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

            {isNativeEngine && (<div className="voice-diagnostics-es">
                <p className="diagnostics-voice-title">Voces es-* ({spanishVoices.length})</p>
                {spanishVoices.map((v) => (<div key={v.id} className="voice-diagnostics-item">
                    <p className="diagnostics-voice-line">{v.name}</p>
                    <p className="diagnostics-voice-line">{v.lang}</p>
                    <p className="diagnostics-voice-line">{v.quality ?? "default"}</p>
                    <p className="diagnostics-voice-line">{v.id}</p>
                    <p className="diagnostics-voice-line">personal: {v.personal ? "true" : "false"}</p>
                  </div>))}
              </div>)}
          </details>

          {error && <p className="error">{error}</p>}

          <label className="load-button secondary">
            {busy ? "Cargando…" : "Cargar otro libro"}
            <input type="file" accept=".pdf,.epub,.txt,.md,.docx" onChange={onFileChange} disabled={busy || importing} hidden/>
          </label>

          <button className="text-link" onClick={onOpenDiagnostics}>
            Diagnóstico
          </button>
        </div>
      </details>}

      {showChapters && (<ChaptersPanel sections={sections} currentSection={currentSection} onClose={onCloseChapters} onSelect={onSelectSection} onAdjacent={onAdjacentSection}/>)}

      {showDiagnostics && (<DiagnosticsPanel book={book} sections={sections} storageUsage={storageUsage} onClose={onCloseDiagnostics}/>)}
    </div>);
}
interface ChaptersPanelProps {
    sections: SectionRecord[];
    currentSection: SectionRecord | undefined;
    onClose: () => void;
    onSelect: (section: SectionRecord) => void;
    onAdjacent: (delta: 1 | -1) => void;
}
function ChaptersPanel({ sections, currentSection, onClose, onSelect, onAdjacent }: ChaptersPanelProps) {
    return (<Sheet title="Capítulos" onClose={onClose}>
        <div className="sheet-header">
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
            return (<button key={s.index} className={`sheet-item${isCurrent ? " current" : ""}`} onClick={() => onSelect(s)}>
                <span className="sheet-item-marker">{isCurrent ? "▶" : isRead ? "✓" : ""}</span>
                <span className="sheet-item-title">{s.title ?? "Libro completo"}</span>
              </button>);
        })}
        </div>
    </Sheet>);
}
interface DiagnosticsPanelProps {
    book: BookRecord;
    sections: SectionRecord[];
    storageUsage: {
        usage: number;
        quota: number;
    } | undefined;
    onClose: () => void;
}
function DiagnosticsPanel({ book, sections, storageUsage, onClose }: DiagnosticsPanelProps) {
    const progress = book.totalChunks > 1 ? Math.round((book.currentChunk / (book.totalChunks - 1)) * 100) : 0;
    return (<Sheet title="Diagnóstico del libro" onClose={onClose}>
        <div className="sheet-header">
          <button className="icon-button small" aria-label="Cerrar" onClick={onClose}>
            ✕
          </button>
        </div>
        <dl className="diagnostics-list">
          <dt>Formato</dt>
          <dd>{book.format.toUpperCase()}</dd>
          <dt>Tamaño</dt>
          <dd>{formatBytes(book.size)}</dd>
          {book.format === "pdf" && (<>
              <dt>Páginas</dt>
              <dd>{book.totalPages ?? "—"}</dd>
            </>)}
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
          {storageUsage && (<>
              <dt>Almacenamiento</dt>
              <dd>
                ~{formatBytes(storageUsage.usage)} de {formatBytes(storageUsage.quota)}
              </dd>
            </>)}
        </dl>
    </Sheet>);
}
