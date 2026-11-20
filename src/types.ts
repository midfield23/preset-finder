// Plugin types for the quick filters: what a plugin is (EQ, compressor, reverb...) and, for
// compressors, which kind. LUNA's categories say EQ or Compressors & Limiters but not FET or
// Opto, so the compressor kind is read from the plugin's name: model numbers and words that
// name the circuit (1176, LA-2A, Fairchild, SSL bus, "multiband"). A compressor the name says
// nothing about is "Other".

export type PluginType = 'eq' | 'comp' | 'reverb' | 'delay' | 'saturation' | 'strip' | 'mod' | 'amp';
export type CompType = 'fet' | 'opto' | 'vca' | 'varimu' | 'multiband' | 'limiter' | 'other';

export const TYPE_LABELS: [PluginType, string][] = [
  ['eq', 'EQ'],
  ['comp', 'Compressors'],
  ['strip', 'Channel strips'],
  ['reverb', 'Reverb'],
  ['delay', 'Delay'],
  ['saturation', 'Saturation'],
  ['mod', 'Modulation'],
  ['amp', 'Amps'],
];

export const COMP_LABELS: [CompType, string][] = [
  ['fet', 'FET'],
  ['opto', 'Opto'],
  ['vca', 'VCA'],
  ['varimu', 'Vari-Mu'],
  ['multiband', 'Multiband'],
  ['limiter', 'Limiter'],
  ['other', 'Other'],
];

// By LUNA category (any of a plugin's categories), then by name for plugins whose categories
// say nothing useful (some third-party plugins report none).
const BY_CATEGORY: [PluginType, RegExp][] = [
  ['eq', /\beq\b|equali[sz]|filter/i],
  ['comp', /compress|dynamic|limit/i],
  ['strip', /channel ?strip|console/i],
  ['reverb', /reverb|room|space/i],
  ['delay', /delay|echo/i],
  ['saturation', /satur|distort|tape|harmonic/i],
  ['mod', /modulat|chorus|flang|phas/i],
  ['amp', /\bamp|guitar|bass amp|cabinet/i],
];

const BY_NAME: [PluginType, RegExp][] = [
  ['eq', /\beq\b|\beq[-\d]|equali[sz]|pultec|\bmeq\b|pro-?q|\bq\d|1073|1084|550a|560\b|maag/i],
  ['comp', /compress|\bcomp\b|limiter|1176|la-?[23]a|fairchild|\bopto\b|vari-?mu|distressor|\bbus ?comp|g ?bus|2500\b|33609|dbx ?160|\bmaximi[sz]er|\bl[123]\b|multiband|de-?ess/i],
  ['strip', /channel ?strip|\bconsole\b|\bstrip\b/i],
  ['reverb', /reverb|\bverb\b|plate|\b(emt|lexicon)\b|chamber|\broom\b|\bhall\b|spring/i],
  ['delay', /delay|echo|\bep-?34\b|space echo|tape echo/i],
  ['saturation', /satur|distort|decapitator|\btape\b|studer|ampex|harmonic|exciter/i],
  ['mod', /chorus|flang|phaser|tremolo|vibrato|rotary|leslie|ensemble/i],
  ['amp', /\bamp\b|amplifier|marshall|fender|\bvox\b|ampeg|mesa|cabinet|\bcab\b|guitar studio/i],
];

/** The quick-filter types a plugin belongs to. Instruments belong to none. */
export function pluginTypes(name: string, categories: readonly string[], kind: 'effect' | 'instrument'): PluginType[] {
  if (kind === 'instrument') return [];
  const out = new Set<PluginType>();
  for (const [t, re] of BY_CATEGORY) if (categories.some((c) => re.test(c))) out.add(t);
  for (const [t, re] of BY_NAME) if (re.test(name)) out.add(t);
  return [...out];
}

// Checked in this order, first match wins: an "1176 Classic Limiter" is a FET compressor, not a
// limiter, and a "Precision Multiband" is multiband before anything else.
const COMP_RULES: [CompType, RegExp][] = [
  ['multiband', /multi-?band|\bmb\b|pro-?mb|\bc[46]\b|\bl3\b|dynamic eq|precision k-?stereo/i],
  ['fet', /\bfet\b|1176|\b76\b|urei|distressor|\bel8\b|purple audio|mc77|fetish|\bfet-?\d/i],
  ['opto', /\bopto\b|la-?2a|la-?3a|teletronix|cl ?1b|tube-?tech|\bla-?2\b|\bltd-?2\b|\bopto-?/i],
  ['varimu', /vari-?mu|variable[- ]mu|fairchild|\b6[67]0\b|sta-?level|manley|\bmu\b|gates/i],
  ['vca', /\bvca\b|\bssl\b|g ?bus|bus ?comp|dbx|\b160\b|api ?2500|\b2500\b|33609|focusrite red|glue|\bvc ?\d|ssl ?g|shadow hills|elysia|alpha compressor|neve ?2254|\b2254\b/i],
  ['limiter', /limit|maximi[sz]er|\bl[12]\b|precision limiter|loudness/i],
];

/** The kind of compressor, guessed from the name; only meaningful for 'comp' plugins. */
export function compType(name: string): CompType {
  for (const [t, re] of COMP_RULES) if (re.test(name)) return t;
  return 'other';
}
