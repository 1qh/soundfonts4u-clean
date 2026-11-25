import {
  AutoProcessor,
  AutoTokenizer,
  ClapAudioModelWithProjection,
  ClapTextModelWithProjection
} from '@huggingface/transformers'
const CLAP_MODEL = 'Xenova/larger_clap_general'
const CLAP_SAMPLE_RATE = 48_000
interface Embedder {
  embed: (mono: Float32Array) => Promise<number[]>
}
const normalize = (v: number[]): number[] => {
  const norm = Math.hypot(...v)
  if (Number.isNaN(norm) || norm <= 0) throw new Error('CLAP returned a zero embedding')
  return v.map(x => x / norm)
}
const embedsOf = (output: unknown): Float32Array | Float64Array | undefined => {
  if (typeof output !== 'object' || output === null || !('audio_embeds' in output)) return undefined
  const { audio_embeds: embeds } = output
  if (typeof embeds !== 'object' || embeds === null || !('data' in embeds)) return undefined
  const { data } = embeds
  if (data === undefined) return undefined
  if (data instanceof Float32Array || data instanceof Float64Array) return data
  throw new TypeError(`${CLAP_MODEL} returned audio_embeds whose data is not a float array`)
}
const createEmbedder = async (): Promise<Embedder> => {
  const processor = await AutoProcessor.from_pretrained(CLAP_MODEL)
  const model = await ClapAudioModelWithProjection.from_pretrained(CLAP_MODEL, { dtype: 'fp32' })
  return {
    embed: async mono => {
      const inputs: unknown = await processor(mono)
      const output: unknown = await model(inputs)
      const embeds = embedsOf(output)
      if (embeds === undefined) throw new Error(`${CLAP_MODEL} returned no audio_embeds`)
      return normalize([...embeds])
    }
  }
}
const textEmbedsOf = (output: unknown): Float32Array | Float64Array => {
  if (typeof output !== 'object' || output === null || !('text_embeds' in output))
    throw new TypeError(`${CLAP_MODEL} returned no text_embeds`)
  const { text_embeds: embeds } = output
  if (typeof embeds !== 'object' || embeds === null || !('data' in embeds))
    throw new TypeError(`${CLAP_MODEL} text_embeds has no data`)
  const { data } = embeds
  if (data instanceof Float32Array || data instanceof Float64Array) return data
  throw new TypeError(`${CLAP_MODEL} returned text_embeds whose data is not a float array`)
}
const embedTexts = async (texts: string[]): Promise<number[][]> => {
  const tokenizer = await AutoTokenizer.from_pretrained(CLAP_MODEL)
  const model = await ClapTextModelWithProjection.from_pretrained(CLAP_MODEL, { dtype: 'fp32' })
  const inputs: unknown = tokenizer(texts, { padding: true, truncation: true })
  const data = textEmbedsOf(await model(inputs))
  const width = data.length / texts.length
  if (!Number.isInteger(width))
    throw new TypeError(`${CLAP_MODEL} text_embeds size ${data.length} does not split into ${texts.length}`)
  return texts.map((_, i) => normalize([...data.subarray(i * width, (i + 1) * width)]))
}
const toMono = (channels: Float32Array[]): Float32Array => {
  const [first] = channels
  if (first === undefined) throw new Error('segment has no channels')
  const mono = new Float32Array(first.length)
  for (const channel of channels) for (const [i, x] of channel.entries()) mono[i] = (mono[i] ?? 0) + x / channels.length
  return mono
}
const cosineDistance = (a: number[], b: number[]): number => {
  let dot = 0
  for (const [i, x] of a.entries()) dot += x * (b[i] ?? 0)
  return 1 - dot
}
export type { Embedder }
export { CLAP_SAMPLE_RATE, cosineDistance, createEmbedder, embedTexts, toMono }
