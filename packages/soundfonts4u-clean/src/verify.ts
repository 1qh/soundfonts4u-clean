/* eslint-disable no-await-in-loop */
import type { BasicPreset } from 'spessasynth_core'
import { file, gc } from 'bun'
import { readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { byCodeUnit, listPresets, loadFont } from './fonts.js'
import { MAX_NAME_LENGTH } from './names.js'
interface Disposition {
  reason: string
  source: string
}
interface Manifest {
  dropped: Disposition[]
  excluded: string[]
  fonts: ManifestFont[]
  merges: ManifestMerge[]
  upstream: { commit: string; dataset: string }
}
interface ManifestFont {
  bank: number
  file: string
  presets: ManifestPreset[]
}
interface ManifestMerge extends Disposition {
  into: string
  nullDb?: number
}
interface ManifestPreset {
  name: string
  program: number
  source: string
}
const FONT_NAME = /^[A-Z][A-Za-z]+\.sf2$/v
const MAX_PRESETS = 128
const PRESET_NAME = /^[A-Z][A-Za-z]*$/v
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const isArrayOf = <T>(value: unknown, isItem: (item: unknown) => item is T): value is T[] =>
  Array.isArray(value) && value.every(isItem)
const isString = (value: unknown): value is string => typeof value === 'string'
const isDisposition = (value: unknown): value is Disposition =>
  isRecord(value) && isString(value.reason) && isString(value.source)
const isMerge = (value: unknown): value is ManifestMerge =>
  isRecord(value) &&
  isString(value.into) &&
  (value.nullDb === undefined || typeof value.nullDb === 'number') &&
  isDisposition(value)
const isPreset = (value: unknown): value is ManifestPreset =>
  isRecord(value) && isString(value.name) && typeof value.program === 'number' && isString(value.source)
const isFont = (value: unknown): value is ManifestFont =>
  isRecord(value) && typeof value.bank === 'number' && isString(value.file) && isArrayOf(value.presets, isPreset)
const isManifest = (value: unknown): value is Manifest =>
  isRecord(value) &&
  isArrayOf(value.dropped, isDisposition) &&
  isArrayOf(value.excluded, isString) &&
  isArrayOf(value.fonts, isFont) &&
  isArrayOf(value.merges, isMerge) &&
  isRecord(value.upstream) &&
  isString(value.upstream.commit) &&
  isString(value.upstream.dataset)
const describeError = (error: unknown): string => JSON.stringify(error instanceof Error ? error.message : String(error))
const readManifest = async (fontsDir: string, failures: string[]) => {
  const path = join(fontsDir, 'manifest.json')
  try {
    const manifest: unknown = await file(path).json()
    if (isManifest(manifest)) return manifest
    failures.push(`manifest: invalid shape in ${path}`)
  } catch (manifestError) {
    failures.push(`manifest: cannot read ${path}: ${describeError(manifestError)}`)
  }
}
const readDirectory = async (dir: string, isRecursive: boolean, failures: string[]) => {
  try {
    const entries = await readdir(dir, { recursive: isRecursive, withFileTypes: true })
    return entries
      .filter(entry => entry.isFile() || entry.isSymbolicLink())
      .map(entry => relative(dir, join(entry.parentPath, entry.name)))
      .toSorted(byCodeUnit)
  } catch (directoryError) {
    failures.push(`directory: cannot list ${dir}: ${describeError(directoryError)}`)
  }
}
const addUpstreamKeys = async ({
  failures,
  inputDir,
  keys,
  sourceFile
}: {
  failures: string[]
  inputDir: string
  keys: Set<string>
  sourceFile: string
}) => {
  try {
    const bank = await loadFont(join(inputDir, sourceFile))
    const presets = listPresets({ bank, recordingBytes: new Map(), sourceFile })
    for (const { key } of presets) keys.add(key)
  } catch (upstreamError) {
    failures.push(`upstream: cannot read ${JSON.stringify(sourceFile)}: ${describeError(upstreamError)}`)
  }
}
const readUpstreamKeys = async (inputDir: string, excluded: string[], failures: string[]) => {
  const keys = new Set<string>()
  const excludedFiles = new Set(excluded)
  const files = await readDirectory(inputDir, true, failures)
  const sourceFiles = (files ?? []).filter(name => name.endsWith('.sf2') && !excludedFiles.has(name))
  for (const sourceFile of sourceFiles) {
    // biome-ignore lint/performance/noAwaitInLoops: Load one upstream SoundFont at a time to bound memory.
    await addUpstreamKeys({ failures, inputDir, keys, sourceFile })
    gc(true)
  }
  return keys
}
const checkAccounting = (manifest: Manifest, keys: Set<string>, failures: string[]) => {
  const shipped = new Set(manifest.fonts.flatMap(font => font.presets.map(p => p.source)))
  const merged = new Set(manifest.merges.map(m => m.source))
  const dropped = new Set(manifest.dropped.map(d => d.source))
  for (const key of keys) {
    const categories = [
      ...(shipped.has(key) ? ['shipped'] : []),
      ...(merged.has(key) ? ['merged'] : []),
      ...(dropped.has(key) ? ['dropped'] : [])
    ]
    if (categories.length === 0) failures.push(`accounting: missing upstream preset ${JSON.stringify(key)}`)
    if (categories.length > 1)
      failures.push(`accounting: upstream preset ${JSON.stringify(key)} is in ${categories.join(', ')}`)
  }
  for (const { into, source } of manifest.merges)
    if (!(shipped.has(into) || dropped.has(into)))
      failures.push(
        `accounting: merge ${JSON.stringify(source)} targets a preset that neither ships nor is dropped: ${JSON.stringify(into)}`
      )
}
const checkPresetName = ({
  failures,
  location,
  name,
  seenNames
}: {
  failures: string[]
  location: string
  name: string
  seenNames: Map<string, string>
}) => {
  const label = JSON.stringify(name)
  if (!PRESET_NAME.test(name)) failures.push(`names: ${location} has invalid name ${label}`)
  if (name.length > MAX_NAME_LENGTH)
    failures.push(`names: ${location} name ${label} has ${name.length} characters, maximum ${MAX_NAME_LENGTH}`)
  const first = seenNames.get(name)
  if (first === undefined) seenNames.set(name, location)
  else failures.push(`names: ${location} repeats name ${label} from ${first}`)
}
const checkFontStructure = (presets: BasicPreset[], fontFile: string, failures: string[]) => {
  const banks = new Set(presets.map(p => p.bankMSB))
  if (banks.size !== 1) failures.push(`structure: ${fontFile} has ${banks.size} banks, expected 1`)
  if (presets.length > MAX_PRESETS)
    failures.push(`structure: ${fontFile} has ${presets.length} presets, maximum ${MAX_PRESETS}`)
}
const checkWrittenPresets = ({
  failures,
  fontFile,
  presets,
  seenNames
}: {
  failures: string[]
  fontFile: string
  presets: BasicPreset[]
  seenNames: Map<string, string>
}) => {
  const programs = new Set<number>()
  for (const { name, program } of presets) {
    if (programs.has(program)) failures.push(`structure: ${fontFile} repeats program ${program}`)
    programs.add(program)
    checkPresetName({ failures, location: `${fontFile} program ${program}`, name, seenNames })
  }
}
const checkWrittenFont = async ({
  failures,
  fontFile,
  path,
  seenNames
}: {
  failures: string[]
  fontFile: string
  path: string
  seenNames: Map<string, string>
}) => {
  try {
    const { presets } = await loadFont(path)
    checkFontStructure(presets, fontFile, failures)
    checkWrittenPresets({ failures, fontFile, presets, seenNames })
    return presets.toSorted((a, b) => a.program - b.program).map(p => p.name)
  } catch (fontError) {
    failures.push(`fonts: cannot read ${fontFile}: ${describeError(fontError)}`)
  }
}
const checkManifestPresetName = ({
  expectedName,
  failures,
  fontFile,
  name,
  position
}: {
  expectedName: string
  failures: string[]
  fontFile: string
  name: string | undefined
  position: number
}) => {
  if (name === expectedName) return
  const label = name === undefined ? 'no preset' : JSON.stringify(name)
  failures.push(
    `names: ${fontFile} at position ${position} in program order has ${label}, manifest expects ${JSON.stringify(expectedName)}`
  )
}
const checkManifestPresets = (font: ManifestFont, actual: string[], failures: string[]) => {
  const fontFile = JSON.stringify(font.file)
  const expected = font.presets.toSorted((a, b) => a.program - b.program)
  if (actual.length !== expected.length)
    failures.push(`structure: ${fontFile} has ${actual.length} presets, manifest expects ${expected.length}`)
  for (const [index, preset] of expected.entries())
    checkManifestPresetName({ expectedName: preset.name, failures, fontFile, name: actual[index], position: index + 1 })
}
const checkListedFonts = (fonts: ManifestFont[], files: string[] | undefined, failures: string[]) => {
  const written = files === undefined ? undefined : new Set(files)
  for (const font of fonts) {
    const fontFile = JSON.stringify(font.file)
    if (!FONT_NAME.test(font.file)) failures.push(`files: invalid font filename ${fontFile}`)
    if (written?.has(font.file) === false) failures.push(`files: missing font ${fontFile}`)
  }
}
const countWrittenSounds = async ({
  failures,
  fonts,
  fontsDir,
  hasManifest,
  name,
  seenNames
}: {
  failures: string[]
  fonts: ManifestFont[] | undefined
  fontsDir: string
  hasManifest: boolean
  name: string
  seenNames: Map<string, string>
}) => {
  const fontFile = JSON.stringify(name)
  if (hasManifest && fonts === undefined) failures.push(`files: unexpected font ${fontFile}`)
  const actual = await checkWrittenFont({ failures, fontFile, path: join(fontsDir, name), seenNames })
  gc(true)
  if (actual === undefined) return 0
  const entries = fonts ?? []
  for (const font of entries) checkManifestPresets(font, actual, failures)
  return actual.length
}
const sumWrittenSounds = async ({
  failures,
  fontFiles,
  fontsDir,
  listed,
  manifest
}: {
  failures: string[]
  fontFiles: string[]
  fontsDir: string
  listed: Map<string, ManifestFont[]>
  manifest: Manifest | undefined
}): Promise<number> => {
  const seenNames = new Map<string, string>()
  let sounds = 0
  for (const name of fontFiles) {
    // biome-ignore lint/performance/noAwaitInLoops: Load one written SoundFont at a time to bound memory.
    const counted = await countWrittenSounds({
      failures,
      fonts: listed.get(name),
      fontsDir,
      hasManifest: manifest !== undefined,
      name,
      seenNames
    })
    sounds += counted
  }
  return sounds
}
const checkWrittenFonts = async (fontsDir: string, manifest: Manifest | undefined, failures: string[]) => {
  const files = await readDirectory(fontsDir, false, failures)
  const manifestFonts = manifest?.fonts ?? []
  checkListedFonts(manifestFonts, files, failures)
  const listed = Map.groupBy(manifestFonts, font => font.file)
  const fontFiles = (files ?? []).filter(name => name.endsWith('.sf2') || listed.has(name))
  const sounds = await sumWrittenSounds({ failures, fontFiles, fontsDir, listed, manifest })
  return { fonts: fontFiles.length, sounds }
}
const countUpstreamPresets = async (inputDir: string, manifest: Manifest | undefined, failures: string[]) => {
  if (manifest === undefined) return
  const keys = await readUpstreamKeys(inputDir, manifest.excluded, failures)
  checkAccounting(manifest, keys, failures)
  return keys.size
}
const reportVerification = ({
  failures,
  fonts,
  sounds,
  upstreamPresets
}: {
  failures: string[]
  fonts: number
  sounds: number
  upstreamPresets: number | undefined
}) => {
  if (upstreamPresets !== undefined && failures.length === 0) {
    process.stdout.write(`ok: ${fonts} fonts, ${sounds} sounds, ${upstreamPresets} upstream presets accounted\n`)
    return 0
  }
  for (const failure of failures) process.stderr.write(`${failure}\n`)
  return 1
}
const verify = async (inputDir: string, fontsDir: string) => {
  const failures: string[] = []
  const manifest = await readManifest(fontsDir, failures)
  const { fonts, sounds } = await checkWrittenFonts(fontsDir, manifest, failures)
  const upstreamPresets = await countUpstreamPresets(inputDir, manifest, failures)
  return reportVerification({ failures, fonts, sounds, upstreamPresets })
}
const main = async () => {
  const [inputDir, fontsDir] = process.argv.slice(2)
  if (inputDir === undefined || inputDir.length === 0 || fontsDir === undefined || fontsDir.length === 0) {
    process.stderr.write('usage: bun packages/soundfonts4u-clean/src/verify.ts <upstream input dir> <fonts dir>\n')
    return 1
  }
  const exitCode = await verify(inputDir, fontsDir)
  return exitCode
}
process.exitCode = await main()
