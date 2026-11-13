import { describe, expect, it } from 'vitest'
import { FormatError } from '../core/errors'
import { frame } from '../tape/framer'
import { type DecoderEvent, TapeDecoder } from '../tape/tape-decoder'
import { AMPLITUDE, type BaudRate, modulate, SAMPLE_RATE } from './kcs-modulator'
import { decodeWav, encodeWav, MAX_IMPORT_SAMPLE_RATE, MIN_IMPORT_SAMPLE_RATE, WAV_HEADER_BYTES } from './wav'

describe('WAV codec (sanity)', () => {
  it('writes a 44-byte canonical mono 16-bit header and peaks 0.7 at 22,937', () => {
    const file = encodeWav(new Float32Array([0, 0.7, -0.7, 2, -2]), 44_100)
    const view = new DataView(file.buffer)
    expect(file.length).toBe(WAV_HEADER_BYTES + 10)
    expect(String.fromCharCode(...file.subarray(0, 4))).toBe('RIFF')
    expect(view.getUint32(4, true)).toBe(36 + 10)
    expect(String.fromCharCode(...file.subarray(8, 16))).toBe('WAVEfmt ')
    expect(view.getUint16(20, true)).toBe(1) // PCM
    expect(view.getUint16(22, true)).toBe(1) // mono
    expect(view.getUint32(24, true)).toBe(44_100)
    expect(view.getUint16(34, true)).toBe(16)
    expect(String.fromCharCode(...file.subarray(36, 40))).toBe('data')
    expect([0, 1, 2, 3, 4].map((i) => view.getInt16(44 + 2 * i, true))).toEqual([0, 22_937, -22_937, 32_767, -32_767])
  })

  it('decodes its own output back to the same samples within one quantisation step', () => {
    const input = new Float32Array([0, 0.25, -0.5, 0.7, -0.7])
    const { samples, sampleRate } = decodeWav(encodeWav(input, 48_000))
    expect(sampleRate).toBe(48_000)
    expect(samples.length).toBe(input.length)
    for (let i = 0; i < input.length; i++) expect(Math.abs(samples[i]! - input[i]!)).toBeLessThan(1 / 16_000)
  })

  it('rejects a non-RIFF file and an unsupported sample rate', () => {
    expect(() => decodeWav(new Uint8Array(44))).toThrow(FormatError)
    expect(() => decodeWav(encodeWav(new Float32Array(4), 8_000))).toThrow('unsupported sample rate 8000 Hz')
  })
})

// ---------------------------------------------------------------------------
// Test WAV builder. Writes RIFF files in any layout the decoder must accept or
// reject, from samples in [−1, 1]. Local to this file; no network.

type Encoding = 'u8' | 's16' | 's24' | 's32' | 'f32'

type WavSpec = {
  encoding: Encoding
  sampleRate: number
  /** Default 1. Frames are written with the same sample count for every channel. */
  channels?: number
  /** Write a 40-byte WAVE_FORMAT_EXTENSIBLE fmt chunk. */
  extensible?: boolean
  /** Override the format tag (plain) or the sub-format code (extensible). */
  formatCode?: number
  /** Override the bits-per-sample field (block align follows it). */
  bits?: number
  /** Replace the GUID tail of the extensible sub-format. */
  guidTail?: number[]
  /** Chunks written before `fmt `, between `fmt ` and `data`, and after `data`. */
  before?: Chunk[]
  between?: Chunk[]
  after?: Chunk[]
  omitFmt?: boolean
  omitData?: boolean
}

type Chunk = { id: string; body: Uint8Array }

const BITS: Record<Encoding, number> = { u8: 8, s16: 16, s24: 24, s32: 32, f32: 32 }
const GUID_TAIL = [0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71]

function clamp(x: number): number {
  return x > 1 ? 1 : x < -1 ? -1 : x
}

function writeSample(view: DataView, at: number, encoding: Encoding, x: number): void {
  const v = clamp(x)
  if (encoding === 'u8') view.setUint8(at, Math.max(0, Math.min(255, Math.round(v * 128) + 128)))
  else if (encoding === 's16') view.setInt16(at, Math.round(v * 32_767), true)
  else if (encoding === 's24') {
    const n = Math.round(v * 8_388_607)
    view.setUint8(at, n & 0xff)
    view.setUint8(at + 1, (n >> 8) & 0xff)
    view.setUint8(at + 2, (n >> 16) & 0xff)
  } else if (encoding === 's32') view.setInt32(at, Math.round(v * 2_147_483_647), true)
  else view.setFloat32(at, v, true)
}

