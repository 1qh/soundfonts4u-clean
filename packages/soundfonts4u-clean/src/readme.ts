/* eslint-disable no-await-in-loop */
import { file, write } from 'bun'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { UPSTREAM } from './upstream.js'
interface Manifest {
  dropped: {
    reason: string
    source: string
  }[]
  fonts: ManifestFont[]
  merges: unknown[]
}
interface ManifestFont {
  bank: number
  file: string
  presets: {
    name: string
    program: number
    source: string
  }[]
}
const CODE_REPO = 'https://github.com/1qh/soundfonts4u-clean'
const isManifest = (value: unknown): value is Manifest =>
  typeof value === 'object' &&
  value !== null &&
  'fonts' in value &&
  Array.isArray(value.fonts) &&
  'merges' in value &&
  Array.isArray(value.merges) &&
  'dropped' in value &&
  Array.isArray(value.dropped)
const megabytes = (bytes: number): string => `${Math.round(bytes / 1e6).toLocaleString('en-US')} MB`
const fontRows = async (dir: string, fonts: ManifestFont[]): Promise<string[]> => {
  const rows: string[] = []
  const sortedFonts = fonts.toSorted((a, b) => a.bank - b.bank)
  for (const f of sortedFonts) {
    // biome-ignore lint/performance/noAwaitInLoops: Check fonts in bank order and stop at the first failure.
    const { size } = await stat(join(dir, f.file))
    rows.push(
      `| ${f.file} | ${f.presets.length} | ${megabytes(size)} | ${f.presets
        .slice(0, 3)
        .map(p => p.name)
        .join(', ')} |`
    )
  }
  return rows
}
const readme = async (dir: string): Promise<string> => {
  const manifest: unknown = await file(join(dir, 'manifest.json')).json()
  if (!isManifest(manifest)) throw new TypeError('malformed manifest.json')
  let sounds = 0
  for (const font of manifest.fonts) sounds += font.presets.length
  const rows = await fontRows(dir, manifest.fonts)
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
  process.stdout.write('ok\n')
}
await main()
