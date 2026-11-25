/** biome-ignore-all lint/performance/noAwaitInLoops: fonts are analysed, staged, written and proved one at a time to bound memory, and their log lines follow that order */
/* eslint-disable no-await-in-loop */
import type { BasicPreset } from 'spessasynth_core'
import { file, write } from 'bun'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { BasicSoundBank } from 'spessasynth_core'
import type { Merge } from './dedupe.js'
import type { Family } from './families.js'
import type { SourcePreset } from './fonts.js'
import type { PresetSlot } from './render.js'
import type { UpstreamFile } from './upstream.js'
import type { FamilyFont } from './write.js'
import { dedupe, NULL_THRESHOLD_DB, nullDb } from './dedupe.js'
import { CLAP_SAMPLE_RATE, createEmbedder, toMono } from './embed.js'
import { labelAll, placeLayers } from './families.js'
import { listPresets, loadFont, presetKey, slotOf } from './fonts.js'
import { SUBFAMILY_NAMES } from './hand-table.js'
import { assignNames } from './names.js'
import { centroid, orderBySimilarity } from './order.js'
import { renderFont, segmentOf } from './render.js'
import { hasSegments, openSegments, storeSegments } from './store.js'
import { UPSTREAM, verifyInput } from './upstream.js'
import { buildFamilyFont } from './write.js'
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
  const segDir = join(work.paths.cache, 'render64', work.upstream.sha256)
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
  await mkdir(join(work.paths.cache, 'clap'), { recursive: true })
  await write(embPath, JSON.stringify(fresh))
}
const ensureEmbeddings = async ({
  embeddings,
  work
}: {
  embeddings: Map<string, number[]>
  work: FontWork
}): Promise<void> => {
  const embPath = join(work.paths.cache, 'clap', `${work.upstream.sha256}.json`)
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
  for (const u of files) readers.set(u.path, await openSegments(join(paths.cache, 'render64', u.sha256)))
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
const splitFamily = ({ family, ordered }: { family: Family; ordered: SourcePreset[] }): SourcePreset[][] => {
  if (ordered.length <= MAX_PRESETS_PER_BANK) return [ordered]
  const position = new Map(ordered.map((p, i) => [p.key, i]))
  const components = recordingComponents(ordered).toSorted(
    (a, b) => Math.min(...a.map(p => position.get(p.key) ?? 0)) - Math.min(...b.map(p => position.get(p.key) ?? 0))
  )
  const chunks: SourcePreset[][] = [[]]
  for (const component of components) {
    const last = chunks.at(-1) ?? []
    if (component.length > MAX_PRESETS_PER_BANK)
      throw new Error(`${family}: ${component.length} presets share recordings, more than one bank holds`)
    if (last.length + component.length > MAX_PRESETS_PER_BANK) chunks.push([...component])
    else last.push(...component)
  }
  return chunks.map(c => c.toSorted((a, b) => (position.get(a.key) ?? 0) - (position.get(b.key) ?? 0)))
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
const splitProblem = ({ chunks, family }: { chunks: SourcePreset[][]; family: Family }): string =>
  `${family}: ${chunks.length} fonts needed; first sounds per chunk: ${chunks
    .map(c =>
      c
        .slice(0, 4)
        .map(p => p.name)
        .join(' / ')
    )
    .join(' || ')}`
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
  members
}: {
  embeddings: Map<string, number[]>
  family: Family
  members: SourcePreset[]
}): { fonts: PlannedFont[]; problems: string[] } => {
  const chunks = splitFamily({ family, ordered: orderFamily({ embeddings, members }) })
  const subNames = chunks.length === 1 ? [family] : SUBFAMILY_NAMES[family]
  if (subNames?.length !== chunks.length) return { fonts: [], problems: [splitProblem({ chunks, family })] }
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
const planFonts = ({
  embeddings,
  labels,
  names,
  presets
}: {
  embeddings: Map<string, number[]>
  labels: Map<string, Family>
  names: Map<string, string>
  presets: SourcePreset[]
}): Planned[] => {
  const byFamily = groupByFamily({ labels, presets })
  const fonts: PlannedFont[] = []
  const splitProblems: string[] = []
  for (const [family, members] of byFamily) {
    const planned = planFamily({ embeddings, family, members })
    fonts.push(...planned.fonts)
    splitProblems.push(...planned.problems)
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
const cloneNeeds = ({
  byKey,
  needs,
  stage,
  u
}: {
  byKey: Map<string, BasicPreset>
  needs: Wanted[]
  stage: BasicSoundBank
  u: UpstreamFile
}) => {
  for (const n of needs) {
    const source = byKey.get(n.key)
    if (source === undefined) throw new Error(`staging: ${n.key} vanished from ${u.path}`)
    const copy = stage.clonePreset(source, { addToBank: true, reuseByName: false, reuseChildren: 'identity' })
    copy.name = n.key
  }
}
const stageSource = async ({
  needs,
  paths,
  stageDir,
  u
}: {
  needs: Wanted[]
  paths: Paths
  stageDir: string
  u: UpstreamFile
}): Promise<void> => {
  const bank = await loadFont(join(paths.input, u.path))
  const byKey = new Map(bank.presets.map(p => [presetKey({ slot: slotOf(p), sourceFile: u.path }), p]))
  const stage = new BasicSoundBank('sf2', false)
  cloneNeeds({ byKey, needs, stage, u })
  stage.removeUnusedElements()
  stage.flush(false)
  await write(
    join(stageDir, `${u.sha256}.sf2`),
    stage.writeSF2({ writeDefaultModulators: false, writeExtendedLimits: true })
  )
  log(`staged ${needs.length} presets from ${u.path}`)
}
const loadStaged = async ({
  font,
  shaOf,
  stageDir
}: {
  font: Planned
  shaOf: Map<string, string>
  stageDir: string
}): Promise<Map<string, BasicPreset>> => {
  const sources = new Map<string, BasicPreset>()
  const sourceFiles = new Set(font.members.map(m => m.key.split('|')[0] ?? ''))
  for (const source of sourceFiles) {
    const bank = await loadFont(join(stageDir, `${shaOf.get(source) ?? ''}.sf2`))
    for (const p of bank.presets) sources.set(p.name, p)
  }
  return sources
}
const writeFont = async ({
  creationDate,
  font,
  paths,
  shaOf,
  stageDir
}: {
  creationDate: Date
  font: Planned
  paths: Paths
  shaOf: Map<string, string>
  stageDir: string
}): Promise<void> => {
  const sources = await loadStaged({ font, shaOf, stageDir })
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
  for (const { needs, u } of toStage) await stageSource({ needs, paths, stageDir, u })
  const shaOf = new Map(upstream.map(u => [u.path, u.sha256]))
  const creationDate = new Date(UPSTREAM.commitDate)
  await mkdir(paths.output, { recursive: true })
  for (const font of plan) await writeFont({ creationDate, font, paths, shaOf, stageDir })
}
const proveOutput = async ({
  paths,
  plan,
  readSource
}: {
  paths: Paths
  plan: Planned[]
  readSource: (key: string) => Promise<Float32Array[]>
}): Promise<void> => {
  const failures: string[] = []
  for (const font of plan) {
    const fontPath = join(paths.output, `${font.fileName}.sf2`)
    const slots = font.members.map((_, program) => ({ bank: font.bank, isDrum: false, program }))
    const rendered = await renderFont({
      fontPath,
      sampleRate: NULL_SAMPLE_RATE,
      slots,
      workDir: join(paths.cache, 'work')
    })
    for (const [index, m] of font.members.entries()) {
      const db = nullDb(segmentOf({ index, rendered }), await readSource(m.key))
      if (db > NULL_THRESHOLD_DB) failures.push(`${font.fileName}/${m.name} from ${m.key}: null ${db.toFixed(1)} dB`)
    }
    log(`proved ${font.fileName}`)
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
    output: requiredArg(3, 'output dir')
  }
  const upstream = await verifiedUpstream(paths)
  const sounds = await analyseAndDedupe({ paths, upstream })
  const labelled = labelAll({ embeddings: sounds.embeddings, presets: sounds.kept })
  await write(join(paths.cache, 'ambiguities.json'), JSON.stringify(labelled.ambiguities, undefined, 2))
  const labels = placeLayers({
    labels: labelled.labels,
    presets: sounds.kept,
    recordingBytes: sounds.recordingBytes
  })
  const names = await checkedNames({ embeddings: sounds.embeddings, kept: sounds.kept, labels, paths })
  const plan = planFonts({ embeddings: sounds.embeddings, labels, names, presets: sounds.kept })
  await stageAndWrite({ paths, plan, upstream })
  await proveOutput({ paths, plan, readSource: sounds.readSource })
  await writeManifest({ merges: sounds.merges, paths, plan })
  log(`ok: ${plan.length} fonts, ${sounds.kept.length} sounds`)
}
await main()
