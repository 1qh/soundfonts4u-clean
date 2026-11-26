/** biome-ignore-all lint/performance/noAwaitInLoops: analysis and writing run sequentially, and proof runs in bounded batches */
/* eslint-disable no-await-in-loop */
import type { BasicPreset } from 'spessasynth_core'
import { CryptoHasher, file, gc, write } from 'bun'
import { mkdir, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { BasicSoundBank } from 'spessasynth_core'
import type { Merge } from './dedupe.js'
import type { Family } from './families.js'
import type { SourcePreset } from './fonts.js'
import type { PresetSlot } from './render.js'
import type { Wanted } from './stage.js'
import type { UpstreamFile } from './upstream.js'
import type { FamilyFont } from './write.js'
import { dedupe, nullDb, SILENT_DB } from './dedupe.js'
import { CLAP_SAMPLE_RATE, cosineDistance, createEmbedder, embedTexts, toMono } from './embed.js'
import { labelAll, placeLayers, topicOf } from './families.js'
import { byCodeUnit, listPresets, loadFont, presetKey, slotOf } from './fonts.js'
import { DROPPED_SOUNDS, SUBFAMILY_NAMES } from './hand-table.js'
import { assignNames } from './names.js'
import { centroid, orderBySimilarity } from './order.js'
import { rendererKey, renderFont, segmentOf } from './render.js'
import { cloneNeeds, stagedNames } from './stage.js'
import { hasSegments, openSegments, storeSegments } from './store.js'
import { UPSTREAM, verifyInput } from './upstream.js'
import { buildFamilyFont, shareIdenticalSamples } from './write.js'
interface FontRecord {
  fontKey: string
  sha256: string
}
interface FontWork {
  fontPath: string
  keys: string[]
  paths: Paths
  slots: PresetSlot[]
  upstream: UpstreamFile
}
interface Paths {
  cache: string
  input: string
  output: string
  renderer: string
}
interface Planned {
  bank: number
  fileName: string
  members: { key: string; name: string }[]
}
interface PlannedFont {
  embedding: number[]
  key: string
  members: SourcePreset[]
}
interface Sounds {
  embeddings: Map<string, number[]>
  kept: SourcePreset[]
  merges: Merge[]
  readSource: (key: string) => Promise<Float32Array[]>
  recordingBytes: Map<string, number>
}
const NULL_SAMPLE_RATE = 64_000
const MAX_PRESETS_PER_BANK = 128
const requiredArg = (index: number, label: string): string => {
  const value = process.argv[index]
  if (value === undefined || value.length === 0) throw new Error(`missing argument: ${label}`)
  return value
}
const log = (message: string) => {
  process.stderr.write(`${message}\n`)
}
const isEmbeddingTable = (value: unknown): value is Record<string, number[]> =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  Object.values(value).every((v: unknown) => Array.isArray(v) && v.every((x: unknown) => typeof x === 'number'))
const ensureSegments = async (work: FontWork) => {
  const segDir = join(work.paths.cache, 'render64', work.paths.renderer, work.upstream.sha256)
  if (await hasSegments(segDir)) return
  const rendered = await renderFont({
    fontPath: work.fontPath,
    sampleRate: NULL_SAMPLE_RATE,
    slots: work.slots,
    workDir: join(work.paths.cache, 'work')
  })
  await storeSegments({ dir: segDir, keys: work.keys, rendered })
}
const loadEmbeddings = async ({ embeddings, embPath }: { embeddings: Map<string, number[]>; embPath: string }) => {
  const cached: unknown = await file(embPath).json()
  if (!isEmbeddingTable(cached)) throw new TypeError(`cached CLAP embeddings are malformed: ${embPath}`)
  for (const [k, v] of Object.entries(cached)) embeddings.set(k, v)
}
const computeEmbeddings = async ({
  embeddings,
  embPath,
  work
}: {
  embeddings: Map<string, number[]>
  embPath: string
  work: FontWork
}) => {
  const rendered = await renderFont({
    fontPath: work.fontPath,
    sampleRate: CLAP_SAMPLE_RATE,
    slots: work.slots,
    workDir: join(work.paths.cache, 'work')
  })
  const embedder = await createEmbedder()
  const fresh: Record<string, number[]> = {}
  for (const [index, key] of work.keys.entries()) {
    const vector = await embedder.embed(toMono(segmentOf({ index, rendered })))
    fresh[key] = vector
    embeddings.set(key, vector)
  }
  await mkdir(join(work.paths.cache, 'clap', work.paths.renderer), { recursive: true })
  await write(embPath, JSON.stringify(fresh))
}
const ensureEmbeddings = async ({ embeddings, work }: { embeddings: Map<string, number[]>; work: FontWork }) => {
  const embPath = join(work.paths.cache, 'clap', work.paths.renderer, `${work.upstream.sha256}.json`)
  await ((await file(embPath).exists())
    ? loadEmbeddings({ embPath, embeddings })
    : computeEmbeddings({ embPath, embeddings, work }))
}
const analyseFont = async ({
  embeddings,
  paths,
  recordingBytes,
  upstream
}: {
  embeddings: Map<string, number[]>
  paths: Paths
  recordingBytes: Map<string, number>
  upstream: UpstreamFile
}): Promise<SourcePreset[]> => {
  const fontPath = join(paths.input, upstream.path)
  const bank = await loadFont(fontPath)
  const presets = listPresets({ bank, recordingBytes, sourceFile: upstream.path })
  const work: FontWork = { fontPath, keys: presets.map(p => p.key), paths, slots: presets.map(p => p.slot), upstream }
  await ensureSegments(work)
  await ensureEmbeddings({ embeddings, work })
  log(`analysed ${upstream.path}: ${presets.length} presets`)
  return presets
}
const segmentReader = async ({ files, paths }: { files: UpstreamFile[]; paths: Paths }) => {
  const readers = new Map<string, (key: string) => Promise<Float32Array[]>>()
  for (const u of files) readers.set(u.path, await openSegments(join(paths.cache, 'render64', paths.renderer, u.sha256)))
  return async (key: string): Promise<Float32Array[]> => {
    const [source] = key.split('|')
    const read = source === undefined ? undefined : readers.get(source)
    if (read === undefined) throw new Error(`no render for ${key}`)
    const segment = await read(key)
    return segment
  }
}
const groupByRoot = (
  members: SourcePreset[],
  rootOf: (member: SourcePreset, index: number) => number | string
): SourcePreset[][] => {
  const groups = new Map<number | string, SourcePreset[]>()
  for (const [i, m] of members.entries()) {
    const root = rootOf(m, i)
    groups.set(root, [...(groups.get(root) ?? []), m])
  }
  return [...groups.values()]
}
const recordingRoots = (members: SourcePreset[]) => {
  const owner = new Map<string, number>()
  const parent = members.map((_, i) => i)
  const find = (i: number): number => {
    let r = i
    while (parent[r] !== r) r = parent[r] ?? r
    return r
  }
  for (const [i, m] of members.entries())
    for (const r of m.recordings) {
      const j = owner.get(r)
      if (j === undefined) owner.set(r, i)
      else parent[find(i)] = find(j)
    }
  return find
}
const recordingComponents = (members: SourcePreset[]): SourcePreset[][] => {
  const rootOf = recordingRoots(members)
  return groupByRoot(members, (_, i) => rootOf(i))
}
const sharedBytes = ({
  left,
  recordingBytes,
  right
}: {
  left: SourcePreset[]
  recordingBytes: Map<string, number>
  right: SourcePreset[]
}): number => {
  const leftRecordings = new Set(left.flatMap(p => p.recordings))
  const shared = new Set(right.flatMap(p => p.recordings).filter(r => leftRecordings.has(r)))
  let total = 0
  for (const r of shared) total += recordingBytes.get(r) ?? 0
  return total
}
const SF2_INDEX_BUDGET = 64_000
const canFitOneFont = (members: SourcePreset[]): boolean => {
  if (members.length > MAX_PRESETS_PER_BANK) return false
  const unique = new Map(members.flatMap(m => m.instruments.map(i => [i.id, i] as const)))
  let generators = 0
  let zones = 0
  for (const i of unique.values()) {
    generators += i.generators
    zones += i.zones
  }
  return generators <= SF2_INDEX_BUDGET && zones <= SF2_INDEX_BUDGET
}
const cutOversized = ({
  component,
  recordingBytes
}: {
  component: SourcePreset[]
  recordingBytes: Map<string, number>
}): SourcePreset[][] => {
  if (canFitOneFont(component)) return [component]
  if (component.length === 1) throw new Error(`${component[0]?.key ?? 'a preset'} alone exceeds one SF2 file`)
  const allCuts = Array.from({ length: component.length - 1 }, (_, i) => i + 1)
  const bothFit = allCuts.filter(k => canFitOneFont(component.slice(0, k)) && canFitOneFont(component.slice(k)))
  const cuts = bothFit.length > 0 ? bothFit : [Math.ceil(component.length / 2)]
  const scored = cuts.map(k => ({
    bytes: sharedBytes({ left: component.slice(0, k), recordingBytes, right: component.slice(k) }),
    k
  }))
  const best = scored.toSorted(
    (a, b) => a.bytes - b.bytes || Math.abs(component.length / 2 - a.k) - Math.abs(component.length / 2 - b.k)
  )[0]
  if (best === undefined) throw new Error(`no cut for a group of ${component.length}`)
  log(`cut a recording group of ${component.length} at ${best.k}, storing ${best.bytes} sample bytes twice`)
  return [
    ...cutOversized({ component: component.slice(0, best.k), recordingBytes }),
    ...cutOversized({ component: component.slice(best.k), recordingBytes })
  ]
}
const splitFamily = ({
  ordered,
  recordingBytes
}: {
  ordered: SourcePreset[]
  recordingBytes: Map<string, number>
}): SourcePreset[][] => {
  if (canFitOneFont(ordered)) return [ordered]
  const position = new Map(ordered.map((p, i) => [p.key, i]))
  const byPosition = (a: SourcePreset, b: SourcePreset): number => (position.get(a.key) ?? 0) - (position.get(b.key) ?? 0)
  const components = recordingComponents(ordered)
    .map(c => c.toSorted(byPosition))
    .flatMap(component => cutOversized({ component, recordingBytes }))
    .toSorted(
      (a, b) => Math.min(...a.map(p => position.get(p.key) ?? 0)) - Math.min(...b.map(p => position.get(p.key) ?? 0))
    )
  const chunks: SourcePreset[][] = [[]]
  for (const component of components) {
    const last = chunks.at(-1) ?? []
    if (canFitOneFont([...last, ...component])) last.push(...component)
    else chunks.push([...component])
  }
  return chunks.map(c => c.toSorted(byPosition))
}
const groupByFamily = ({
  labels,
  presets
}: {
  labels: Map<string, Family>
  presets: SourcePreset[]
}): Map<Family, SourcePreset[]> => {
  const byFamily = new Map<Family, SourcePreset[]>()
  for (const p of presets) {
    const f = labels.get(p.key)
    if (f === undefined) throw new Error(`unlabelled ${p.key}`)
    byFamily.set(f, [...(byFamily.get(f) ?? []), p])
  }
  return byFamily
}
const orderFamily = ({
  embeddings,
  members
}: {
  embeddings: Map<string, number[]>
  members: SourcePreset[]
}): SourcePreset[] => {
  const withEmb = members.map(m => {
    const embedding = embeddings.get(m.key)
    if (embedding === undefined) throw new Error(`no embedding for ${m.key}`)
    return { embedding, key: m.key, preset: m }
  })
  return orderBySimilarity(withEmb).map(x => x.preset)
}
const splitProblem = ({ chunks, family }: { chunks: SourcePreset[][]; family: string }): string => {
  const details = chunks.map((c, i) => `  font ${i + 1} (${c.length} sounds): ${c.map(p => p.name).join(' / ')}`)
  return `${family}: ${chunks.length} fonts needed:\n${details.join('\n')}`
}
const chunkFonts = ({
  chunks,
  embeddings,
  family,
  subNames
}: {
  chunks: SourcePreset[][]
  embeddings: Map<string, number[]>
  family: Family
  subNames: readonly string[]
}): PlannedFont[] =>
  chunks.map((chunk, i) => {
    const fileName = subNames[i]
    if (fileName === undefined) throw new Error(`no sub-family name ${i} for ${family}`)
    return { embedding: centroid(chunk.map(p => embeddings.get(p.key) ?? [])), key: fileName, members: chunk }
  })
const planFamily = ({
  embeddings,
  family,
  fontName,
  members,
  recordingBytes
}: {
  embeddings: Map<string, number[]>
  family: Family
  fontName: string
  members: SourcePreset[]
  recordingBytes: Map<string, number>
}): { fonts: PlannedFont[]; problems: string[] } => {
  const chunks = splitFamily({ ordered: orderFamily({ embeddings, members }), recordingBytes })
  const subNames = chunks.length === 1 ? [fontName] : SUBFAMILY_NAMES[family]
  if (subNames?.length !== chunks.length) return { fonts: [], problems: [splitProblem({ chunks, family: fontName })] }
  return { fonts: chunkFonts({ chunks, embeddings, family, subNames }), problems: [] }
}
const namedMembers = ({
  members,
  names
}: {
  members: SourcePreset[]
  names: Map<string, string>
}): { key: string; name: string }[] =>
  members.map(m => {
    const name = names.get(m.key)
    if (name === undefined) throw new Error(`no name for ${m.key}`)
    return { key: m.key, name }
  })
const GRAND_TONE_LADDERS: readonly (readonly string[])[] = [
  ['Grand'],
  ['BrightGrand', 'DarkGrand'],
  ['BrightGrand', 'MellowGrand', 'DarkGrand'],
  ['BrightGrand', 'ClearGrand', 'MellowGrand', 'DarkGrand'],
  ['BrightGrand', 'ClearGrand', 'MellowGrand', 'WarmGrand', 'DarkGrand']
]
const scoreGrands = async ({
  embeddings,
  labels,
  presets
}: {
  embeddings: Map<string, number[]>
  labels: Map<string, Family>
  presets: SourcePreset[]
}): Promise<{ p: SourcePreset; score: number }[]> => {
  const [bright, dark] = await embedTexts(['bright grand piano', 'dark grand piano'])
  if (bright === undefined || dark === undefined) throw new Error('CLAP returned no tone prompts')
  const grands = presets.filter(p => {
    const family = labels.get(p.key)
    return family !== undefined && topicOf({ family, name: p.name }) === 'Grand'
  })
  return grands.map(p => {
    const embedding = embeddings.get(p.key)
    if (embedding === undefined) throw new Error(`no embedding for ${p.key}`)
    return { p, score: cosineDistance(embedding, bright) - cosineDistance(embedding, dark) }
  })
}
const grandRoots = (grands: SourcePreset[]) => {
  const parent = new Map<string, string>()
  const find = (k: string): string => {
    let r = k
    while (parent.get(r) !== undefined && parent.get(r) !== r) r = parent.get(r) ?? r
    return r
  }
  const owner = new Map<string, string>()
  for (const p of grands) {
    parent.set(p.key, p.key)
    for (const inst of p.instruments) {
      const o = owner.get(inst.id)
      if (o === undefined) owner.set(inst.id, p.key)
      else parent.set(find(p.key), find(o))
    }
  }
  return find
}
const grandComponents = (grands: SourcePreset[]): SourcePreset[][] => {
  const rootOf = grandRoots(grands)
  return groupByRoot(grands, p => rootOf(p.key))
}
const orderGrandComponents = (components: SourcePreset[][], scoreOf: Map<string, number>): SourcePreset[][] => {
  const mean = (ms: SourcePreset[]): number => {
    let total = 0
    for (const m of ms) total += scoreOf.get(m.key) ?? 0
    return total / ms.length
  }
  return components
    .map(ms => ms.toSorted((x, y) => (scoreOf.get(x.key) ?? 0) - (scoreOf.get(y.key) ?? 0) || byCodeUnit(x.key, y.key)))
    .toSorted((x, y) => mean(x) - mean(y) || byCodeUnit(x[0]?.key ?? '', y[0]?.key ?? ''))
}
const appendGrandComponent = (groups: SourcePreset[][], component: SourcePreset[]) => {
  const last = groups.at(-1) ?? []
  if (canFitOneFont([...last, ...component])) {
    last.push(...component)
    return
  }
  if (canFitOneFont(component)) {
    groups.push([...component])
    return
  }
  for (const p of component) {
    const tail = groups.at(-1) ?? []
    if (canFitOneFont([...tail, p])) tail.push(p)
    else groups.push([p])
  }
}
const nameGrandTones = (groups: SourcePreset[][]): Map<string, string> => {
  const ladder = GRAND_TONE_LADDERS[groups.length - 1]
  if (ladder === undefined) throw new Error(`grands need ${groups.length} fonts, more than the tone ladder names`)
  const tones = new Map<string, string>()
  for (const [g, members] of groups.entries()) for (const p of members) tones.set(p.key, ladder[g] ?? '')
  const summary = groups.map((m, g) => `${ladder[g] ?? ''} ${m.length}`).join(', ')
  log(`grands by tone: ${summary}`)
  return tones
}
const grandTones = async ({
  embeddings,
  labels,
  presets
}: {
  embeddings: Map<string, number[]>
  labels: Map<string, Family>
  presets: SourcePreset[]
}): Promise<Map<string, string>> => {
  const scored = await scoreGrands({ embeddings, labels, presets })
  const scoreOf = new Map(scored.map(x => [x.p.key, x.score]))
  const components = grandComponents(scored.map(x => x.p))
  const groups: SourcePreset[][] = [[]]
  for (const component of orderGrandComponents(components, scoreOf)) appendGrandComponent(groups, component)
  return nameGrandTones(groups)
}
const groupByTopic = ({
  family,
  members,
  tones
}: {
  family: Family
  members: SourcePreset[]
  tones: Map<string, string>
}): Map<string, SourcePreset[]> => {
  const byTopic = new Map<string, SourcePreset[]>()
  for (const m of members) {
    const named = topicOf({ family, name: m.name })
    const topic = named === 'Grand' ? tones.get(m.key) : named
    if (topic === undefined) throw new Error(`no tone for grand ${m.key}`)
    byTopic.set(topic, [...(byTopic.get(topic) ?? []), m])
  }
  return byTopic
}
const planTopics = ({
  byFamily,
  embeddings,
  recordingBytes,
  tones
}: {
  byFamily: Map<Family, SourcePreset[]>
  embeddings: Map<string, number[]>
  recordingBytes: Map<string, number>
  tones: Map<string, string>
}): { fonts: PlannedFont[]; splitProblems: string[] } => {
  const fonts: PlannedFont[] = []
  const splitProblems: string[] = []
  for (const [family, members] of byFamily) {
    const byTopic = groupByTopic({ family, members, tones })
    for (const [fontName, topicMembers] of byTopic) {
      const planned = planFamily({ embeddings, family, fontName, members: topicMembers, recordingBytes })
      fonts.push(...planned.fonts)
      splitProblems.push(...planned.problems)
    }
  }
  return { fonts, splitProblems }
}
const planFonts = ({
  embeddings,
  labels,
  names,
  presets,
  recordingBytes,
  tones
}: {
  embeddings: Map<string, number[]>
  labels: Map<string, Family>
  names: Map<string, string>
  presets: SourcePreset[]
  recordingBytes: Map<string, number>
  tones: Map<string, string>
}): Planned[] => {
  const byFamily = groupByFamily({ labels, presets })
  const { fonts, splitProblems } = planTopics({ byFamily, embeddings, recordingBytes, tones })
  if (splitProblems.length > 0)
    throw new Error(`name the sub-families in hand-table.ts SUBFAMILY_NAMES:\n${splitProblems.join('\n')}`)
  return orderBySimilarity(fonts).map((f, bank) => ({
    bank,
    fileName: f.key,
    members: namedMembers({ members: f.members, names })
  }))
}
const wantedBySource = (plan: Planned[]): Map<string, Wanted[]> => {
  const wanted = new Map<string, Wanted[]>()
  for (const font of plan)
    for (const m of font.members) {
      const [source] = m.key.split('|')
      if (source === undefined) throw new Error(`bad key ${m.key}`)
      wanted.set(source, [...(wanted.get(source) ?? []), { fileName: font.fileName, key: m.key }])
    }
  return wanted
}
const stageSource = async ({
  names,
  needs,
  paths,
  stageDir,
  u
}: {
  names: Map<string, string>
  needs: Wanted[]
  paths: Paths
  stageDir: string
  u: UpstreamFile
}) => {
  const bank = await loadFont(join(paths.input, u.path))
  const byKey = new Map(bank.presets.map(p => [presetKey({ slot: slotOf(p), sourceFile: u.path }), p]))
  const stage = new BasicSoundBank('sf2', false)
  cloneNeeds({ byKey, names, needs, stage, u })
  shareIdenticalSamples(stage)
  stage.removeUnusedElements()
  stage.flush(false)
  await write(
    join(stageDir, `${u.sha256}.sf2`),
    stage.writeSF2({ writeDefaultModulators: false, writeExtendedLimits: true })
  )
  log(`staged ${needs.length} presets from ${u.path}`)
  gc(true)
}
const collectStagedMembers = ({
  byStagedName,
  font,
  names,
  source,
  sources
}: {
  byStagedName: Map<string, BasicPreset>
  font: Planned
  names: Map<string, string>
  source: string
  sources: Map<string, BasicPreset>
}) => {
  const prefix = `${source}|`
  for (const m of font.members) {
    const staged = m.key.startsWith(prefix) ? byStagedName.get(names.get(m.key) ?? '') : undefined
    if (staged !== undefined) sources.set(m.key, staged)
  }
}
const loadStaged = async ({
  font,
  names,
  shaOf,
  stageDir
}: {
  font: Planned
  names: Map<string, string>
  shaOf: Map<string, string>
  stageDir: string
}): Promise<Map<string, BasicPreset>> => {
  const sources = new Map<string, BasicPreset>()
  const sourceFiles = new Set(font.members.map(m => m.key.split('|')[0] ?? ''))
  for (const source of sourceFiles) {
    const bank = await loadFont(join(stageDir, `${shaOf.get(source) ?? ''}.sf2`))
    const byStagedName = new Map<string, BasicPreset>()
    for (const p of bank.presets) byStagedName.set(p.name, p)
    collectStagedMembers({ byStagedName, font, names, source, sources })
  }
  return sources
}
const writeFont = async ({
  creationDate,
  font,
  names,
  paths,
  shaOf,
  stageDir
}: {
  creationDate: Date
  font: Planned
  names: Map<string, string>
  paths: Paths
  shaOf: Map<string, string>
  stageDir: string
}) => {
  const sources = await loadStaged({ font, names, shaOf, stageDir })
  const familyFont: FamilyFont = {
    bank: font.bank,
    fileName: font.fileName,
    members: font.members.map(m => {
      const source = sources.get(m.key)
      if (source === undefined) throw new Error(`stage lost ${m.key}`)
      return { name: m.name, source }
    })
  }
  await write(join(paths.output, `${font.fileName}.sf2`), buildFamilyFont({ creationDate, font: familyFont }))
  log(`wrote ${font.fileName}.sf2: ${font.members.length} presets`)
  gc(true)
}
const fontRecordPath = (paths: Paths, kind: 'proved' | 'written', fileName: string): string =>
  join(paths.cache, kind, `${fileName}.json`)
const readFontRecord = async (recordPath: string): Promise<FontRecord | undefined> => {
  const cached = file(recordPath)
  if (!(await cached.exists())) return undefined
  try {
    const value: unknown = await cached.json()
    if (typeof value === 'object' && value !== null && 'fontKey' in value && 'sha256' in value) {
      const { fontKey, sha256 } = value
      if (typeof fontKey === 'string' && typeof sha256 === 'string') return { fontKey, sha256 }
    }
  } catch (recordError) {
    if (!(recordError instanceof SyntaxError)) throw recordError
  }
  return undefined
}
const outputSha256 = async (fontPath: string): Promise<string> => {
  const hasher = new CryptoHasher('sha256')
  for await (const chunk of file(fontPath).stream()) hasher.update(chunk)
  return hasher.digest('hex')
}
const clearStaleOutputs = async (paths: Paths, plan: Planned[]) => {
  const plannedFiles = new Set(plan.map(font => `${font.fileName}.sf2`))
  const entries = await readdir(paths.output, { withFileTypes: true })
  const stale = entries.filter(
    entry => (entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith('.sf2') && !plannedFiles.has(entry.name)
  )
  for (const entry of stale) {
    const fileName = entry.name.slice(0, -'.sf2'.length)
    await rm(fontRecordPath(paths, 'written', fileName), { force: true })
    await rm(fontRecordPath(paths, 'proved', fileName), { force: true })
    await rm(join(paths.output, entry.name), { force: true })
    log(`deleted ${entry.name}`)
  }
}
const plannedFontKey = ({ font, patch, renderer }: { font: Planned; patch: string; renderer: string }): string =>
  new CryptoHasher('sha256')
    .update(JSON.stringify([renderer, font.fileName, font.bank, font.members.map(m => [m.key, m.name])]))
    .update(UPSTREAM.commit)
    .update(patch)
    .digest('hex')
const planWrites = async ({ patch, paths, plan }: { patch: string; paths: Paths; plan: Planned[] }) => {
  const records = new Map<string, FontRecord>()
  const toWrite: { font: Planned; fontKey: string }[] = []
  for (const font of plan) {
    const fontKey = plannedFontKey({ font, patch, renderer: paths.renderer })
    const previous = await readFontRecord(fontRecordPath(paths, 'written', font.fileName))
    const fontPath = join(paths.output, `${font.fileName}.sf2`)
    if (
      previous?.fontKey === fontKey &&
      (await file(fontPath).exists()) &&
      previous.sha256 === (await outputSha256(fontPath))
    )
      records.set(font.fileName, previous)
    else toWrite.push({ font, fontKey })
  }
  return { records, toWrite }
}
const stageInputs = async ({ paths, plan, upstream }: { paths: Paths; plan: Planned[]; upstream: UpstreamFile[] }) => {
  const wanted = wantedBySource(plan)
  const stageDir = join(paths.cache, 'stage')
  await mkdir(stageDir, { recursive: true })
  const toStage = upstream.flatMap(u => {
    const needs = wanted.get(u.path) ?? []
    return needs.length > 0 ? [{ needs, u }] : []
  })
  const names = stagedNames(wanted)
  for (const { needs, u } of toStage) await stageSource({ names, needs, paths, stageDir, u })
  return { names, stageDir }
}
const saveWrittenRecord = async ({ font, fontKey, paths }: { font: Planned; fontKey: string; paths: Paths }) => {
  const sha256 = await outputSha256(join(paths.output, `${font.fileName}.sf2`))
  const record = { fontKey, sha256 }
  await write(fontRecordPath(paths, 'written', font.fileName), JSON.stringify(record))
  return record
}
const writePendingFonts = async ({
  paths,
  records,
  toWrite,
  upstream
}: {
  paths: Paths
  records: Map<string, FontRecord>
  toWrite: Awaited<ReturnType<typeof planWrites>>['toWrite']
  upstream: UpstreamFile[]
}) => {
  const { names, stageDir } = await stageInputs({ paths, plan: toWrite.map(({ font }) => font), upstream })
  const shaOf = new Map(upstream.map(u => [u.path, u.sha256]))
  const creationDate = new Date(UPSTREAM.commitDate)
  await mkdir(join(paths.cache, 'written'), { recursive: true })
  for (const { font, fontKey } of toWrite) {
    await writeFont({ creationDate, font, names, paths, shaOf, stageDir })
    const record = await saveWrittenRecord({ font, fontKey, paths })
    records.set(font.fileName, record)
  }
}
const stageAndWrite = async ({
  paths,
  plan,
  upstream
}: {
  paths: Paths
  plan: Planned[]
  upstream: UpstreamFile[]
}): Promise<Map<string, FontRecord>> => {
  const patch = await file(join(import.meta.dirname, '../../../patches/spessasynth_core@4.4.12.patch')).text()
  const { records, toWrite } = await planWrites({ patch, paths, plan })
  await mkdir(paths.output, { recursive: true })
  if (toWrite.length > 0) await writePendingFonts({ paths, records, toWrite, upstream })
  return records
}
const compareProof = async ({
  font,
  readSource,
  rendered
}: {
  font: Planned
  readSource: Sounds['readSource']
  rendered: Awaited<ReturnType<typeof renderFont>>
}): Promise<string[]> => {
  const failures: string[] = []
  let exact = 0
  let worst = SILENT_DB
  for (const [index, m] of font.members.entries()) {
    const db = nullDb(segmentOf({ index, rendered }), await readSource(m.key))
    if (db === SILENT_DB) exact += 1
    worst = Math.max(worst, db)
    if (db !== SILENT_DB)
      failures.push(`${font.fileName}/${m.name} from ${m.key}: null ${db.toFixed(1)} dB, not bit-exact`)
  }
  log(`proved ${font.fileName}: ${exact} of ${font.members.length} bit-exact, worst null ${worst.toFixed(1)} dB`)
  return failures
}
const batchFailures = (result: PromiseSettledResult<string[]>): string[] => {
  if (result.status === 'rejected') {
    const proofError: unknown = result.reason
    throw proofError
  }
  return result.value
}
const settleProofBatch = async (fonts: Planned[], proveFont: (font: Planned) => Promise<string[]>) => {
  const pending: Promise<string[]>[] = []
  for (const font of fonts) pending.push(proveFont(font))
  const batch = await Promise.allSettled(pending)
  return batch
}
const proveInBatches = async (plan: Planned[], proveFont: (font: Planned) => Promise<string[]>) => {
  const failures: string[] = []
  const renderLimit = 4
  let offset = 0
  while (offset < plan.length) {
    const fonts = plan.slice(offset, offset + renderLimit)
    const batch = await settleProofBatch(fonts, proveFont)
    for (const result of batch) failures.push(...batchFailures(result))
    offset += renderLimit
  }
  if (failures.length > 0) throw new Error(`output does not sound like its source:\n${failures.join('\n')}`)
}
const proveOutput = async ({
  drumKeys,
  paths,
  plan,
  readSource,
  records
}: {
  drumKeys: Set<string>
  paths: Paths
  plan: Planned[]
  readSource: Sounds['readSource']
  records: Map<string, FontRecord>
}) => {
  await mkdir(join(paths.cache, 'proved'), { recursive: true })
  const renderAndCompare = async (font: Planned, record: FontRecord, recordPath: string): Promise<string[]> => {
    const fontPath = join(paths.output, `${font.fileName}.sf2`)
    const slots = font.members.map((m, program) => ({ bank: font.bank, isDrum: drumKeys.has(m.key), program }))
    const rendered = await renderFont({
      fontPath,
      sampleRate: NULL_SAMPLE_RATE,
      slots,
      workDir: join(paths.cache, 'work', font.fileName)
    })
    const failures = await compareProof({ font, readSource, rendered })
    if (failures.length === 0) await write(recordPath, JSON.stringify(record))
    return failures
  }
  const proveFont = async (font: Planned): Promise<string[]> => {
    const record = records.get(font.fileName)
    if (record === undefined) throw new Error(`no written record for ${font.fileName}`)
    const recordPath = fontRecordPath(paths, 'proved', font.fileName)
    const previous = await readFontRecord(recordPath)
    if (previous?.fontKey === record.fontKey && previous.sha256 === record.sha256) {
      log(`proved ${font.fileName}: unchanged`)
      return []
    }
    const failures = await renderAndCompare(font, record, recordPath)
    return failures
  }
  await proveInBatches(plan, proveFont)
}
const verifiedUpstream = async (paths: Paths): Promise<UpstreamFile[]> => {
  const upstream = await verifyInput(paths.input)
  log(`verified ${upstream.length} input files against ${UPSTREAM.commit}`)
  return upstream
}
const analyseAndDedupe = async ({ paths, upstream }: { paths: Paths; upstream: UpstreamFile[] }): Promise<Sounds> => {
  const embeddings = new Map<string, number[]>()
  const recordingBytes = new Map<string, number>()
  const all: SourcePreset[] = []
  for (const u of upstream) all.push(...(await analyseFont({ embeddings, paths, recordingBytes, upstream: u })))
  const readSource = await segmentReader({ files: upstream, paths })
  const { kept, merges } = await dedupe({ presets: all, segmentOf: readSource })
  log(`dedupe: ${all.length} presets, ${merges.length} merged, ${kept.length} kept`)
  return { embeddings, kept, merges, readSource, recordingBytes }
}
const checkedNames = async ({
  embeddings,
  kept,
  labels,
  paths
}: {
  embeddings: Map<string, number[]>
  kept: SourcePreset[]
  labels: Map<string, Family>
  paths: Paths
}): Promise<Map<string, string>> => {
  const { names, problems } = await assignNames({ embeddings, labels, presets: kept })
  if (problems.length === 0) return names
  const report = problems.map(p => `${p.key}\t${p.name}\t${p.problem}`).join('\n')
  await write(join(paths.cache, 'name-problems.tsv'), `${report}\n`)
  throw new Error(`${problems.length} names need hand-table.ts entries; see ${join(paths.cache, 'name-problems.tsv')}`)
}
const finalTarget = ({ intoOf, key }: { intoOf: Map<string, string>; key: string }): string => {
  const seen = new Set<string>()
  let current = key
  let next = intoOf.get(current)
  while (next !== undefined) {
    if (seen.has(current)) throw new Error(`merge cycle through ${current}`)
    seen.add(current)
    current = next
    next = intoOf.get(current)
  }
  return current
}
const resolvedMerges = ({ merges, plan }: { merges: Merge[]; plan: Planned[] }) => {
  const shipped = new Set(plan.flatMap(f => f.members.map(m => m.key)))
  const intoOf = new Map(merges.map(m => [m.key, m.into]))
  return merges.map((m: Merge) => {
    const into = finalTarget({ intoOf, key: m.key })
    if (!shipped.has(into) && DROPPED_SOUNDS[into] === undefined)
      throw new Error(`merge of ${m.key} ends at ${into}, which neither ships nor is dropped`)
    return {
      into,
      ...(Number.isNaN(m.nullDb) ? {} : { nullDb: m.nullDb }),
      reason: into === m.into ? m.reason : `${m.reason}; ${m.into} merged further into ${into}`,
      source: m.key
    }
  })
}
const writeManifest = async ({ merges, paths, plan }: { merges: Merge[]; paths: Paths; plan: Planned[] }) => {
  const manifest = {
    dropped: Object.entries(DROPPED_SOUNDS).map(([source, reason]) => ({ reason, source })),
    excluded: UPSTREAM.excluded,
    fonts: plan.map(f => ({
      bank: f.bank,
      file: `${f.fileName}.sf2`,
      presets: f.members.map((m, program) => ({ name: m.name, program, source: m.key }))
    })),
    merges: resolvedMerges({ merges, plan }),
    upstream: { commit: UPSTREAM.commit, dataset: UPSTREAM.dataset }
  }
  await write(join(paths.output, 'manifest.json'), `${JSON.stringify(manifest, undefined, 2)}\n`)
}
const writeLabels = async ({
  labelled,
  paths,
  presets
}: {
  labelled: ReturnType<typeof labelAll>
  paths: Paths
  presets: SourcePreset[]
}) => {
  await write(join(paths.cache, 'ambiguities.json'), JSON.stringify(labelled.ambiguities, undefined, 2))
  const labels = presets.map(p => ({ family: labelled.labels.get(p.key), key: p.key, name: p.name }))
  await write(join(paths.cache, 'labels.json'), JSON.stringify(labels, undefined, 1))
}
const applyDrops = (analysed: Sounds): Sounds => {
  const sounds = { ...analysed, kept: analysed.kept.filter(p => DROPPED_SOUNDS[p.key] === undefined) }
  const missingDrops = Object.keys(DROPPED_SOUNDS).filter(
    k => !(analysed.kept.some(p => p.key === k) || analysed.merges.some(m => m.key === k))
  )
  if (missingDrops.length > 0) throw new Error(`dropped sounds not found upstream: ${missingDrops.join(', ')}`)
  return sounds
}
const labelSounds = async (paths: Paths, sounds: Sounds) => {
  const labelled = labelAll({ embeddings: sounds.embeddings, presets: sounds.kept })
  await writeLabels({ labelled, paths, presets: sounds.kept })
  const labels = placeLayers({
    labels: labelled.labels,
    presets: sounds.kept,
    recordingBytes: sounds.recordingBytes
  })
  return labels
}
const preparePlan = async ({ paths, upstream }: { paths: Paths; upstream: UpstreamFile[] }) => {
  const analysed = await analyseAndDedupe({ paths, upstream })
  const sounds = applyDrops(analysed)
  const labels = await labelSounds(paths, sounds)
  const names = await checkedNames({ embeddings: sounds.embeddings, kept: sounds.kept, labels, paths })
  const tones = await grandTones({ embeddings: sounds.embeddings, labels, presets: sounds.kept })
  const plan = planFonts({
    embeddings: sounds.embeddings,
    labels,
    names,
    presets: sounds.kept,
    recordingBytes: sounds.recordingBytes,
    tones
  })
  return { plan, sounds }
}
const main = async () => {
  const paths: Paths = {
    cache: requiredArg(4, 'cache dir'),
    input: requiredArg(2, 'input dir'),
    output: requiredArg(3, 'output dir'),
    renderer: await rendererKey()
  }
  log(`renderer key ${paths.renderer}`)
  const upstream = await verifiedUpstream(paths)
  const { plan, sounds } = await preparePlan({ paths, upstream })
  const records = await stageAndWrite({ paths, plan, upstream })
  await clearStaleOutputs(paths, plan)
  const drumKeys = new Set(sounds.kept.filter(p => p.slot.isDrum).map(p => p.key))
  await proveOutput({ drumKeys, paths, plan, readSource: sounds.readSource, records })
  await writeManifest({ merges: sounds.merges, paths, plan })
  log(`ok: ${plan.length} fonts, ${sounds.kept.length} sounds`)
}
await main()