/** Interleaved PCM bytes for `channels`, each an array of samples of equal length. */
function pcmBytes(channels: Float32Array[], encoding: Encoding): Uint8Array<ArrayBuffer> {
  const width = BITS[encoding] / 8
  const frames = channels[0]?.length ?? 0
  const out = new Uint8Array(frames * channels.length * width)
  const view = new DataView(out.buffer)
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels.length; c++) {
      writeSample(view, (i * channels.length + c) * width, encoding, channels[c]![i]!)
    }
  }
  return out
}

function fmtChunk(spec: WavSpec): Chunk {
  const channels = spec.channels ?? 1
  const bits = spec.bits ?? BITS[spec.encoding]
  const code = spec.formatCode ?? (spec.encoding === 'f32' ? 3 : 1)
  const body = new Uint8Array(spec.extensible === true ? 40 : 16)
  const view = new DataView(body.buffer)
  view.setUint16(0, spec.extensible === true ? 0xfffe : code, true)
  view.setUint16(2, channels, true)
  view.setUint32(4, spec.sampleRate, true)
  view.setUint32(8, (spec.sampleRate * channels * bits) / 8, true)
  view.setUint16(12, (channels * bits) / 8, true)
  view.setUint16(14, bits, true)
  if (spec.extensible === true) {
    view.setUint16(16, 22, true) // cbSize
    view.setUint16(18, bits, true) // valid bits per sample
    view.setUint32(20, channels === 2 ? 0x3 : 0x4, true) // channel mask
    view.setUint16(24, code, true) // sub-format GUID data1, low 16 bits
    body.set(spec.guidTail ?? GUID_TAIL, 26)
  }
  return { id: 'fmt ', body }
}

/** Builds a RIFF WAVE file. Odd-sized chunks get the RIFF pad byte. */
function buildWav(spec: WavSpec, channels: Float32Array[]): Uint8Array<ArrayBuffer> {
  const chunks: Chunk[] = [...(spec.before ?? [])]
  if (spec.omitFmt !== true) chunks.push(fmtChunk(spec))
  chunks.push(...(spec.between ?? []))
  if (spec.omitData !== true) chunks.push({ id: 'data', body: pcmBytes(channels, spec.encoding) })
  chunks.push(...(spec.after ?? []))

  const size = chunks.reduce((sum, chunk) => sum + 8 + chunk.body.length + (chunk.body.length & 1), 12)
  const out = new Uint8Array(size)
  const view = new DataView(out.buffer)
  const ascii = (at: number, id: string) => {
    for (let i = 0; i < 4; i++) out[at + i] = id.charCodeAt(i)
  }
  ascii(0, 'RIFF')
  view.setUint32(4, size - 8, true)
  ascii(8, 'WAVE')
  let at = 12
  for (const chunk of chunks) {
    ascii(at, chunk.id)
    view.setUint32(at + 4, chunk.body.length, true)
    out.set(chunk.body, at + 8)
    at += 8 + chunk.body.length + (chunk.body.length & 1)
  }
  return out
}

/** An odd-sized LIST chunk, so the pad byte after it matters. */
const LIST_CHUNK: Chunk = { id: 'LIST', body: new Uint8Array([0x49, 0x4e, 0x46, 0x4f, 0x21]) }

function formatErrorOf(run: () => unknown): FormatError {
  try {
    run()
  } catch (error) {
    if (error instanceof FormatError) return error
    throw error
  }
  throw new Error('expected a FormatError')
}

const SIGNAL = new Float32Array([0, 0.5, -0.5, 0.25, -0.75, 0.7, -0.7, 0.999])

