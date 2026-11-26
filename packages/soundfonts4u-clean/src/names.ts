import type { Family } from './families.js'
import type { SourcePreset } from './fonts.js'
import { cosineDistance, embedTexts } from './embed.js'
import { HAND_NAMES } from './hand-table.js'
import { spacedWords, splitWords } from './text.js'
const MAX_NAME_LENGTH = 20
const VALID_NAME = /^[A-Z][A-Za-z]*$/v
const NOT_THE_SOUND = new Set([
  'abbey',
  'best',
  'bosendorfer',
  'bs',
  'ch',
  'chateau',
  'deluxe',
  'dore',
  'essential',
  'extended',
  'fazioli',
  'fender',
  'gibson',
  'gs',
  'gu',
  'hamlin',
  'jn',
  'kawai',
  'kbh',
  'korg',
  'le',
  'lite',
  'map',
  'mark',
  'marks',
  'mason',
  'mh',
  'mod',
  'nice',
  'ny',
  'orpheus',
  'ortheus',
  'p',
  'performer',
  'plus',
  'pro',
  'real',
  'rol',
  'roland',
  's',
  'sal',
  'salamander',
  'sc',
  'sgm',
  'sso',
  'steinway',
  'sybs',
  'ultimate',
  'universal',
  'yam',
  'yamaha'
])
const DIGIT_WORDS: Readonly<Record<string, string>> = { dx: 'Dx', s: 'S' }
const words = splitWords
const camel = (parts: string[]): string =>
  parts
    .map(
      w => DIGIT_WORDS[w.toLowerCase()] ?? (w.length > 3 && w === w.toUpperCase() ? w[0] + w.slice(1).toLowerCase() : w)
    )
    .map(w => (w[0]?.toUpperCase() ?? '') + w.slice(1))
    .join('')
const FAMILY_WORDS: Readonly<Partial<Record<Family, readonly string[]>>> = {
  Acoustic: ['acoustic', 'guitar', 'gtr', 'steel'],
  Bass: ['bass'],
  Drums: ['drum', 'drums', 'kit'],
  EGuitar: ['electric', 'guitar', 'gtr'],
  EPiano: ['ep', 'electric', 'piano', 'e'],
  Flute: ['flute'],
  Harp: ['harp'],
  Harpsichord: ['harpsichord'],
  Nylon: ['nylon', 'guitar', 'gtr'],
  Organ: ['organ'],
  Piano: ['grand', 'piano'],
  Strings: ['strings', 'string', 'str']
}
const DESCRIPTORS = [
  'Airy',
  'Big',
  'Bold',
  'Bright',
  'Breathy',
  'Clean',
  'Close',
  'Crisp',
  'Dark',
  'Deep',
  'Dry',
  'Dull',
  'Fat',
  'Full',
  'Glassy',
  'Gritty',
  'Hard',
  'Harsh',
  'Hollow',
  'Light',
  'Lush',
  'Mellow',
  'Muted',
  'Nasal',
  'Open',
  'Punchy',
  'Rich',
  'Round',
  'Sharp',
  'Short',
  'Smooth',
  'Soft',
  'Sparkly',
  'Thick',
  'Thin',
  'Tight',
  'Vintage',
  'Warm',
  'Wet',
  'Wide'
] as const
const SOUND_ABBREVIATIONS = new Set(['CR', 'DX', 'EP', 'FM', 'SD', 'SFX', 'TR'])
const SPELLED: Readonly<Record<string, string>> = {
  accordeon: 'accordion',
  accordian: 'accordion',
  brt: 'bright',
  cbs: 'contrabass',
  cym: 'cymbal',
  dis: 'distortion',
  dist: 'distortion',
  dyn: 'dynamic',
  exp: 'expressive',
  fl: 'flute',
  ful: 'full',
  gt: 'guitar',
  har: 'harmonics',
  harm: 'harmonics',
  lg: 'large',
  lge: 'large',
  med: 'medium',
  oct: 'octave',
  orc: 'orchestra',
  org: 'organ',
  orhcestra: 'orchestra',
  pic: 'pick',
  res: 'resonance',
  rez: 'resonance',
  sm: 'small',
  sml: 'small',
  sq: 'square',
  sqr: 'square',
  st: 'stereo',
  std: 'standard',
  stl: 'steel',
  str: 'strings',
  sus: 'sustain',
  syn: 'synth',
  th: 'fifth',
  trem: 'tremolo',
  trm: 'tremolo',
  var: 'variable',
  vel: 'velocity',
  whistlin: 'whistling'
}
const ACRONYM_BOUNDARY = /(?<initial>[A-Z])(?<word>[A-Z][a-z])/gv
const SOUND_ABBREVIATION_PATTERN = new RegExp([...SOUND_ABBREVIATIONS].join('|'), 'gv')
const nameWords = (name: string): string[] => {
  const spaced = spacedWords(name.replaceAll(ACRONYM_BOUNDARY, '$<initial> $<word>'))
  return spaced.split(' ').flatMap(w => {
    const abbreviations = Array.from(w.matchAll(SOUND_ABBREVIATION_PATTERN), m => m[0])
    const parts = abbreviations.length > 0 && abbreviations.join('') === w ? abbreviations : [w]
    return parts.map(part => part.toLowerCase())
  })
}
const isSourceAbbreviation = (w: string): boolean =>
  w.length === 1 || (w.length <= 3 && w === w.toUpperCase() && !SOUND_ABBREVIATIONS.has(w))
