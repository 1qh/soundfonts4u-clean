import type { AsyncZippable, Unzipped } from 'fflate'
import decode from 'audio-decode'
import { file, spawn, write } from 'bun'
import { strFromU8, strToU8, unzip, zip } from 'fflate'
import { mkdir, realpath } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { nullDb } from './dedupe.js'
import { segmentOf } from './render.js'
interface ProofFont {
  bank: number
  file: string
  presets: ProofPreset[]
}
interface ProofPreset {
  name: string
  program: number
}
const MSCORE = '/Applications/MuseScore 4.app/Contents/MacOS/mscore'
const CONVERT_TIMEOUT_MS = 1_200_000
const EXPORT_TIMEOUT_MS = 3_600_000
const FALLBACK_FONT = 'NoSuchFont'
const SECONDS_PER_SOUND = 2
const PCM_SCALE = 32_768
const SILENT_RMS = 20
const FALLBACK_DB = -20
const PART = /<Part id="(?<partId>\d+)">(?<body>.*?)<\/Part>/gsv
const INSTRUMENT = /<Instrument id="(?<instrumentId>[^"]+)">/v
const ATTRIBUTES =
  '<attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>'
const TEMPO =
  '<direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>120</per-minute></metronome></direction-type><sound tempo="120"/></direction>'
const REST = '<note><rest/><duration>4</duration><type>whole</type></note>'
const PITCHES = [
  ['C', 4],
  ['E', 4],
  ['G', 4],
  ['C', 5]
] as const
const NOTES = PITCHES.map(
  ([step, octave]) =>
    `<note><pitch><step>${step}</step><octave>${octave}</octave></pitch><duration>1</duration><type>quarter</type></note>`
).join('')
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const isPreset = (value: unknown): value is ProofPreset =>
  isRecord(value) && typeof value.name === 'string' && typeof value.program === 'number' && Number.isInteger(value.program)
const isFont = (value: unknown): value is ProofFont =>
  isRecord(value) &&
  typeof value.bank === 'number' &&
  Number.isInteger(value.bank) &&
  typeof value.file === 'string' &&
  value.file === basename(value.file) &&
  value.file.endsWith('.sf2') &&
  value.file.length > 4 &&
  Array.isArray(value.presets) &&
  value.presets.length > 0 &&
  value.presets.every(isPreset)
const isManifest = (value: unknown): value is { fonts: ProofFont[] } =>
  isRecord(value) && Array.isArray(value.fonts) && value.fonts.length > 0 && value.fonts.every(isFont)
const fontName = (font: ProofFont): string => basename(font.file, '.sf2')
const partMeasures = (part: number, count: number): string => {
  const measures: string[] = []
  for (let measure = 1; measure <= count; measure += 1) {
    const attributes = measure === 1 ? ATTRIBUTES : ''
    const tempo = measure === 1 && part === 1 ? TEMPO : ''
    const notes = measure === part ? NOTES : REST
    measures.push(`<measure number="${measure}">${attributes}${tempo}${notes}</measure>`)
  }
  return measures.join('')
}
const musicXml = (count: number): string => {
  const partList: string[] = []
  const parts: string[] = []
  for (let part = 1; part <= count; part += 1) {
    partList.push(`<score-part id="P${part}"><part-name>S${part}</part-name></score-part>`)
    parts.push(`<part id="P${part}">${partMeasures(part, count)}</part>`)
  }
  return `<?xml version="1.0" encoding="UTF-8"?><score-partwise version="4.0"><part-list>${partList.join('')}</part-list>${parts.join('')}</score-partwise>`
}
const runMuseScore = async (input: string, output: string, timeout: number) => {
  const proc = spawn({ cmd: [MSCORE, '-o', output, input], stderr: 'pipe', stdin: 'ignore', stdout: 'ignore', timeout })
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
  if (proc.signalCode !== null)
    throw new Error(`MuseScore killed (${proc.signalCode}) exporting ${output}: ${stderr.trim()}`)
  if (code !== 0) throw new Error(`MuseScore exited ${code} exporting ${output}: ${stderr.trim()}`)
}
const scoreParts = (xml: string) =>
  Array.from(xml.matchAll(PART), m => {
    const partId = m.groups?.partId
    const instrumentId = m.groups?.body?.match(INSTRUMENT)?.groups?.instrumentId
    if (partId === undefined || instrumentId === undefined) throw new Error(`missing instrument ID for part ${partId}`)
    return { instrumentId, partId }
  })
