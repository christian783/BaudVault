// WAV codec (design.md, "WAV codec"; Requirements 4.6, 5.4, 5.5).
//
// Export: a 44-byte canonical header (RIFF, WAVE, `fmt ` with format 1, `data`)
// followed by mono 16-bit signed little-endian PCM. Each sample is clamped to
// [−1, 1] and scaled by 32,767 with rounding, so a 0.7 tone peaks at 22,937.
//
// Import: walks the RIFF chunks, skipping unknown ones such as LIST and
// honouring the pad byte after an odd-sized chunk. Accepts
// - format 1, integer PCM at 8 (unsigned, offset 128), 16, 24, or 32 bits,
// - format 3, 32-bit float,
// - WAVE_FORMAT_EXTENSIBLE (0xFFFE) whose sub-format GUID is either of those,
// in mono or stereo (averaged to mono) at 22,050 to 96,000 Hz inclusive.
// Everything else throws FormatError naming the unsupported property. Messages
// carry only literals and header numbers, never sample data.

import { FormatError, InputError } from '../core/errors'

/** Lowest sample rate the decoder accepts, in Hz (Requirement 5.4). */
export const MIN_IMPORT_SAMPLE_RATE = 22_050
/** Highest sample rate the decoder accepts, in Hz (Requirement 5.4). */
export const MAX_IMPORT_SAMPLE_RATE = 96_000

/** Size of the canonical header `encodeWav` writes. */
export const WAV_HEADER_BYTES = 44

const FORMAT_PCM = 0x0001
const FORMAT_FLOAT = 0x0003
const FORMAT_EXTENSIBLE = 0xfffe

/** Bytes 2 to 15 of the KSDATAFORMAT_SUBTYPE_PCM and _IEEE_FLOAT GUIDs; bytes 0 and 1 hold the format code. */
const SUBFORMAT_GUID_TAIL = [0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71]

const PCM16_SCALE = 32_767

function fourCC(view: DataView, offset: number): string {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  )
}

function writeFourCC(view: DataView, offset: number, id: string): void {
  for (let i = 0; i < 4; i++) view.setUint8(offset + i, id.charCodeAt(i))
}

/**
 * Encodes mono samples as a RIFF WAV file of 16-bit signed little-endian PCM
 * (Requirement 4.6). NaN samples are written as 0.
 *
 * @throws InputError if `sampleRate` is not a positive whole number or the
 *   samples do not fit in a WAV file
 */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array<ArrayBuffer> {
  // The byte rate (2 · sampleRate) must fit in an unsigned 32-bit field.
  if (!Number.isInteger(sampleRate) || sampleRate < 1 || sampleRate > 0x7fffffff) {
    throw new InputError('sample rate must be a positive whole number', sampleRate, 'Hz')
  }
  const dataBytes = samples.length * 2
  // The RIFF size field holds 36 + dataBytes as an unsigned 32-bit integer.
  if (dataBytes > 0xffffffff - 36) throw new InputError('too many samples for a WAV file', samples.length)

  const out = new Uint8Array(WAV_HEADER_BYTES + dataBytes)
  const view = new DataView(out.buffer)
  writeFourCC(view, 0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  writeFourCC(view, 8, 'WAVE')
  writeFourCC(view, 12, 'fmt ')
  view.setUint32(16, 16, true) // fmt chunk size
  view.setUint16(20, FORMAT_PCM, true)
  view.setUint16(22, 1, true) // channels
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true) // byte rate
  view.setUint16(32, 2, true) // block align
  view.setUint16(34, 16, true) // bits per sample
  writeFourCC(view, 36, 'data')
  view.setUint32(40, dataBytes, true)

  let offset = WAV_HEADER_BYTES
  for (let i = 0; i < samples.length; i++) {
    const x = samples[i]!
    const clamped = x > 1 ? 1 : x < -1 ? -1 : x === x ? x : 0
    view.setInt16(offset, Math.round(clamped * PCM16_SCALE), true)
    offset += 2
  }
  return out
}

/** Sample encodings the decoder supports, after resolving WAVE_FORMAT_EXTENSIBLE. */
type Encoding = 'u8' | 's16' | 's24' | 's32' | 'f32'

/** Reads one sample at `offset` and returns it in [−1, 1]. */
type SampleReader = (view: DataView, offset: number) => number

const READERS: Record<Encoding, SampleReader> = {
  u8: (view, offset) => (view.getUint8(offset) - 128) / 128,
  s16: (view, offset) => view.getInt16(offset, true) / 32_768,
  s24: (view, offset) => {
    const low = view.getUint8(offset) | (view.getUint8(offset + 1) << 8)
    // Shift the top byte as a signed value so the 24-bit result keeps its sign.
    return ((view.getInt8(offset + 2) << 16) | low) / 8_388_608
  },
  s32: (view, offset) => view.getInt32(offset, true) / 2_147_483_648,
  f32: (view, offset) => {
    const x = view.getFloat32(offset, true)
    return x > 1 ? 1 : x < -1 ? -1 : x === x ? x : 0
  },
}