const baseName = ({ family, p }: { family: Family | undefined; p: SourcePreset }): string => {
  const implied = new Set(family === undefined ? [] : (FAMILY_WORDS[family] ?? []))
  const all = words(p.name).map(w => SPELLED[w.toLowerCase()] ?? w)
  return camel(
    all.filter(w => !(implied.has(w.toLowerCase()) || NOT_THE_SOUND.has(w.toLowerCase()) || isSourceAbbreviation(w)))
  )
}
interface NameProblem {
  key: string
  name: string
  problem: string
}
const baseNames = ({ labels, presets }: { labels: Map<string, Family>; presets: SourcePreset[] }): Map<string, string> => {
  const names = new Map<string, string>()
  for (const p of presets) names.set(p.key, HAND_NAMES[p.key] ?? baseName({ family: labels.get(p.key), p }))
  return names
}
const groupByName = ({
  names,
  presets
}: {
  names: Map<string, string>
  presets: SourcePreset[]
}): Map<string, SourcePreset[]> => {
  const groups = new Map<string, SourcePreset[]>()
  for (const p of presets) {
    const n = names.get(p.key) ?? ''
    groups.set(n, [...(groups.get(n) ?? []), p])
  }
  return groups
}
const collidingDerived = ({ names, presets }: { names: Map<string, string>; presets: SourcePreset[] }): SourcePreset[] => {
  const collisions = groupByName({ names, presets })
  return [...collisions.entries()]
    .filter(([name, group]) => group.length > 1 || name.length === 0)
    .map(([, group]) => group)
    .flatMap(group => group.filter(g => HAND_NAMES[g.key] === undefined))
}
const similarity = (a: number[], b: number[]): number => 1 - cosineDistance(a, b)
interface DescriptorPair {
  key: string
  score: number
  word: string
}
const chooseDescriptors = (pairs: DescriptorPair[], existingWords: Set<string>): Map<string, string> => {
  const sorted = pairs.toSorted((a, b) => b.score - a.score || a.key.localeCompare(b.key) || a.word.localeCompare(b.word))
  const candidates = sorted.filter(pair => pair.word.length > 0 && !existingWords.has(pair.word.toLowerCase()))
  const chosen = new Map<string, string>()
  const usedWords = new Set<string>()
  const choose = ({ key, word }: DescriptorPair) => {
    if (chosen.has(key) || usedWords.has(word)) return
    chosen.set(key, word)
    usedWords.add(word)
  }
  for (const pair of candidates) choose(pair)
  return chosen
}
const pickDescriptors = ({
  group,
  name,
  words: wordVectors
}: {
  group: { embedding: number[]; key: string }[]
  name: string
  words: number[][]
}): Map<string, string> => {
  const mean = wordVectors.map(w => {
    let total = 0
    for (const m of group) total += similarity(m.embedding, w)
    return total / group.length
  })
  const pairs = group
    .flatMap(m =>
      wordVectors.map((w, wi) => ({
        key: m.key,
        score: similarity(m.embedding, w) - (mean[wi] ?? 0),
        word: DESCRIPTORS[wi] ?? ''
      }))
    )
    .filter(pair => name.length + pair.word.length <= MAX_NAME_LENGTH)
  return chooseDescriptors(pairs, new Set(nameWords(name)))
}
const addDescriptors = async ({
  embedDescriptors,
  embeddings,
  names,
  presets
}: {
  embedDescriptors: typeof embedTexts
  embeddings: Map<string, number[]>
  names: Map<string, string>
  presets: SourcePreset[]
}) => {
  const collidingPresets = collidingDerived({ names, presets })
  const groups = groupByName({ names, presets: collidingPresets })
  if (groups.size === 0) return
  const wordVectors = await embedDescriptors(DESCRIPTORS.map(d => `a ${d.toLowerCase()} sound`))
  for (const [name, group] of groups) {
    const members = group.flatMap(p => {
      const embedding = embeddings.get(p.key)
      return embedding === undefined ? [] : [{ embedding, key: p.key }]
    })
    const chosen = pickDescriptors({ group: members, name, words: wordVectors })
    for (const [key, word] of chosen) names.set(key, `${names.get(key) ?? ''}${word}`)
  }
}
const formatProblems = ({ key, name }: { key: string; name: string }): NameProblem[] => {
  const parts = nameWords(name)
  return [
    ...(VALID_NAME.test(name) ? [] : [{ key, name, problem: 'not CamelCase letters only' }]),
    ...(name.length > MAX_NAME_LENGTH ? [{ key, name, problem: `${name.length} chars` }] : []),
    ...(new Set(parts).size < parts.length ? [{ key, name, problem: 'repeated word' }] : [])
  ]
}
const clashProblems = ({ key, name, seen }: { key: string; name: string; seen: Map<string, string> }): NameProblem[] => {
  const clash = seen.get(name)
  if (clash !== undefined) return [{ key, name, problem: `same name as ${clash}` }]
  seen.set(name, key)
  return []
}
const findProblems = ({ names, presets }: { names: Map<string, string>; presets: SourcePreset[] }): NameProblem[] => {
  const problems: NameProblem[] = []
  const seen = new Map<string, string>()
  const sorted = presets.toSorted((a, b) => a.key.localeCompare(b.key))
  for (const p of sorted) {
    const n = names.get(p.key) ?? ''
    problems.push(...formatProblems({ key: p.key, name: n }), ...clashProblems({ key: p.key, name: n, seen }))
  }
  return problems
}
const SHORT_FORMS: readonly (readonly [RegExp, string])[] = [
  [/Italian/gv, ''],
  [/Harpsichord/gv, '']
]
const shorten = (name: string): string => {
  let out = name
  for (const [pattern, short] of SHORT_FORMS) out = out.replaceAll(pattern, short)
  return out
}
const assignNames = async ({
  embedDescriptors = embedTexts,
  embeddings,
  labels,
  presets
}: {
  embedDescriptors?: typeof embedTexts
  embeddings: Map<string, number[]>
  labels: Map<string, Family>
  presets: SourcePreset[]
}): Promise<{ names: Map<string, string>; problems: NameProblem[] }> => {
  const names = baseNames({ labels, presets })
  const descriptorInputs = { embedDescriptors, embeddings, names, presets }
  await addDescriptors(descriptorInputs)
  await addDescriptors(descriptorInputs)
  await addDescriptors(descriptorInputs)
  await addDescriptors(descriptorInputs)
  for (const [key, name] of names) if (name.length > MAX_NAME_LENGTH) names.set(key, shorten(name))
  return { names, problems: findProblems({ names, presets }) }
}
export type { NameProblem }
export { assignNames, isSourceAbbreviation, MAX_NAME_LENGTH }