describe('encodeWav (Requirement 4.6)', () => {
  it('writes the exact 44-byte header for mono 16-bit PCM at 44,100 Hz', () => {
    const file = encodeWav(new Float32Array([0.7, -0.7]), 44_100)
    const expected = [
      0x52, 0x49, 0x46, 0x46, 40, 0, 0, 0, // "RIFF", 36 + 4 data bytes
      0x57, 0x41, 0x56, 0x45, // "WAVE"
      0x66, 0x6d, 0x74, 0x20, 16, 0, 0, 0, // "fmt ", chunk size 16
      1, 0, 1, 0, // PCM, mono
      0x44, 0xac, 0, 0, // 44,100 Hz
      0x88, 0x58, 0x01, 0, // byte rate 88,200
      2, 0, 16, 0, // block align 2, 16 bits
      0x64, 0x61, 0x74, 0x61, 4, 0, 0, 0, // "data", 4 bytes
      0x99, 0x59, 0x67, 0xa6, // 22,937 and −22,937 little-endian
    ]
    expect([...file]).toEqual(expected)
  })

  it('exports a modulated tape as a 0.7 sine: no sample above 22,937 and the crest sampled as closely as the grid allows', () => {
    const file = encodeWav(modulate(frame(new Uint8Array([1, 2, 3]), 'envelope', 2400), 2400), SAMPLE_RATE)
    const view = new DataView(file.buffer)
    let peak = 0
    for (let at = WAV_HEADER_BYTES; at < file.length; at += 2) peak = Math.max(peak, Math.abs(view.getInt16(at, true)))
    // Both tone steps (2π · 1200 / 44100 and 2π · 2400 / 44100) are multiples of
    // 2π / 147, so every sample phase is k · 2π / 147. The closest to the crest
    // (k = 37) misses π/2 by a quarter step, so the largest sample is
    // round(22,936.9 · cos(π / 294)) = 22,936 while the tone's amplitude is 22,937.
    expect(peak).toBe(Math.round(AMPLITUDE * 32_767 * Math.cos(Math.PI / 294)))
    expect(peak).toBeLessThanOrEqual(22_937)
  })
})

describe('decodeWav formats (Requirement 5.4)', () => {
  it.each<[string, WavSpec, number]>([
    ['8-bit unsigned PCM', { encoding: 'u8', sampleRate: 22_050 }, 1 / 128],
    // The builder scales 16-bit by 32,767 (like encodeWav) and the decoder divides by 32,768.
    ['16-bit PCM', { encoding: 's16', sampleRate: 44_100 }, 1 / 16_000],
    ['24-bit PCM', { encoding: 's24', sampleRate: 48_000 }, 1e-6],
    ['32-bit integer PCM', { encoding: 's32', sampleRate: 96_000 }, 1e-6],
    ['32-bit float', { encoding: 'f32', sampleRate: 44_100 }, 1e-7],
    ['EXTENSIBLE 16-bit PCM', { encoding: 's16', sampleRate: 44_100, extensible: true }, 1 / 16_000],
    ['EXTENSIBLE 24-bit PCM', { encoding: 's24', sampleRate: 44_100, extensible: true }, 1e-6],
    ['EXTENSIBLE 32-bit float', { encoding: 'f32', sampleRate: 48_000, extensible: true }, 1e-7],
  ])('reads %s', (_, spec, tolerance) => {
    const { samples, sampleRate } = decodeWav(buildWav(spec, [SIGNAL]))
    expect(sampleRate).toBe(spec.sampleRate)
    expect(samples.length).toBe(SIGNAL.length)
    for (let i = 0; i < SIGNAL.length; i++) expect(Math.abs(samples[i]! - SIGNAL[i]!)).toBeLessThanOrEqual(tolerance)
  })

  it('reads the sign and full scale of 8-bit and 24-bit samples', () => {
    const u8 = decodeWav(buildWav({ encoding: 'u8', sampleRate: 44_100 }, [new Float32Array([-1, 0, 1])])).samples
    expect([...u8]).toEqual([-1, 0, 127 / 128])
    const s24 = decodeWav(buildWav({ encoding: 's24', sampleRate: 44_100 }, [new Float32Array([-1, -1 / 8_388_607, 1])]))
    expect([...s24.samples]).toEqual([-8_388_607 / 8_388_608, -1 / 8_388_608, 8_388_607 / 8_388_608].map(Math.fround))
  })

  it.each<Encoding>(['s16', 'f32', 'u8'])('averages stereo channels to mono (%s)', (encoding) => {
    const left = new Float32Array([0.5, -0.5, 0.25, 0])
    const right = new Float32Array([0.1, 0.3, -0.25, -0.5])
    const { samples } = decodeWav(buildWav({ encoding, sampleRate: 44_100, channels: 2 }, [left, right]))
    const tolerance = encoding === 'u8' ? 1 / 128 : 1 / 16_000
    expect(samples.length).toBe(4)
    for (let i = 0; i < 4; i++) expect(Math.abs(samples[i]! - (left[i]! + right[i]!) / 2)).toBeLessThanOrEqual(tolerance)
  })

  it('averages stereo in a WAVE_FORMAT_EXTENSIBLE file', () => {
    const left = new Float32Array([0.5, -0.5])
    const right = new Float32Array([0.3, 0.1])
    const { samples } = decodeWav(buildWav({ encoding: 'f32', sampleRate: 44_100, channels: 2, extensible: true }, [left, right]))
    expect([...samples]).toEqual([0.4, -0.2].map(Math.fround))
  })

  it('skips unknown chunks such as LIST and honours the pad byte after an odd-sized chunk', () => {
    const odd = new Float32Array([0.5, -0.5, 0.25]) // 3 bytes of 8-bit data: odd-sized data chunk
    const file = buildWav(
      { encoding: 'u8', sampleRate: 44_100, before: [LIST_CHUNK], between: [LIST_CHUNK], after: [LIST_CHUNK] },
      [odd],
    )
    const { samples } = decodeWav(file)
    expect([...samples]).toEqual([0.5, -0.5, 0.25])
  })

  it('accepts the sample rate limits 22,050 Hz and 96,000 Hz', () => {
    expect(MIN_IMPORT_SAMPLE_RATE).toBe(22_050)
    expect(MAX_IMPORT_SAMPLE_RATE).toBe(96_000)
    for (const sampleRate of [22_050, 96_000]) {
      expect(decodeWav(buildWav({ encoding: 's16', sampleRate }, [SIGNAL])).sampleRate).toBe(sampleRate)
    }
  })
})

