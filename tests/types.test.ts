import { describe, expect, it } from 'vitest';
import { compType, pluginTypes } from '../src/types';

const CMP = ['Compressors & Limiters'];

describe('plugin types', () => {
  it('tells compressor kinds apart by name', () => {
    const cases: [string, string][] = [
      ['1176 Classic Limiter', 'fet'],
      ['1176AE Rev A', 'fet'],
      ['Empirical Labs Distressor', 'fet'],
      ['Teletronix LA-2A Tube Compressor', 'opto'],
      ['LA-3A Audio Leveler', 'opto'],
      ['Tube-Tech CL 1B', 'opto'],
      ['Fairchild 670', 'varimu'],
      ['Manley Variable Mu', 'varimu'],
      ['Gates Sta-Level', 'varimu'],
      ['SSL G Bus Compressor', 'vca'],
      ['API 2500 Bus Compressor', 'vca'],
      ['dbx 160 Compressor / Limiter', 'vca'],
      ['Neve 33609 Compressor', 'vca'],
      ['Precision Multiband', 'multiband'],
      ['FabFilter Pro-MB', 'multiband'],
      ['Precision Limiter', 'limiter'],
      ['Ozone Maximizer', 'limiter'],
      ['Bettermaker C502V', 'other'],
    ];
    expect(cases.map(([n]) => [n, compType(n)])).toEqual(cases);
  });

  it('puts plugins in EQ, compressors and the rest by LUNA category, else by name', () => {
    expect(pluginTypes('Pultec EQP-1A', ['EQ'], 'effect')).toEqual(['eq']);
    expect(pluginTypes('Bettermaker EQ232D', [], 'effect')).toEqual(['eq']);
    expect(pluginTypes('1176 Classic Limiter', CMP, 'effect')).toEqual(['comp']);
    expect(pluginTypes('API Vision Channel Strip', ['Channel Strips'], 'effect')).toContain('strip');
    expect(pluginTypes('Pure Plate Reverb', ['Reverb'], 'effect')).toEqual(['reverb']);
    expect(pluginTypes('Galaxy Tape Echo', [], 'effect')).toContain('delay');
    expect(pluginTypes('Moog Minimoog', ['Synth'], 'instrument')).toEqual([]);
  });
});
