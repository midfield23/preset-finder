// Favourites, recently loaded presets and the last filters: small, kept in localStorage, which
// on macOS belongs to this install of the Add On. Every read and write tolerates storage being
// unavailable.

import { NO_FILTERS, type Filters } from './search';

export interface Recent {
  uid: string;
  at: number;
}

export interface Prefs {
  favorites: Set<string>;
  recents: Recent[];
  filters: Filters;
}

export const MAX_RECENTS = 25;

export interface SimpleStorage {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}

function read<T>(s: SimpleStorage | undefined, key: string, fallback: T): T {
  try {
    const raw = s?.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(s: SimpleStorage | undefined, key: string, value: unknown): void {
  try {
    s?.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full or blocked: the page still works, it just forgets */
  }
}

export function loadPrefs(s: SimpleStorage | undefined): Prefs {
  return {
    favorites: new Set(read<string[]>(s, 'pf.favorites', [])),
    recents: read<Recent[]>(s, 'pf.recents', []).slice(0, MAX_RECENTS),
    filters: { ...NO_FILTERS, ...read<Partial<Filters>>(s, 'pf.filters', {}) },
  };
}

export function toggleFavorite(s: SimpleStorage | undefined, prefs: Prefs, uid: string): boolean {
  const on = !prefs.favorites.has(uid);
  if (on) prefs.favorites.add(uid);
  else prefs.favorites.delete(uid);
  write(s, 'pf.favorites', [...prefs.favorites]);
  return on;
}

export function addRecent(s: SimpleStorage | undefined, prefs: Prefs, uid: string, now = Date.now()): void {
  prefs.recents = [{ uid, at: now }, ...prefs.recents.filter((r) => r.uid !== uid)].slice(0, MAX_RECENTS);
  write(s, 'pf.recents', prefs.recents);
}

export function saveFilters(s: SimpleStorage | undefined, prefs: Prefs): void {
  write(s, 'pf.filters', prefs.filters);
}
