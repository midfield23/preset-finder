// The preset index: every installed plugin's presets, read once from LUNA's preset library and
// kept between launches, so a search never has to ask LUNA anything.
//
// LUNA answers preset queries one plugin at a time (`luna.presets.query({ pluginId })`), so a
// full scan of a few hundred plugins takes a while. The index is cached, shown at once on the
// next launch, and topped up for plugins installed or removed since. Rescan reads everything.

export type PluginKind = 'effect' | 'instrument';

export interface PluginEntry {
  id: string;
  name: string;
  /** The maker as LUNA reports it (`universal_audio_inc` for UA). */
  maker: string;
  /** The maker for people: `Universal Audio` rather than `universal_audio_inc`. */
  makerLabel: string;
  ua: boolean;
  kind: PluginKind;
  categories: string[];
  /** Set when LUNA failed to answer for this plugin's presets. */
  error?: string;
}

export interface PresetEntry {
  uid: string;
  name: string;
  /** Index into {@link PresetIndex.plugins}. */
  p: number;
  factory: boolean;
  /** Marked as a favourite in LUNA's own preset browser. */
  lunaFavorite: boolean;
}

export interface PresetIndex {
  version: 1;
  builtAt: number;
  plugins: PluginEntry[];
  presets: PresetEntry[];
}

export interface ScanProgress {
  done: number;
  total: number;
  plugin?: string;
}

export interface ScanOptions {
  /** Keep this index's presets for plugins it already has and read only the new ones. */
  previous?: PresetIndex;
  onProgress?: (p: ScanProgress) => void;
  /** Queries in flight at once. */
  concurrency?: number;
  /** Give up on one plugin after this long. Some AU ids are never answered (fact 132). */
  timeoutMs?: number;
  /** Stop early (the page closed, a newer scan started). */
  signal?: { aborted: boolean };
}

const UA_MAKER = /universal[ _-]?audio|uaudio|^ua$/i;

export function isUA(maker: string, pluginId: string, name: string): boolean {
  return UA_MAKER.test(maker) || /^uaudio_/.test(pluginId) || /^com\.uaudio\./.test(pluginId) || /^uad?\s/i.test(name);
}

/** `universal_audio_inc` → `Universal Audio`; names that already look like names pass through. */
export function makerLabel(maker: string): string {
  const m = maker.trim();
  if (!m) return 'Unknown';
  if (!/_/.test(m) && m !== m.toLowerCase()) return m;
  const words = m
    .replace(/[_]+/g, ' ')
    .replace(/\b(inc|llc|ltd|gmbh|corp|co)\b\.?/gi, '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return m;
  return words.map((w) => w[0]!.toUpperCase() + w.slice(1)).join(' ');
}

export const isVst3 = (pluginId: string): boolean => /(^|[._])vst3([._]|$)/i.test(pluginId);

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(Object.assign(new Error('no answer'), { code: 'timeout' })), ms);
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e)),
    );
  });
}

/** Installed plugins, once each: a format twin of a VST3 is left out, as LUNA's browser does. */
export function dedupe(all: readonly Luna.PluginRow[]): Luna.PluginRow[] {
  const seen = new Set<string>();
  const unique = all.filter((p) => p.pluginId && !seen.has(p.pluginId) && (seen.add(p.pluginId), true));
  // A plugin installed as both VST3 and AU is listed once per format. LUNA's own browser shows
  // only the VST3 (fact 127), so do the same: drop a format twin when a VST3 of the same name and
  // maker is installed.
  const key = (p: { name: string; manufacturer: string }): string => `${p.name.toLowerCase()}\u0000${p.manufacturer.toLowerCase()}`;
  const vst3 = new Set(unique.filter((p) => isVst3(p.pluginId)).map(key));
  return unique.filter((p) => isVst3(p.pluginId) || !vst3.has(key(p)));

}

