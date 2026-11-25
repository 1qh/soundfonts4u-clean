import { file, write } from 'bun'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { RenderedFont } from './render.js'
interface SegmentIndex {
  channels: number
  keys: string[]
  segmentFrames: number
}
const NEGATIVE_SCALE = 32_768
const POSITIVE_SCALE = 32_767
const BYTES_PER_SAMPLE = 2
const fromInt16 = (v: number): number => v / (v < 0 ? NEGATIVE_SCALE : POSITIVE_SCALE)
const toInt16 = (x: number): number => {
  const v = Math.round(x * (x < 0 ? NEGATIVE_SCALE : POSITIVE_SCALE))
  if (v > POSITIVE_SCALE || v < -NEGATIVE_SCALE) throw new Error(`sample ${x} is outside the 16-bit range`)
  return v
}
const storeSegments = async ({
  dir,
  keys,
  rendered
}: {
  dir: string
  keys: string[]
  rendered: RenderedFont
}): Promise<void> => {
  await mkdir(dir, { recursive: true })
  const { channels, segmentFrames } = rendered
  const frames = segmentFrames * keys.length
  const pcm = new Int16Array(frames * channels.length)
  for (let f = 0; f < frames; f += 1)
    for (const [c, channel] of channels.entries()) pcm[f * channels.length + c] = toInt16(channel[f] ?? 0)
  await write(join(dir, 'segments.pcm'), pcm)
  const index: SegmentIndex = { channels: channels.length, keys, segmentFrames }
  await write(join(dir, 'index.json'), JSON.stringify(index))
}
const hasSegments = async (dir: string): Promise<boolean> =>
  (await file(join(dir, 'index.json')).exists()) && file(join(dir, 'segments.pcm')).exists()
const isSegmentIndex = (value: unknown): value is SegmentIndex =>
  typeof value === 'object' &&
  value !== null &&
  'channels' in value &&
  typeof value.channels === 'number' &&
  'segmentFrames' in value &&
  typeof value.segmentFrames === 'number' &&
  'keys' in value &&
  Array.isArray(value.keys) &&
  value.keys.every((k: unknown) => typeof k === 'string')
const openSegments = async (dir: string): Promise<(key: string) => Promise<Float32Array[]>> => {
  const index: unknown = await file(join(dir, 'index.json')).json()
  if (!isSegmentIndex(index)) throw new TypeError(`malformed segment index in ${dir}`)
  const { channels, keys, segmentFrames } = index
  const position = new Map(keys.map((k, i) => [k, i]))
  const pcm = file(join(dir, 'segments.pcm'))
  return async key => {
    const i = position.get(key)
    if (i === undefined) throw new Error(`no stored segment for ${key} in ${dir}`)
    const bytesPerSegment = segmentFrames * channels * BYTES_PER_SAMPLE
    const raw = new Int16Array(await pcm.slice(i * bytesPerSegment, (i + 1) * bytesPerSegment).arrayBuffer())
    if (raw.length !== segmentFrames * channels) throw new Error(`truncated segment for ${key} in ${dir}`)
    return Array.from({ length: channels }, (_, c) => {
      const out = new Float32Array(segmentFrames)
      for (let f = 0; f < segmentFrames; f += 1) out[f] = fromInt16(raw[f * channels + c] ?? 0)
      return out
    })
  }
}
export { fromInt16, hasSegments, openSegments, storeSegments, toInt16 }
