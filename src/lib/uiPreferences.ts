import type { ReaderTheme, View } from '../components/DesignSystem';
export interface UIPreferences {
    version: 1;
    view: View;
    theme: ReaderTheme;
    fontSize: number;
}
export const DEFAULT_UI: UIPreferences = { version: 1, view: 'library', theme: 'paper', fontSize: 22 };
export function normalizeUI(value: unknown): UIPreferences {
    const p = value && typeof value === 'object' ? value as Partial<UIPreferences> : {};
    return { version: 1, view: ['library', 'reader', 'activity', 'settings'].includes(p.view ?? '') ? p.view! : 'library', theme: ['paper', 'sepia', 'dark', 'oled'].includes(p.theme ?? '') ? p.theme! : 'paper', fontSize: typeof p.fontSize === 'number' && Number.isFinite(p.fontSize) ? Math.max(18, Math.min(32, p.fontSize)) : 22 };
}
// A tiny synchronous checkpoint protects preferences during immediate reloads.
// Only this versioned key is owned here; book content remains in IndexedDB.
export function readUICheckpoint(): UIPreferences | undefined {
    try {
        const value = localStorage.getItem('evoreader.ui.v3');
        return value ? normalizeUI(JSON.parse(value)) : undefined;
    }
    catch {
        return undefined;
    }
}
export function writeUICheckpoint(value: UIPreferences): void {
    try {
        localStorage.setItem('evoreader.ui.v3', JSON.stringify(value));
    }
    catch { /* IndexedDB remains the fallback. */ }
}
