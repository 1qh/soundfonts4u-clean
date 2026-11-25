import type { Family } from './families.js'
const HAND_FAMILIES: Readonly<Record<string, Family>> = {
  '2Grands-Plus-Instruments-bs16i-v4.0.sf2|0|74': 'Piano',
  'Chris Mandolin-4U-v3.0.sf2|0|4': 'Ethnic',
  'Chris Mandolin-4U-v3.0.sf2|0|8': 'Ethnic',
  'Chris Mandolin-4U-v3.0.sf2|0|9': 'Ethnic',
  'Concert-Chateau-Upright-Pianos-bs-16i-v3.2.sf2|0|15': 'Piano',
  'Essential Keys-bs16i-v11.1.sf2|0|34': 'Piano',
  'Essential Keys-sforzando-v9.6.sf2|0|52': 'Piano',
  'KBH-Real-Choir-V2.5.sf2|0|4': 'Choir',
  'MasonHamlin-A-v7.sf2|0|0': 'Piano',
  'MasonHamlin-A-v7.sf2|0|1': 'Piano',
  'MasonHamlin-A-v7.sf2|0|2': 'Piano',
  'MasonHamlin-A-v7.sf2|0|3': 'Piano',
  'MasonHamlin-A-v7.sf2|0|4': 'Piano',
  'Nice-Instruments-Extended-V1.3.sf2|0|11': 'EPiano',
  'Nice-Instruments-Extended-V1.3.sf2|0|64': 'Fx',
  'Nice-Instruments-Extended-V1.3.sf2|0|77': 'Organ',
  'Nice-Keys-Ultimate-V2.3.sf2|0|6': 'Piano',
  'Nice-Keys-Ultimate-V2.3.sf2|0|7': 'Piano',
  'Nice-Keys-Ultimate-V2.3.sf2|1|8': 'Piano',
  'Nice-Keys-Ultimate-V2.3.sf2|5|8': 'Piano',
  'Nice-Keys-Ultimate-V2.3.sf2|6|8': 'Piano',
  'Nice-Keys-Ultimate-V2.3.sf2|7|8': 'Piano',
  'Nice-Keys-Ultimate-V2.3.sf2|8|8': 'Piano',
  'P125-Performer-POGS-v3.0.sf2|0|99': 'Piano',
  'Rhodes EPs Plus-v2.3.sf2|0|3': 'EPiano',
  'Rhodes EPs Plus-v2.3.sf2|0|6': 'EPiano',
  'Yamaha-C5-Salamander-JNv5.1.sf2|0|8': 'Piano'
}
const HAND_NAMES: Readonly<Record<string, string>> = {
  '2Grands-Plus-Instruments-bs16i-v4.0.sf2|0|17': 'BellBrightGlassy',
  '2Grands-Plus-Instruments-bs16i-v4.0.sf2|0|18': 'BellSlowTremSparkly',
  '2Grands-Plus-Instruments-bs16i-v4.0.sf2|0|19': 'BellFastTremDark',
  '2Grands-Plus-Instruments-bs16i-v4.0.sf2|0|27': 'SmPleinJeuSparkly',
  '2Grands-Plus-Instruments-bs16i-v4.0.sf2|0|28': 'PadPleinJeuVintage',
  '2Grands-Plus-Instruments-bs16i-v4.0.sf2|0|59': 'CoilFxPickMuted',
  '2Grands-Plus-Instruments-bs16i-v4.0.sf2|0|60': 'CoilMutedGlassy',
  'Best of Guitars-4U-v1.0.sf2|0|12': 'CoilMutedSparkly',
  'Essential Keys-bs16i-v11.1.sf2|0|9': 'SlowTremSparkly',
  'Guitars-Universal-V1.5.sf2|0|27': 'CoilFxPickClean',
  'Rhodes EPs Plus-v2.3.sf2|0|10': 'BellBrightSharp',
  'Rhodes EPs Plus-v2.3.sf2|0|11': 'BellSlowTremHard',
  'Rhodes EPs Plus-v2.3.sf2|0|12': 'BellFastTremPunchy'
}
const SUBFAMILY_NAMES: Readonly<Partial<Record<Family, readonly string[]>>> = {
  Drums: ['Drums', 'Timpani'],
  Fx: ['Fx', 'Noise']
}
export { HAND_FAMILIES, HAND_NAMES, SUBFAMILY_NAMES }
