/** biome-ignore-all lint/performance/noAwaitInLoops: Load one SoundFont at a time to bound memory. */
/* eslint-disable no-await-in-loop */
import { file, gc } from 'bun'
import { readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { listPresets, loadFont } from './fonts.js'
import { MAX_NAME_LENGTH } from './names.js'
interface Disposition {
  reason: string
  source: string
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
interface ManifestFont {
  bank: number
  file: string
  presets: ManifestPreset[]
}
interface Manifest {
  dropped: Disposition[]
  excluded: string[]
  fonts: ManifestFont[]
  merges: ManifestMerge[]
  upstream: { commit: string; dataset: string }
}
const FONT_NAME = /^[A-Z][A-Za-z]+\.sf2$/v
const PRESET_NAME = /^[A-Z][A-Za-z]*$/v
const MAX_PRESETS = 128
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && Array.isArray(value) === false
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
  return undefined
}
const readDirectory = async (dir: string, isRecursive: boolean, failures: string[]) => {
  try {
    const entries = await readdir(dir, { recursive: isRecursive, withFileTypes: true })
    return entries
      .filter(entry => entry.isFile() || entry.isSymbolicLink())
      .map(entry => relative(dir, join(entry.parentPath, entry.name)))
      .toSorted()
  } catch (directoryError) {
    failures.push(`directory: cannot list ${dir}: ${describeError(directoryError)}`)
    return undefined
  }
}
const readUpstreamKeys = async (inputDir: string, excluded: string[], failures: string[]) => {
  const keys = new Set<string>()
  const excludedFiles = new Set(excluded)
  const files = await readDirectory(inputDir, true, failures)
  if (files === undefined) return keys
  for (const sourceFile of files.filter(name => name.endsWith('.sf2') && excludedFiles.has(name) === false)) {
    try {
      const bank = await loadFont(join(inputDir, sourceFile))
      for (const { key } of listPresets({ bank, recordingBytes: new Map(), sourceFile })) keys.add(key)
    } catch (upstreamError) {
      failures.push(`upstream: cannot read ${JSON.stringify(sourceFile)}: ${describeError(upstreamError)}`)
    }
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
    if (shipped.has(into) === false && dropped.has(into) === false)
      failures.push(`accounting: merge ${JSON.stringify(source)} targets a preset that neither ships nor is dropped: ${JSON.stringify(into)}`)
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
    const banks = new Set(presets.map(p => p.bankMSB))
    const programs = new Set<number>()
    if ((banks.size === 1) === false) failures.push(`structure: ${fontFile} has ${banks.size} banks, expected 1`)
    if (presets.length > MAX_PRESETS)
      failures.push(`structure: ${fontFile} has ${presets.length} presets, maximum ${MAX_PRESETS}`)
    for (const { name, program } of presets) {
      const location = `${fontFile} program ${program}`
      const label = JSON.stringify(name)
      if (programs.has(program)) failures.push(`structure: ${fontFile} repeats program ${program}`)
      programs.add(program)
      if (PRESET_NAME.test(name) === false) failures.push(`names: ${location} has invalid name ${label}`)
      if (name.length > MAX_NAME_LENGTH)
        failures.push(`names: ${location} name ${label} has ${name.length} characters, maximum ${MAX_NAME_LENGTH}`)
      const first = seenNames.get(name)
      if (first === undefined) seenNames.set(name, location)
      else failures.push(`names: ${location} repeats name ${label} from ${first}`)
    }
    return presets.toSorted((a, b) => a.program - b.program).map(p => p.name)
  } catch (fontError) {
    failures.push(`fonts: cannot read ${fontFile}: ${describeError(fontError)}`)
    return undefined
  }
}
const checkManifestPresets = (font: ManifestFont, actual: string[], failures: string[]) => {
  const fontFile = JSON.stringify(font.file)
  const expected = font.presets.toSorted((a, b) => a.program - b.program)
  if ((actual.length === expected.length) === false)
    failures.push(`structure: ${fontFile} has ${actual.length} presets, manifest expects ${expected.length}`)
  for (const [index, preset] of expected.entries()) {
    const name = actual[index]
    if ((name === preset.name) === false) {
      const label = name === undefined ? 'no preset' : JSON.stringify(name)
      failures.push(
        `names: ${fontFile} at position ${index + 1} in program order has ${label}, manifest expects ${JSON.stringify(preset.name)}`
      )
    }
  }
}
const checkWrittenFonts = async (fontsDir: string, manifest: Manifest | undefined, failures: string[]) => {
  const files = await readDirectory(fontsDir, false, failures)
  const written = files === undefined ? undefined : new Set(files)
  const listed = new Set<string>()
  for (const font of manifest?.fonts ?? []) {
    const fontFile = JSON.stringify(font.file)
    if (FONT_NAME.test(font.file) === false) failures.push(`files: invalid font filename ${fontFile}`)
    if (written?.has(font.file) === false) failures.push(`files: missing font ${fontFile}`)
    listed.add(font.file)
  }
  const seenNames = new Map<string, string>()
  let sounds = 0
  const fontFiles = (files ?? []).filter(name => name.endsWith('.sf2') || listed.has(name))
  for (const name of fontFiles) {
    const fontFile = JSON.stringify(name)
    if (manifest !== undefined && listed.has(name) === false) failures.push(`files: unexpected font ${fontFile}`)
    const actual = await checkWrittenFont({ failures, fontFile, path: join(fontsDir, name), seenNames })
    gc(true)
    if (actual !== undefined) {
      sounds += actual.length
      for (const font of (manifest?.fonts ?? []).filter(f => f.file === name)) checkManifestPresets(font, actual, failures)
    }
  }
  return { fonts: fontFiles.length, sounds }
}
const main = async () => {
  const [, , inputDir, fontsDir] = process.argv
  if (inputDir === undefined || inputDir.length === 0 || fontsDir === undefined || fontsDir.length === 0) {
    console.error('usage: bun packages/soundfonts4u-clean/src/verify.ts <upstream input dir> <fonts dir>')
    return 1
  }
  const failures: string[] = []
  const manifest = await readManifest(fontsDir, failures)
  const { fonts, sounds } = await checkWrittenFonts(fontsDir, manifest, failures)
  if (manifest !== undefined) {
    const keys = await readUpstreamKeys(inputDir, manifest.excluded, failures)
    checkAccounting(manifest, keys, failures)
    if (failures.length === 0) {
      console.log(`ok: ${fonts} fonts, ${sounds} sounds, ${keys.size} upstream presets accounted`)
      return 0
    }
  }
  for (const failure of failures) console.error(failure)
  return 1
}
process.exitCode = await main()
