// Preset Finder: DOM wiring. Connects to LUNA, keeps the preset index, renders search results
// and loads what the user picks. The parts tests exercise live in presetIndex.ts, search.ts,
// loader.ts and prefs.ts.
//
// npm run build bundles this file and everything it imports into dist/main.js, one classic
// script (an IIFE) that index.html loads after vendor/luna.global.js.

import { describe, loadPreset, planLoad } from './loader';
import { addRecent, loadPrefs, saveFilters, toggleFavorite, type Prefs } from './prefs';
import { indexedDbStore, loadCached, pluginsChanged, saveCached, scan, type PluginEntry, type PresetEntry, type PresetIndex } from './presetIndex';
import { COMP_LABELS, TYPE_LABELS, type CompType, type PluginType } from './types';
import { byUid, categories, makers, NO_FILTERS, prepare, search, terms, typeCounts, type Filters, type Hit, type Kind, type Prepared, type Source } from './search';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`index.html has no #${id}`);
  return el as T;
};

const qEl = $<HTMLInputElement>('q');
const rescanEl = $<HTMLButtonElement>('rescan');
const resultsEl = $('results');
const whereEl = $('where');
const statusEl = $('status');
const progressEl = $('progress').firstElementChild as HTMLElement;
const makerEl = $<HTMLSelectElement>('maker');
const categoryEl = $<HTMLSelectElement>('category');
const favEl = $('fav');
const clearFiltersEl = $('clearFilters');
const typesEl = $('types');
const compsEl = $('comps');

let storage: Storage | undefined;
try {
  storage = window.localStorage;
} catch {
  storage = undefined;
}
const store = indexedDbStore();
const prefs: Prefs = loadPrefs(storage);

let luna: Luna.Client | undefined;
let session: Luna.Session | undefined;
let sessionOffs: Luna.Unsubscribe[] = [];
let index: PresetIndex | undefined;
let prep: Prepared | undefined;
let uidMap = new Map<string, PresetEntry>();
let scanning = false;
let busy = false;

// What is on screen, in order, for the arrow keys.
let shown: Hit[] = [];
let active = 0;
let limit = 300;
const collapsed = new Set<string>();

// ---- Status --------------------------------------------------------------------------------

let statusTimer: ReturnType<typeof setTimeout> | undefined;
function say(text: string, kind: '' | 'err' | 'ok' = '', sticky = kind === 'err'): void {
  statusEl.textContent = text;
  statusEl.className = kind;
  statusEl.title = text;
  clearTimeout(statusTimer);
  if (!sticky && text) statusTimer = setTimeout(summary, 6000);
}

