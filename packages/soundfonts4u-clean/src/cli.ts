/** biome-ignore-all lint/performance/noAwaitInLoops: fonts are analysed, staged, written and proved one at a time to bound memory, and their log lines follow that order */
/* eslint-disable no-await-in-loop */
import type { BasicPreset } from 'spessasynth_core'
import { file, gc, write } from 'bun'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { BasicSoundBank, SoundBankCloner } from 'spessasynth_core'
import type { Merge } from './dedupe.js'
import type { Family } from './families.js'
import type { SourcePreset } from './fonts.js'
import type { PresetSlot } from './render.js'
import type { UpstreamFile } from './upstream.js'
import type { FamilyFont } from './write.js'
import { dedupe, nullDb, SILENT_DB } from './dedupe.js'
import { CLAP_SAMPLE_RATE, cosineDistance, createEmbedder, embedTexts, toMono } from './embed.js'
import { labelAll, placeLayers, topicOf } from './families.js'
import { byCodeUnit, listPresets, loadFont, presetKey, slotOf } from './fonts.js'
import { SUBFAMILY_NAMES } from './hand-table.js'
import { assignNames } from './names.js'
import { centroid, orderBySimilarity } from './order.js'
import { rendererKey, renderFont, segmentOf } from './render.js'
import { hasSegments, openSegments, storeSegments } from './store.js'
import { UPSTREAM, verifyInput } from './upstream.js'
import { buildFamilyFont, shareIdenticalSamples } from './write.js'
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
interface Wanted {
  fileName: string
  key: string
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
const ensureSegments = async (work: FontWork): Promise<void> => {
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
const loadEmbeddings = async ({
  embeddings,
  embPath
}: {
  embeddings: Map<string, number[]>
  embPath: string
}): Promise<void> => {
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
}): Promise<void> => {
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
const ensureEmbeddings = async ({
  embeddings,
  work
}: {
  embeddings: Map<string, number[]>
  work: FontWork
}): Promise<void> => {
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
const recordingComponents = (members: SourcePreset[]): SourcePreset[][] => {
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
  const groups = new Map<number, SourcePreset[]>()
  for (const [i, m] of members.entries()) groups.set(find(i), [...(groups.get(find(i)) ?? []), m])
  return [...groups.values()]
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
const fitsOneFont = (members: SourcePreset[]): boolean => {
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
  if (fitsOneFont(component)) return [component]
  if (component.length === 1) throw new Error(`${component[0]?.key ?? 'a preset'} alone exceeds one SF2 file`)
  const allCuts = Array.from({ length: component.length - 1 }, (_, i) => i + 1)
  const bothFit = allCuts.filter(k => fitsOneFont(component.slice(0, k)) && fitsOneFont(component.slice(k)))
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
  if (fitsOneFont(ordered)) return [ordered]
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
    if (fitsOneFont([...last, ...component])) last.push(...component)
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
const splitProblem = ({ chunks, family }: { chunks: SourcePreset[][]; family: string }): string =>
  `${family}: ${chunks.length} fonts needed:\n${chunks
    .map((c, i) => `  font ${i + 1} (${c.length} sounds): ${c.map(p => p.name).join(' / ')}`)
    .join('\n')}`
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
const grandTones = async ({
  embeddings,
  labels,
  presets
}: {
  embeddings: Map<string, number[]>
  labels: Map<string, Family>
  presets: SourcePreset[]
}): Promise<Map<string, string>> => {
  const [bright, dark] = await embedTexts(['bright grand piano', 'dark grand piano'])
  if (bright === undefined || dark === undefined) throw new Error('CLAP returned no tone prompts')
  const grands = presets.filter(p => {
    const family = labels.get(p.key)
    return family !== undefined && topicOf({ family, name: p.name }) === 'Grand'
  })
  const scored = grands.map(p => {
    const embedding = embeddings.get(p.key)
    if (embedding === undefined) throw new Error(`no embedding for ${p.key}`)
    return { p, score: cosineDistance(embedding, bright) - cosineDistance(embedding, dark) }
  })
  const scoreOf = new Map(scored.map(x => [x.p.key, x.score]))
  const parent = new Map<string, string>()
  const find = (k: string): string => {
    let r = k
    while (parent.get(r) !== undefined && parent.get(r) !== r) r = parent.get(r) ?? r
    return r
  }
  const owner = new Map<string, string>()
  for (const { p } of scored) {
    parent.set(p.key, p.key)
    for (const inst of p.instruments) {
      const o = owner.get(inst.id)
      if (o === undefined) owner.set(inst.id, p.key)
      else parent.set(find(p.key), find(o))
    }
  }
  const byRoot = new Map<string, SourcePreset[]>()
  for (const { p } of scored) byRoot.set(find(p.key), [...(byRoot.get(find(p.key)) ?? []), p])
  const mean = (ms: SourcePreset[]): number => ms.reduce((t, m) => t + (scoreOf.get(m.key) ?? 0), 0) / ms.length
  const components = [...byRoot.values()]
    .map(ms => ms.toSorted((x, y) => (scoreOf.get(x.key) ?? 0) - (scoreOf.get(y.key) ?? 0) || byCodeUnit(x.key, y.key)))
    .toSorted((x, y) => mean(x) - mean(y) || byCodeUnit(x[0]?.key ?? '', y[0]?.key ?? ''))
  const groups: SourcePreset[][] = [[]]
  for (const component of components) {
    const last = groups.at(-1) ?? []
    if (fitsOneFont([...last, ...component])) last.push(...component)
    else if (fitsOneFont(component)) groups.push([...component])
    else
      for (const p of component) {
        const tail = groups.at(-1) ?? []
        if (fitsOneFont([...tail, p])) tail.push(p)
        else groups.push([p])
      }
  }
  const ladder = GRAND_TONE_LADDERS[groups.length - 1]
  if (ladder === undefined) throw new Error(`grands need ${groups.length} fonts, more than the tone ladder names`)
  const tones = new Map<string, string>()
  for (const [g, members] of groups.entries()) for (const p of members) tones.set(p.key, ladder[g] ?? '')
  log(`grands by tone: ${groups.map((m, g) => `${ladder[g] ?? ''} ${m.length}`).join(', ')}`)
  return tones
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
  const fonts: PlannedFont[] = []
  const splitProblems: string[] = []
  for (const [family, members] of byFamily) {
    const byTopic = new Map<string, SourcePreset[]>()
    for (const m of members) {
      const named = topicOf({ family, name: m.name })
      const topic = named === 'Grand' ? tones.get(m.key) : named
      if (topic === undefined) throw new Error(`no tone for grand ${m.key}`)
      byTopic.set(topic, [...(byTopic.get(topic) ?? []), m])
    }
    for (const [fontName, topicMembers] of byTopic) {
      const planned = planFamily({ embeddings, family, fontName, members: topicMembers, recordingBytes })
      fonts.push(...planned.fonts)
      splitProblems.push(...planned.problems)
    }
  }
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
const stagedNames = (wanted: Map<string, Wanted[]>): Map<string, string> =>
  new Map([...wanted.values()].flatMap(needs => needs.map((n, i) => [n.key, `s${i}`] as const)))
const cloneNeeds = ({
  byKey,
  names,
  needs,
  stage,
  u
}: {
  byKey: Map<string, BasicPreset>
  names: Map<string, string>
  needs: Wanted[]
  stage: BasicSoundBank
  u: UpstreamFile
}) => {
  const cloner = new SoundBankCloner(stage, { addToBank: true, reuseByName: false, reuseChildren: 'identity' })
  for (const n of needs) {
    const source = byKey.get(n.key)
    if (source === undefined) throw new Error(`staging: ${n.key} vanished from ${u.path}`)
    const copy = cloner.clonePreset(source)
    const name = names.get(n.key)
    if (name === undefined) throw new Error(`staging: no staged name for ${n.key}`)
    copy.name = name
  }
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
}): Promise<void> => {
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
    const byStagedName = new Map(bank.presets.map(p => [p.name, p]))
    for (const m of font.members.filter(x => x.key.startsWith(`${source}|`))) {
      const staged = byStagedName.get(names.get(m.key) ?? '')
      if (staged !== undefined) sources.set(m.key, staged)
    }
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
}): Promise<void> => {
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
const stageAndWrite = async ({
  plan,
  paths,
  upstream
}: {
  paths: Paths
  plan: Planned[]
  upstream: UpstreamFile[]
}): Promise<void> => {
  const wanted = wantedBySource(plan)
  const stageDir = join(paths.cache, 'stage')
  await mkdir(stageDir, { recursive: true })
  const toStage = upstream.flatMap(u => {
    const needs = wanted.get(u.path) ?? []
    return needs.length > 0 ? [{ needs, u }] : []
  })
  const names = stagedNames(wanted)
  for (const { needs, u } of toStage) await stageSource({ names, needs, paths, stageDir, u })
  const shaOf = new Map(upstream.map(u => [u.path, u.sha256]))
  const creationDate = new Date(UPSTREAM.commitDate)
  await mkdir(paths.output, { recursive: true })
  for (const font of plan) await writeFont({ creationDate, font, names, paths, shaOf, stageDir })
}
const proveOutput = async ({
  isDrumKey,
  paths,
  plan,
  readSource
}: {
  isDrumKey: Set<string>
  paths: Paths
  plan: Planned[]
  readSource: (key: string) => Promise<Float32Array[]>
}): Promise<void> => {
  const failures: string[] = []
  for (const font of plan) {
    const fontPath = join(paths.output, `${font.fileName}.sf2`)
    const slots = font.members.map((m, program) => ({ bank: font.bank, isDrum: isDrumKey.has(m.key), program }))
    const rendered = await renderFont({
      fontPath,
      sampleRate: NULL_SAMPLE_RATE,
      slots,
      workDir: join(paths.cache, 'work')
    })
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
  }
  if (failures.length > 0) throw new Error(`output does not sound like its source:\n${failures.join('\n')}`)
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
const writeManifest = async ({ merges, paths, plan }: { merges: Merge[]; paths: Paths; plan: Planned[] }) => {
  const manifest = {
    excluded: UPSTREAM.excluded,
    fonts: plan.map(f => ({
      bank: f.bank,
      file: `${f.fileName}.sf2`,
      presets: f.members.map((m, program) => ({ name: m.name, program, source: m.key }))
    })),
    merges: merges.map((m: Merge) => ({
      into: m.into,
      ...(Number.isNaN(m.nullDb) ? {} : { nullDb: m.nullDb }),
      reason: m.reason,
      source: m.key
    })),
    upstream: { commit: UPSTREAM.commit, dataset: UPSTREAM.dataset }
  }
  await write(join(paths.output, 'manifest.json'), `${JSON.stringify(manifest, undefined, 2)}\n`)
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
  const sounds = await analyseAndDedupe({ paths, upstream })
  const labelled = labelAll({ embeddings: sounds.embeddings, presets: sounds.kept })
  await write(join(paths.cache, 'ambiguities.json'), JSON.stringify(labelled.ambiguities, undefined, 2))
  await write(
    join(paths.cache, 'labels.json'),
    JSON.stringify(
      sounds.kept.map(p => ({ family: labelled.labels.get(p.key), key: p.key, name: p.name })),
      undefined,
      1
    )
  )
  const labels = placeLayers({
    labels: labelled.labels,
    presets: sounds.kept,
    recordingBytes: sounds.recordingBytes
  })
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
  await stageAndWrite({ paths, plan, upstream })
  const isDrumKey = new Set(sounds.kept.filter(p => p.slot.isDrum).map(p => p.key))
  await proveOutput({ isDrumKey, paths, plan, readSource: sounds.readSource })
  await writeManifest({ merges: sounds.merges, paths, plan })
  log(`ok: ${plan.length} fonts, ${sounds.kept.length} sounds`)
}
await main()
