import decode from 'audio-decode'
import { file, spawn, write } from 'bun'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { MIDIBuilder, MIDIControllers } from 'spessasynth_core'
interface PresetSlot {
  bank: number
  isDrum: boolean
  program: number
}
interface RenderedFont {
  channels: Float32Array[]
  segmentFrames: number
}
const TICKS_PER_QUARTER = 480
const TEMPO_BPM = 120
const STEP_TICKS = 240
const CHORD_TICKS = 960
const TAIL_TICKS = 960
const PAD_TICKS = 240
const MELODIC_NOTES = [36, 48, 60, 72, 84] as const
const DRUM_NOTES = [36, 38, 42, 46, 49, 51] as const
const VELOCITIES = [30, 80, 127] as const
const MELODIC_CHORD = [60, 64, 67] as const
const DRUM_CHORD = [36, 38, 42] as const
const CHORD_VELOCITY = 90
const DRUM_CHANNEL = 9
const MELODIC_CHANNEL = 0
const MELODIC_STEPS = MELODIC_NOTES.length * VELOCITIES.length
const SEGMENT_TICKS = MELODIC_STEPS * STEP_TICKS + CHORD_TICKS + TAIL_TICKS + PAD_TICKS
const RENDER_TIMEOUT_MS = 1_800_000
const segmentSeconds = (): number => (SEGMENT_TICKS / TICKS_PER_QUARTER) * (60 / TEMPO_BPM)
interface Voice {
  channel: number
  midi: MIDIBuilder
  start: number
}
const resetChannel = ({ slot, voice }: { slot: PresetSlot; voice: Voice }) => {
  const { channel, midi, start } = voice
  midi.controllerChange(start, 0, channel, MIDIControllers.allSoundOff, 0)
  midi.controllerChange(start, 0, channel, MIDIControllers.resetAllControllers, 0)
  if (!slot.isDrum) midi.controllerChange(start, 0, channel, MIDIControllers.bankSelect, slot.bank % 128)
  midi.programChange(start, 0, channel, slot.program)
}
const playScale = ({ notes, voice }: { notes: readonly number[]; voice: Voice }) => {
  const { channel, midi, start } = voice
  let tick = start
  for (const note of notes)
    for (const velocity of VELOCITIES) {
      midi.noteOn(tick, 0, channel, note, velocity)
      midi.noteOff(tick + STEP_TICKS, 0, channel, note)
      tick += STEP_TICKS
    }
}
const playChord = ({ notes, voice }: { notes: readonly number[]; voice: Voice }) => {
  const { channel, midi, start } = voice
  for (const note of notes) {
    midi.noteOn(start, 0, channel, note, CHORD_VELOCITY)
    midi.noteOff(start + CHORD_TICKS, 0, channel, note)
  }
}
const addSegment = ({ midi, slot, start }: { midi: MIDIBuilder; slot: PresetSlot; start: number }) => {
  const channel = slot.isDrum ? DRUM_CHANNEL : MELODIC_CHANNEL
  resetChannel({ slot, voice: { channel, midi, start } })
  playScale({ notes: slot.isDrum ? DRUM_NOTES : MELODIC_NOTES, voice: { channel, midi, start } })
  const chord = slot.isDrum ? DRUM_CHORD : MELODIC_CHORD
  playChord({ notes: chord, voice: { channel, midi, start: start + MELODIC_STEPS * STEP_TICKS } })
}
const buildProbeMidi = (slots: PresetSlot[]): ArrayBuffer => {
  const midi = new MIDIBuilder({ initialTempo: TEMPO_BPM, timeDivision: TICKS_PER_QUARTER })
  for (const [index, slot] of slots.entries()) addSegment({ midi, slot, start: index * SEGMENT_TICKS })
  midi.controllerChange(slots.length * SEGMENT_TICKS, 0, MELODIC_CHANNEL, MIDIControllers.allSoundOff, 0)
  midi.flush()
  return midi.writeMIDI()
}
const runFluidSynth = async ({
  fontPath,
  midiPath,
  sampleRate,
  wavPath
}: {
  fontPath: string
  midiPath: string
  sampleRate: number
  wavPath: string
}): Promise<void> => {
  const proc = spawn({
    cmd: [
      'fluidsynth',
      '-ni',
      '-q',
      '-R',
      '0',
      '-C',
      '0',
      '-g',
      '0.5',
      '-r',
      String(sampleRate),
      '-o',
      'synth.polyphony=512',
      '-F',
      wavPath,
      fontPath,
      midiPath
    ],
    stderr: 'pipe',
    stdin: 'ignore',
    stdout: 'ignore',
    timeout: RENDER_TIMEOUT_MS
  })
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
  if (proc.signalCode !== null) throw new Error(`fluidsynth killed (${proc.signalCode}) rendering ${fontPath}`)
  if (code !== 0) throw new Error(`fluidsynth exited ${code} rendering ${fontPath}: ${stderr.trim()}`)
}
const readRender = async ({
  fontPath,
  sampleRate,
  slotCount,
  wavPath
}: {
  fontPath: string
  sampleRate: number
  slotCount: number
  wavPath: string
}): Promise<RenderedFont> => {
  const decoded = await decode(new Uint8Array(await file(wavPath).arrayBuffer()))
  if (decoded.sampleRate !== sampleRate)
    throw new Error(`render of ${fontPath} came back at ${decoded.sampleRate} Hz, expected ${sampleRate}`)
  const segmentFrames = Math.round(segmentSeconds() * sampleRate)
  const minFrames = segmentFrames * slotCount
  const frames = decoded.channelData[0]?.length ?? 0
  if (frames < minFrames) throw new Error(`render of ${fontPath} has ${frames} frames, needs ${minFrames}`)
  await file(wavPath).delete()
  return { channels: decoded.channelData, segmentFrames }
}
const renderFont = async ({
  fontPath,
  sampleRate,
  slots,
  workDir
}: {
  fontPath: string
  sampleRate: number
  slots: PresetSlot[]
  workDir: string
}): Promise<RenderedFont> => {
  await mkdir(workDir, { recursive: true })
  const midiPath = join(workDir, 'probe.mid')
  const wavPath = join(workDir, `render-${sampleRate}.wav`)
  await write(midiPath, buildProbeMidi(slots))
  await runFluidSynth({ fontPath, midiPath, sampleRate, wavPath })
  const rendered = await readRender({ fontPath, sampleRate, slotCount: slots.length, wavPath })
  return rendered
}
const segmentOf = ({ index, rendered }: { index: number; rendered: RenderedFont }): Float32Array[] =>
  rendered.channels.map(c => c.subarray(index * rendered.segmentFrames, (index + 1) * rendered.segmentFrames))
export type { PresetSlot, RenderedFont }
export { renderFont, segmentOf, segmentSeconds }
