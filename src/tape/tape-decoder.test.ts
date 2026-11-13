import { describe, expect, it } from 'vitest'
import { FormatError, IntegrityError, UncorrectableError } from '../core/errors'
import { type BaudRate, BITS_PER_FRAME, leaderBits, modulate, SAMPLE_RATE } from '../modem/kcs-modulator'
import { decodeWav, encodeWav } from '../modem/wav'
import { CODEWORD_BYTES, frame, HEADER_FRAME_BYTES, RECORD_HEADER_BYTES } from './framer'
import { type DecoderEvent, TapeDecoder } from './tape-decoder'

// Sanity check only; the full Tape_Decoder tests are task 6.5.
describe('tape decoder (sanity)', () => {
  const body = new Uint8Array(40).map((_, i) => (i * 53 + 7) & 0xff)

  it.each<BaudRate>([300, 2400])('recovers a clean %i-baud record in auto mode from 2,048-sample chunks', (baud) => {
    const samples = modulate(frame(body, 'envelope', baud), baud)
    const decoder = new TapeDecoder({ sampleRate: SAMPLE_RATE })
    const events: DecoderEvent[] = []
    for (let i = 0; i < samples.length; i += 2_048) events.push(...decoder.push(samples.subarray(i, i + 2_048)))

    const types = events.map((event) => event.type)
    // A 40-byte Body fits one Interleave_Group at both rates (B = D).
    expect(types).toEqual(['lock', 'header', 'progress', 'record', 'unlock'])
    expect(events[0]).toEqual({ type: 'lock', baud })

    const record = events.find((event) => event.type === 'record')
    if (record?.type !== 'record') throw new Error('no record event')
    expect(record.body).toEqual(body)
    expect(record.header.baud).toBe(baud)
    expect(record.stats.correctedBytes).toBe(0)
    expect(record.stats.uncorrectableBlocks).toEqual([])
    expect(record.stats.bytesReceived).toBe(record.stats.bytesExpected)
  })
})

// ---------------------------------------------------------------------------
// Helpers. Turbo_Mode is used wherever the rate does not matter, because its
// tapes are half as long as Standard_Mode tapes for a short Body.

type EventOf<T extends DecoderEvent['type']> = Extract<DecoderEvent, { type: T }>

function decodeAll(samples: Float32Array, baud?: BaudRate, chunk = 2_048): DecoderEvent[] {
  const decoder = new TapeDecoder(baud === undefined ? { sampleRate: SAMPLE_RATE } : { sampleRate: SAMPLE_RATE, baud })
  const events: DecoderEvent[] = []
  for (let i = 0; i < samples.length; i += chunk) events.push(...decoder.push(samples.subarray(i, i + chunk)))
  return events
}

function ofType<T extends DecoderEvent['type']>(events: DecoderEvent[], type: T): EventOf<T>[] {
  return events.filter((event): event is EventOf<T> => event.type === type)
}