/** Read the installed plugins and their presets from LUNA. */
export async function scan(luna: Luna.Client, options: ScanOptions = {}): Promise<PresetIndex> {
  const { previous, onProgress, concurrency = 4, timeoutMs = 8000, signal } = options;
  const [all, instruments] = await Promise.all([luna.plugins.query({}), luna.plugins.query({ insertType: 'instrument' }).catch(() => [])]);
  const instrumentIds = new Set(instruments.map((p) => p.pluginId));

  const rows = dedupe(all);

  const plugins: PluginEntry[] = rows.map((p) => ({
    id: p.pluginId,
    name: p.name || p.pluginId,
    maker: p.manufacturer,
    makerLabel: isUA(p.manufacturer, p.pluginId, p.name) ? 'Universal Audio' : makerLabel(p.manufacturer),
    ua: isUA(p.manufacturer, p.pluginId, p.name),
    kind: instrumentIds.has(p.pluginId) ? 'instrument' : 'effect',
    categories: p.categories,
  }));

  // Presets already read, by plugin id, when topping up.
  const kept = new Map<string, Omit<PresetEntry, 'p'>[]>();
  if (previous) {
    for (const pr of previous.presets) {
      const id = previous.plugins[pr.p]?.id;
      if (!id) continue;
      const list = kept.get(id) ?? [];
      list.push({ uid: pr.uid, name: pr.name, factory: pr.factory, lunaFavorite: pr.lunaFavorite });
      kept.set(id, list);
    }
    for (const pl of previous.plugins) if (!pl.error && !kept.has(pl.id)) kept.set(pl.id, []);
  }

  const byPlugin: Omit<PresetEntry, 'p'>[][] = new Array(plugins.length);
  const todo: number[] = [];
  plugins.forEach((pl, i) => {
    const had = kept.get(pl.id);
    if (had) byPlugin[i] = had;
    else todo.push(i);
  });

  let done = plugins.length - todo.length;
  onProgress?.({ done, total: plugins.length });
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < todo.length && !signal?.aborted) {
      const i = todo[next++]!;
      const pl = plugins[i]!;
      try {
        const found = await withTimeout(luna.presets.query({ pluginId: pl.id }), timeoutMs);
        byPlugin[i] = found.map((r) => ({ uid: r.uid, name: r.name, factory: r.factory, lunaFavorite: r.favorite }));
      } catch (e) {
        byPlugin[i] = [];
        pl.error = (e as { code?: string }).code ?? (e as Error).message ?? 'error';
      }
      done++;
      onProgress?.({ done, total: plugins.length, plugin: pl.name });
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));

  const presets: PresetEntry[] = [];
  byPlugin.forEach((list, p) => {
    for (const r of list ?? []) presets.push({ ...r, p });
  });
  return { version: 1, builtAt: Date.now(), plugins, presets };
}

/** Plugins that are installed but not in the index, or in the index but no longer installed. */
export async function pluginsChanged(luna: Luna.Client, index: PresetIndex): Promise<boolean> {
  const now = dedupe(await luna.plugins.query({}));
  const ids = new Set(now.map((p) => p.pluginId));
  if (ids.size !== index.plugins.length) return true;
  return index.plugins.some((p) => !ids.has(p.id));
}

// ---- Cache ----------------------------------------------------------------------------------

export interface KeyValueStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}

/** An in-memory store, for tests and for when the page has no IndexedDB. */
export function memoryStore(): KeyValueStore {
  const m = new Map<string, unknown>();
  return {
    get: async (k) => m.get(k),
    set: async (k, v) => void m.set(k, v),
  };
}

/**
 * IndexedDB, which holds tens of thousands of presets where localStorage would run out. On
 * macOS it belongs to this install of the Add On and lasts across launches (MANIFEST.md, "What
 * an install keeps"); an update starts empty and the index is simply read again.
 */
export function indexedDbStore(name = 'preset-finder'): KeyValueStore {
  if (typeof indexedDB === 'undefined') return memoryStore();
  const open = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  const run = <T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> =>
    open.then(
      (db) =>
        new Promise<T>((resolve, reject) => {
          const req = fn(db.transaction('kv', mode).objectStore('kv'));
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        }),
    );
  return {
    get: (k) => run('readonly', (s) => s.get(k)).catch(() => undefined),
    set: (k, v) => run('readwrite', (s) => s.put(v, k)).then(() => undefined),
  };
}

const KEY = 'index.v1';

export async function loadCached(store: KeyValueStore): Promise<PresetIndex | undefined> {
  const v = (await store.get(KEY).catch(() => undefined)) as PresetIndex | undefined;
  return v && v.version === 1 && Array.isArray(v.plugins) && Array.isArray(v.presets) ? v : undefined;
}

export function saveCached(store: KeyValueStore, index: PresetIndex): Promise<void> {
  return store.set(KEY, index).catch(() => undefined);
}
