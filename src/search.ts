// Search over the preset index. Pure functions: no LUNA, no DOM.

import type { PluginEntry, PresetEntry, PresetIndex } from './presetIndex';
import { compType, pluginTypes, type CompType, type PluginType } from './types';

export type Source = 'all' | 'ua' | 'third';
export type Kind = 'all' | 'effect' | 'instrument';

export interface Filters {
  source: Source;
  kind: Kind;
  favoritesOnly: boolean;
  /** A maker label, or empty for every maker. */
  maker: string;
  /** A plugin category as LUNA names it (`EQ`, `Reverb`), or empty for every category. */
  category: string;
  /** A quick type (EQ, compressors...), or empty for every type. */
  type: PluginType | '';
  /** With type 'comp', a kind of compressor, or empty for every kind. */
  comp: CompType | '';
}

export const NO_FILTERS: Filters = { source: 'all', kind: 'all', favoritesOnly: false, maker: '', category: '', type: '', comp: '' };

export interface Hit {
  preset: PresetEntry;
  plugin: PluginEntry;
  favorite: boolean;
}

export interface Group {
  plugin: PluginEntry;
  hits: Hit[];
  /** Lower is better: how well the best preset in the group matched. */
  rank: number;
}

export interface Result {
  groups: Group[];
  total: number;
}

/** Lower-cased names, built once per index so each keystroke only compares strings. */
export interface Prepared {
  index: PresetIndex;
  presetNames: string[];
  pluginText: string[];
  types: PluginType[][];
  comps: CompType[];
}

export function prepare(index: PresetIndex): Prepared {
  return {
    index,
    presetNames: index.presets.map((p) => p.name.toLowerCase()),
    pluginText: index.plugins.map((p) => `${p.name} ${p.makerLabel} ${p.maker}`.toLowerCase()),
    types: index.plugins.map((p) => pluginTypes(p.name, p.categories, p.kind)),
    comps: index.plugins.map((p) => compType(p.name)),
  };
}

export function terms(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

function pluginPasses(pl: PluginEntry, f: Filters, types: PluginType[], comp: CompType): boolean {
  if (f.type && !types.includes(f.type)) return false;
  if (f.type === 'comp' && f.comp && comp !== f.comp) return false;
  if (f.source === 'ua' && !pl.ua) return false;
  if (f.source === 'third' && pl.ua) return false;
  if (f.kind !== 'all' && pl.kind !== f.kind) return false;
  if (f.maker && pl.makerLabel !== f.maker) return false;
  if (f.category && !pl.categories.includes(f.category)) return false;
  return true;
}

/** 0 the whole name, 1 the name starts with the first term, 2 a word does, 3 anywhere, 4 only the plugin matched. */
function rankOf(name: string, ts: string[]): number {
  if (!ts.length) return 3;
  const first = ts[0]!;
  if (ts.length === 1 && name === first) return 0;
  if (!name.includes(first)) return 4;
  if (name.startsWith(first)) return 1;
  if (new RegExp(`(^|[^a-z0-9])${first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(name)) return 2;
  return 3;
}

/**
 * Every preset whose name (or its plugin's name or maker) holds every word typed, after the
 * filters, grouped by plugin. A word may match the plugin, so `kick 1176` finds the 1176's kick
 * presets. Presets whose own name matches sort first.
 */
export function search(prep: Prepared, query: string, filters: Filters, favorites: ReadonlySet<string>): Result {
  const { index, presetNames, pluginText } = prep;
  const ts = terms(query);
  const okPlugin = index.plugins.map((pl, i) => pluginPasses(pl, filters, prep.types[i]!, prep.comps[i]!));
  const groups = new Map<number, Group>();
  let total = 0;
  for (let i = 0; i < index.presets.length; i++) {
    const pr = index.presets[i]!;
    if (!okPlugin[pr.p]) continue;
    const fav = favorites.has(pr.uid) || pr.lunaFavorite;
    if (filters.favoritesOnly && !fav) continue;
    const name = presetNames[i]!;
    const ptext = pluginText[pr.p]!;
    let ok = true;
    for (const t of ts) {
      if (!name.includes(t) && !ptext.includes(t)) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    total++;
    const rank = rankOf(name, ts);
    let g = groups.get(pr.p);
    if (!g) groups.set(pr.p, (g = { plugin: index.plugins[pr.p]!, hits: [], rank }));
    g.rank = Math.min(g.rank, rank);
    g.hits.push({ preset: pr, plugin: g.plugin, favorite: fav });
  }
  const out = [...groups.values()];
  for (const g of out) g.hits.sort((a, b) => rankOf(a.preset.name.toLowerCase(), ts) - rankOf(b.preset.name.toLowerCase(), ts) || naturalCompare(a.preset.name, b.preset.name));
  out.sort((a, b) => a.rank - b.rank || naturalCompare(a.plugin.name, b.plugin.name));
  return { groups: out, total };
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
export const naturalCompare = (a: string, b: string): number => collator.compare(a, b);

/** Makers with presets in the index, for the maker menu, most presets first. */
export function makers(index: PresetIndex): { label: string; count: number; ua: boolean }[] {
  const counts = new Map<string, { label: string; count: number; ua: boolean }>();
  for (const pr of index.presets) {
    const pl = index.plugins[pr.p]!;
    const c = counts.get(pl.makerLabel) ?? { label: pl.makerLabel, count: 0, ua: pl.ua };
    c.count++;
    counts.set(pl.makerLabel, c);
  }
  return [...counts.values()].sort((a, b) => naturalCompare(a.label, b.label));
}

/** Plugin categories with presets in the index, for the category menu. */
export function categories(index: PresetIndex): string[] {
  const set = new Set<string>();
  const withPresets = new Set(index.presets.map((p) => p.p));
  index.plugins.forEach((pl, i) => {
    if (withPresets.has(i)) for (const c of pl.categories) set.add(c);
  });
  return [...set].sort(naturalCompare);
}

/** How many presets each quick type and compressor kind holds, so empty chips can be hidden. */
export function typeCounts(prep: Prepared): { types: Map<PluginType, number>; comps: Map<CompType, number> } {
  const types = new Map<PluginType, number>();
  const comps = new Map<CompType, number>();
  for (const pr of prep.index.presets) {
    const ts = prep.types[pr.p]!;
    for (const t of ts) types.set(t, (types.get(t) ?? 0) + 1);
    if (ts.includes('comp')) comps.set(prep.comps[pr.p]!, (comps.get(prep.comps[pr.p]!) ?? 0) + 1);
  }
  return { types, comps };
}

/** Look a preset up by uid. */
export function byUid(index: PresetIndex): Map<string, PresetEntry> {
  return new Map(index.presets.map((p) => [p.uid, p]));
}
