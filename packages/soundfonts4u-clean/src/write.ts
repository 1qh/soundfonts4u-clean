import type { BasicPreset, BasicSample, BasicZone } from 'spessasynth_core'
import { CryptoHasher, write } from 'bun'
import { BasicSoundBank, SoundBankCloner } from 'spessasynth_core'
import { writtenGenerators } from './fonts.js'
interface FamilyFont {
  bank: number
  fileName: string
  members: FamilyMember[]
}
interface FamilyMember {
  name: string
  source: BasicPreset
}
const contentKey = (sample: BasicSample, digests: Map<BasicSample, string>): string => {
  let digest = digests.get(sample)
  if (digest === undefined) {
    digest = new CryptoHasher('sha1').update(sample.getRawData(false)).digest('hex')
    digests.set(sample, digest)
  }
  return [
    digest,
    sample.sampleRate,
    sample.originalKey,
    sample.pitchCorrection,
    sample.loopStart,
    sample.loopEnd,
    sample.sampleType
  ].join(':')
}
const fullKey = (sample: BasicSample, digests: Map<BasicSample, string>): string => {
  const partner = sample.linkedSample
  return `${contentKey(sample, digests)}|${partner === undefined ? '' : contentKey(partner, digests)}`
}
const shareIdenticalSamples = (bank: BasicSoundBank): number => {
  const digests = new Map<BasicSample, string>()
  const canonical = new Map<string, BasicSample>()
  let repointed = 0
  for (const instrument of bank.instruments)
    for (const zone of instrument.zones) {
      const key = fullKey(zone.sample, digests)
      const keep = canonical.get(key)
      if (keep === undefined) canonical.set(key, zone.sample)
      else if (keep !== zone.sample) {
        zone.sample = keep
        repointed += 1
      }
    }
  return repointed
}
const addMembers = ({ bank, font }: { bank: BasicSoundBank; font: FamilyFont }) => {
  const cloner = new SoundBankCloner(bank, { addToBank: true, reuseByName: false, reuseChildren: 'identity' })
  for (const [program, member] of font.members.entries()) {
    const copy = cloner.clonePreset(member.source)
    copy.name = member.name
    copy.bankMSB = font.bank
    copy.bankLSB = 0
    copy.isGMGSDrum = false
    copy.program = program
  }
}
const assertLossless = ({ bank, fileName }: { bank: BasicSoundBank; fileName: string }) => {
  const losses = bank.getSF2Losses()
  const lost = Object.entries(losses).filter(([, n]) => n !== 0)
  if (lost.length > 0) throw new Error(`${fileName}: plain SF2 would lose ${JSON.stringify(Object.fromEntries(lost))}`)
}
const countZones = (owners: readonly { globalZone: BasicZone; zones: readonly BasicZone[] }[]) => {
  const counts = { generators: 0, modulators: 0, zones: 0 }
  for (const owner of owners) {
    const zones = [owner.globalZone, ...owner.zones]
    for (const [index, zone] of zones.entries()) {
      counts.zones += 1
      counts.generators += writtenGenerators({ isLinked: index > 0, zone })
      counts.modulators += zone.modulators.length
    }
  }
  return counts
}
const assertWithinLimits = ({ bank, fileName }: { bank: BasicSoundBank; fileName: string }) => {
  const samples = bank.samples.length
  const instruments = countZones(bank.instruments)
  const presets = countZones(bank.presets)
  const counts = {
    igen: instruments.generators,
    imod: instruments.modulators,
    izone: instruments.zones,
    pgen: presets.generators,
    pmod: presets.modulators,
    pzone: presets.zones,
    samples
  }
  const limit = 65_535
  if (Object.values(counts).some(n => n > limit))
    throw new Error(
      `${fileName}: ${JSON.stringify(counts)} across ${bank.instruments.length} instruments, SF2 holds ${limit} of each`
    )
}
const buildFamilyFont = ({ creationDate, font }: { creationDate: Date; font: FamilyFont }): ArrayBuffer => {
  const bank = new BasicSoundBank('sf2', false)
  bank.soundBankInfo.name = font.fileName
  bank.soundBankInfo.creationDate = creationDate
  addMembers({ bank, font })
  shareIdenticalSamples(bank)
  bank.removeUnusedElements()
  bank.flush(false)
  assertLossless({ bank, fileName: font.fileName })
  assertWithinLimits({ bank, fileName: font.fileName })
  return bank.writeSF2({ writeDefaultModulators: false, writeExtendedLimits: false })
}
const writeFamilyFont = async ({ creationDate, font, path }: { creationDate: Date; font: FamilyFont; path: string }) => {
  await write(path, buildFamilyFont({ creationDate, font }))
}
export type { FamilyFont, FamilyMember }
export { buildFamilyFont, shareIdenticalSamples, writeFamilyFont }
