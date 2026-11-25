import type { Family } from './families.js'
import type { SourcePreset } from './fonts.js'
import { cosineDistance, embedTexts } from './embed.js'
import { splitWords } from './text.js'
import { HAND_NAMES } from './hand-table.js'
const MAX_NAME_LENGTH = 20
const VALID_NAME = /^[A-Z][A-Za-z]*$/v
const NOT_THE_SOUND = new Set([
  'abbey', 'best', 'bosendorfer', 'bs', 'chateau', 'ch', 'deluxe', 'dore', 'essential', 'extended', 'fazioli', 'fender',
  'gibson', 'gs', 'gu', 'hamlin', 'jn', 'kawai', 'kbh', 'korg', 'lite', 'mark', 'marks', 'mason', 'mh', 'nice', 'ny',
  'orpheus', 'ortheus', 'p', 'performer', 'plus', 'pro', 'real', 'roland', 's', 'sal', 'salamander', 'sgm', 'sso',
  'steinway', 'ultimate', 'universal', 'yam', 'yamaha'
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
  Nylon: ['nylon', 'guitar', 'gtr'],
  Organ: ['organ'],
  Piano: ['grand', 'piano'],
  Harpsichord: ['harpsichord'],
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
const baseName = ({ family, p }: { family: Family | undefined; p: SourcePreset }): string => {
  const implied = new Set(family === undefined ? [] : (FAMILY_WORDS[family] ?? []))
  const all = words(p.name)
  return camel(all.filter(w => !implied.has(w.toLowerCase()) && !NOT_THE_SOUND.has(w.toLowerCase())))
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
const collidingDerived = ({ names, presets }: { names: Map<string, string>; presets: SourcePreset[] }): SourcePreset[] => {
  const collisions = new Map<string, SourcePreset[]>()
  for (const p of presets) {
    const n = names.get(p.key) ?? ''
    collisions.set(n, [...(collisions.get(n) ?? []), p])
  }
  return [...collisions.entries()]
    .filter(([name, group]) => group.length > 1 || name.length === 0)
    .map(([, group]) => group)
    .flatMap(group => group.filter(g => HAND_NAMES[g.key] === undefined))
}
const similarity = (a: number[], b: number[]): number => 1 - cosineDistance(a, b)
const pickDescriptors = ({
  group,
  words: wordVectors
}: {
  group: { embedding: number[]; key: string }[]
  words: number[][]
}): Map<string, string> => {
  const mean = wordVectors.map(w => group.reduce((acc, m) => acc + similarity(m.embedding, w), 0) / group.length)
  const pairs = group.flatMap(m =>
    wordVectors.map((w, wi) => ({
      key: m.key,
      score: similarity(m.embedding, w) - (mean[wi] ?? 0),
      word: DESCRIPTORS[wi] ?? ''
    }))
  )
  const sorted = pairs.toSorted((a, b) => b.score - a.score || a.key.localeCompare(b.key) || a.word.localeCompare(b.word))
  const chosen = new Map<string, string>()
  const usedWords = new Set<string>()
  for (const pair of sorted.filter(x => x.word.length > 0))
    if (!(chosen.has(pair.key) || usedWords.has(pair.word))) {
      chosen.set(pair.key, pair.word)
      usedWords.add(pair.word)
    }
  return chosen
}
const addDescriptors = async ({
  embeddings,
  names,
  presets
}: {
  embeddings: Map<string, number[]>
  names: Map<string, string>
  presets: SourcePreset[]
}) => {
  const groups = new Map<string, SourcePreset[]>()
  for (const p of collidingDerived({ names, presets })) {
    const n = names.get(p.key) ?? ''
    groups.set(n, [...(groups.get(n) ?? []), p])
  }
  if (groups.size === 0) return
  const wordVectors = await embedTexts(DESCRIPTORS.map(d => `a ${d.toLowerCase()} sound`))
  for (const group of groups.values()) {
    const members = group.flatMap(p => {
      const embedding = embeddings.get(p.key)
      return embedding === undefined ? [] : [{ embedding, key: p.key }]
    })
    const chosen = pickDescriptors({ group: members, words: wordVectors })
    for (const [key, word] of chosen) names.set(key, `${names.get(key) ?? ''}${word}`)
  }
}
const formatProblems = ({ key, name }: { key: string; name: string }): NameProblem[] => [
  ...(VALID_NAME.test(name) ? [] : [{ key, name, problem: 'not CamelCase letters only' }]),
  ...(name.length > MAX_NAME_LENGTH ? [{ key, name, problem: `${name.length} chars` }] : [])
]
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
const DESCRIPTOR_PASSES = 4
const SHORT_FORMS: readonly (readonly [RegExp, string])[] = [
  [/Tremolo|Trm/gv, 'Trem'],
  [/Dynamic/gv, 'Dyn'],
  [/Small|Sml/gv, 'Sm'],
  [/Large/gv, 'Lg'],
  [/Velocity/gv, 'Vel'],
  [/Italian/gv, ''],
  [/Harpsichord/gv, '']
]
const shorten = (name: string): string => {
  let out = name
  for (const [pattern, short] of SHORT_FORMS) out = out.replaceAll(pattern, short)
  return out
}
const assignNames = async ({
  embeddings,
  labels,
  presets
}: {
  embeddings: Map<string, number[]>
  labels: Map<string, Family>
  presets: SourcePreset[]
}): Promise<{ names: Map<string, string>; problems: NameProblem[] }> => {
  const names = baseNames({ labels, presets })
  for (let pass = 0; pass < DESCRIPTOR_PASSES; pass += 1) await addDescriptors({ embeddings, names, presets })
  for (const [key, name] of names) if (name.length > MAX_NAME_LENGTH) names.set(key, shorten(name))
  return { names, problems: findProblems({ names, presets }) }
}
export type { NameProblem }
export { assignNames, MAX_NAME_LENGTH }
