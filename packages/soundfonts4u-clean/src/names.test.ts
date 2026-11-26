import { describe, expect, test } from 'bun:test'
import { BasicInstrument, BasicPreset, BasicSoundBank, EmptySample, SoundBankLoader } from 'spessasynth_core'
import type { Family } from './families.js'
import type { SourcePreset } from './fonts.js'
import { planFonts } from './cli.js'
import { assignNames, isSourceAbbreviation } from './names.js'
import { buildFamilyFont } from './write.js'
const preset = (name: string, program: number): SourcePreset => ({
  instruments: [],
  key: `fixture.sf2|0|${program}`,
  name,
  recordings: [],
  slot: { bank: 0, isDrum: false, program },
  sourceFile: 'fixture.sf2'
})
const fixtureInstrument = (sourceBank: BasicSoundBank) => {
  const sample = new EmptySample()
  sample.name = 'Fixture sample'
  sample.loopEnd = 4
  sample.setStoredData({ data: new Uint8Array(8), form: 's16le' })
  sourceBank.addSamples(sample)
  const instrument = new BasicInstrument()
  instrument.name = 'Fixture instrument'
  instrument.createZone(sample)
  sourceBank.addInstruments(instrument)
  return instrument
}
const fixtureMembers = async (planned: readonly { key: string; name: string }[]) => {
  await BasicSoundBank.ready
  const sourceBank = new BasicSoundBank('sf2', false)
  const instrument = fixtureInstrument(sourceBank)
  return planned.map((m, program) => {
    const source = new BasicPreset(sourceBank)
    source.name = m.key
    source.program = 127 - program
    source.createZone(instrument)
    sourceBank.addPresets(source)
    return { name: m.name, source }
  })
}
describe('isSourceAbbreviation', () => {
  test.each(['OB', 'JP', 'KG', 'CC', 'DG', 'RF', 'AR', 'SG', 'CP', 'C', 'V'])('drops %s', w => {
    expect(isSourceAbbreviation(w)).toBe(true)
  })
  test.each(['EP', 'FM', 'DX', 'TR', 'SFX', 'Pad', 'Saw', 'Dry', 'Lead'])('keeps %s', w => {
    expect(isSourceAbbreviation(w)).toBe(false)
  })
})
describe('assignNames', () => {
  test('expands shorthand before dropping implied words and source marks', async () => {
    const fixtures: { family: Family; name: string; want: string }[] = [
      { family: 'Strings', name: 'Cbs Section', want: 'ContrabassSection' },
      { family: 'Fx', name: 'Fl. Key Click', want: 'FluteKeyClick' },
      { family: 'EGuitar', name: 'Rol Steel Guitar', want: 'Steel' },
      { family: 'EGuitar', name: 'Gu Muted Gt', want: 'Muted' },
      { family: 'Organ', name: 'Sc-55 Map Jazz Org', want: 'Jazz' },
      { family: 'Strings', name: 'Sybs Le Chamber Str', want: 'Chamber' },
      { family: 'Piano', name: 'S&S Mod B Dyn', want: 'Dynamic' },
      { family: 'Synth', name: '5th Sqr', want: 'FifthSquare' },
      { family: 'Ethnic', name: 'Accordeon Vel', want: 'AccordionVelocity' },
      { family: 'Brass', name: 'Ful Orc', want: 'FullOrchestra' },
      { family: 'Acoustic', name: 'Stl Gt Har', want: 'Harmonics' },
      { family: 'Synth', name: 'Dist Harm', want: 'DistortionHarmonics' },
      { family: 'Synth', name: 'Slow Trm Pad', want: 'SlowTremoloPad' },
      { family: 'Synth', name: 'Fast Trem Pad', want: 'FastTremoloPad' }
    ]
    const entries = fixtures.map((f, i) => ({ family: f.family, preset: preset(f.name, i) }))
    const presets = entries.map(e => e.preset)
    const labels = new Map(entries.map(e => [e.preset.key, e.family]))
    const { names, problems } = await assignNames({ embeddings: new Map(), labels, presets })
    expect(problems).toStrictEqual([])
    expect(names.size).toBeGreaterThan(0)
    expect([...names.values()]).toStrictEqual(fixtures.map(f => f.want))
  })
  test('keeps full words in an over-length name and reports its length', async () => {
    const long = preset('Dynamic Large Small Velocity Tremolo', 0)
    const { names, problems } = await assignNames({ embeddings: new Map(), labels: new Map(), presets: [long] })
    const name = 'DynamicLargeSmallVelocityTremolo'
    expect(names.size).toBeGreaterThan(0)
    expect(names.get(long.key)).toBe(name)
    expect(problems.length).toBeGreaterThan(0)
    expect(problems).toStrictEqual([{ key: long.key, name, problem: '32 chars' }])
  })
  test('chooses descriptors that fit a clashing 16-character base name', async () => {
    const first = preset('Expressive Guitar', 0)
    const second = preset('Expressive Guitar', 1)
    const vectors = new Map([
      ['a airy sound', [0.6, 0, 0.8]],
      ['a big sound', [0, 0.6, 0.8]],
      ['a bright sound', [1, 0, 0]],
      ['a mellow sound', [0, 1, 0]]
    ])
    const { names, problems } = await assignNames({
      embedDescriptors: async prompts => Promise.resolve(prompts.map(p => vectors.get(p) ?? [0, 0, 1])),
      embeddings: new Map([
        [first.key, [1, 0, 0]],
        [second.key, [0, 1, 0]]
      ]),
      labels: new Map(),
      presets: [first, second]
    })
    expect(names.size).toBeGreaterThan(0)
    expect([...names.values()]).toStrictEqual(['ExpressiveGuitarAiry', 'ExpressiveGuitarBig'])
    expect(problems).toStrictEqual([])
  })
  test('skips a descriptor already present in the base name', async () => {
    const first = preset('DX airy', 0)
    const second = preset('DX Airy', 1)
    const { names, problems } = await assignNames({
      embedDescriptors: async prompts => {
        const vectors = new Map([
          ['a airy sound', [1, 0]],
          ['a big sound', [0, 1]]
        ])
        return Promise.resolve(prompts.map(p => vectors.get(p) ?? [0, 0]))
      },
      embeddings: new Map([
        [first.key, [1, 0]],
        [second.key, [0, 1]]
      ]),
      labels: new Map(),
      presets: [first, second]
    })
    expect(problems).toStrictEqual([])
    expect(names.size).toBeGreaterThan(0)
    expect([...names.values()]).toStrictEqual(['DxAiryBold', 'DxAiryBig'])
  })
  const repeatedWords = [
    { name: 'Dark dark', want: 'DarkDark' },
    { name: 'FM FM', want: 'FMFM' }
  ]
  test.each(repeatedWords)('reports repeated words in $want', async ({ name, want }) => {
    const repeated = preset(name, 0)
    const { problems } = await assignNames({ embeddings: new Map(), labels: new Map(), presets: [repeated] })
    expect(problems.length).toBeGreaterThan(0)
    expect(problems).toStrictEqual([{ key: repeated.key, name: want, problem: 'repeated word' }])
  })
})
describe('output ordering', () => {
  const fontPlan = () => {
    const fixtures: { family: Family; name: string }[] = [
      { family: 'Organ', name: 'Zest' },
      { family: 'Organ', name: 'DxPad' },
      { family: 'Harp', name: 'Pluck' },
      { family: 'Organ', name: 'Dusk' },
      { family: 'Bass', name: 'Deep' },
      { family: 'Organ', name: 'DXPad' }
    ]
    const entries = fixtures.map((f, i) => Object.assign(f, { preset: preset(f.family, i) }))
    return planFonts({
      embeddings: new Map(),
      labels: new Map(entries.map(f => [f.preset.key, f.family])),
      names: new Map(entries.map(f => [f.preset.key, f.name])),
      presets: entries.map(f => f.preset),
      recordingBytes: new Map(),
      tones: new Map()
    })
  }
  test('assigns banks by alphabetical file name', () => {
    const plan = fontPlan()
    expect(plan.length).toBeGreaterThan(0)
    expect(plan.map(f => [f.fileName, f.bank])).toStrictEqual([
      ['Bass', 0],
      ['Harp', 1],
      ['Organ', 2]
    ])
  })
  test('writes consecutive programs by final name with exact casing as the tie-break', async () => {
    const plan = fontPlan()
    expect(plan.length).toBeGreaterThan(0)
    const font = plan.find(f => f.fileName === 'Organ')
    if (font === undefined) throw new Error('missing Organ fixture')
    expect(font.members.length).toBeGreaterThan(0)
    const members = await fixtureMembers(font.members)
    const bytes = buildFamilyFont({
      creationDate: new Date(0),
      font: { ...font, members }
    })
    const { presets } = SoundBankLoader.fromArrayBuffer(bytes)
    expect(presets.length).toBeGreaterThan(0)
    expect(presets.map(p => [p.name, p.program, p.bankMSB])).toStrictEqual([
      ['Dusk', 0, 2],
      ['DXPad', 1, 2],
      ['DxPad', 2, 2],
      ['Zest', 3, 2]
    ])
  })
})
