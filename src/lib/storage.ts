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

export const saveBook = (book: StoredBook) => set(BOOK_KEY, book);
export const loadBook = () => get<StoredBook>(BOOK_KEY);
export const clearBook = async () => {
  await del(BOOK_KEY);
  await del(PROGRESS_KEY);
};

export const saveProgress = (progress: StoredProgress) => set(PROGRESS_KEY, progress);
export const loadProgress = () => get<StoredProgress>(PROGRESS_KEY);

export const saveSettings = (settings: StoredSettings) => set(SETTINGS_KEY, settings);
export const loadSettings = () => get<StoredSettings>(SETTINGS_KEY);
