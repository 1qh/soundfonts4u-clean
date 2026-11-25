/** biome-ignore-all lint/performance/noAwaitInLoops: survivors are compared in preference order with early exit, so each null test waits on the previous one */
/* eslint-disable no-await-in-loop */
import type { SourcePreset } from './fonts.js'
interface DedupeResult {
  kept: SourcePreset[]
  merges: Merge[]
}
interface Energy {
  residual: number
  signalA: number
  signalB: number
}
interface Merge {
  into: string
  key: string
  nullDb: number
  reason: 'audibly-identical' | 'superseded-version'
}
const NULL_THRESHOLD_DB = -60
const SILENT_DB = -999
const VERSION_FAMILIES: Readonly<Record<string, readonly string[]>> = {
  '2Grands-Plus-Instruments-bs16i': ['2Grands-Plus-Instruments-bs16i-v1.2.sf2', '2Grands-Plus-Instruments-bs16i-v4.0.sf2'],
  'Chateau Grand': ['Chateau Grand-v1.8.sf2', 'Chateau Grand-v2.2.sf2'],
  'ChateauGrand-Plus-Instruments-bs16i': [
    'ChateauGrand-Plus-Instruments-bs16i-v1.4.sf2',
    'ChateauGrand-Plus-Instruments-bs16i-v3.0.sf2'
  ],
  "Dore Mark's NY S&S Model B": ["Dore Mark's NY S&S Model B-v5.1.sf2", "Dore Mark's NY S&S Model B-v5.2.sf2"],
  'Essential Keys-bs16i': ['Essential Keys-bs16i-v10.9.sf2', 'Essential Keys-bs16i-v11.1.sf2'],
  'Essential Keys-sforzando': [
    'Essential Keys-sforzando-v7.7.sf2',
    'Essential Keys-sforzando-v9.5.sf2',
    'Essential Keys-sforzando-v9.6.sf2'
  ],
  'Expressive Flute SSO': ['Expressive Flute SSO-v1.0.sf2', 'Expressive Flute SSO-v1.2.sf2'],
  'Nice-Bass-Plus-Drums': ['Nice-Bass-Plus-Drums-v5.1.sf2', 'Nice-Bass-Plus-Drums-v5.2.sf2']
}
const newestOf = new Map<string, string>()
for (const versions of Object.values(VERSION_FAMILIES)) {
  const newest = versions.at(-1)
  if (newest === undefined) throw new Error('empty version family')
  for (const v of versions) newestOf.set(v, newest)
}
const isOlderVersion = (sourceFile: string): boolean => {
  const newest = newestOf.get(sourceFile)
  return newest !== undefined && newest !== sourceFile
}
const preferenceOrder = (a: SourcePreset, b: SourcePreset): number =>
  Number(isOlderVersion(a.sourceFile)) - Number(isOlderVersion(b.sourceFile)) ||
  a.sourceFile.localeCompare(b.sourceFile) ||
  a.slot.bank - b.slot.bank ||
  a.slot.program - b.slot.program
