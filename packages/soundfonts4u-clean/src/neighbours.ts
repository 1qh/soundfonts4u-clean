import { file, write } from 'bun'
import { readdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { cosineDistance } from './embed.js'
import { byCodeUnit } from './fonts.js'
interface ManifestFont {
  file: string
  presets: ManifestPreset[]
}
interface ManifestPreset {
  name: string
  source: string
}
interface NeighbourFlag extends ManifestPreset {
  font: string
  neighbourFamily: string
  neighbours: string[]
}
interface ShippedSound extends ManifestPreset {
  embedding: number[]
  family: string
  font: string
}
const NEIGHBOUR_COUNT = 5
const FAMILY_THRESHOLD = 3
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const isManifestPreset = (value: unknown): value is ManifestPreset =>
  isObject(value) && typeof value.name === 'string' && typeof value.source === 'string'
const isManifestFont = (value: unknown): value is ManifestFont =>
  isObject(value) &&
  typeof value.file === 'string' &&
  Array.isArray(value.presets) &&
  value.presets.every(isManifestPreset)
const isEmbedding = (value: unknown): value is number[] =>
  Array.isArray(value) && value.length > 0 && value.every(Number.isFinite)
const readEmbeddingTable = async (tablePath: string): Promise<[string, number[]][]> => {
  const data: unknown = await file(tablePath).json()
  if (!isObject(data)) throw new TypeError(`expected a CLAP embedding table in ${tablePath}`)
  const entries: [string, number[]][] = []
  for (const [key, vector] of Object.entries(data)) {
    if (!isEmbedding(vector)) throw new TypeError(`invalid CLAP embedding for ${key} in ${tablePath}`)
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
  const vectors = await Promise.all(
    tables.toSorted(byCodeUnit).map(async name => readEmbeddingTable(join(rendererDir, name)))
  )
  return new Map(vectors.flat())
}
const familyOf = (font: string): string => {
  const family = basename(font, '.sf2')
  if (family.endsWith('Grand') || family === 'Upright' || family === 'PianoLayer') return 'Piano'
  if (family === 'Percussion') return 'Drums'
  return family
}
const readManifestFonts = async (fontsDir: string): Promise<ManifestFont[]> => {
  const manifestPath = join(fontsDir, 'manifest.json')
  const manifest: unknown = await file(manifestPath).json()
  if (!(isObject(manifest) && Array.isArray(manifest.fonts) && manifest.fonts.every(isManifestFont)))
    throw new TypeError(`invalid fonts or presets in ${manifestPath}`)
  return manifest.fonts
}
const soundsForFont = ({ file: font, presets }: ManifestFont, embeddings: Map<string, number[]>): ShippedSound[] => {
  const family = familyOf(font)
  return presets.map(({ name, source }) => {
    const embedding = embeddings.get(source)
    if (embedding === undefined) throw new Error(`missing CLAP embedding for ${font} / ${name} (${source})`)
    return { embedding, family, font, name, source }
  })
}
const loadShippedSounds = async (fontsDir: string, embeddings: Map<string, number[]>): Promise<ShippedSound[]> => {
  const fonts = await readManifestFonts(fontsDir)
  return fonts.flatMap(font => soundsForFont(font, embeddings))
}
const nearestSounds = (sound: ShippedSound, sounds: ShippedSound[]) =>
  sounds
    .filter(other => !Object.is(other, sound))
    .map(other => ({ distance: cosineDistance(sound.embedding, other.embedding), other }))
    .toSorted((a, b) => a.distance - b.distance)
    .slice(0, NEIGHBOUR_COUNT)
const findNeighbourFamily = (nearest: ReturnType<typeof nearestSounds>, family: string): string | undefined => {
  const counts = new Map<string, number>()
  const otherFamilies = nearest.filter(neighbour => neighbour.other.family !== family)
  for (const { other } of otherFamilies) {
    const count = (counts.get(other.family) ?? 0) + 1
    if (count === FAMILY_THRESHOLD) return other.family
    counts.set(other.family, count)
  }
  return undefined
}
const flagSound = (sound: ShippedSound, sounds: ShippedSound[]): NeighbourFlag | undefined => {
  const { family, font, name, source } = sound
  const nearest = nearestSounds(sound, sounds)
  const neighbourFamily = findNeighbourFamily(nearest, family)
  if (neighbourFamily === undefined) return undefined
  return { font, name, neighbourFamily, neighbours: nearest.map(n => n.other.name), source }
}
const readDirectories = () => {
  const cacheDir = process.argv.at(2)
  const fontsDir = process.argv.at(3)
  if (cacheDir === undefined || cacheDir.length === 0 || fontsDir === undefined || fontsDir.length === 0)
    throw new Error('usage: neighbours.ts <cache dir> <fonts dir>')
  return { cacheDir, fontsDir }
}
const collectFlags = (sounds: ShippedSound[]): NeighbourFlag[] => {
  const flags: NeighbourFlag[] = []
  for (const sound of sounds) {
    const flag = flagSound(sound, sounds)
    if (flag) flags.push(flag)
  }
  return flags.toSorted((a, b) => byCodeUnit(a.font, b.font) || byCodeUnit(a.name, b.name))
}
const main = async () => {
  const { cacheDir, fontsDir } = readDirectories()
  const embeddings = await loadEmbeddings(cacheDir)
  const sounds = await loadShippedSounds(fontsDir, embeddings)
  const flags = collectFlags(sounds)
  await write(join(cacheDir, 'neighbour-flags.json'), `${JSON.stringify(flags, undefined, 2)}\n`)
  process.stdout.write(`ok: ${flags.length} flagged of ${sounds.length}\n`)
}
try {
  await main()
} catch (neighbourError) {
  const message = neighbourError instanceof Error ? neighbourError.message : String(neighbourError)
  process.stderr.write(`${message}\n`)
  process.exitCode = 1
}