interface WavFormat {
  encoding: Encoding
  channels: number
  sampleRate: number
  /** Bytes per frame (one sample for every channel). */
  blockAlign: number
}

/** Resolves the format code, following WAVE_FORMAT_EXTENSIBLE to its sub-format. */
function formatCode(view: DataView, start: number, size: number): number {
  const tag = view.getUint16(start, true)
  if (tag !== FORMAT_EXTENSIBLE) return tag
  // WAVEFORMATEXTENSIBLE: cbSize at 16 (at least 22), sub-format GUID at 24 to 39.
  if (size < 40 || view.getUint16(start + 16, true) < 22) throw new FormatError('truncated extensible fmt chunk')
  const guid = start + 24
  for (let i = 0; i < SUBFORMAT_GUID_TAIL.length; i++) {
    if (view.getUint8(guid + 2 + i) !== SUBFORMAT_GUID_TAIL[i]) throw new FormatError('unsupported extensible sub-format')
  }
  return view.getUint16(guid, true)
}

function parseFormat(view: DataView, start: number, size: number): WavFormat {
  if (size < 16) throw new FormatError('truncated fmt chunk')
  const code = formatCode(view, start, size)
  const channels = view.getUint16(start + 2, true)
  const sampleRate = view.getUint32(start + 4, true)
  const blockAlign = view.getUint16(start + 12, true)
  const bits = view.getUint16(start + 14, true)

  let encoding: Encoding
  if (code === FORMAT_PCM) {
    if (bits === 8) encoding = 'u8'
    else if (bits === 16) encoding = 's16'
    else if (bits === 24) encoding = 's24'
    else if (bits === 32) encoding = 's32'
    else throw new FormatError('unsupported PCM bit depth', bits, 'bits')
  } else if (code === FORMAT_FLOAT) {
    if (bits !== 32) throw new FormatError('unsupported float bit depth', bits, 'bits')
    encoding = 'f32'
  } else {
    throw new FormatError('unsupported encoding format', code)
  }

  if (channels !== 1 && channels !== 2) throw new FormatError('unsupported channel count', channels)
  if (sampleRate < MIN_IMPORT_SAMPLE_RATE || sampleRate > MAX_IMPORT_SAMPLE_RATE) {
    throw new FormatError('unsupported sample rate', sampleRate, 'Hz')
  }
  if (blockAlign !== channels * (bits / 8)) throw new FormatError('unsupported block align', blockAlign)
  return { encoding, channels, sampleRate, blockAlign }
}

/**
 * Decodes a RIFF WAV file to mono samples in [−1, 1] at the file's sample rate
 * (Requirements 5.4, 5.5). A data chunk longer than the file is read up to the
 * end of the file, and a trailing partial frame is dropped.
 *
 * @throws FormatError if the file is not RIFF WAVE, lacks a fmt or data chunk,
 *   or uses an encoding, channel count, or sample rate outside Requirement 5.4
 */
export function decodeWav(file: Uint8Array): { samples: Float32Array<ArrayBuffer>; sampleRate: number } {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength)
  if (file.byteLength < 12 || fourCC(view, 0) !== 'RIFF' || fourCC(view, 8) !== 'WAVE') {
    throw new FormatError('not a RIFF WAVE file')
  }

  let format: WavFormat | undefined
  let dataStart = -1
  let dataBytes = 0

  // Walk to the end of the file rather than trusting the RIFF size, which
  // streaming writers often leave as 0 or 0xFFFFFFFF.
  let offset = 12
  while (offset + 8 <= file.byteLength) {
    const id = fourCC(view, offset)
    const size = view.getUint32(offset + 4, true)
    const body = offset + 8
    const available = Math.min(size, file.byteLength - body)
    if (id === 'fmt ' && format === undefined) {
      format = parseFormat(view, body, available)
    } else if (id === 'data' && dataStart < 0) {
      dataStart = body
      dataBytes = available
    }
    // Chunks are word-aligned: an odd-sized chunk is followed by one pad byte.
    offset = body + size + (size & 1)
  }

  if (format === undefined) throw new FormatError('missing fmt chunk')
  if (dataStart < 0) throw new FormatError('missing data chunk')

  const { encoding, channels, sampleRate, blockAlign } = format
  const read = READERS[encoding]
  const frames = Math.floor(dataBytes / blockAlign)
  const samples = new Float32Array(frames)
  if (channels === 1) {
    for (let i = 0, at = dataStart; i < frames; i++, at += blockAlign) samples[i] = read(view, at)
  } else {
    const second = blockAlign / 2
    for (let i = 0, at = dataStart; i < frames; i++, at += blockAlign) {
      samples[i] = (read(view, at) + read(view, at + second)) / 2
    }
  }
  return { samples, sampleRate }
}