const resourceMeta = (soundFontName: string, bank: number, preset: ProofPreset) => ({
  attributes: {
    playbackSetupData: 'last.last.last',
    presetBank: String(bank),
    presetName: preset.name,
    presetProgram: String(preset.program),
    soundFontName
  },
  hasNativeEditorSupport: false,
  id: `${soundFontName}\\${bank}\\${preset.program}`,
  type: 'fluid_soundfont',
  vendor: 'Fluid'
})
const unpackScore = async (data: Uint8Array): Promise<Unzipped> => {
  const names = new Set<string>()
  const entries = await new Promise<Unzipped>((resolve, reject) => {
    unzip(
      data,
      {
        filter: entry => {
          names.add(entry.name)
          return true
        }
      },
      (error, unzipped) => {
        if (error === null) resolve(unzipped)
        else reject(error)
      }
    )
  })
  const ordered: Unzipped = {}
  for (const name of names) {
    const entry = entries[name]
    if (entry !== undefined && Object.hasOwn(entries, name)) ordered[name] = entry
  }
  return ordered
}
const packScore = async (entries: AsyncZippable): Promise<Uint8Array<ArrayBuffer>> => {
  const packed = await new Promise<Uint8Array<ArrayBuffer>>((resolve, reject) => {
    zip(entries, (error, archive) => {
      if (error === null) resolve(archive)
      else reject(error)
    })
  })
  return packed
}
const scoreContents = (entries: Unzipped) => {
  const scoreEntry = Object.keys(entries).find(e => e.endsWith('.mscx'))
  const score = scoreEntry === undefined ? undefined : entries[scoreEntry]
  const settingsEntry = entries['audiosettings.json']
  if (score === undefined || settingsEntry === undefined) throw new Error('MSCZ needs a .mscx and audiosettings.json')
  return { score, settingsEntry }
}
const readScore = async (scorePath: string, count: number) => {
  const data = new Uint8Array(await file(scorePath).arrayBuffer())
  const entries = await unpackScore(data)
  const { score, settingsEntry } = scoreContents(entries)
  const parts = scoreParts(strFromU8(score))
  if (parts.length !== count) throw new Error(`${parts.length} parts for ${count} sounds`)
  const settings: unknown = JSON.parse(strFromU8(settingsEntry))
  if (!isRecord(settings)) throw new Error('invalid audiosettings.json')
  return { entries, parts, settings }
}
const audioTracks = (parts: ReturnType<typeof scoreParts>, font: ProofFont, soundFontName: string) =>
  parts.map((p, i) => {
    const preset = font.presets[i]
    if (preset === undefined) throw new Error(`missing preset for part ${p.partId}`)
    return {
      in: { resourceMeta: resourceMeta(soundFontName, font.bank, preset), unitConfiguration: {} },
      instrumentId: p.instrumentId,
      out: { balance: 0, fxChain: {}, volumeDb: 0 },
      partId: p.partId
    }
  })
