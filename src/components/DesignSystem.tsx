import { useEffect, useId, useRef, type ReactNode } from 'react';
export type View = 'library' | 'reader' | 'activity' | 'settings';
export type ReaderTheme = 'paper' | 'sepia' | 'dark' | 'oled';
export function Glyph({ name }: {
    name: 'book' | 'library' | 'activity' | 'settings' | 'plus' | 'arrow' | 'headphones';
}) {
    const paths = { book: 'M12 5C8 2 3 3 3 3v16s5-1 9 2c4-3 9-2 9-2V3s-5-1-9 2v16', library: 'M4 4v16M9 4v16M14 4v16M18 4l3 16', activity: 'M4 20V12m8 8V4m8 16V8', settings: 'M4 7h16M4 17h16M9 4v6m6 4v6', plus: 'M12 5v14M5 12h14', arrow: 'M5 12h14m-6-6 6 6-6 6', headphones: 'M4 14v-3a8 8 0 0 1 16 0v3M4 12h3v8H4zm13 0h3v8h-3z' };
    return <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]}/></svg>;
}
export function Progress({ value, label }: {
    value: number;
    label: string;
}) {
    const safe = Math.max(0, Math.min(100, value));
    return <div className="evo-progress" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={safe}><span style={{ transform: `scaleX(${safe / 100})` }}/></div>;
}
export function BookCover({ title, author, url, large = false }: {
    title: string;
    author?: string | null;
    url?: string | null;
    large?: boolean;
}) {
    return <div className={`book-cover ${large ? 'large' : ''}`} aria-hidden="true">{url ? <img src={url} alt=""/> : <><span className="cover-edition">EVO / BIBLIOTECA PERSONAL</span><strong>{title}</strong><div className="cover-orbit"/><span className="cover-author">{author || 'Una nueva perspectiva'}</span></>}</div>;
}
export function Sheet({ title, onClose, children }: {
    title: string;
    onClose: () => void;
    children: ReactNode;
}) {
    const ref = useRef<HTMLDialogElement>(null);
    const id = useId();
    useEffect(() => {
        const dialog = ref.current;
        const previous = document.activeElement as HTMLElement | null;
        const overflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        dialog?.showModal();
        return () => { dialog?.close(); document.body.style.overflow = overflow; previous?.focus(); };
    }, []);
    return <dialog ref={ref} className="evo-sheet" aria-labelledby={id} onCancel={(e) => { e.preventDefault(); onClose(); }} onClick={(e) => { if (e.target === e.currentTarget) {
        const r = e.currentTarget.getBoundingClientRect();
        if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)
            onClose();
    } }}><header><h2 id={id}>{title}</h2><button className="round-button" aria-label="Cerrar" onClick={onClose}>✕</button></header>{children}</dialog>;
}
