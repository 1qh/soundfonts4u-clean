import type { SourcePreset } from './fonts.js'
import { cosineDistance } from './embed.js'
import { byCodeUnit } from './fonts.js'
import { HAND_FAMILIES } from './hand-table.js'
import { centroid } from './order.js'
import { spacedWords } from './text.js'
const FAMILIES = [
  'Bass',
  'Brass',
  'Choir',
  'Mallets',
  'Drums',
  'EGuitar',
  'EPiano',
  'Ethnic',
  'Flute',
  'Piano',
  'Harp',
  'Harpsichord',
  'Nylon',
  'Organ',
  'Reed',
  'Fx',
  'Acoustic',
  'Strings',
  'Synth',
  'Lead',
  'Pad'
] as const
type Family = (typeof FAMILIES)[number]
const KEYWORDS: readonly (readonly [Family, readonly RegExp[]])[] = [
  ['Fx', [/\bhit\b/iv]],
  ['Organ', [/organ|hammond|\bb3\b|rotary|leslie|drawbar|\bpipe\s|church|harmonium|accord|melodica|plein|\bjeu\b/iv]],
  [
    'Drums',
    [
      /(?<!steel\s?)drum|kit\b|perc|standard|\broom\b|power|brush|electronic/iv,
      /\btr\s?\d|timpani|cymbal|snare|tom\b|tambourine|wind\s?chime/iv
    ]
  ],
  ['EPiano', [/rhodes|wurli|\bep\b|\be\s?piano|elec\w*\s*piano|dx\s?7|fm\s.*piano|suitcase|tine/iv]],
  ['Harpsichord', [/harpsi|clav|cembalo/iv]],
  [
    'Piano',
    [
      /grand|steinway|yamaha|bosendorfer|fazioli|chateau|salamander|piano|\bc5\b|\bs6\b|mod\w*\s?b\b|\bs\s?s\b|mason/iv,
      /\bdyn\s?ch\b|\bd\s?ch\s?g\b|\bstudio\s?ch\b/iv
    ]
  ],
  [
    'Mallets',
    [/vibra|marimba|xylo|glock|celesta|bell|(?<!wind\s?)chime|music\s?box|dulcimer|kalimba|steel\s?drum|tubular/iv]
  ],
  ['Nylon', [/nylon|classic\w*\s*g|spanish/iv]],
  ['Acoustic', [/steel|acoustic\s*g|12\s?string|folk|finger\s?pick/iv]],
  [
    'EGuitar',
    [
      /jazz\s?g|clean|elec\w*\s*g|dist|overdrive/iv,
      /muted|strat|tele|les\s?paul|\blp\b/iv,
      /single\s?coil/iv,
      /g(?:ui)?t(?:ar)?/iv
    ]
  ],
  ['Bass', [/bass/iv]],
  ['Strings', [/string|\bstr\b|violin|viola|cello|pizz|ensemble|orchestra(?!\s?hit)/iv]],
  ['Harp', [/harp/iv]],
  ['Choir', [/choir|vocal|voice|aah|ooh|vox/iv]],
  ['Brass', [/brass|trumpet|trombone|(?<!english\s?)horn|tuba/iv]],
  ['Reed', [/sax|oboe|clarinet|bassoon|english\s?horn/iv]],
  ['Flute', [/flute|piccolo|recorder|whistle|ocarina|bottle|shakuhachi/iv]],
  ['Lead', [/lead|square|saw|sine/iv]],
  ['Pad', [/pad|warm|halo|sweep|polysynth|space|atmos/iv]],
  ['Synth', [/synth|moog|voyager|\bfm\b|analog/iv]],
  ['Ethnic', [/sitar|banjo|shamisen|koto|bagpipe|fiddle|shanai|mandolin|ukulele/iv]],
  ['Fx', [/fx|noise|seashore|bird|telephone|helicopter|applause|gunshot|fret|breath|rain|crystal|goblin|echo/iv]]
]
const GM_LAYOUT_FONTS = new Set([
  'font.sf2',
  'GeneralUser_GS_v1_471.sf2',
  'Orpheus_18.06.2020.sf2',
  'SGM-v2.01-Sal-Guit-Bass-V1.3.sf2',
  'SGM-v2.01-YamahaGrand-Guit-Bass-v2.7.sf2',
  'SGMv2.01-GuitsPlusBass-V1.4.sf2'
])
const GM_BLOCKS: readonly (readonly [number, Family])[] = [
  [0, 'Piano'],
  [4, 'EPiano'],
  [6, 'Harpsichord'],
  [8, 'Mallets'],
  [16, 'Organ'],
  [24, 'Nylon'],
  [25, 'Acoustic'],
  [26, 'EGuitar'],
  [32, 'Bass'],
  [40, 'Strings'],
  [46, 'Harp'],
  [47, 'Drums'],
  [48, 'Strings'],
  [52, 'Choir'],
  [55, 'Strings'],
  [56, 'Brass'],
  [64, 'Reed'],
  [72, 'Flute'],
  [80, 'Lead'],
  [88, 'Pad'],
  [96, 'Fx'],
  [104, 'Ethnic'],
  [112, 'Mallets'],
  [114, 'Drums'],
  [120, 'Fx']
]
const GM_DRUM_BANK_FLOOR = 127
const gmFamily = (program: number): Family => {
  let family: Family = 'Piano'
  for (const [start, f] of GM_BLOCKS) if (program >= start) family = f
  return family
}
interface Ambiguity {
  candidates: Family[]
  chosen: Family
  key: string
  name: string
}
const keywordFamilies = (name: string): Family[] => {
  const spaced = spacedWords(name)
  const hits = KEYWORDS.filter(([, patterns]) => patterns.some(pattern => pattern.test(spaced))).map(([f]) => f)
  return [...new Set(hits)]
}
const SF2_EXTENSION = /\.sf2$/iv
const sourceFileFamily = (sourceFile: string): Family | undefined => {
  const hits = keywordFamilies(sourceFile.replace(SF2_EXTENSION, ''))
  return hits.length === 1 ? hits[0] : undefined
}
const fallbackFamily = (p: SourcePreset): Family | undefined => {
  if (p.slot.isDrum || p.slot.bank >= GM_DRUM_BANK_FLOOR) return 'Drums'
  if (GM_LAYOUT_FONTS.has(p.sourceFile)) return gmFamily(p.slot.program)
  return sourceFileFamily(p.sourceFile)
}
const firstPass = (
  presets: SourcePreset[]
): { ambiguous: SourcePreset[]; labels: Map<string, Family>; unlabelled: string[] } => {
  const labels = new Map<string, Family>()
  const ambiguous: SourcePreset[] = []
  const unlabelled: string[] = []
  for (const p of presets) {
    const hand = HAND_FAMILIES[p.key]
    const hits = keywordFamilies(p.name)
    const drumKit = p.slot.isDrum || p.slot.bank >= GM_DRUM_BANK_FLOOR ? 'Drums' : undefined
    const single =
      hand ?? drumKit ?? (hits.length === 1 ? hits[0] : undefined) ?? (hits.length === 0 ? fallbackFamily(p) : undefined)
    if (single !== undefined) labels.set(p.key, single)
    else if (hits.length > 1) ambiguous.push(p)
    else unlabelled.push(`${p.key} (${p.name})`)
  }
  return { ambiguous, labels, unlabelled }
}
const familyCentroids = ({
  embeddings,
  labels
}: {
  embeddings: Map<string, number[]>
  labels: Map<string, Family>
}): Map<Family, number[]> => {
  const vectors = new Map<Family, number[][]>()
  for (const [key, family] of labels) {
    const v = embeddings.get(key)
    if (v !== undefined) vectors.set(family, [...(vectors.get(family) ?? []), v])
  }
  return new Map([...vectors].map(([family, vs]) => [family, centroid(vs)]))
}
const closestFamily = ({
  candidates,
  centroids,
  embedding
}: {
  candidates: Family[]
  centroids: Map<Family, number[]>
  embedding: number[]
}): Family | undefined => {
  const scored = candidates.flatMap(f => {
    const c = centroids.get(f)
    return c === undefined ? [] : [{ d: cosineDistance(embedding, c), f }]
  })
  return scored.toSorted((a, b) => a.d - b.d || byCodeUnit(a.f, b.f))[0]?.f
}
const LAYER_JOINERS = ['+', '&'] as const
const leadInstrument = ({ candidates, name }: { candidates: Family[]; name: string }): Family | undefined => {
  const [lead] = name.replaceAll('&', '+').split('+')
  if (lead === undefined || lead === name) return undefined
  const hits = keywordFamilies(lead).filter(f => candidates.includes(f))
  return hits.length === 1 ? hits[0] : undefined
}
const resolveAmbiguity = ({
  centroids,
  embeddings,
  p
}: {
  centroids: Map<Family, number[]>
  embeddings: Map<string, number[]>
  p: SourcePreset
}): Ambiguity => {
  const candidates = keywordFamilies(p.name)
  const embedding = embeddings.get(p.key)
  const gm = GM_LAYOUT_FONTS.has(p.sourceFile) && !p.slot.isDrum ? gmFamily(p.slot.program) : undefined
  const byProgram = gm !== undefined && candidates.includes(gm) ? gm : undefined
  const instrument =
    candidates.length === 2 && candidates.includes('Synth') ? candidates.find(c => c !== 'Synth') : undefined
  const chosen =
    byProgram ??
    leadInstrument({ candidates, name: p.name }) ??
    instrument ??
    (embedding === undefined ? undefined : closestFamily({ candidates, centroids, embedding }))
  if (chosen === undefined)
    throw new Error(`cannot resolve family for ${p.key} (${p.name}) among ${candidates.join(', ')}`)
  return { candidates, chosen, key: p.key, name: p.name }
}
const labelAll = ({
  embeddings,
  presets
}: {
  embeddings: Map<string, number[]>
  presets: SourcePreset[]
}): { ambiguities: Ambiguity[]; labels: Map<string, Family> } => {
  const { ambiguous, labels, unlabelled } = firstPass(presets)
  if (unlabelled.length > 0)
    throw new Error(`no family for ${unlabelled.length} presets; add them to hand-table.ts:\n${unlabelled.join('\n')}`)
  const centroids = familyCentroids({ embeddings, labels })
  const ambiguities: Ambiguity[] = []
  for (const p of ambiguous) {
    const ambiguity = resolveAmbiguity({ centroids, embeddings, p })
    labels.set(p.key, ambiguity.chosen)
    ambiguities.push(ambiguity)
  }
  return { ambiguities, labels }
}
const bytesHeldElsewhere = ({
  family,
  labels,
  p,
  presets,
  recordingBytes
}: {
  family: Family
  labels: Map<string, Family>
  p: SourcePreset
  presets: SourcePreset[]
  recordingBytes: Map<string, number>
}): number => {
  const held = new Set<string>()
  for (const other of presets) {
    const isSameFamilyOther = other.key !== p.key && labels.get(other.key) === family
    if (isSameFamilyOther) for (const r of other.recordings) held.add(r)
  }
  let total = 0
  for (const r of p.recordings) if (held.has(r)) total += recordingBytes.get(r) ?? 0
  return total
}
const MOVE_FRACTION = 0.5
const MAX_PLACEMENT_PASSES = 5
interface Placement {
  placed: Map<string, Family>
  presets: SourcePreset[]
  recordingBytes: Map<string, number>
}
const heldBy = ({ family, p, placement }: { family: Family; p: SourcePreset; placement: Placement }): number =>
  bytesHeldElsewhere({
    family,
    labels: placement.placed,
    p,
    presets: placement.presets,
    recordingBytes: placement.recordingBytes
  })