describe('decodeWav rejections (Requirement 5.5)', () => {
  it.each<[string, () => Uint8Array, string]>([
    ['a file that is not RIFF', () => new Uint8Array(64), 'not a RIFF WAVE file'],
    [
      'a RIFF file that is not WAVE',
      () => {
        const file = buildWav({ encoding: 's16', sampleRate: 44_100 }, [SIGNAL])
        file.set([0x41, 0x56, 0x49, 0x20], 8) // "AVI "
        return file
      },
      'not a RIFF WAVE file',
    ],
    ['ADPCM encoding', () => buildWav({ encoding: 's16', sampleRate: 44_100, formatCode: 2 }, [SIGNAL]), 'unsupported encoding format 2'],
    [
      'an EXTENSIBLE sub-format that is not PCM or float',
      () => buildWav({ encoding: 's16', sampleRate: 44_100, extensible: true, formatCode: 2 }, [SIGNAL]),
      'unsupported encoding format 2',
    ],
    [
      'an EXTENSIBLE sub-format GUID outside the KSDATAFORMAT family',
      () => buildWav({ encoding: 's16', sampleRate: 44_100, extensible: true, guidTail: new Array(14).fill(0x11) }, [SIGNAL]),
      'unsupported extensible sub-format',
    ],
    ['12-bit PCM', () => buildWav({ encoding: 's16', sampleRate: 44_100, bits: 12 }, [SIGNAL]), 'unsupported PCM bit depth 12 bits'],
    [
      '64-bit float',
      () => buildWav({ encoding: 'f32', sampleRate: 44_100, bits: 64 }, [SIGNAL]),
      'unsupported float bit depth 64 bits',
    ],
    [
      'three channels',
      () => buildWav({ encoding: 's16', sampleRate: 44_100, channels: 3 }, [SIGNAL, SIGNAL, SIGNAL]),
      'unsupported channel count 3',
    ],
    ['zero channels', () => buildWav({ encoding: 's16', sampleRate: 44_100, channels: 0 }, []), 'unsupported channel count 0'],
    ['22,049 Hz', () => buildWav({ encoding: 's16', sampleRate: 22_049 }, [SIGNAL]), 'unsupported sample rate 22049 Hz'],
    ['96,001 Hz', () => buildWav({ encoding: 's16', sampleRate: 96_001 }, [SIGNAL]), 'unsupported sample rate 96001 Hz'],
    ['192,000 Hz', () => buildWav({ encoding: 'f32', sampleRate: 192_000 }, [SIGNAL]), 'unsupported sample rate 192000 Hz'],
    ['a missing fmt chunk', () => buildWav({ encoding: 's16', sampleRate: 44_100, omitFmt: true }, [SIGNAL]), 'missing fmt chunk'],
    [
      'a missing data chunk',
      () => buildWav({ encoding: 's16', sampleRate: 44_100, omitData: true, after: [LIST_CHUNK] }, [SIGNAL]),
      'missing data chunk',
    ],
  ])('rejects %s with a FormatError naming the property', (_, build, message) => {
    const error = formatErrorOf(() => decodeWav(build()))
    expect(error.message).toBe(message)
  })
})

