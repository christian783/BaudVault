import { describe, expect, it } from 'vitest'
import { applyTapeChannel } from '../channel/virtual-tape'
import { modulate, SAMPLE_RATE } from '../modem/kcs-modulator'
import { decodeWav } from '../modem/wav'
import { frame } from '../tape/framer'
import { decodeImportedWav, exportTapeWav, playTape } from './playback'

/** The parts of an AudioBufferSourceNode that playTape uses. */
class FakeSource {
  buffer: { data: Float32Array } | null = null
  onended: (() => void) | null = null
  connected = 0
  disconnected = false
  startedAt: number | undefined
  stopped = false
  connect(): void {
    this.connected++
  }
  disconnect(): void {
    this.disconnected = true
  }
  start(when: number): void {
    this.startedAt = when
  }
  stop(): void {
    this.stopped = true
    this.onended?.()
  }
}

/** The parts of an AudioContext that playTape uses, with a settable clock. */
class FakeContext {
  currentTime = 1
  readonly destination = {}
  readonly sources: FakeSource[] = []
  createBuffer(_channels: number, length: number, sampleRate: number) {
    const data = new Float32Array(length)
    return { data, sampleRate, getChannelData: () => data }
  }
  createBufferSource(): FakeSource {
    const source = new FakeSource()
    this.sources.push(source)
    return source
  }
  asContext(): BaseAudioContext {
    return this as unknown as BaseAudioContext
  }
}

function tone(length: number): Float32Array<ArrayBuffer> {
  return Float32Array.from({ length }, (_, n) => 0.7 * Math.sin((2 * Math.PI * 2_400 * n) / SAMPLE_RATE))
}

function concat(chunks: Float32Array[]): Float32Array {
  const out = new Float32Array(chunks.reduce((sum, c) => sum + c.length, 0))
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.length
  }
  return out
}

describe('playTape', () => {
  it('plays and hands over the unprocessed samples when the channel is off', () => {
    const fake = new FakeContext()
    const samples = tone(44_100)
    const chunks: Float32Array[] = []
    let ended = 0
    const session = playTape({
      context: fake.asContext(),
      samples,
      channel: null,
      autoPump: false,
      onChunk: (chunk, rate) => {
        expect(rate).toBe(SAMPLE_RATE)
        chunks.push(chunk.slice())
      },
      onEnded: () => ended++,
    })
    const source = fake.sources[0]!
    expect(source.startedAt).toBe(1)
    expect(source.buffer!.data).toEqual(samples)

    // Half a second in, exactly the played half has been handed over.
    fake.currentTime = 1.5
    session.pump()
    expect(session.delivered).toBe(22_050)

    source.onended!()
    expect(ended).toBe(1)
    expect(source.disconnected).toBe(true)
    expect(concat(chunks)).toEqual(samples)
  })

  it('plays and hands over the Virtual_Tape_Channel output when the channel is on (6.2)', () => {
    const fake = new FakeContext()
    const samples = tone(44_100)
    const channel = { hiss: 0.3, wow: 0.02, seed: 1234 }
    const expected = applyTapeChannel(samples, SAMPLE_RATE, channel)
    const chunks: Float32Array[] = []
    const session = playTape({
      context: fake.asContext(),
      samples,
      channel,
      autoPump: false,
      onChunk: (chunk) => chunks.push(chunk.slice()),
    })
    expect(session.played).toEqual(expected)
    expect(fake.sources[0]!.buffer!.data).toEqual(expected)

    fake.currentTime = 1.25
    session.pump()
    fake.sources[0]!.onended!()
    expect(concat(chunks)).toEqual(expected)
  })

  it('stop silences the source and hands over nothing more', () => {
    const fake = new FakeContext()
    const chunks: Float32Array[] = []
    let ended = 0
    const session = playTape({
      context: fake.asContext(),
      samples: tone(44_100),
      channel: null,
      autoPump: false,
      onChunk: (chunk) => chunks.push(chunk),
      onEnded: () => ended++,
    })
    fake.currentTime = 1.1
    session.pump()
    const before = session.delivered
    session.stop()
    fake.currentTime = 3
    session.pump()

    const source = fake.sources[0]!
    expect(source.stopped).toBe(true)
    expect(source.disconnected).toBe(true)
    expect(session.delivered).toBe(before)
    expect(ended).toBe(0)
  })
})

describe('WAV export and import', () => {
  it('exports the unprocessed Modulator output and decodes an import without the channel (4.6, 6.6)', () => {
    const body = Uint8Array.from({ length: 20 }, (_, i) => (i * 37 + 11) & 0xff)
    const samples = modulate(frame(body, 'envelope', 2400), 2400)

    const wav = exportTapeWav(samples)
    const decoded = decodeWav(wav)
    expect(decoded.sampleRate).toBe(SAMPLE_RATE)
    expect(decoded.samples.length).toBe(samples.length)
    for (let n = 0; n < samples.length; n += 997) {
      expect(Math.round(decoded.samples[n]! * 32_768)).toBe(Math.round(samples[n]! * 32_767))
    }

    const events = decodeImportedWav(wav)
    const record = events.find((event) => event.type === 'record')
    expect(record?.type).toBe('record')
    if (record?.type !== 'record') return
    expect(record.body).toEqual(body)
    expect(record.stats.correctedBytes).toBe(0)
    expect(events.some((event) => event.type === 'error')).toBe(false)
  })
})