function summary(): void {
  if (scanning) return;
  if (!index) return say('');
  const withPresets = new Set(index.presets.map((p) => p.p)).size;
  const when = new Date(index.builtAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  say(`${index.presets.length.toLocaleString()} presets in ${withPresets} plugins · read ${when}`, '', true);
}

function progress(done: number, total: number): void {
  progressEl.style.width = total ? `${Math.round((done / total) * 100)}%` : '0';
  if (done >= total) setTimeout(() => (progressEl.style.width = '0'), 400);
}

// ---- Index ---------------------------------------------------------------------------------

function setIndex(next: PresetIndex): void {
  index = next;
  prep = prepare(next);
  uidMap = byUid(next);
  fillMenus();
  qEl.disabled = false;
  render();
}

function fillMenus(): void {
  if (!index) return;
  const keepMaker = prefs.filters.maker;
  const keepCat = prefs.filters.category;
  const ms = makers(index);
  makerEl.replaceChildren(new Option('Any maker', ''), ...ms.map((m) => new Option(`${m.label} (${m.count.toLocaleString()})`, m.label)));
  categoryEl.replaceChildren(new Option('Any category', ''), ...categories(index).map((c) => new Option(c, c)));
  fillTypeChips();
  makerEl.value = ms.some((m) => m.label === keepMaker) ? keepMaker : '';
  categoryEl.value = [...categoryEl.options].some((o) => o.value === keepCat) ? keepCat : '';
  prefs.filters.maker = makerEl.value;
  prefs.filters.category = categoryEl.value;
  paintFilters();
}

/** Chips for the quick types and compressor kinds that have presets, with counts. */
function fillTypeChips(): void {
  if (!prep) return;
  const { types, comps } = typeCounts(prep);
  const chip = (v: string, label: string, n?: number): HTMLButtonElement => {
    const b = Object.assign(document.createElement('button'), { className: 'chip' });
    b.dataset.v = v;
    b.textContent = label;
    if (n !== undefined) b.append(Object.assign(document.createElement('span'), { className: 'c', textContent: n.toLocaleString() }));
    return b;
  };
  typesEl.replaceChildren(chip('', 'All types'), ...TYPE_LABELS.filter(([t]) => types.get(t)).map(([t, l]) => chip(t, l, types.get(t))));
  const lbl = Object.assign(document.createElement('span'), { className: 'lbl', textContent: 'Kind (guessed from the name):' });
  compsEl.replaceChildren(lbl, chip('', 'All'), ...COMP_LABELS.filter(([c]) => comps.get(c)).map(([c, l]) => chip(c, l, comps.get(c))));
  if (prefs.filters.type && !types.get(prefs.filters.type)) prefs.filters.type = '';
  if (prefs.filters.comp && !comps.get(prefs.filters.comp)) prefs.filters.comp = '';
}

/** Read presets from LUNA: everything, or only plugins the cached index lacks. */
async function runScan(full: boolean): Promise<void> {
  if (!luna || scanning) return;
  scanning = true;
  rescanEl.disabled = true;
  rescanEl.textContent = 'Reading…';
  const started = Date.now();
  try {
    const next = await scan(luna, {
      previous: full ? undefined : index,
      onProgress: ({ done, total }) => {
        progress(done, total);
        say(`Reading presets: ${done} of ${total} plugins`, '', true);
      },
    });
    await saveCached(store, next);
    setIndex(next);
    const errors = next.plugins.filter((p) => p.error).length;
    scanning = false;
    say(`Read ${next.presets.length.toLocaleString()} presets in ${Math.round((Date.now() - started) / 1000)} s${errors ? ` · ${errors} plugins did not answer` : ''}`, 'ok');
  } catch (e) {
    scanning = false;
    say(`Could not read presets: ${(e as Error).message}`, 'err');
  } finally {
    scanning = false;
    rescanEl.disabled = false;
    rescanEl.textContent = 'Rescan';
  }
}

async function startIndex(): Promise<void> {
  const cached = await loadCached(store);
  if (cached) {
    setIndex(cached);
    summary();
    rescanEl.disabled = false;
    // Top up for plugins installed or removed since; presets saved since need a Rescan.
    if (luna && (await pluginsChanged(luna, cached).catch(() => false))) await runScan(false);
    return;
  }
  resultsEl.innerHTML = '<div class="empty">Reading every plugin\'s presets from LUNA.<br>This happens once; after that the list opens instantly.</div>';
  await runScan(true);
}

// ---- Session and target track ---------------------------------------------------------------

async function bindSession(): Promise<void> {
  for (const off of sessionOffs) off();
  sessionOffs = [];
  session = luna?.sessions.current();
  if (!session) {
    whereEl.textContent = 'Open a session in LUNA to load presets';
    return;
  }
  await session.ready();
  const paint = (): void => void paintWhere();
  sessionOffs.push(session.focusedTrack.onChange(paint));
  sessionOffs.push(session.tracks.onChange(paint));
  paint();
}

let whereGen = 0;
/** Say where Enter or a click would put the highlighted preset. */
async function paintWhere(): Promise<void> {
  const gen = ++whereGen;
  if (!session) return;
  const track = session.focusedTrack.value;
  const hit = shown[active];
  const base = (t: string): void => {
    whereEl.innerHTML = '';
    whereEl.append(t);
  };
  if (!hit) {
    if (track) {
      whereEl.innerHTML = 'Loads onto <b></b> · <kbd>⌥</kbd>-click for a new track';
      whereEl.querySelector('b')!.textContent = track.name.value ?? track.id;
    } else base('Loads onto a new track');
    return;
  }
  try {
    const plan = await planLoad(session, hit.plugin);
    if (gen !== whereGen) return;
    const name = plan.track?.name.value ?? '';
    const slot = plan.slot?.id === 'instrument' ? 'its instrument slot' : plan.slot ? `insert ${Number(plan.slot.id.replace('effect_', '')) + 1}` : '';
    if (plan.action === 'existing-slot') whereEl.innerHTML = `<kbd>↵</kbd> loads onto the ${esc(hit.plugin.name)} on <b>${esc(name)}</b>`;
    else if (plan.action === 'free-slot') whereEl.innerHTML = `<kbd>↵</kbd> inserts on <b>${esc(name)}</b>, ${esc(slot)}`;
    else whereEl.innerHTML = `<kbd>↵</kbd> makes a new track${plan.reason ? ` (${esc(plan.reason)})` : ''}`;
    whereEl.innerHTML += ' · <kbd>⌥</kbd> new track';
  } catch {
    /* the session went away mid-plan */
  }
}

// ---- Loading -------------------------------------------------------------------------------

async function load(hit: Hit, newTrack: boolean): Promise<void> {
  if (busy) return;
  if (!session) return say('Open a session in LUNA first', 'err');
  busy = true;
  resultsEl.classList.add('busy');
  say(`Loading ${hit.preset.name}…`, '', true);
  try {
    const result = await loadPreset(session, hit.preset, hit.plugin, { newTrack });
    addRecent(storage, prefs, hit.preset.uid);
    say(describe(result, hit.preset, hit.plugin), 'ok');
    if (!qEl.value.trim()) render();
    void paintWhere();
  } catch (e) {
    const err = e as { code?: string; message?: string };
    const why = err.code === 'device.database_error' ? 'LUNA no longer has this preset; try Rescan' : err.code === 'mixer.missing_plug-in' ? `${hit.plugin.name} did not load` : (err.message ?? String(e));
    say(`Could not load ${hit.preset.name}: ${why}`, 'err');
  } finally {
    busy = false;
    resultsEl.classList.remove('busy');
  }
}

// ---- Rendering -----------------------------------------------------------------------------

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

function highlight(name: string, ts: string[]): string {
  if (!ts.length) return esc(name);
  const lower = name.toLowerCase();
  const marks = new Array<boolean>(name.length).fill(false);
  for (const t of ts) {
    let i = lower.indexOf(t);
    while (i >= 0) {
      for (let k = i; k < i + t.length; k++) marks[k] = true;
      i = lower.indexOf(t, i + t.length);
    }
  }
  let out = '';
  let open = false;
  for (let i = 0; i < name.length; i++) {
    if (marks[i] !== open) {
      out += marks[i] ? '<mark>' : '</mark>';
      open = marks[i]!;
    }
    out += esc(name[i]!);
  }
  return open ? `${out}</mark>` : out;
}

function filtersActive(f: Filters): boolean {
  return f.source !== 'all' || f.kind !== 'all' || f.favoritesOnly || !!f.maker || !!f.category || !!f.type;
}

function tagsFor(pl: PluginEntry): string {
  return `<span class="tag ${pl.ua ? 'ua' : 'third'}">${pl.ua ? 'UA' : '3rd'}</span>${pl.kind === 'instrument' ? '<span class="tag inst">Inst</span>' : ''}`;
}

function rowEl(hit: Hit, ts: string[], withPlugin: boolean): HTMLElement {
  const i = shown.length;
  shown.push(hit);
  const row = document.createElement('div');
  row.className = 'row';
  row.dataset.i = String(i);
  row.title = `${hit.preset.name} · ${hit.plugin.name}\nClick to load, ⌥-click for a new track`;
  const fav = prefs.favorites.has(hit.preset.uid) || hit.preset.lunaFavorite;
  row.innerHTML =
    `<button class="star${fav ? ' on' : ''}" title="Favourite">${fav ? '★' : '☆'}</button>` +
    `<span class="name">${highlight(hit.preset.name, ts)}</span>` +
    (hit.preset.factory ? '' : '<span class="tag user">user</span>') +
    (withPlugin ? `<span class="sub">${esc(hit.plugin.name)}</span>${tagsFor(hit.plugin)}` : '');
  return row;
}

function groupEl(plugin: PluginEntry, hits: Hit[], ts: string[], budget: number): HTMLElement {
  const g = document.createElement('div');
  const closed = collapsed.has(plugin.id);
  g.className = `group${closed ? ' closed' : ''}`;
  g.dataset.plugin = plugin.id;
  g.innerHTML = `<button class="gh"><span class="tw">${closed ? '▸' : '▾'}</span><span class="pn">${esc(plugin.name)}</span><span class="mk">${esc(plugin.makerLabel)}</span>${tagsFor(plugin)}<span class="n">${hits.length}</span></button>`;
  if (!closed) for (const h of hits.slice(0, budget)) g.append(rowEl(h, ts, false));
  return g;
}

function render(): void {
  shown = [];
  resultsEl.replaceChildren();
  paintFilters();
  if (!prep || !index) return;
  const query = qEl.value.trim();
  const ts = terms(query);
  const f = prefs.filters;

  if (!query && !filtersActive(f)) {
    const recents = prefs.recents.map((r) => uidMap.get(r.uid)).filter((p): p is PresetEntry => !!p);
    const favs = index.presets.filter((p) => prefs.favorites.has(p.uid));
    const toHit = (p: PresetEntry): Hit => ({ preset: p, plugin: index!.plugins[p.p]!, favorite: prefs.favorites.has(p.uid) });
    if (recents.length) {
      resultsEl.append(Object.assign(document.createElement('div'), { className: 'section', textContent: 'Recently used' }));
      for (const p of recents.slice(0, 12)) resultsEl.append(rowEl(toHit(p), ts, true));
    }
    if (favs.length) {
      resultsEl.append(Object.assign(document.createElement('div'), { className: 'section', textContent: 'Favourites' }));
      for (const p of favs.slice(0, 200)) resultsEl.append(rowEl(toHit(p), ts, true));
    }
    const hint = document.createElement('div');
    hint.className = 'empty';
    hint.innerHTML = `Type to search ${index.presets.length.toLocaleString()} presets across every plugin, for example <i>kick</i>, <i>vocal</i> or <i>kick 1176</i>.<br><kbd>↑</kbd> <kbd>↓</kbd> to move, <kbd>↵</kbd> to load, <kbd>⌥</kbd><kbd>↵</kbd> onto a new track.`;
    resultsEl.append(hint);
    finishRender();
    return;
  }

  const result = search(prep, query, f, prefs.favorites);
  if (!result.total) {
    resultsEl.innerHTML = `<div class="empty">No presets match${query ? ` “${esc(query)}”` : ''}${filtersActive(f) ? ' with these filters' : ''}.</div>`;
    finishRender();
    return;
  }
  let budget = limit;
  for (const g of result.groups) {
    if (budget <= 0) break;
    resultsEl.append(groupEl(g.plugin, g.hits, ts, budget));
    if (!collapsed.has(g.plugin.id)) budget -= g.hits.length;
  }
  if (budget < 0 || result.groups.length > resultsEl.childElementCount) {
    const more = Object.assign(document.createElement('button'), { className: 'btn more', textContent: `Show more (${result.total.toLocaleString()} presets in ${result.groups.length} plugins)` });
    more.onclick = () => {
      limit += 1000;
      render();
    };
    resultsEl.append(more);
  }
  finishRender();
}

function finishRender(): void {
  active = Math.min(active, Math.max(0, shown.length - 1));
  paintActive(false);
}

function paintActive(scroll = true): void {
  resultsEl.querySelectorAll('.row.active').forEach((r) => r.classList.remove('active'));
  const row = resultsEl.querySelector<HTMLElement>(`.row[data-i="${active}"]`);
  if (row) {
    row.classList.add('active');
    if (scroll) row.scrollIntoView({ block: 'nearest' });
  }
  void paintWhere();
}

function paintFilters(): void {
  const f = prefs.filters;
  for (const [id, v] of [['source', f.source], ['kind', f.kind]] as const) {
    $(id).querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === v)));
  }
  favEl.setAttribute('aria-pressed', String(f.favoritesOnly));
  typesEl.querySelectorAll<HTMLElement>('.chip').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === f.type)));
  compsEl.querySelectorAll<HTMLElement>('.chip').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === f.comp)));
  compsEl.hidden = f.type !== 'comp';
  makerEl.classList.toggle('set', !!f.maker);
  categoryEl.classList.toggle('set', !!f.category);
  clearFiltersEl.hidden = !filtersActive(f);
}

