import { file, write } from 'bun'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { UPSTREAM } from './upstream.js'
interface ManifestFont {
  bank: number
  file: string
  presets: { name: string; program: number; source: string }[]
}
interface Manifest {
  dropped: { reason: string; source: string }[]
  fonts: ManifestFont[]
  merges: unknown[]
}
const CODE_REPO = 'https://github.com/1qh/soundfonts4u-clean'
const isManifest = (value: unknown): value is Manifest =>
  typeof value === 'object' &&
  value !== null &&
  Array.isArray((value as { fonts?: unknown }).fonts) &&
  Array.isArray((value as { merges?: unknown }).merges) &&
  Array.isArray((value as { dropped?: unknown }).dropped)
const megabytes = (bytes: number): string => `${Math.round(bytes / 1e6).toLocaleString('en-US')} MB`
const fontRows = async ({ dir, fonts }: { dir: string; fonts: ManifestFont[] }): Promise<string[]> => {
  const rows: string[] = []
  for (const f of fonts.toSorted((a, b) => a.bank - b.bank)) {
    const { size } = await stat(join(dir, f.file))
    rows.push(`| ${f.file} | ${f.presets.length} | ${megabytes(size)} | ${f.presets.slice(0, 3).map(p => p.name).join(', ')} |`)
  }
  return rows
}
const readme = async (dir: string): Promise<string> => {
  const manifest: unknown = await file(join(dir, 'manifest.json')).json()
  if (!isManifest(manifest)) throw new TypeError('malformed manifest.json')
  const sounds = manifest.fonts.reduce((n, f) => n + f.presets.length, 0)
  const rows = await fontRows({ dir, fonts: manifest.fonts })
  return `---
license: cc-by-nc-sa-4.0
tags:
- soundfont
- sf2
- musescore
- music
pretty_name: SoundFonts4U Clean
---

# SoundFonts4U Clean

The [${UPSTREAM.dataset}](https://huggingface.co/datasets/${UPSTREAM.dataset}) mirror of the Soundfonts 4U collection, rebuilt into ${manifest.fonts.length} flat SoundFont 2 files, 1 per sound family, for picking sounds by name in MuseScore. It is for musicians who want every distinct sound of the collection without nested banks, duplicates or older versions.

## What changed from the upstream collection

| Change | Result |
|---|---|
| Duplicates merged | ${manifest.merges.length.toLocaleString('en-US')} presets that render identically to another (null test at -60 dB or deeper) are merged into 1 |
| Older versions dropped | A preset an older version of the same font family ships is dropped where the newest version ships the same name |
| Families | Every sound sits in exactly 1 family font, 1 bank, at most 128 presets |
| Order | Inside a font, sounds that sound alike sit next to each other, ordered by CLAP audio similarity |
| Names | Every preset name is unique across all fonts: CamelCase letters, at most 20 characters, describing the sound and never the source, maker or brand |
| Audio | Lossless: every output preset renders bit-identical to its source preset in FluidSynth |

## Fonts

${sounds.toLocaleString('en-US')} sounds in ${manifest.fonts.length} fonts.

| File | Sounds | Size | First sounds |
|---|---|---|---|
${rows.join('\n')}

## What is left out

- \`${UPSTREAM.excluded.join('`, `')}\`: its samples are lossy, 12 of them reference a hardware ROM no software ships, and FluidSynth refuses its file type.
${manifest.dropped.map(d => `- \`${d.source}\`: ${d.reason}.`).join('\n')}

## Provenance

\`manifest.json\` maps every output preset to its source file, bank and program, and every merged preset to the preset that replaced it with the measured null.

Built from upstream commit \`${UPSTREAM.commit}\` by the deterministic build at ${CODE_REPO}; running it again on the same commit reproduces these files byte for byte.

## License and credit

The sounds come from the Soundfonts 4U site (https://sites.google.com/site/soundfonts4u/, now offline) as mirrored in [${UPSTREAM.dataset}](https://huggingface.co/datasets/${UPSTREAM.dataset}), and keep that dataset's license, [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/): credit the source, no commercial use, share alike.
`
}
const main = async () => {
  const dir = process.argv[2]
  if (dir === undefined) throw new Error('usage: readme.ts <fonts dir>')
  await write(join(dir, 'README.md'), await readme(dir))
  console.log('ok')
}
await main()