function concat(...parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((sum, part) => sum + part.length, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

const silence = (seconds: number) => new Float32Array(Math.round(seconds * SAMPLE_RATE))

function makeBody(length: number, seed: number): Uint8Array<ArrayBuffer> {
  return new Uint8Array(length).map((_, i) => (i * 131 + seed * 29 + 11) & 0xff)
}

/** Offset in the Tape_Record of byte `i` of Codeword `c` (design.md, "Interleave_Group g"). */
function codewordByteOffset(c: number, i: number, depth: number): number {
  const g = Math.floor(c / depth)
  return RECORD_HEADER_BYTES + g * CODEWORD_BYTES * depth + i * depth + (c % depth)
}

/** XORs `count` distinct bytes of Codeword `c` with 0x5A, spread over the Codeword. */
function damageCodeword(record: Uint8Array, c: number, depth: number, count: number): void {
  for (let k = 0; k < count; k++) record[codewordByteOffset(c, k * 7, depth)]! ^= 0x5a
}

/** XORs `count` bytes of Header_Frame copy 1 or 2 with 0xA5, spread over the 48 bytes. */
function damageHeaderCopy(record: Uint8Array, copy: 1 | 2, count: number): void {
  const base = copy === 1 ? 0 : HEADER_FRAME_BYTES
  for (let k = 0; k < count; k++) record[base + ((k * 5) % HEADER_FRAME_BYTES)]! ^= 0xa5
}

const types = (events: DecoderEvent[]) => events.map((event) => event.type)

// A 900-byte Body in Turbo_Mode has B = ceil(ceil(900 / 223) / 4) · 4 = 8
// Codewords in two Interleave_Groups of 1,020 bytes: 96 + 2,040 = 2,136 bytes.
const TWO_GROUP_BODY = makeBody(900, 1)
const SHORT_BODY = makeBody(40, 2)

describe('clean WAV round trip (Requirement 5.1)', () => {
  it.each<BaudRate>([300, 2400])(
    'recovers every byte at %i baud through encodeWav and decodeWav with zero corrected bytes (fixed baud)',
    (baud) => {
      const record = frame(SHORT_BODY, 'envelope', baud)
      const { samples, sampleRate } = decodeWav(encodeWav(modulate(record, baud), SAMPLE_RATE))
      expect(sampleRate).toBe(SAMPLE_RATE)
      const events = decodeAll(samples, baud)

      // With a fixed baud, `lock` fires at Carrier_Lock, before any byte.
      expect(types(events)).toEqual(['lock', 'header', 'progress', 'record', 'unlock'])
      expect(events[0]).toEqual({ type: 'lock', baud })
      const [result] = ofType(events, 'record')
      expect(result!.body).toEqual(SHORT_BODY)
      expect(result!.stats).toEqual({
        bytesReceived: record.length,
        bytesExpected: record.length,
        codewords: baud === 300 ? 1 : 4,
        correctedBytes: 0,
        uncorrectableBlocks: [],
        headerCopyUsed: 1,
      })
    },
  )
})

describe('baud detection (Requirement 5.3)', () => {
  it('detects each rate in auto mode from back-to-back 2,400- and 300-baud tapes', () => {
    const other = makeBody(30, 3)
    const samples = concat(
      modulate(frame(SHORT_BODY, 'envelope', 2400), 2400),
      silence(0.3),
      modulate(frame(other, 'shard', 300), 300),
    )
    const events = decodeAll(samples)

    expect(types(events)).toEqual([
      ...['lock', 'header', 'progress', 'record', 'unlock'],
      ...['lock', 'header', 'progress', 'record', 'unlock'],
    ])
    expect(ofType(events, 'lock').map((event) => event.baud)).toEqual([2400, 300])
    const records = ofType(events, 'record')
    expect(records.map((event) => event.header.baud)).toEqual([2400, 300])
    expect(records.map((event) => event.header.type)).toEqual(['envelope', 'shard'])
    expect(records[0]!.body).toEqual(SHORT_BODY)
    expect(records[1]!.body).toEqual(other)
  })

  it('does not decode a 2,400-baud tape when fixed at 300 baud', () => {
    const events = decodeAll(modulate(frame(SHORT_BODY, 'envelope', 2400), 2400), 300)
    // The 300-baud lane locks on the shared leader tone, finds no usable header
    // for its rate, and releases the lock silently.
    expect(events.length).toBeGreaterThan(0)
    expect(events.every((event) => event.type === 'lock' || event.type === 'unlock')).toBe(true)
    expect(events[0]).toEqual({ type: 'lock', baud: 300 })
    expect(events.at(-1)).toEqual({ type: 'unlock' })
  })
})

describe('truncated record (Requirement 5.9)', () => {
  it('reports the partial stats when the audio stops mid-record, then decodes the next tape', () => {
    const record = frame(TWO_GROUP_BODY, 'envelope', 2400)
    expect(record.length).toBe(2_136)
    const full = modulate(record, 2400)
    // Cut where byte 1,416 starts: the first group (bytes 96 to 1,115) is complete.
    const cutByte = 1_416
    const cut = Math.round(((leaderBits(2400) + BITS_PER_FRAME * cutByte) * SAMPLE_RATE) / 2400)
    const samples = concat(full.subarray(0, cut), silence(0.3), modulate(frame(SHORT_BODY, 'envelope', 2400), 2400))
    const events = decodeAll(samples)

    expect(types(events)).toEqual([
      ...['lock', 'header', 'progress', 'error', 'unlock'],
      ...['lock', 'header', 'progress', 'record', 'unlock'],
    ])
    const [failure] = ofType(events, 'error')
    expect(failure!.error).toBeInstanceOf(FormatError)
    expect((failure!.error as FormatError).detail).toBe('signal lost before end of tape record')
    const stats = failure!.stats
    expect(stats.bytesExpected).toBe(2_136)
    expect(stats.bytesReceived).toBeLessThan(stats.bytesExpected)
    // Bytes up to the cut, plus at most the two flywheel frames before lock is lost.
    expect(stats.bytesReceived).toBeGreaterThanOrEqual(cutByte)
    expect(stats.bytesReceived).toBeLessThanOrEqual(cutByte + 3)
    expect(stats.correctedBytes).toBe(0)
    expect(stats.uncorrectableBlocks).toEqual([])

    const records = ofType(events, 'record')
    expect(records).toHaveLength(1)
    expect(records[0]!.body).toEqual(SHORT_BODY)
  })
})

describe('Header_Frame copies (Requirements 3.6, 3.9)', () => {
  it('releases lock with no record and no error when both copies are unusable, then decodes the next tape', () => {
    const bad = frame(makeBody(40, 4), 'envelope', 2400)
    damageHeaderCopy(bad, 1, 20)
    damageHeaderCopy(bad, 2, 20)
    const samples = concat(modulate(bad, 2400), silence(0.3), modulate(frame(SHORT_BODY, 'envelope', 2400), 2400))
    const events = decodeAll(samples)

    // In auto mode `lock` fires only with a confirmed header, so the bad tape
    // shows up as `unlock` alone. After the silent release the lanes search
    // again and can lock on the bad tape's own 0.5 s trailer (the trailer
    // hold-off only follows a completed record), which ends in a second
    // `unlock` when the trailer stops. Both are allowed by Requirement 3.9.
    const firstLock = events.findIndex((event) => event.type === 'lock')
    const badTape = types(events.slice(0, firstLock))
    expect(badTape.length === 1 || badTape.length === 2).toBe(true)
    expect(badTape.every((type) => type === 'unlock')).toBe(true)
    expect(types(events.slice(firstLock))).toEqual(['lock', 'header', 'progress', 'record', 'unlock'])
    expect(ofType(events, 'error')).toEqual([])
    const [result] = ofType(events, 'record')
    expect(result!.body).toEqual(SHORT_BODY)
  })

  it('uses the second copy when the first is unusable and counts the repairs in that copy', () => {
    const record = frame(SHORT_BODY, 'envelope', 2400)
    damageHeaderCopy(record, 1, 20)
    damageHeaderCopy(record, 2, 3)
    const events = decodeAll(modulate(record, 2400))

    expect(types(events)).toEqual(['lock', 'header', 'progress', 'record', 'unlock'])
    const [result] = ofType(events, 'record')
    expect(result!.body).toEqual(SHORT_BODY)
    expect(result!.stats.headerCopyUsed).toBe(2)
    expect(result!.stats.correctedBytes).toBe(3)
  })
})

describe('record failures (Requirements 3.4, 3.7)', () => {
  it('decodes every group and lists every uncorrectable Codeword in one UncorrectableError', () => {
    const record = frame(TWO_GROUP_BODY, 'envelope', 2400)
    damageCodeword(record, 1, 4, 17) // group 0
    damageCodeword(record, 3, 4, 5) // group 0, correctable
    damageCodeword(record, 6, 4, 17) // group 1
    const events = decodeAll(modulate(record, 2400))

    expect(types(events)).toEqual(['lock', 'header', 'progress', 'progress', 'error', 'unlock'])
    expect(ofType(events, 'progress').map((event) => event.bytesReceived)).toEqual([1_116, 2_136])
    const [failure] = ofType(events, 'error')
    expect(failure!.error).toBeInstanceOf(UncorrectableError)
    expect((failure!.error as UncorrectableError).blocks).toEqual([1, 6])
    expect(failure!.stats.uncorrectableBlocks).toEqual([1, 6])
    expect(failure!.stats.correctedBytes).toBe(5)
    expect(failure!.stats.bytesReceived).toBe(2_136)
  })

  it('rejects a restored Body whose CRC-32 differs from the header with an IntegrityError', () => {
    const changed = SHORT_BODY.slice()
    changed[17]! ^= 0x01
    // Header copies of the original Body, Codewords of the changed one: every
    // Codeword decodes cleanly but the CRC-32 no longer matches.
    const record = frame(changed, 'envelope', 2400)
    record.set(frame(SHORT_BODY, 'envelope', 2400).subarray(0, RECORD_HEADER_BYTES))
    const events = decodeAll(modulate(record, 2400))

    expect(types(events)).toEqual(['lock', 'header', 'progress', 'error', 'unlock'])
    const [failure] = ofType(events, 'error')
    expect(failure!.error).toBeInstanceOf(IntegrityError)
    expect(failure!.stats.correctedBytes).toBe(0)
    expect(failure!.stats.uncorrectableBlocks).toEqual([])
  })
})

describe('UI accessors (Requirements 7.3, 7.6)', () => {
  it('reports Carrier_Lock from the leader in auto mode, before the lock event, and clears it after the record', () => {
    const samples = modulate(frame(SHORT_BODY, 'envelope', 2400), 2400)
    const decoder = new TapeDecoder({ sampleRate: SAMPLE_RATE })
    expect(decoder.carrierLock).toBe(false)

    // 1.5 s into the 2 s leader: the lanes have locked, but no header yet.
    const leaderEnd = Math.round(1.5 * SAMPLE_RATE)
    expect(decoder.push(samples.subarray(0, leaderEnd))).toEqual([])
    expect(decoder.carrierLock).toBe(true)
    // A clean 2,400 Hz leader: mark energy about 0.7² dominates space energy.
    expect(decoder.energies.mark).toBeGreaterThan(0.3)
    expect(decoder.energies.mark).toBeGreaterThan(decoder.energies.space * 10)

    const events = decoder.push(samples.subarray(leaderEnd))
    expect(types(events)).toEqual(['lock', 'header', 'progress', 'record', 'unlock'])
    expect(decoder.carrierLock).toBe(false)

    decoder.push(silence(0.2))
    expect(decoder.energies.mark).toBeLessThan(1e-6)
    expect(decoder.energies.space).toBeLessThan(1e-6)
  })
})