const recordingTotal = ({ p, recordingBytes }: { p: SourcePreset; recordingBytes: Map<string, number> }): number => {
  let total = 0
  for (const r of p.recordings) total += recordingBytes.get(r) ?? 0
  return total
}
const candidateFamilies = ({ p, placement }: { p: SourcePreset; placement: Placement }): Family[] => {
  const candidates = new Set(
    placement.presets.filter(o => o.recordings.some(r => p.recordings.includes(r))).map(o => placement.placed.get(o.key))
  )
  return [...candidates].filter((c): c is Family => c !== undefined).toSorted(byCodeUnit)
}
const strongestFamily = ({
  own,
  ownHeld,
  p,
  placement
}: {
  own: Family | undefined
  ownHeld: number
  p: SourcePreset
  placement: Placement
}): { family: Family | undefined; held: number } => {
  const scored = candidateFamilies({ p, placement }).map(family => ({ family, held: heldBy({ family, p, placement }) }))
  let best: { family: Family | undefined; held: number } = { family: own, held: ownHeld }
  for (const s of scored) if (s.held > best.held) best = s
  return best
}
const didMovePreset = ({ p, placement }: { p: SourcePreset; placement: Placement }): boolean => {
  const own = placement.placed.get(p.key)
  const total = recordingTotal({ p, recordingBytes: placement.recordingBytes })
  const ownHeld = own === undefined ? 0 : heldBy({ family: own, p, placement })
  const { family, held } = strongestFamily({ own, ownHeld, p, placement })
  if (family === undefined || family === own || held <= ownHeld || held < MOVE_FRACTION * total) return false
  placement.placed.set(p.key, family)
  return true
}
const runPass = ({ movable, placement }: { movable: SourcePreset[]; placement: Placement }): number => {
  let moves = 0
  for (const p of movable) if (didMovePreset({ p, placement })) moves += 1
  return moves
}
const LAYER_WORD = /\blayer/iv
const PIANO_LAYER = /\+|\blayer|\bpad\b|\bstr(?:ings?)?\b|chamber|orch|\bbell|&\s*(?:str|fm|pad)/iv
const PERCUSSION_PATTERNS = [
  /tambour|snap|castan|cymbal|\bcym\b|reverse|\btoms?\b|wood\s?block|timpani|taiko|melodic|synth drum|concert/iv,
  /bass drum|\bsfx\b|crash|\bsd\b|kick|bongo|conga|agogo|cowbell|triangle|shaker|clap/iv
]
const UPRIGHT = /upright|honky|tonk|\bcp\s?80\b/iv
const isPercussionName = (name: string): boolean => {
  const spaced = spacedWords(name)
  return PERCUSSION_PATTERNS.some(pattern => pattern.test(spaced))
}
const FAMILY_TOPICS: Readonly<Partial<Record<Family, readonly (readonly [string, (name: string) => boolean])[]>>> = {
  Drums: [
    ['Percussion', isPercussionName],
    ['Drums', () => true]
  ],
  Piano: [
    ['PianoLayer', name => PIANO_LAYER.test(name)],
    ['Upright', name => UPRIGHT.test(name)],
    ['Grand', () => true]
  ]
}
const topicOf = ({ family, name }: { family: Family; name: string }): string => {
  const topics = FAMILY_TOPICS[family]
  if (topics === undefined) return family
  const hit = topics.find(([, matchesName]) => matchesName(name))
  if (hit === undefined) throw new Error(`no ${family} topic for ${name}`)
  return hit[0]
}
const isLayerName = (name: string): boolean => LAYER_JOINERS.some(j => name.includes(j)) || LAYER_WORD.test(name)
const placeLayers = ({
  labels,
  presets,
  recordingBytes
}: {
  labels: Map<string, Family>
  presets: SourcePreset[]
  recordingBytes: Map<string, number>
}): Map<string, Family> => {
  const placement: Placement = { placed: new Map(labels), presets, recordingBytes }
  const movable = presets.filter(x => HAND_FAMILIES[x.key] === undefined && isLayerName(x.name))
  for (let pass = 0; pass < MAX_PLACEMENT_PASSES; pass += 1) if (runPass({ movable, placement }) === 0) break
  return placement.placed
}
export type { Ambiguity, Family }
export { FAMILIES, keywordFamilies, labelAll, leadInstrument, placeLayers, topicOf }
