import { describe, expect, it } from 'vitest'
import { readUint16BE, readUint32BE, writeUint32BE } from '../core/bytes'
import { FormatError, InputError, IntegrityError, UncorrectableError } from '../core/errors'
import { crc16, crc32 } from '../fec/crc'
import { rsEncode } from '../fec/reed-solomon'
import {
  type BaudRate,
  CODEWORD_BYTES,
  codewordCount,
  frame,
  HEADER_FRAME_BYTES,
  interleaveDepth,
  MAX_BODY_BYTES,
  parseHeaderFrame,
  RECORD_HEADER_BYTES,
  RecordAssembler,
  readHeader,
  unframe,
} from './framer'

function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(length)
  for (let offset = 0; offset < length; offset += 65_536) {
    crypto.getRandomValues(bytes.subarray(offset, offset + 65_536))
  }
  return bytes
}

/** Offset in the Tape_Record of byte `i` of Codeword `c` (design.md, "Interleave_Group g"). */
function codewordByteOffset(c: number, i: number, depth: number): number {
  const g = Math.floor(c / depth)
  const j = c % depth
  return RECORD_HEADER_BYTES + g * CODEWORD_BYTES * depth + i * depth + j
}

/** XORs `count` distinct bytes of Codeword `c` with 0x5A, spread over the codeword. */
function damageCodeword(record: Uint8Array, c: number, depth: number, count: number): void {
  for (let k = 0; k < count; k++) record[codewordByteOffset(c, k * 7, depth)]! ^= 0x5a
}

function catchError(run: () => unknown): unknown {
  try {
    run()
  } catch (error) {
    return error
  }
  return undefined
}

const BAUDS: BaudRate[] = [300, 2400]

describe('sizes', () => {
  it('uses Interleave_Depth 1 at 300 baud and 4 at 2,400 baud', () => {
    expect(interleaveDepth(300)).toBe(1)
    expect(interleaveDepth(2400)).toBe(4)
  })

  it.each([
    [150, 300, 1],
    [150, 2400, 4],
    [223, 300, 1],
    [224, 300, 2],
    [16_384, 300, 74],
    [16_384, 2400, 76],
  ] as const)('a %i-byte Body at %i baud has %i Codewords', (length, baud, expected) => {
    expect(codewordCount(length, baud)).toBe(expected)
  })
})

describe('frame', () => {
  it.each(BAUDS)('builds a record of 96 + 255·B bytes at %i baud (Requirement 3.1)', (baud) => {
    const body = randomBytes(500)
    const record = frame(body, 'envelope', baud)
    expect(record.length).toBe(96 + 255 * codewordCount(500, baud))
  })

  it('writes two identical Header_Frames with the v1 field layout', () => {
    const body = randomBytes(500)
    const record = frame(body, 'shard', 2400)
    const first = record.subarray(0, HEADER_FRAME_BYTES)
    expect(record.subarray(HEADER_FRAME_BYTES, RECORD_HEADER_BYTES)).toEqual(first)

    expect(first[0]).toBe(0x42)
    expect(first[1]).toBe(0x56)
    expect(first[2]).toBe(0x01)
    expect(first[3]).toBe(0x02) // shard
    expect(first[4]).toBe(0x02) // 2,400 baud
    expect(first[5]).toBe(4)
    expect(readUint16BE(first, 6)).toBe(4)
    expect(readUint16BE(first, 8)).toBe(500)
    expect(readUint32BE(first, 10)).toBe(crc32(body))
    expect(readUint16BE(first, 14)).toBe(crc16(first.subarray(0, 14)))
    expect(first).toEqual(rsEncode(first.subarray(0, 16)))
  })

  it('writes record type 0x01 and baud code 0x01 for an Envelope at 300 baud', () => {
    const record = frame(randomBytes(10), 'envelope', 300)
    expect(record[3]).toBe(0x01)
    expect(record[4]).toBe(0x01)
    expect(record[5]).toBe(1)
  })

  it('interleaves Codewords column by column at 2,400 baud', () => {
    const body = randomBytes(4 * 223)
    const record = frame(body, 'envelope', 2400)
    for (let c = 0; c < 4; c++) {
      for (let i = 0; i < 223; i++) {
        expect(record[codewordByteOffset(c, i, 4)]).toBe(body[c * 223 + i])
      }
    }
  })

  it('rejects an empty Body with InputError (Requirement 3.8)', () => {
    expect(() => frame(new Uint8Array(0), 'envelope', 300)).toThrow(InputError)
  })

  it('rejects a 16,385-byte Body with InputError (Requirement 3.8)', () => {
    expect(() => frame(new Uint8Array(MAX_BODY_BYTES + 1), 'envelope', 2400)).toThrow(InputError)
  })

  it('accepts and round-trips a 16,384-byte Body', () => {
    const body = randomBytes(MAX_BODY_BYTES)
    expect(unframe(frame(body, 'envelope', 2400), 2400).body).toEqual(body)
  })
})

