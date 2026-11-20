// Runs against Luna.MockEngine: no LUNA needed. `npm test`.
import { describe, expect, it } from 'vitest';
import { loadPreset, planLoad } from '../src/loader';
import { addRecent, loadPrefs, toggleFavorite, type SimpleStorage } from '../src/prefs';
import { isUA, loadCached, makerLabel, memoryStore, pluginsChanged, saveCached, scan, type PresetIndex } from '../src/presetIndex';
import { categories, makers, NO_FILTERS, prepare, search } from '../src/search';

const EQ = 'uaudio_pultec_eqp1a';
const COMP = 'com.bettermaker.vst3.c502v';
const SYNTH = 'uaudio_minimoog';
const DRUMS = 'com.xln.au.addictive_drums';

async function connected() {
  const engine = new Luna.MockEngine();
  engine.addSession('abc', { name: 'Demo', tracks: ['Vocal', 'Bass'] });
  engine.addPlugin(EQ, { name: 'Pultec EQP-1A', manufacturer: 'universal_audio_inc', categories: ['EQ'] });
  engine.addPlugin(COMP, { name: 'Bettermaker C502V', manufacturer: 'Bettermaker', categories: ['Compressors & Limiters'] });
  engine.addPlugin(SYNTH, { name: 'Moog Minimoog', manufacturer: 'universal_audio_inc', categories: ['Synth'], effectType: 'instrument' });
  engine.addPlugin(DRUMS, { name: 'Addictive Drums 2', manufacturer: 'XLN Audio', categories: ['Drums'], effectType: 'instrument' });
  engine.addPreset(EQ, 'Kick Thump', { uid: 'eq_kick', factory: true });
  engine.addPreset(EQ, 'Vocal Air', { uid: 'eq_vox', factory: true });
  engine.addPreset(COMP, 'Kick Punch', { uid: 'c_kick', factory: false });
  engine.addPreset(COMP, 'Drum Bus Glue', { uid: 'c_bus', factory: false, favorite: true });
  engine.addPreset(SYNTH, 'Fat Bass', { uid: 'syn_bass', factory: true });
  engine.addPreset(DRUMS, 'Big Kick Kit', { uid: 'ad_kick', factory: true });
  await engine.settled();
  const luna = await Luna.connect({ port_: engine.port() });
  const session = await luna.session();
  return { engine, luna, session };
}

const names = (idx: PresetIndex, r: ReturnType<typeof search>) => r.groups.map((g) => [g.plugin.name, g.hits.map((h) => h.preset.name)]);
const edits = (engine: Luna.MockEngine) => engine.requests.filter((r) => /set_inserts|\/load$|new_track/.test(r.path)).map((r) => r.path.split('/').pop());

describe('index', () => {
  it('reads every plugin, marks UA and instruments, and keeps user presets alongside factory ones', async () => {
    const { luna } = await connected();
    const seen: number[] = [];
    const idx = await scan(luna, { onProgress: (p) => seen.push(p.done) });
    expect(idx.plugins.map((p) => [p.name, p.ua, p.kind]).sort()).toEqual([
      ['Addictive Drums 2', false, 'instrument'],
      ['Bettermaker C502V', false, 'effect'],
      ['Moog Minimoog', true, 'instrument'],
      ['Pultec EQP-1A', true, 'effect'],
    ]);
    expect(idx.presets).toHaveLength(6);
    expect(idx.presets.find((p) => p.uid === 'c_kick')).toMatchObject({ factory: false });
    expect(idx.presets.find((p) => p.uid === 'c_bus')).toMatchObject({ lunaFavorite: true });
    expect(seen.at(-1)).toBe(4);
  });

  it('tops up only new plugins from a cached index and survives the cache', async () => {
    const { engine, luna } = await connected();
    const first = await scan(luna);
    const store = memoryStore();
    await saveCached(store, first);
    const cached = (await loadCached(store))!;
    expect(await pluginsChanged(luna, cached)).toBe(false);
    engine.addPlugin('com.soundtoys.decapitator', { name: 'Decapitator', manufacturer: 'Soundtoys' });
    engine.addPreset('com.soundtoys.decapitator', 'Kick Crush', { uid: 'st_kick', factory: true });
    await engine.settled();
    expect(await pluginsChanged(luna, cached)).toBe(true);
    const before = engine.requests.filter((r) => r.path === '/presets/query').length;
    const next = await scan(luna, { previous: cached });
    expect(engine.requests.filter((r) => r.path === '/presets/query').length - before).toBe(1);
    expect(next.presets.map((p) => p.uid).sort()).toEqual(['ad_kick', 'c_bus', 'c_kick', 'eq_kick', 'eq_vox', 'st_kick', 'syn_bass']);
  });

  it('gives up on a plugin that never answers and carries on', async () => {
    const { engine, luna } = await connected();
    engine.fail('/presets/query', 'uasrv.invalid_type', 1);
    const real = luna.presets.query.bind(luna.presets);
    luna.presets.query = (o) => (o?.pluginId === SYNTH ? new Promise(() => {}) : real(o));
    const idx = await scan(luna, { timeoutMs: 100, concurrency: 1 });
    expect(idx.plugins.filter((p) => p.error).map((p) => p.error).sort()).toEqual(['timeout', 'uasrv.invalid_type']);
    expect(idx.presets.length).toBeGreaterThanOrEqual(3);
  });

  it('lists a plugin installed as VST3 and AU once, as the VST3', async () => {
    const { engine, luna } = await connected();
    engine.addPlugin('com.fab.au.proq3', { name: 'Pro-Q 3', manufacturer: 'FabFilter' });
    engine.addPlugin('com.fab.vst3.proq3', { name: 'Pro-Q 3', manufacturer: 'FabFilter' });
    engine.addPlugin('com.fab.au.timeless', { name: 'Timeless 3', manufacturer: 'FabFilter' });
    await engine.settled();
    const idx = await scan(luna);
    expect(idx.plugins.filter((p) => p.makerLabel === 'FabFilter').map((p) => p.id).sort()).toEqual(['com.fab.au.timeless', 'com.fab.vst3.proq3']);
    expect(await pluginsChanged(luna, idx)).toBe(false);
  });

  it('names makers for people', () => {
    expect(makerLabel('universal_audio_inc')).toBe('Universal Audio');
    expect(makerLabel('Plugin Alliance')).toBe('Plugin Alliance');
    expect(makerLabel('xln_audio')).toBe('Xln Audio');
    expect(isUA('universal_audio_inc', 'x', 'y')).toBe(true);
    expect(isUA('Bettermaker', 'com.bettermaker', 'C502V')).toBe(false);
  });
});

