// Loading a preset into the session. Each way in is a single LUNA command, so each load is one
// undo step.
//
// Auto (a plain click):
// 1. The audition slot: the slot the last load on this track went into, while it still holds
//    what we put there. Clicking through presets keeps swapping that one slot, the same
//    plugin's presets in place (fact 122), another plugin by replacing it (`set_inserts` with
//    the new plugin and `preset_uid`, facts 99 and 146).
// 2. The selected track already has that plugin: load the preset onto it.
// 3. The next free slot: the empty instrument slot of an instrument track, or the first empty
//    insert.
// 4. Otherwise a new track from the preset (fact 132).
//
// A chosen slot (the "Load into" menu) replaces whatever is in it. Add (⇧) skips 1 and 2 and
// always takes a free slot. New track (⌥) always makes a track.

import type { PluginEntry, PresetEntry } from './presetIndex';

export type LoadAction = 'existing-slot' | 'replace' | 'free-slot' | 'new-track';
export type LoadMode = 'auto' | 'add' | 'new-track';

/** A slot on a track, by ids, so it survives LUNA reloading the objects. */
export interface SlotRef {
  trackId: string;
  slotId: string;
}

/** Where the last load went, and which plugin it put there. */
export interface Audition extends SlotRef {
  pluginId: string;
}

export interface LoadOptions {
  mode?: LoadMode;
  /** A slot the user picked: replace what is in it. Ignored on another track. */
  target?: SlotRef;
  audition?: Audition;
}

export interface LoadResult {
  action: LoadAction;
  trackName: string;
  trackId?: string;
  slot?: string;
  /** What the slot held before a replace. */
  replaced?: string;
}

export interface Plan {
  action: LoadAction;
  track?: Luna.Track;
  slot?: Luna.Effect;
  /** Why it falls back to a new track, for the hint under the search box. */
  reason?: string;
}

const trackLabel = (t: Luna.Track | undefined): string => t?.name.value ?? t?.id ?? 'a new track';

/** Effect slots plus the instrument slot, loaded. */
export async function slotsOf(track: Luna.Track): Promise<readonly Luna.Effect[]> {
  await track.effects.load();
  await track.effects.membersReady();
  return track.effects.items;
}

/** Whether a plugin of this kind can go in this slot. */
export function fits(slot: Luna.Effect, plugin: PluginEntry): boolean {
  return plugin.kind === 'instrument' ? slot.id === 'instrument' : slot.isEffectSlot;
}

/** Put the plugin in a slot that already holds something: load in place, or replace. */
function into(track: Luna.Track, slot: Luna.Effect, plugin: PluginEntry): Plan {
  return { action: slot.pluginId.value === plugin.id ? 'existing-slot' : slot.isEmpty ? 'free-slot' : 'replace', track, slot };
}

/** Decide where a preset would go, without changing anything. */
export async function planLoad(session: Luna.Session, plugin: PluginEntry, options: LoadOptions = {}): Promise<Plan> {
  const mode: LoadMode = options.mode ?? 'auto';
  if (mode === 'new-track') return { action: 'new-track' };
  const track = session.focusedTrack.value;
  if (!track) return { action: 'new-track', reason: 'no track selected' };
  const type = track.trackType.value;
  if (type !== 'audio' && type !== 'instrument') return { action: 'new-track', reason: `${trackLabel(track)} cannot take plugins` };
  const slots = await slotsOf(track);
  const byId = (id: string): Luna.Effect | undefined => slots.find((s) => s.id === id);

  let note: string | undefined;
  if (mode === 'auto' && options.target?.trackId === track.id) {
    const slot = byId(options.target.slotId);
    if (slot && fits(slot, plugin)) return into(track, slot, plugin);
    if (slot) note = plugin.kind === 'instrument' ? 'the chosen slot takes effects' : 'the chosen slot takes instruments';
  }

  if (mode === 'auto') {
    const a = options.audition;
    if (!note && a && a.trackId === track.id) {
      const slot = byId(a.slotId);
      // Only while it still holds what we put there: never swap out a plugin the user chose.
      if (slot && fits(slot, plugin) && slot.pluginId.value === a.pluginId) return into(track, slot, plugin);
    }
    const same = slots.find((s) => (s.isEffectSlot || s.id === 'instrument') && s.pluginId.value === plugin.id);
    if (same) return { action: 'existing-slot', track, slot: same };
  }

  if (plugin.kind === 'instrument') {
    const inst = byId('instrument');
    if (type === 'instrument' && inst && inst.isEmpty) return { action: 'free-slot', track, slot: inst };
    return { action: 'new-track', reason: note ?? (type === 'instrument' ? `${trackLabel(track)} already has an instrument; pick its slot under Load into to swap it` : `${trackLabel(track)} is not an instrument track`) };
  }

  const free = track.effectSlots.find((s) => s.isEmpty);
  if (free) return { action: 'free-slot', track, slot: free };
  return { action: 'new-track', reason: note ?? `${trackLabel(track)} has no free insert` };
}

/** Load `preset` (of `plugin`) where {@link planLoad} says. */
export async function loadPreset(session: Luna.Session, preset: PresetEntry, plugin: PluginEntry, options: LoadOptions = {}): Promise<LoadResult> {
  const plan = await planLoad(session, plugin, options);
  const base = { trackName: trackLabel(plan.track), trackId: plan.track?.id };
  if (plan.action === 'existing-slot' && plan.slot) {
    await plan.slot.loadPreset(preset.uid);
    return { ...base, action: plan.action, slot: plan.slot.id };
  }
  if ((plan.action === 'free-slot' || plan.action === 'replace') && plan.slot) {
    const replaced = plan.action === 'replace' ? (plan.slot.pluginName.value ?? plan.slot.pluginId.value ?? undefined) : undefined;
    // One `set_inserts`: the plugin and the preset in one undo step, whatever the slot held.
    await plan.slot.setPlugin(plugin.id, { presetUid: preset.uid, presetName: preset.name });
    return { ...base, action: plan.action, slot: plan.slot.id, replaced };
  }
  const [track] = await session.newTrackFromPreset({ uid: preset.uid, name: preset.name });
  return { action: 'new-track', trackName: trackLabel(track), trackId: track?.id };
}

/** Where the next auto load should audition, after this one. */
export function auditionAfter(result: LoadResult, plugin: PluginEntry): Audition | undefined {
  if (!result.trackId) return undefined;
  if (result.slot) return { trackId: result.trackId, slotId: result.slot, pluginId: plugin.id };
  // A new track from an instrument preset: its instrument slot.
  if (result.action === 'new-track' && plugin.kind === 'instrument') return { trackId: result.trackId, slotId: 'instrument', pluginId: plugin.id };
  return undefined;
}

/** "insert 2" or "the instrument slot". */
export function slotLabel(slotId: string): string {
  if (slotId === 'instrument') return 'the instrument slot';
  const n = /^effect_(\d+)$/.exec(slotId);
  return n ? `insert ${Number(n[1]) + 1}` : slotId;
}

/** One line for the status bar after a load. */
export function describe(result: LoadResult, preset: PresetEntry, plugin: PluginEntry): string {
  const what = `${preset.name} (${plugin.name})`;
  if (result.action === 'new-track') return `Made ${result.trackName} with ${what}`;
  if (result.action === 'existing-slot') return `Loaded ${what} on ${result.trackName}`;
  if (result.action === 'replace') return `Swapped ${what} into ${slotLabel(result.slot ?? '')} on ${result.trackName}`;
  return `Inserted ${what} on ${result.trackName}, ${slotLabel(result.slot ?? '')}`;
}