// End to end (Requirement 5.4): a BaudVault tape converted to another format
// without noise must still decode through decodeWav → TapeDecoder. Lives here
// because it exercises the import formats; tests may import upward from tape/.
//
// Sample rate conversion. 22,050 Hz is exact decimation by 2 (keep every other
// sample); both tones sit well below its 11,025 Hz Nyquist limit. 96,000 Hz
// uses linear interpolation. For tones at most 2,400 Hz sampled at 44,100 Hz,
// linear interpolation attenuates by under 1% and adds images far above both
// tones, which is what a basic converter does to a noise-free file.
describe('import of converted BaudVault tapes (Requirement 5.4)', () => {
  const body = new Uint8Array(40).map((_, i) => (i * 97 + 13) & 0xff)
  const tapes: Record<BaudRate, Float32Array> = {
    300: modulate(frame(body, 'envelope', 300), 300),
    2400: modulate(frame(body, 'envelope', 2400), 2400),
  }

  function resample(input: Float32Array, rate: number): Float32Array {
    if (rate === SAMPLE_RATE) return input
    if (rate * 2 === SAMPLE_RATE) return input.filter((_, i) => i % 2 === 0)
    const out = new Float32Array(Math.floor(((input.length - 1) * rate) / SAMPLE_RATE) + 1)
    for (let i = 0; i < out.length; i++) {
      const pos = (i * SAMPLE_RATE) / rate
      const i0 = Math.floor(pos)
      const a = input[i0]!
      const b = input[Math.min(i0 + 1, input.length - 1)]!
      out[i] = a + (pos - i0) * (b - a)
    }
    return out
  }

  // Turbo_Mode where the rate does not matter, to keep the suite fast; one
  // Standard_Mode case at a non-44.1 kHz rate covers the 300-baud lane.
  it.each<[string, BaudRate, WavSpec]>([
    ['8-bit unsigned PCM', 2400, { encoding: 'u8', sampleRate: 44_100 }],
    ['24-bit PCM', 2400, { encoding: 's24', sampleRate: 44_100 }],
    ['32-bit integer PCM', 2400, { encoding: 's32', sampleRate: 44_100 }],
    ['32-bit float', 2400, { encoding: 'f32', sampleRate: 44_100 }],
    ['16-bit stereo', 2400, { encoding: 's16', sampleRate: 44_100, channels: 2 }],
    ['EXTENSIBLE 24-bit stereo', 2400, { encoding: 's24', sampleRate: 44_100, channels: 2, extensible: true }],
    ['EXTENSIBLE float', 2400, { encoding: 'f32', sampleRate: 44_100, extensible: true }],
    ['16-bit PCM at 22,050 Hz', 2400, { encoding: 's16', sampleRate: 22_050 }],
    ['16-bit PCM at 48,000 Hz', 2400, { encoding: 's16', sampleRate: 48_000 }],
    ['16-bit PCM at 96,000 Hz', 2400, { encoding: 's16', sampleRate: 96_000 }],
    ['8-bit stereo PCM at 22,050 Hz', 300, { encoding: 'u8', sampleRate: 22_050, channels: 2 }],
  ])('recovers the Body from %s at %i baud in auto mode', (_, baud, spec) => {
    const mono = resample(tapes[baud], spec.sampleRate)
    const channels = Array.from({ length: spec.channels ?? 1 }, () => mono)
    const file = buildWav({ ...spec, before: [LIST_CHUNK] }, channels)

    const { samples, sampleRate } = decodeWav(file)
    expect(sampleRate).toBe(spec.sampleRate)
    const decoder = new TapeDecoder({ sampleRate })
    const events: DecoderEvent[] = []
    for (let i = 0; i < samples.length; i += 4_096) events.push(...decoder.push(samples.subarray(i, i + 4_096)))

    const records = events.filter((event) => event.type === 'record')
    expect(records).toHaveLength(1)
    const record = records[0]!
    if (record.type !== 'record') throw new Error('no record event')
    expect(record.body).toEqual(body)
    expect(record.header.baud).toBe(baud)
    expect(events.some((event) => event.type === 'error')).toBe(false)
  })
})