describe('search', () => {
  it('finds "kick" in every plugin, grouped by plugin, best matches first', async () => {
    const { luna } = await connected();
    const idx = await scan(luna);
    const r = search(prepare(idx), 'kick', NO_FILTERS, new Set());
    expect(r.total).toBe(3);
    expect(names(idx, r)).toEqual([
      ['Bettermaker C502V', ['Kick Punch']],
      ['Pultec EQP-1A', ['Kick Thump']],
      ['Addictive Drums 2', ['Big Kick Kit']],
    ]);
  });

  it('lets a word name the plugin or maker', async () => {
    const { luna } = await connected();
    const idx = await scan(luna);
    const p = prepare(idx);
    expect(names(idx, search(p, 'kick pultec', NO_FILTERS, new Set()))).toEqual([['Pultec EQP-1A', ['Kick Thump']]]);
    expect(search(p, 'bettermaker', NO_FILTERS, new Set()).total).toBe(2);
  });

  it('filters by UA or third-party, effect or instrument, favourites, maker and category', async () => {
    const { luna } = await connected();
    const idx = await scan(luna);
    const p = prepare(idx);
    const total = (f: Partial<typeof NO_FILTERS>, favs = new Set<string>()) => search(p, 'kick', { ...NO_FILTERS, ...f }, favs).total;
    expect(total({ source: 'ua' })).toBe(1);
    expect(total({ source: 'third' })).toBe(2);
    expect(total({ kind: 'instrument' })).toBe(1);
    expect(total({ kind: 'effect' })).toBe(2);
    expect(total({ favoritesOnly: true })).toBe(0);
    expect(total({ favoritesOnly: true }, new Set(['eq_kick']))).toBe(1);
    expect(search(p, '', { ...NO_FILTERS, favoritesOnly: true }, new Set()).total).toBe(1); // LUNA's own favourite
    expect(total({ maker: 'Universal Audio' })).toBe(1);
    expect(total({ category: 'EQ' })).toBe(1);
    expect(total({ type: 'eq' })).toBe(1);
    expect(total({ type: 'comp' })).toBe(1);
    expect(total({ type: 'comp', comp: 'other' })).toBe(1);
    expect(total({ type: 'comp', comp: 'fet' })).toBe(0);
    expect(makers(idx).map((m) => m.label)).toEqual(['Bettermaker', 'Universal Audio', 'XLN Audio']);
    expect(categories(idx)).toContain('Compressors & Limiters');
  });

  it('searches 100,000 presets quickly', () => {
    const plugins = Array.from({ length: 600 }, (_, i) => ({ id: `p${i}`, name: `Plugin ${i}`, maker: 'm', makerLabel: 'M', ua: i % 3 === 0, kind: 'effect' as const, categories: [] }));
    const presets = Array.from({ length: 100_000 }, (_, i) => ({ uid: `u${i}`, name: `Preset ${i} ${i % 50 === 0 ? 'Kick' : 'Snare'} Room`, p: i % 600, factory: true, lunaFavorite: false }));
    const p = prepare({ version: 1, builtAt: 0, plugins, presets });
    const t0 = performance.now();
    const r = search(p, 'kick room', NO_FILTERS, new Set());
    expect(r.total).toBe(2000);
    expect(performance.now() - t0).toBeLessThan(150);
  });
});

