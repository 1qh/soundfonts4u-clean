import { describe, expect, test } from 'bun:test'
import type { Family } from './families.js'
import { keywordFamilies, leadInstrument, topicOf } from './families.js'
import { byCodeUnit } from './fonts.js'
const cases: { name: string; title: string; want: Family }[] = [
  { name: 'DreamyEP', title: 'an electric piano glued to an adjective', want: 'EPiano' },
  { name: 'BigRoom', title: 'a drum room glued to an adjective', want: 'Drums' },
  { name: 'ChamberStr', title: 'a strings abbreviation glued to a word', want: 'Strings' },
  { name: 'TwinLP', title: 'a guitar model glued to a word', want: 'EGuitar' },
  { name: 'TR-909', title: 'a drum machine written with a dash', want: 'Drums' },
  { name: 'E.Piano 1', title: 'an electric piano written with a dot', want: 'EPiano' },
  { name: 'DynC5', title: 'a piano model with a digit glued to a word', want: 'Piano' },
  { name: 'S&S Bright', title: 'a piano maker written with an ampersand', want: 'Piano' }
]
describe('keywordFamilies', () => {
  test.each(cases)('$title', ({ name, want }) => {
    expect(keywordFamilies(name)).toContain(want)
  })
  test('offers every family a name matches so none is chosen by keyword order', () => {
    expect(keywordFamilies('Steel Drums').toSorted(byCodeUnit)).toStrictEqual(['Acoustic', 'Mallets'])
  })
  test.each(['Bowed Glass', 'Car-Pass', 'Brightness', 'Finger Bass'])(
    'does not read the letters ss inside %s as a piano maker',
    name => {
      expect(keywordFamilies(name)).not.toContain('Piano')
    }
  )
  test('reads a bagpipe as a bagpipe, not a pipe organ', () => {
    expect(keywordFamilies('Bagpipe Ensemble')).not.toContain('Organ')
  })
  test('does not read a plain word as an electric piano', () => {
    expect(keywordFamilies('Tone Piano')).not.toContain('EPiano')
  })
})
describe('topicOf', () => {
  const pianoCases: { name: string; want: string }[] = [
    { name: 'YamC5 + Pad', want: 'PianoLayer' },
    { name: 'Ch Grand+ChamberStr', want: 'PianoLayer' },
    { name: 'Piano & Str.-Fade', want: 'PianoLayer' },
    { name: 'Bell Piano', want: 'PianoLayer' },
    { name: 'Mason&Hamlin-A Grand', want: 'Grand' },
    { name: 'Dark S&S Model B', want: 'Grand' },
    { name: 'Upright Piano Res', want: 'Upright' },
    { name: 'Honky-Tonk', want: 'Upright' },
    { name: 'Yamaha CP80', want: 'Upright' },
    { name: 'Large Concert Grand', want: 'Grand' }
  ]
  test.each(pianoCases)('files $name under $want', ({ name, want }) => {
    expect(topicOf({ family: 'Piano', name })).toBe(want)
  })
  test('leaves a family without topics as itself', () => {
    expect(topicOf({ family: 'Organ', name: 'Rock Organ' })).toBe('Organ')
  })
})
describe('drum topics', () => {
  test.each(['Timpani', 'Taiko Drum', 'Reverse Cymbal', 'Melodic Tom 2', 'Wood Block', 'SFX', 'Castanets'])(
    'files %s under Percussion',
    name => {
      expect(topicOf({ family: 'Drums', name })).toBe('Percussion')
    }
  )
  test.each(['Standard Kit 1', 'Room', 'Jazz', 'TR-808', 'Brush Drums', 'Orchestra Kit'])('files %s under Drums', name => {
    expect(topicOf({ family: 'Drums', name })).toBe('Drums')
  })
})
describe('keyword edges', () => {
  test('files an english horn as a reed, not brass', () => {
    expect(keywordFamilies('English Horn')).toStrictEqual(['Reed'])
  })
  test('reads tremolo as an articulation, not a family', () => {
    expect(keywordFamilies('Slow, Light, Tremolo')).toStrictEqual([])
  })
  test('files a tambourine and a wind chime as percussion', () => {
    expect(keywordFamilies('Tambourine')).toStrictEqual(['Drums'])
    expect(keywordFamilies('Windchimes')).toStrictEqual(['Drums'])
  })
})
describe('layer families', () => {
  test.each([
    ['YamC5+Strings', 'Piano'],
    ['DX7+LowStrings', 'EPiano'],
    ['Harp(EW)+Chambr Str', 'Harp'],
    ['Nylon G+Chamber Str', 'Nylon']
  ] as const)('files %s under the instrument before the plus', (name, want) => {
    expect(leadInstrument({ candidates: keywordFamilies(name), name })).toBe(want)
  })
  test('reads steel drums as pitched mallets, not a kit', () => {
    expect(keywordFamilies('Steel Drums')).not.toContain('Drums')
  })
})
