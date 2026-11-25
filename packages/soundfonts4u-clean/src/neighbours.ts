import { file, write } from 'bun'
import { readdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { cosineDistance } from './embed.js'
import { byCodeUnit } from './fonts.js'
interface ManifestPreset {
  name: string
  source: string
}
interface ManifestFont {
  file: string
  presets: ManifestPreset[]
}
interface ShippedSound extends ManifestPreset {
  embedding: number[]
  family: string
  font: string
}
interface NeighbourFlag extends ManifestPreset {
  font: string
  neighbourFamily: string
  neighbours: string[]
}
const NEIGHBOUR_COUNT = 5
const FAMILY_THRESHOLD = 3
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && Array.isArray(value) === false
const isManifestPreset = (value: unknown): value is ManifestPreset =>
  isObject(value) && typeof value.name === 'string' && typeof value.source === 'string'
const isManifestFont = (value: unknown): value is ManifestFont =>
  isObject(value) && typeof value.file === 'string' && Array.isArray(value.presets) && value.presets.every(isManifestPreset)
const isEmbedding = (value: unknown): value is number[] =>
  Array.isArray(value) && value.length > 0 && value.every(Number.isFinite)
const readEmbeddingTable = async (tablePath: string): Promise<[string, number[]][]> => {
  const data: unknown = await file(tablePath).json()
  if (isObject(data) === false) throw new TypeError(`expected a CLAP embedding table in ${tablePath}`)
  const entries: [string, number[]][] = []
  for (const [key, vector] of Object.entries(data)) {
    if (isEmbedding(vector) === false) throw new TypeError(`invalid CLAP embedding for ${key} in ${tablePath}`)
    entries.push([key, vector])
  }
  return entries
}
const loadEmbeddings = async (cacheDir: string): Promise<Map<string, number[]>> => {
  const clapDir = join(cacheDir, 'clap')
  const entries = await readdir(clapDir, { withFileTypes: true })
  const folders = entries.filter(entry => entry.isDirectory())
  const [folder] = folders
  if (folder === undefined || folders.length > 1)
    throw new Error(`expected exactly one renderer-key folder in ${clapDir}, found ${folders.length}`)
  const rendererDir = join(clapDir, folder.name)
  const rendererEntries = await readdir(rendererDir, { withFileTypes: true })
  const tables = rendererEntries.filter(entry => entry.isFile() && entry.name.endsWith('.json')).map(entry => entry.name)
  const vectors = await Promise.all(tables.toSorted(byCodeUnit).map(name => readEmbeddingTable(join(rendererDir, name))))
  return new Map(vectors.flat())
}
const familyOf = (font: string): string => {
  const family = basename(font, '.sf2')
  if (family.endsWith('Grand') || family === 'Upright' || family === 'PianoLayer') return 'Piano'
  if (family === 'Percussion') return 'Drums'
  return family
}
const loadShippedSounds = async (fontsDir: string, embeddings: Map<string, number[]>): Promise<ShippedSound[]> => {
  const manifestPath = join(fontsDir, 'manifest.json')
  const manifest: unknown = await file(manifestPath).json()
  if (isObject(manifest) === false || Array.isArray(manifest.fonts) === false || manifest.fonts.every(isManifestFont) === false)
    throw new TypeError(`invalid fonts or presets in ${manifestPath}`)
  const sounds: ShippedSound[] = []
  for (const { file: font, presets } of manifest.fonts) {
    const family = familyOf(font)
    for (const { name, source } of presets) {
      const embedding = embeddings.get(source)
      if (embedding === undefined) throw new Error(`missing CLAP embedding for ${font} / ${name} (${source})`)
      sounds.push({ embedding, family, font, name, source })
    }
  }
  return sounds
}
const flagSound = (sound: ShippedSound, sounds: ShippedSound[]): NeighbourFlag | undefined => {
  const { embedding, family, font, name, source } = sound
  const nearest = sounds
    .filter(other => Object.is(other, sound) === false)
    .map(other => ({ distance: cosineDistance(embedding, other.embedding), other }))
    .toSorted((a, b) => a.distance - b.distance)
    .slice(0, NEIGHBOUR_COUNT)
  const counts = new Map<string, number>()
  for (const { other } of nearest.filter(neighbour => Object.is(neighbour.other.family, family) === false)) {
    const count = (counts.get(other.family) ?? 0) + 1
    if (count === FAMILY_THRESHOLD)
      return { font, name, neighbourFamily: other.family, neighbours: nearest.map(n => n.other.name), source }
    counts.set(other.family, count)
  }
  return undefined
}
const main = async () => {
  const [, , cacheDir, fontsDir] = process.argv
  if (cacheDir === undefined || cacheDir.length === 0 || fontsDir === undefined || fontsDir.length === 0)
    throw new Error('usage: neighbours.ts <cache dir> <fonts dir>')
  const embeddings = await loadEmbeddings(cacheDir)
  const sounds = await loadShippedSounds(fontsDir, embeddings)
  const flags: NeighbourFlag[] = []
  for (const sound of sounds) {
    const flag = flagSound(sound, sounds)
    if (flag) flags.push(flag)
  }
  const sorted = flags.toSorted((a, b) => byCodeUnit(a.font, b.font) || byCodeUnit(a.name, b.name))
  await write(join(cacheDir, 'neighbour-flags.json'), `${JSON.stringify(sorted, undefined, 2)}\n`)
  console.log(`ok: ${flags.length} flagged of ${sounds.length}`)
}
try {
  await main()
} catch (neighbourError) {
  console.error(neighbourError instanceof Error ? neighbourError.message : String(neighbourError))
  process.exitCode = 1
}