// ---- Events --------------------------------------------------------------------------------

function changed(): void {
  saveFilters(storage, prefs);
  limit = 300;
  active = 0;
  render();
}

for (const id of ['source', 'kind'] as const) {
  $(id).addEventListener('click', (e) => {
    const v = (e.target as HTMLElement).closest('button')?.dataset.v;
    if (!v) return;
    if (id === 'source') prefs.filters.source = v as Source;
    else {
      prefs.filters.kind = v as Kind;
      if (v === 'instrument') prefs.filters.type = '';
    }
    changed();
  });
}
typesEl.addEventListener('click', (e) => {
  const v = (e.target as HTMLElement).closest<HTMLElement>('.chip')?.dataset.v;
  if (v === undefined) return;
  prefs.filters.type = v as PluginType | '';
  prefs.filters.comp = '';
  // Types are effect types: an Instruments filter would hide every one of them.
  if (v && prefs.filters.kind === 'instrument') prefs.filters.kind = 'all';
  changed();
});
compsEl.addEventListener('click', (e) => {
  const v = (e.target as HTMLElement).closest<HTMLElement>('.chip')?.dataset.v;
  if (v === undefined) return;
  prefs.filters.comp = v as CompType | '';
  changed();
});
favEl.onclick = () => {
  prefs.filters.favoritesOnly = !prefs.filters.favoritesOnly;
  changed();
};
makerEl.onchange = () => {
  prefs.filters.maker = makerEl.value;
  changed();
};
categoryEl.onchange = () => {
  prefs.filters.category = categoryEl.value;
  changed();
};
clearFiltersEl.onclick = () => {
  prefs.filters = { ...NO_FILTERS };
  makerEl.value = '';
  categoryEl.value = '';
  changed();
};