describe('loading', () => {
  it('inserts an effect preset into the next free slot of the selected track in one command', async () => {
    const { engine, luna, session } = await connected();
    const idx = await scan(luna);
    const preset = idx.presets.find((p) => p.uid === 'eq_vox')!;
    const plugin = idx.plugins[preset.p]!;
    const res = await loadPreset(session, preset, plugin);
    await engine.settled();
    expect(res).toMatchObject({ action: 'free-slot', trackName: 'Vocal', slot: 'effect_0' });
    expect(engine.value('/sessions/abc/tracks/Vocal/effects/effect_0', 'preset_uid')).toBe('eq_vox');
    expect(edits(engine)).toEqual(['set_inserts']);
  });

  it('loads onto the slot that already holds the plugin', async () => {
    const { engine, luna, session } = await connected();
    const idx = await scan(luna);
    const vox = idx.presets.find((p) => p.uid === 'eq_vox')!;
    const kick = idx.presets.find((p) => p.uid === 'eq_kick')!;
    const plugin = idx.plugins[vox.p]!;
    await loadPreset(session, vox, plugin);
    await engine.settled();
    await luna.settled();
    const res = await loadPreset(session, kick, plugin);
    await engine.settled();
    expect(res).toMatchObject({ action: 'existing-slot', slot: 'effect_0' });
    expect(engine.value('/sessions/abc/tracks/Vocal/effects/effect_0', 'preset_uid')).toBe('eq_kick');
    expect(engine.value('/sessions/abc/tracks/Vocal/effects/effect_1', 'plugin_id') ?? null).toBe(null);
    expect(edits(engine)).toEqual(['set_inserts', 'load']);
  });

  it('makes a new track for an instrument preset on an audio track, or when asked', async () => {
    const { engine, luna, session } = await connected();
    const idx = await scan(luna);
    const bass = idx.presets.find((p) => p.uid === 'syn_bass')!;
    const synth = idx.plugins[bass.p]!;
    expect((await planLoad(session, synth)).reason).toMatch(/not an instrument track/);
    const res = await loadPreset(session, bass, synth);
    expect(res).toMatchObject({ action: 'new-track', trackName: 'Fat Bass' });
    const vox = idx.presets.find((p) => p.uid === 'eq_vox')!;
    const forced = await loadPreset(session, vox, idx.plugins[vox.p]!, { newTrack: true });
    expect(forced.action).toBe('new-track');
    await engine.settled();
    expect(edits(engine)).toEqual(['new_track', 'new_track']);
  });

  it('loads another preset onto an instrument track that already has that instrument', async () => {
    const { engine, luna, session } = await connected();
    engine.addPreset(SYNTH, 'Lead Saw', { uid: 'syn_lead', factory: true });
    await engine.settled();
    const idx = await scan(luna);
    const bass = idx.presets.find((p) => p.uid === 'syn_bass')!;
    const synth = idx.plugins[bass.p]!;
    const [track] = await session.newTrackFromPreset({ uid: 'syn_bass', name: 'Fat Bass' });
    await session.context.select({ trackUids: [track!.id] });
    await engine.settled();
    await luna.settled();
    expect(session.focusedTrack.value?.id).toBe(track!.id);
    const lead = idx.presets.find((p) => p.uid === 'syn_lead')!;
    const res = await loadPreset(session, lead, synth);
    expect(res).toMatchObject({ action: 'existing-slot', slot: 'instrument' });
    const drums = idx.presets.find((p) => p.uid === 'ad_kick')!;
    expect((await planLoad(session, idx.plugins[drums.p]!)).reason).toMatch(/already has an instrument/);
  });
});

describe('prefs', () => {
  it('keeps favourites and recents, newest first, without duplicates', () => {
    const m = new Map<string, string>();
    const s: SimpleStorage = { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) };
    const prefs = loadPrefs(s);
    toggleFavorite(s, prefs, 'a');
    addRecent(s, prefs, 'x', 1);
    addRecent(s, prefs, 'y', 2);
    addRecent(s, prefs, 'x', 3);
    const again = loadPrefs(s);
    expect([...again.favorites]).toEqual(['a']);
    expect(again.recents.map((r) => r.uid)).toEqual(['x', 'y']);
    toggleFavorite(s, again, 'a');
    expect(loadPrefs(s).favorites.size).toBe(0);
  });

  it('works with no storage at all', () => {
    const prefs = loadPrefs(undefined);
    expect(() => addRecent(undefined, prefs, 'x')).not.toThrow();
    expect(prefs.filters).toEqual(NO_FILTERS);
  });
});
