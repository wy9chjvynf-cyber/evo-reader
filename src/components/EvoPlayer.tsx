import { useEffect, useState } from 'react';
import type { BookRecord, SectionRecord } from '../lib/db';
import type { SpeechController, PlaybackStatus } from '../lib/speechController';
import type { SpeechVoice } from '../lib/speechEngine';
import { BookCover, Progress, Sheet } from './DesignSystem';
export function EvoPlayer({ book, index, coverUrl, section, status, controller, supported, rate, onRate, voiceURI, voices, onVoice, onChapters }: {
    book: BookRecord;
    index: number;
    coverUrl: string | null;
    section?: SectionRecord;
    status: PlaybackStatus;
    controller: SpeechController;
    supported: boolean;
    rate: number;
    onRate: (rate: number) => void;
    voiceURI: string | null;
    voices: SpeechVoice[];
    onVoice: (voice: string) => void;
    onChapters: () => void;
}) {
    const [expanded, setExpanded] = useState(false);
    const [deadline, setDeadline] = useState<number | null>(null);
    const active = status === 'playing' || status === 'buffering';
    const progress = book.totalChunks > 1 ? Math.round(index / (book.totalChunks - 1) * 100) : 0;
    useEffect(() => {
        if (deadline === null)
            return;
        const finish = () => { if (Date.now() >= deadline) {
            controller.pause();
            setDeadline(null);
        } };
        const timer = window.setTimeout(finish, Math.max(0, deadline - Date.now()));
        document.addEventListener('visibilitychange', finish);
        return () => { clearTimeout(timer); document.removeEventListener('visibilitychange', finish); };
    }, [deadline, controller]);
    const transport = <div className="evo-transport"><button aria-label="Fragmento anterior" disabled={index <= 0} onClick={() => controller.skip(-1)}>↤</button><button className="evo-play" aria-label={active ? 'Pausar' : 'Reproducir'} disabled={!supported || book.totalChunks === 0} onClick={() => active ? controller.pause() : controller.play()}>{active ? 'Ⅱ' : '▶'}</button><button aria-label="Fragmento siguiente" disabled={index >= book.totalChunks - 1} onClick={() => controller.skip(1)}>↦</button></div>;
    return <><section className="mini-player" aria-label="EvoPlayer"><button className="mini-book" onClick={() => setExpanded(true)} aria-label="Abrir reproductor completo"><BookCover title={book.title} url={coverUrl}/><span><strong>{book.title}</strong><small>{status === 'buffering' ? 'Preparando audio…' : section?.title || 'Tu lectura actual'}</small></span></button>{transport}<button className="mini-expand" onClick={() => setExpanded(true)} aria-label="Expandir EvoPlayer">⌃</button><div className="mini-progress"><Progress value={progress} label="Progreso de escucha"/></div></section>{expanded && <Sheet title="Ahora escuchas" onClose={() => setExpanded(false)}><div className="full-player"><BookCover large title={book.title} author={book.author} url={coverUrl}/><h3>{book.title}</h3><p>{section?.title || 'Libro completo'}</p><label className="setting">Posición · {progress}%<input type="range" min={0} max={Math.max(0, book.totalChunks - 1)} value={index} onChange={e => controller.goToChunk(Number(e.target.value))}/></label>{transport}<p className="fine-print">Los saltos avanzan por fragmentos de texto.</p><div className="player-settings"><label className="setting">Velocidad · {rate.toFixed(2)}×<input type="range" min="0.75" max="2" step="0.05" value={rate} onChange={e => onRate(Number(e.target.value))}/></label><label className="setting">Voz<select value={voiceURI ?? ''} onChange={e => onVoice(e.target.value)}><option value="">Predeterminada</option>{voices.map(v => <option key={v.id} value={v.id}>{v.name} · {v.lang}{v.quality && v.quality !== 'default' ? ` · ${v.quality}` : ''}</option>)}</select></label><label className="setting">Temporizador<select value={deadline ? 'active' : 'off'} onChange={e => setDeadline(e.target.value === 'off' ? null : Date.now() + Number(e.target.value) * 60000)}><option value="off">Sin temporizador</option>{deadline && <option value="active">Pausa a las {new Date(deadline).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</option>}{[10, 20, 30, 45, 60].map(m => <option key={m} value={m}>{m} minutos</option>)}</select></label></div><button className="subtle-button" onClick={() => { setExpanded(false); onChapters(); }}>Ver capítulos</button>{!supported && <p className="notice">La voz no está disponible en este navegador.</p>}</div></Sheet>}</>;
}
