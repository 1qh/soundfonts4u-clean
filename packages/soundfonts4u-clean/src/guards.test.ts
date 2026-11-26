import { describe, expect, test } from 'bun:test'
import {
  BasicInstrument,
  BasicMIDI,
  BasicPreset,
  BasicSoundBank,
  EmptySample,
  MIDIControllers,
  MIDIMessageTypes
} from 'spessasynth_core'
import { presetKey, SF2_DRUM_BANK, slotOf } from './fonts.js'
import { buildProbeMidi, segmentSeconds } from './render.js'
import { cloneNeeds, stagedNames } from './stage.js'
const slots = [
  { bank: 0, isDrum: false, program: 0 },
  { bank: SF2_DRUM_BANK, isDrum: true, program: 0 },
  { bank: 5, isDrum: true, program: 1 }
]
const probeSegment = (index: number) => {
  const midi = BasicMIDI.fromArrayBuffer(buildProbeMidi(slots))
  const tempo = midi.tempoChanges.find(t => t.ticks === 0)
  if (tempo === undefined) throw new Error('probe MIDI has no starting tempo')
  const segmentTicks = Math.round((segmentSeconds() * tempo.tempo * midi.timeDivision) / 60)
  const start = index * segmentTicks
  const boundary = start + segmentTicks
  const events = midi.tracks.flatMap(t => t.events).filter(e => e.ticks >= start && e.ticks <= boundary)
  return { boundary, events }
}
const createSharedSample = () => {
  const pcm = new Int16Array([0, 1024, -1024, 0])
  const sample = new EmptySample()
  sample.name = 'Shared sample'
  sample.loopEnd = pcm.length
  sample.setStoredData({ data: new Uint8Array(pcm.buffer), form: 's16le' })
  return sample
}
const createSharedPresets = (source: BasicSoundBank, instrument: BasicInstrument) => {
  const first = new BasicPreset(source)
  first.name = 'First preset'
  first.createZone(instrument)
  const second = new BasicPreset(source)
  second.name = 'Second preset'
  second.program = 1
  second.createZone(instrument)
  return { first, second }
}
const createSharedPresetBank = () => {
  const source = new BasicSoundBank('sf2', false)
  const sample = createSharedSample()
  source.addSamples(sample)
  const instrument = new BasicInstrument()
  instrument.name = 'Shared instrument'
  instrument.createZone(sample)
  source.addInstruments(instrument)
  const { first, second } = createSharedPresets(source, instrument)
  source.addPresets(first, second)
  return source
}
const createSharedPresetNeeds = () => {
  const source = createSharedPresetBank()
  const sourceFile = 'shared.sf2'
  const byKey = new Map(source.presets.map(p => [presetKey({ slot: slotOf(p), sourceFile }), p] as const))
  const needs = Array.from(byKey.keys(), key => ({ fileName: 'Family', key }))
  return { byKey, needs, sourceFile }
}
describe('soundfont guards', () => {
  test.each([
    { index: 0, slotName: 'melodic preset' },
    { index: 1, slotName: 'bank 128 drum kit' },
    { index: 2, slotName: 'bank 5 drum preset' }
  ])('silences both channels before the end of the $slotName segment', ({ index }) => {
    expect(slots.length).toBeGreaterThan(index)
    const { boundary, events } = probeSegment(index)
    const noteOffTicks = events
      .filter(e => {
        const status = e.statusByte - (e.statusByte % 16)
        return status === MIDIMessageTypes.noteOff || (status === MIDIMessageTypes.noteOn && e.data[1] === 0)
      })
      .map(e => e.ticks)
    expect(noteOffTicks.length).toBeGreaterThan(0)
    const lastNoteOff = Math.max(...noteOffTicks)
    const silence = events.filter(
      e => e.ticks > lastNoteOff && e.ticks < boundary && e.data[0] === MIDIControllers.allSoundOff
    )
    expect(silence.some(e => e.statusByte === MIDIMessageTypes.controllerChange)).toBe(true)
    expect(silence.some(e => e.statusByte === MIDIMessageTypes.controllerChange + 9)).toBe(true)
  })
  test('one staging clone session shares the instrument and sample across both presets', () => {
    const { byKey, needs, sourceFile } = createSharedPresetNeeds()
    expect(needs).toHaveLength(2)
    const names = stagedNames(new Map([[sourceFile, needs]]))
    const stage = new BasicSoundBank('sf2', false)
    cloneNeeds({ byKey, names, needs, stage, u: { path: sourceFile, sha256: '', size: 0 } })
    expect(stage.presets).toHaveLength(2)
    expect(stage.instruments).toHaveLength(1)
    expect(stage.samples).toHaveLength(1)
  })
  test('staged names are unique and fit the SF2 name field', () => {
    const sourceFile = 'A long shared SoundFont filename that exceeds the SF2 preset name limit.sf2'
    const needs = Array.from({ length: 300 }, (_, i) => ({
      fileName: 'Family',
      key: presetKey({ slot: { bank: Math.floor(i / 128), isDrum: false, program: i % 128 }, sourceFile })
    }))
    expect(needs.length).toBeGreaterThan(0)
    const names = [...stagedNames(new Map([[sourceFile, needs]])).values()]
    expect(names).toHaveLength(needs.length)
    for (const name of names) expect(name.length).toBeLessThanOrEqual(20)
    expect(new Set(names).size).toBe(needs.length)
  })
})