describe('unframe', () => {
  it.each(BAUDS)('round-trips Bodies at %i baud with zero corrections', (baud) => {
    for (const length of [1, 222, 223, 224, 1000]) {
      const body = randomBytes(length)
      const { body: out, header, stats } = unframe(frame(body, 'envelope', baud), baud)
      expect(out).toEqual(body)
      expect(header.bodyLength).toBe(length)
      expect(header.type).toBe('envelope')
      expect(stats.correctedBytes).toBe(0)
      expect(stats.headerCopyUsed).toBe(1)
      expect(stats.uncorrectableBlocks).toEqual([])
      expect(stats.bytesReceived).toBe(stats.bytesExpected)
    }
  })

  it('ignores bytes after the declared record length', () => {
    const body = randomBytes(50)
    const record = frame(body, 'shard', 300)
    const padded = new Uint8Array(record.length + 20)
    padded.set(record)
    expect(unframe(padded, 300).body).toEqual(body)
  })

  it('repairs a damaged first Header_Frame copy and counts the repair', () => {
    const body = randomBytes(100)
    const record = frame(body, 'envelope', 300)
    for (let p = 0; p < 10; p++) record[p * 4]! ^= 0xff
    const { body: out, stats } = unframe(record, 300)
    expect(out).toEqual(body)
    expect(stats.headerCopyUsed).toBe(1)
    expect(stats.correctedBytes).toBe(10)
  })

  it.each(BAUDS)('uses the second copy when the first is destroyed at %i baud (Requirement 3.6)', (baud) => {
    const body = randomBytes(300)
    const record = frame(body, 'envelope', baud)
    record.fill(0xff, 0, HEADER_FRAME_BYTES)
    expect(parseHeaderFrame(record.subarray(0, HEADER_FRAME_BYTES), baud)).toBeNull()
    const { body: out, stats } = unframe(record, baud)
    expect(out).toEqual(body)
    expect(stats.headerCopyUsed).toBe(2)
  })

  it('uses the second copy when the first decodes but fails its CRC-16', () => {
    const body = randomBytes(300)
    const record = frame(body, 'envelope', 300)
    const bad = record.slice(0, 16)
    bad[15]! ^= 0x01
    record.set(rsEncode(bad), 0)
    expect(parseHeaderFrame(record.subarray(0, HEADER_FRAME_BYTES), 300)).toBeNull()
    expect(unframe(record, 300).stats.headerCopyUsed).toBe(2)
  })

  it('throws FormatError when both Header_Frame copies are destroyed', () => {
    const record = frame(randomBytes(300), 'envelope', 300)
    record.fill(0xff, 0, RECORD_HEADER_BYTES)
    expect(readHeader(record, 300)).toBeNull()
    expect(() => unframe(record, 300)).toThrow(FormatError)
  })

  it('treats a header for the other baud rate as unusable', () => {
    const record = frame(randomBytes(300), 'envelope', 300)
    expect(parseHeaderFrame(record.subarray(0, HEADER_FRAME_BYTES), 2400)).toBeNull()
    expect(() => unframe(record, 2400)).toThrow(FormatError)
  })

  it('throws FormatError for a truncated record', () => {
    const record = frame(randomBytes(300), 'envelope', 300)
    expect(() => unframe(record.subarray(0, record.length - 1), 300)).toThrow(FormatError)
    expect(() => unframe(record.subarray(0, 50), 300)).toThrow(FormatError)
  })

  it('throws IntegrityError when the Body CRC-32 does not match the header (Requirement 3.7)', () => {
    const body = randomBytes(300)
    const record = frame(body, 'envelope', 300)
    // Rebuild a self-consistent header that declares the wrong CRC-32.
    const data = record.slice(0, 16)
    writeUint32BE(data, 10, (crc32(body) ^ 0x1) >>> 0)
    const sum = crc16(data.subarray(0, 14))
    data[14] = sum >>> 8
    data[15] = sum & 0xff
    const header = rsEncode(data)
    record.set(header, 0)
    record.set(header, HEADER_FRAME_BYTES)
    expect(parseHeaderFrame(header, 300)).not.toBeNull()
    expect(() => unframe(record, 300)).toThrow(IntegrityError)
  })

  it('throws IntegrityError when a Codeword is replaced by a different valid Codeword', () => {
    const body = randomBytes(300)
    const record = frame(body, 'envelope', 300)
    const chunk = record.slice(RECORD_HEADER_BYTES, RECORD_HEADER_BYTES + 223)
    chunk[0]! ^= 0x01
    record.set(rsEncode(chunk), RECORD_HEADER_BYTES)
    expect(() => unframe(record, 300)).toThrow(IntegrityError)
  })

  it.each([
    [300, [1, 4, 6]],
    [2400, [0, 3, 5, 7]],
  ] as const)('lists every uncorrectable Codeword at %i baud (Requirement 3.4)', (baud, failing) => {
    const depth = interleaveDepth(baud)
    const record = frame(randomBytes(8 * 223), 'envelope', baud)
    for (const c of failing) damageCodeword(record, c, depth, 20)
    // A correctable Codeword between the failures still decodes.
    damageCodeword(record, 2, depth, 3)
    const error = catchError(() => unframe(record, baud))
    expect(error).toBeInstanceOf(UncorrectableError)
    expect((error as UncorrectableError).blocks).toEqual(failing)
  })

  it.each(BAUDS)('repairs a burst of 16·D bytes in the data section at %i baud (Requirement 3.5)', (baud) => {
    const depth = interleaveDepth(baud)
    const body = randomBytes(8 * 223)
    const clean = frame(body, 'envelope', baud)
    const burst = 16 * depth
    for (const start of [RECORD_HEADER_BYTES, RECORD_HEADER_BYTES + CODEWORD_BYTES * depth - burst / 2]) {
      const record = clean.slice()
      for (let p = start; p < start + burst; p++) record[p]! ^= 0xc3
      const { body: out, stats } = unframe(record, baud)
      expect(out).toEqual(body)
      expect(stats.correctedBytes).toBe(burst)
    }
  })

  it('rejects a Header_Frame that is not 48 bytes with RangeError', () => {
    expect(() => parseHeaderFrame(new Uint8Array(47), 300)).toThrow(RangeError)
  })
})

describe('RecordAssembler', () => {
  it('reports progress after each Interleave_Group', () => {
    const body = randomBytes(8 * 223)
    const record = frame(body, 'shard', 2400)
    const chosen = readHeader(record, 2400)!
    const assembler = new RecordAssembler(chosen.header, chosen.copy)
    expect(assembler.groupCount).toBe(2)
    expect(assembler.stats.bytesReceived).toBe(96)
    expect(() => assembler.finish()).toThrow(RangeError)

    const groupBytes = assembler.groupBytes
    const first = assembler.addGroup(record.subarray(96, 96 + groupBytes))
    expect(first.bytesReceived).toBe(96 + 1020)
    expect(first.bytesExpected).toBe(96 + 2040)
    expect(assembler.complete).toBe(false)

    assembler.addGroup(record.subarray(96 + groupBytes, 96 + 2 * groupBytes))
    expect(assembler.complete).toBe(true)
    expect(assembler.finish()).toEqual(body)
    expect(() => assembler.addGroup(new Uint8Array(groupBytes))).toThrow(RangeError)
  })
})
