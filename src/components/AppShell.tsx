import type { ReactNode } from 'react';
import { Glyph, type View } from './DesignSystem';
const navigation = [{ view: 'library', label: 'Biblioteca', icon: 'library' }, { view: 'reader', label: 'Lector', icon: 'book' }, { view: 'activity', label: 'Tu lectura', icon: 'activity' }, { view: 'settings', label: 'Ajustes', icon: 'settings' }] as const;
export function AppShell({ view, onNavigate, children, hasBook }: {
    view: View;
    onNavigate: (view: View) => void;
    children: ReactNode;
    hasBook: boolean;
}) {
    return <div className={`app-shell view-${view} ${hasBook ? 'has-book' : ''}`}><a className="skip-link" href="#main">Ir al contenido</a><aside className="sidebar"><a className="brand" href="#library" onClick={(e) => { e.preventDefault(); onNavigate('library'); }}><span className="brand-mark"><Glyph name="book"/></span>EvoReader<span className="brand-version">3.0</span></a><p className="nav-caption">TU ESPACIO DE LECTURA</p><nav aria-label="Principal">{navigation.map(item => <button key={item.view} aria-current={view === item.view ? 'page' : undefined} onClick={() => onNavigate(item.view)}><Glyph name={item.icon}/><span>{item.label}</span></button>)}</nav><div className="sidebar-note"><span className="status-dot"/>Un espacio solo tuyo<p>Tus libros, en tu dispositivo.</p></div></aside><main id="main" tabIndex={-1}>{children}</main></div>;
}