let typing: ReturnType<typeof setTimeout> | undefined;
qEl.addEventListener('input', () => {
  clearTimeout(typing);
  typing = setTimeout(() => {
    limit = 300;
    active = 0;
    collapsed.clear();
    render();
    resultsEl.scrollTop = 0;
  }, 60);
});

rescanEl.onclick = () => void runScan(true);

resultsEl.addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  const gh = t.closest<HTMLElement>('.gh');
  if (gh) {
    const id = gh.parentElement!.dataset.plugin!;
    if (collapsed.has(id)) collapsed.delete(id);
    else collapsed.add(id);
    render();
    return;
  }
  const row = t.closest<HTMLElement>('.row');
  if (!row) return;
  const hit = shown[Number(row.dataset.i)];
  if (!hit) return;
  if (t.closest('.star')) {
    toggleFavorite(storage, prefs, hit.preset.uid);
    if (prefs.filters.favoritesOnly || !qEl.value.trim()) render();
    else {
      const on = prefs.favorites.has(hit.preset.uid) || hit.preset.lunaFavorite;
      const star = row.querySelector('.star')!;
      star.classList.toggle('on', on);
      star.textContent = on ? '★' : '☆';
    }
    return;
  }
  active = Number(row.dataset.i);
  paintActive(false);
  void load(hit, e.altKey);
});

