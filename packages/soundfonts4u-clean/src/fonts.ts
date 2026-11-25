import type { BasicPreset, BasicSample } from 'spessasynth_core'
import { CryptoHasher, file } from 'bun'
import { BasicSoundBank, SoundBankLoader } from 'spessasynth_core'
import type { PresetSlot } from './render.js'
interface SourcePreset {
  key: string
  name: string
  recordings: string[]
  slot: PresetSlot
  sourceFile: string
}
const SF2_DRUM_BANK = 128
const byCodeUnit = (a: string, b: string): number => Number(a > b) - Number(a < b)
const loadFont = async (path: string): Promise<BasicSoundBank> => {
  await BasicSoundBank.ready
  const bytes = await file(path).arrayBuffer()
  return SoundBankLoader.fromArrayBuffer(bytes)
}
const slotOf = (preset: BasicPreset): PresetSlot => ({
  bank: preset.isGMGSDrum ? SF2_DRUM_BANK : preset.bankMSB,
  isDrum: preset.isGMGSDrum,
  program: preset.program
})
const presetKey = ({ slot, sourceFile }: { slot: PresetSlot; sourceFile: string }): string =>
  `${sourceFile}|${slot.bank}|${slot.program}`
const digestOf = ({
  hashes,
  recordingBytes,
  sample
}: {
  hashes: Map<object, string>
  recordingBytes: Map<string, number>
  sample: BasicSample
}): string => {
  const known = hashes.get(sample)
  if (known !== undefined) return known
  const raw = sample.getRawData(false)
  const digest = new CryptoHasher('sha1').update(raw).digest('hex')
  hashes.set(sample, digest)
  recordingBytes.set(digest, raw.byteLength)
  return digest
}
const recordingsOf = ({
  hashes,
  preset,
  recordingBytes
}: {
  hashes: Map<object, string>
  preset: BasicPreset
  recordingBytes: Map<string, number>
}): string[] => {
  const found = new Set<string>()
  for (const zone of preset.zones)
    for (const { sample } of zone.instrument.zones) found.add(digestOf({ hashes, recordingBytes, sample }))
  return [...found].toSorted(byCodeUnit)
}
const listPresets = ({
  bank,
  recordingBytes,
  sourceFile
}: {
  bank: BasicSoundBank
  recordingBytes: Map<string, number>
  sourceFile: string
}): SourcePreset[] => {
  const hashes = new Map<object, string>()
  return bank.presets.map(preset => {
    const slot = slotOf(preset)
    return {
      key: presetKey({ slot, sourceFile }),
      name: preset.name.trim(),
      recordings: recordingsOf({ hashes, preset, recordingBytes }),
      slot,
      sourceFile
    }
  })
}
export type { SourcePreset }
export { byCodeUnit, listPresets, loadFont, presetKey, slotOf }
