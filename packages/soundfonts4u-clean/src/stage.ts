import type { BasicPreset, BasicSoundBank } from 'spessasynth_core'
import { SoundBankCloner } from 'spessasynth_core'
import type { UpstreamFile } from './upstream.js'
interface Wanted {
  fileName: string
  key: string
}
const stagedNames = (wanted: Map<string, Wanted[]>): Map<string, string> =>
  new Map([...wanted.values()].flatMap(needs => needs.map((n, i) => [n.key, `s${i}`] as const)))
const cloneNeeds = ({
  byKey,
  names,
  needs,
  stage,
  u
}: {
  byKey: Map<string, BasicPreset>
  names: Map<string, string>
  needs: Wanted[]
  stage: BasicSoundBank
  u: UpstreamFile
}) => {
  const cloner = new SoundBankCloner(stage, { addToBank: true, reuseByName: false, reuseChildren: 'identity' })
  for (const n of needs) {
    const source = byKey.get(n.key)
    if (source === undefined) throw new Error(`staging: ${n.key} vanished from ${u.path}`)
    const copy = cloner.clonePreset(source)
    const name = names.get(n.key)
    if (name === undefined) throw new Error(`staging: no staged name for ${n.key}`)
    copy.name = name
  }
}
export type { Wanted }
export { cloneNeeds, stagedNames }