const addChannel = ({
  channelA,
  channelB,
  total
}: {
  channelA: Float32Array
  channelB: Float32Array
  total: Energy
}): Energy => {
  let { residual, signalA, signalB } = total
  for (const [i, x] of channelA.entries()) {
    const y = channelB[i] ?? 0
    signalA += x * x
    signalB += y * y
    residual += (x - y) * (x - y)
  }
  return { residual, signalA, signalB }
}
const energies = (a: Float32Array[], b: Float32Array[]): Energy => {
  let total: Energy = { residual: 0, signalA: 0, signalB: 0 }
  for (const [c, channelA] of a.entries()) {
    const channelB = b[c]
    if (channelB?.length !== channelA.length) throw new Error('null test on segments of different shape')
    total = addChannel({ channelA, channelB, total })
  }
  return total
}
const nullDb = (a: Float32Array[], b: Float32Array[]): number => {
  const { residual, signalA, signalB } = energies(a, b)
  const signal = Math.max(signalA, signalB)
  if (residual === 0) return SILENT_DB
  if (signal === 0) throw new Error('null test on 2 silent segments')
  return 10 * Math.log10(residual / signal)
}
const namesBySource = (presets: SourcePreset[]): Map<string, Map<string, string>> => {
  const namesIn = new Map<string, Map<string, string>>()
  for (const p of presets) {
    const byName = namesIn.get(p.sourceFile) ?? new Map<string, string>()
    byName.set(p.name.toLowerCase(), p.key)
    namesIn.set(p.sourceFile, byName)
  }
  return namesIn
}
const dropSuperseded = (presets: SourcePreset[]): { kept: SourcePreset[]; merges: Merge[] } => {
  const namesIn = namesBySource(presets)
  const kept: SourcePreset[] = []
  const merges: Merge[] = []
  for (const p of presets) {
    const newest = newestOf.get(p.sourceFile)
    const replacement =
      newest === undefined || newest === p.sourceFile ? undefined : namesIn.get(newest)?.get(p.name.toLowerCase())
    if (replacement === undefined) kept.push(p)
    else merges.push({ into: replacement, key: p.key, nullDb: Number.NaN, reason: 'superseded-version' })
  }
  return { kept, merges }
}
const findMatch = async ({
  p,
  segmentOf,
  survivors
}: {
  p: SourcePreset
  segmentOf: (key: string) => Promise<Float32Array[]>
  survivors: SourcePreset[]
}): Promise<undefined | { db: number; s: SourcePreset }> => {
  const mine = await segmentOf(p.key)
  for (const s of survivors) {
    const db = nullDb(mine, await segmentOf(s.key))
    if (db <= NULL_THRESHOLD_DB) return { db, s }
  }
  return undefined
}
const groupByRecordings = (presets: SourcePreset[]): SourcePreset[][] => {
  const byRecordings = new Map<string, SourcePreset[]>()
  for (const p of presets) {
    const id = p.recordings.join(',')
    byRecordings.set(id, [...(byRecordings.get(id) ?? []), p])
  }
  return [...byRecordings.values()]
}
const mergeGroup = async ({
  group,
  segmentOf
}: {
  group: SourcePreset[]
  segmentOf: (key: string) => Promise<Float32Array[]>
}): Promise<{ kept: SourcePreset[]; merges: Merge[] }> => {
  const survivors: SourcePreset[] = []
  const merges: Merge[] = []
  const preferred = group.toSorted(preferenceOrder)
  for (const p of preferred) {
    const match = await findMatch({ p, segmentOf, survivors })
    if (match === undefined) survivors.push(p)
    else merges.push({ into: match.s.key, key: p.key, nullDb: match.db, reason: 'audibly-identical' })
  }
  return { kept: survivors, merges }
}
const mergeAudiblyIdentical = async ({
  presets,
  segmentOf
}: {
  presets: SourcePreset[]
  segmentOf: (key: string) => Promise<Float32Array[]>
}): Promise<{ kept: SourcePreset[]; merges: Merge[] }> => {
  const kept: SourcePreset[] = []
  const merges: Merge[] = []
  const groups = groupByRecordings(presets)
  for (const group of groups) {
    const merged = await mergeGroup({ group, segmentOf })
    kept.push(...merged.kept)
    merges.push(...merged.merges)
  }
  return { kept, merges }
}
const dedupe = async ({
  presets,
  segmentOf
}: {
  presets: SourcePreset[]
  segmentOf: (key: string) => Promise<Float32Array[]>
}): Promise<DedupeResult> => {
  const versioned = dropSuperseded(presets)
  const audible = await mergeAudiblyIdentical({ presets: versioned.kept, segmentOf })
  return { kept: audible.kept, merges: [...versioned.merges, ...audible.merges] }
}
export type { DedupeResult, Merge }
export { dedupe, NULL_THRESHOLD_DB, nullDb }
