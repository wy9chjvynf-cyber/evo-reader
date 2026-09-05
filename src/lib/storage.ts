import { del, get, set } from "idb-keyval";

const BOOK_KEY = "evoreader:book";
const PROGRESS_KEY = "evoreader:progress";
const SETTINGS_KEY = "evoreader:settings";

export interface StoredBook {
  title: string;
  chunks: string[];
}

export interface StoredProgress {
  index: number;
}

export interface StoredSettings {
  rate: number;
  voiceURI: string | null;
}

export const DEFAULT_SETTINGS: StoredSettings = { rate: 1, voiceURI: null };

/**
 * idb-keyval calls indexedDB.open() synchronously the moment get()/set() is
 * invoked. On some iOS/WebKit builds (private browsing, restricted profiles,
 * older engine versions) indexedDB is present but not fully functional, so
 * that call can throw synchronously instead of rejecting a promise. Routing
 * every storage call through here means a broken IndexedDB degrades to
 * "nothing was saved" instead of crashing app init.
 */
async function safely<T>(op: () => Promise<T>): Promise<T | undefined> {
  try {
    return await op();
  } catch {
    return undefined;
  }
}

export const saveBook = (book: StoredBook) => safely(() => set(BOOK_KEY, book));
export const loadBook = () => safely(() => get<StoredBook>(BOOK_KEY));
export const clearBook = () =>
  safely(async () => {
    await del(BOOK_KEY);
    await del(PROGRESS_KEY);
  });

export const saveProgress = (progress: StoredProgress) => safely(() => set(PROGRESS_KEY, progress));
export const loadProgress = () => safely(() => get<StoredProgress>(PROGRESS_KEY));

export const saveSettings = (settings: StoredSettings) => safely(() => set(SETTINGS_KEY, settings));
export const loadSettings = () => safely(() => get<StoredSettings>(SETTINGS_KEY));