const renderVariant = async ({
  base,
  font,
  score,
  soundFontName
}: {
  base: string
  font: ProofFont
  score: Awaited<ReturnType<typeof readScore>>
  soundFontName: string
}) => {
  const entries = {
    ...score.entries,
    'audiosettings.json': strToU8(
      JSON.stringify({ ...score.settings, tracks: audioTracks(score.parts, font, soundFontName) }, undefined, 4)
    )
  }
  const variant = `${base}-${soundFontName}`
  const scorePath = `${variant}.set.mscz`
  const wavPath = `${variant}.wav`
  const archive = await packScore(entries)
  await write(scorePath, archive)
  await runMuseScore(scorePath, wavPath, EXPORT_TIMEOUT_MS)
  const decoded = await decode(new Uint8Array(await file(wavPath).arrayBuffer()))
  return { channels: decoded.channelData, segmentFrames: decoded.sampleRate * SECONDS_PER_SOUND }
}
const rms16 = (channels: Float32Array[]): number => {
  let energy = 0
  let samples = 0
  for (const channel of channels) {
    for (const sample of channel) energy += sample * sample
    samples += channel.length
  }
  return PCM_SCALE * Math.sqrt(energy / Math.max(samples, 1))
}
const convertScore = async (base: string, count: number) => {
  const xml = `${base}.musicxml`
  const scorePath = `${base}.mscz`
  await write(xml, musicXml(count))
  await runMuseScore(xml, scorePath, CONVERT_TIMEOUT_MS)
  const score = await readScore(scorePath, count)
  return score
}
type RenderedVariant = Awaited<ReturnType<typeof renderVariant>>
const checkRenderLengths = (real: RenderedVariant, fallback: RenderedVariant, count: number) => {
  if (real.segmentFrames !== fallback.segmentFrames || real.channels.length !== fallback.channels.length)
    throw new Error('MuseScore renders have different sample rates or channel counts')
  const requiredFrames = real.segmentFrames * count
  const channels = [...real.channels, ...fallback.channels]
  if (channels.length === 0 || channels.some(c => c.length < requiredFrames))
    throw new Error(`MuseScore renders need at least ${requiredFrames} frames per channel`)
}
const compareRenders = (font: ProofFont, real: RenderedVariant, fallback: RenderedVariant) => {
  checkRenderLengths(real, fallback, font.presets.length)
  const same: string[] = []
  const silent: string[] = []
  for (const [index, preset] of font.presets.entries()) {
    const actual = segmentOf({ index, rendered: real })
    if (rms16(actual) < SILENT_RMS) silent.push(preset.name)
    const db = nullDb(actual, segmentOf({ index, rendered: fallback }))
    if (db < FALLBACK_DB) same.push(`${preset.name} (${db.toFixed(1)} dB)`)
  }
  return { same, silent }
}
const scoreFont = async (font: ProofFont, workDir: string) => {
  const name = fontName(font)
  const base = join(workDir, `proof-${name}`)
  const score = await convertScore(base, font.presets.length)
  const real = await renderVariant({ base, font, score, soundFontName: name })
  const fallback = await renderVariant({ base, font, score, soundFontName: FALLBACK_FONT })
  return compareRenders(font, real, fallback)
}
const describeError = (error: unknown): string => (error instanceof Error ? error.message : String(error))
const proveFont = async (font: ProofFont, workDir: string, failures: string[]) => {
  const name = fontName(font)
  const sounds = `${name}: ${font.presets.length} sounds`
  try {
    const { same, silent } = await scoreFont(font, workDir)
    process.stdout.write(`${sounds}, silent ${silent.length}, same-as-fallback ${same.length}\n`)
    if (silent.length > 0 || same.length > 0)
      failures.push(`${name}: silent [${silent.join(', ')}] same-as-fallback [${same.join(', ')}]`)
  } catch (proofError) {
    process.stdout.write(`${sounds}, silent unknown, same-as-fallback unknown\n`)
    failures.push(`${name}: ${describeError(proofError)}`)
  }
}
const proveInTurn = async (fonts: ProofFont[], workDir: string, failures: string[]): Promise<void> => {
  const [first, ...rest] = fonts
  if (first === undefined) return
  await proveFont(first, workDir, failures)
  await proveInTurn(rest, workDir, failures)
}
const readManifest = async (fontsDir: string) => {
  const manifest: unknown = await file(join(fontsDir, 'manifest.json')).json()
  if (!isManifest(manifest)) throw new TypeError('malformed manifest.json')
  return manifest
}
const proveFonts = async (fonts: ProofFont[], workDir: string, targets: string[]) => {
  await mkdir(workDir, { recursive: true })
  const outDir = await realpath(workDir)
  const failures = targets.filter(t => fonts.every(f => fontName(f) !== t)).map(t => `${t}: unknown font`)
  const selected = fonts.filter(f => targets.length === 0 || targets.includes(fontName(f)))
  await proveInTurn(selected, outDir, failures)
  if (failures.length > 0) throw new Error(`FAILURES\n${failures.join('\n')}`)
}
const main = async () => {
  const [fontsDir, workDir, ...targets] = process.argv.slice(2)
  if (fontsDir === undefined || workDir === undefined || fontsDir.length === 0 || workDir.length === 0)
    throw new Error('usage: musescore-proof.ts <fonts dir> <work dir> [font names...]')
  const manifest = await readManifest(fontsDir)
  await proveFonts(manifest.fonts, workDir, targets)
  process.stdout.write('ok: every sound plays from its own font in MuseScore\n')
}
try {
  await main()
} catch (mainError) {
  process.stderr.write(`${describeError(mainError)}\n`)
  process.exitCode = 1
}
