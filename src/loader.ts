// Loading a preset into the session. Each way in is a single LUNA command, so each load is one
// undo step:
//
// 1. The selected track already has that plugin: load the preset onto it (fact 122).
// 2. Otherwise put the plugin, on the preset, into the next free slot: the instrument slot of
//    an empty instrument track, or the first empty effect slot (`set_inserts` with
//    `preset_uid`, fact 99).
// 3. Otherwise, or when asked, make a new track from the preset (fact 132): an instrument
//    track for an instrument, an audio track with the effect on it.

import type { PluginEntry, PresetEntry } from './presetIndex';

export type LoadAction = 'existing-slot' | 'free-slot' | 'new-track';

export interface LoadResult {
  action: LoadAction;
  trackName: string;
  slot?: string;
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
async function slotsOf(track: Luna.Track): Promise<readonly Luna.Effect[]> {
  await track.effects.load();
  await track.effects.membersReady();
  return track.effects.items;
}

/** Decide where a preset would go, without changing anything. */
export async function planLoad(session: Luna.Session, plugin: PluginEntry, options: { newTrack?: boolean } = {}): Promise<Plan> {
  if (options.newTrack) return { action: 'new-track' };
  const track = session.focusedTrack.value;
  if (!track) return { action: 'new-track', reason: 'no track selected' };
  const type = track.trackType.value;
  if (type !== 'audio' && type !== 'instrument') return { action: 'new-track', reason: `${trackLabel(track)} cannot take plugins` };
  const slots = await slotsOf(track);

  const same = slots.find((s) => (s.isEffectSlot || s.id === 'instrument') && s.pluginId.value === plugin.id);
  if (same) return { action: 'existing-slot', track, slot: same };

  if (plugin.kind === 'instrument') {
    const inst = slots.find((s) => s.id === 'instrument');
    if (type === 'instrument' && inst && inst.isEmpty) return { action: 'free-slot', track, slot: inst };
    return { action: 'new-track', reason: type === 'instrument' ? `${trackLabel(track)} already has an instrument` : `${trackLabel(track)} is not an instrument track` };
  }

  const free = track.effectSlots.find((s) => s.isEmpty);
  if (free) return { action: 'free-slot', track, slot: free };
  return { action: 'new-track', reason: `${trackLabel(track)} has no free insert` };
}

/** Load `preset` (of `plugin`) where {@link planLoad} says. */
export async function loadPreset(session: Luna.Session, preset: PresetEntry, plugin: PluginEntry, options: { newTrack?: boolean } = {}): Promise<LoadResult> {
  const plan = await planLoad(session, plugin, options);
  if (plan.action === 'existing-slot' && plan.slot) {
    await plan.slot.loadPreset(preset.uid);
    return { action: plan.action, trackName: trackLabel(plan.track), slot: plan.slot.id };
  }
  if (plan.action === 'free-slot' && plan.slot) {
    await plan.slot.setPlugin(plugin.id, { presetUid: preset.uid, presetName: preset.name });
    return { action: plan.action, trackName: trackLabel(plan.track), slot: plan.slot.id };
  }
  const [track] = await session.newTrackFromPreset({ uid: preset.uid, name: preset.name });
  return { action: 'new-track', trackName: trackLabel(track) };
}

/** One line for the status bar after a load. */
export function describe(result: LoadResult, preset: PresetEntry, plugin: PluginEntry): string {
  const what = `${preset.name} (${plugin.name})`;
  if (result.action === 'new-track') return `Made ${result.trackName} with ${what}`;
  if (result.action === 'existing-slot') return `Loaded ${what} on ${result.trackName}`;
  return `Inserted ${what} on ${result.trackName}`;
}