document.addEventListener('keydown', (e) => {
  const inSearch = e.target === qEl;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (!shown.length) return;
    e.preventDefault();
    active = Math.max(0, Math.min(shown.length - 1, active + (e.key === 'ArrowDown' ? 1 : -1)));
    paintActive();
  } else if (e.key === 'Enter' && (inSearch || e.target === document.body || e.target === resultsEl)) {
    const hit = shown[active];
    if (!hit) return;
    e.preventDefault();
    void load(hit, e.altKey);
  } else if (e.key === 'Escape' && inSearch && qEl.value) {
    e.preventDefault();
    qEl.value = '';
    qEl.dispatchEvent(new Event('input'));
  } else if (!inSearch && (e.key === '/' || ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f'))) {
    e.preventDefault();
    qEl.focus();
    qEl.select();
  }
});

// ---- Start ---------------------------------------------------------------------------------

async function connect(): Promise<void> {
  for (;;) {
    try {
      luna = await Luna.connect();
      break;
    } catch (e) {
      whereEl.textContent = e instanceof Luna.NotRunning ? 'Waiting for LUNA…' : String((e as Error).message ?? e);
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  // LUNA's undo, redo, play and record keys for any key this page does not handle.
  Luna.bindShortcuts(luna);
  luna.status.onChange(() => {
    if (luna?.status.value === 'disconnected') say('Reconnecting to LUNA…', 'err');
    else if (luna?.status.value === 'connected') summary();
  });
  await luna.sessions.ready();
  luna.sessions.focused.onChange(() => void bindSession());
  await bindSession();
  qEl.disabled = false;
  qEl.focus();
  await startIndex();
}

paintFilters();
void connect();
