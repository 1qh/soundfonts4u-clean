import decode from 'audio-decode'
import { describe, expect, test } from 'bun:test'
import { fromInt16, toInt16 } from './store.js'
const CODES = 65_536
const HEADER_BYTES = 44
const wavOfEveryCode = (): Uint8Array => {
  const buf = new ArrayBuffer(HEADER_BYTES + CODES * 2)
  const view = new DataView(buf)
  const ascii = (offset: number, text: string) => {
    for (const [i, ch] of [...text].entries()) view.setUint8(offset + i, ch.codePointAt(0) ?? 0)
  }
  ascii(0, 'RIFF')
  view.setUint32(4, 36 + CODES * 2, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, 48_000, true)
  view.setUint32(28, 96_000, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  ascii(36, 'data')
  view.setUint32(40, CODES * 2, true)
  for (let i = 0; i < CODES; i += 1) view.setInt16(HEADER_BYTES + i * 2, i - 32_768, true)
  return new Uint8Array(buf)
}
describe('16-bit sample store', () => {
  test('round-trips every 16-bit code through the real WAV decoder', async () => {
    const decoded = await decode(wavOfEveryCode())
    const [channel] = decoded.channelData
    expect(channel?.length).toBe(CODES)
    let mismatches = 0
    for (const [i, x] of (channel ?? new Float32Array()).entries()) if (toInt16(x) !== i - 32_768) mismatches += 1
    expect(mismatches).toBe(0)
  })
  test('reads back exactly what it stores', () => {
    for (const code of [-32_768, -1, 0, 1, 32_767]) expect(toInt16(fromInt16(code))).toBe(code)
  })
})
