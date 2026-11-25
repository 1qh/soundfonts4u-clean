/* eslint-disable no-await-in-loop */
import { file, spawn, write } from 'bun'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { renderToWav, segmentSeconds } from './render.js'
interface ManifestFont {
  bank: number
  file: string
  presets: ManifestPreset[]
}
interface ManifestPreset {
  name: string
  program: number
  source: string
}
const REVIEW_RATE = 44_100
const ENCODE_TIMEOUT_MS = 600_000
const isManifest = (value: unknown): value is { fonts: ManifestFont[] } =>
  typeof value === 'object' && value !== null && 'fonts' in value && Array.isArray(value.fonts)
const clock = (seconds: number): string =>
  `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`
const nameTable = (font: ManifestFont): string => {
  const step = segmentSeconds()
  const rows = font.presets.map(p => `| ${clock(p.program * step)} | ${p.name} | ${p.source.split('|')[0] ?? ''} |`)
  return [
    `## ${font.file.replace('.sf2', '')} (${font.presets.length} sounds)`,
    '',
    '| At | Name | From |',
    '|---|---|---|',
    ...rows,
    ''
  ].join('\n')
}
const encode = async ({ m4a, wav }: { m4a: string; wav: string }) => {
  const proc = spawn({
    cmd: ['afconvert', '-f', 'm4af', '-d', 'aac', '-b', '160000', wav, m4a],
    stderr: 'pipe',
    stdout: 'ignore',
    timeout: ENCODE_TIMEOUT_MS
  })
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
  if (code !== 0) throw new Error(`afconvert exited ${code} on ${wav}: ${stderr.trim()}`)
  await file(wav).delete()
}
const renderSample = async ({ font, fontsDir, outDir }: { font: ManifestFont; fontsDir: string; outDir: string }) => {
  const base = font.file.replace('.sf2', '')
  const wav = join(outDir, `${base}.wav`)
  const slots = font.presets.map(p => ({ bank: font.bank, isDrum: base === 'Drums', program: p.program }))
  await renderToWav({
    fontPath: join(fontsDir, font.file),
    sampleRate: REVIEW_RATE,
    slots,
    wavPath: wav,
    workDir: join(outDir, 'work')
  })
  await encode({ m4a: join(outDir, `${base}.m4a`), wav })
}
const main = async () => {
  const [fontsDir, outDir] = [process.argv[2], process.argv[3]]
  if (fontsDir === undefined || outDir === undefined) throw new Error('usage: review.ts <fonts dir> <review dir>')
  const manifest: unknown = await file(join(fontsDir, 'manifest.json')).json()
  if (!isManifest(manifest)) throw new TypeError('malformed manifest.json')
  await mkdir(outDir, { recursive: true })
  const header = `# Review\n\nEvery output sound by font, in picker order. Each sound plays for ${segmentSeconds()} seconds in that font's sample, starting at the time shown.\n\n`
  await write(join(outDir, 'names.md'), header + manifest.fonts.map(nameTable).join('\n'))
  // biome-ignore lint/performance/noAwaitInLoops: Render and encode one font at a time to bound resource use.
  for (const font of manifest.fonts) await renderSample({ font, fontsDir, outDir })
  process.stdout.write('ok\n')
}
await main()
