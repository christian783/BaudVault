// Tape_Framer: turns a Body into a Tape_Record and back (design.md,
// "Tape_Framer", "Header_Frame", and "Tape_Record").
//
// Tape_Record = Header_Frame ‖ Header_Frame ‖ Interleave_Group 0 ‖ … ‖ Group (B/D − 1)
//
// - The Body is zero-padded to 223·B bytes and cut into B chunks. Each chunk
//   becomes a 255-byte Codeword through `rsEncode`.
// - Group g holds Codewords g·D to g·D + D − 1, sent column by column: for i in
//   0..254, for j in 0..D−1, send codeword[g·D + j][i]. A burst of up to 16·D
//   consecutive bytes then touches each Codeword at most 16 times.
// - Total length is 96 + 255·B bytes.
//
// The batch `unframe` and the streaming Tape_Decoder share the same building
// blocks: `readHeader` picks a usable Header_Frame copy, and `RecordAssembler`
// decodes one Interleave_Group at a time and finishes the record (padding
// strip and CRC-32). Error messages carry fixed text and safe numbers only
// (Requirement 8.9).

import { readUint16BE, readUint32BE, writeUint16BE, writeUint32BE } from '../core/bytes'
import { FormatError, InputError, IntegrityError, UncorrectableError } from '../core/errors'
import { crc16, crc32 } from '../fec/crc'
import { MAX_DATA_BYTES, PARITY_BYTES, rsDecode, rsEncode } from '../fec/reed-solomon'
import type { BaudRate } from '../modem/kcs-modulator'

// BaudRate lives in the modem layer because imports flow `tape → modem`.
export type { BaudRate }
export type RecordType = 'envelope' | 'shard'

/** Largest Body one Tape_Record carries (Requirement 3.8). */
export const MAX_BODY_BYTES = 16_384
/** Data bytes in a Header_Frame, before its Reed-Solomon parity. */
export const HEADER_DATA_BYTES = 16
/** One Header_Frame copy: 16 data bytes and 32 parity bytes. */
export const HEADER_FRAME_BYTES = HEADER_DATA_BYTES + PARITY_BYTES
/** Both Header_Frame copies at the start of a Tape_Record. */
export const RECORD_HEADER_BYTES = 2 * HEADER_FRAME_BYTES
/** Bytes in one full-length Codeword. */
export const CODEWORD_BYTES = MAX_DATA_BYTES + PARITY_BYTES

const MAGIC_0 = 0x42 // 'B'
const MAGIC_1 = 0x56 // 'V'
const FORMAT_VERSION = 0x01

const OFFSET_VERSION = 2
const OFFSET_TYPE = 3
const OFFSET_BAUD = 4
const OFFSET_DEPTH = 5
const OFFSET_CODEWORDS = 6
const OFFSET_LENGTH = 8
const OFFSET_BODY_CRC = 10
const OFFSET_HEADER_CRC = 14
/** CRC-16 covers bytes 0 to 13. */
const HEADER_CRC_SPAN = 14

const TYPE_CODES: Record<RecordType, number> = { envelope: 0x01, shard: 0x02 }
const BAUD_CODES: Record<BaudRate, number> = { 300: 0x01, 2400: 0x02 }

/** The decoded fields of one usable Header_Frame copy. */
export type TapeHeader = {
  type: RecordType
  baud: BaudRate
  /** Interleave_Depth D: 1 at 300 baud, 4 at 2,400 baud. */
  interleaveDepth: number
  /** Codeword count B, a multiple of D. */
  codewords: number
  /** Body length L, 1 to 16,384. */
  bodyLength: number
  /** CRC-32 of the L Body bytes, unsigned. */
  bodyCrc32: number
  /** Bytes Reed-Solomon repaired in this Header_Frame copy. */
  correctedBytes: number
}

/** Decode progress and results, shared by `unframe`, the Tape_Decoder, and the UI telemetry. */
export type DecodeStats = {
  /** Tape_Record bytes received so far, including both Header_Frame copies. */
  bytesReceived: number
  /** Total Tape_Record length declared by the header: 96 + 255·B. */
  bytesExpected: number
  /** Codeword count B. */
  codewords: number
  /** Bytes repaired in the Header_Frame copy used plus all Codewords decoded so far. */
  correctedBytes: number
  /** Zero-based indices of every uncorrectable Codeword found so far. */
  uncorrectableBlocks: number[]
  headerCopyUsed: 1 | 2
}

/** Interleave_Depth for a baud rate: 1 in Standard_Mode, 4 in Turbo_Mode. */
export function interleaveDepth(baud: BaudRate): number {
  if (baud === 300) return 1
  if (baud === 2400) return 4
  throw new InputError('unsupported baud rate', baud)
}

/** Codeword count B for a Body of `bodyLength` bytes: ceil(ceil(L / 223) / D) · D. */
export function codewordCount(bodyLength: number, baud: BaudRate): number {
  const depth = interleaveDepth(baud)
  return Math.ceil(Math.ceil(bodyLength / MAX_DATA_BYTES) / depth) * depth
}

/** Total Tape_Record length for a header: 96 + 255·B. */
export function recordLength(header: TapeHeader): number {
  return RECORD_HEADER_BYTES + CODEWORD_BYTES * header.codewords
}

function checkBody(body: Uint8Array): void {
  if (body.length < 1 || body.length > MAX_BODY_BYTES) {
    throw new InputError('body must be 1 to 16384 bytes', body.length, 'bytes')
  }
}

/** Builds one 48-byte Header_Frame for `body`. */
function encodeHeaderFrame(body: Uint8Array, type: RecordType, baud: BaudRate): Uint8Array {
  const typeCode = TYPE_CODES[type]
  if (typeCode === undefined) throw new InputError('unsupported record type')
  const data = new Uint8Array(HEADER_DATA_BYTES)
  data[0] = MAGIC_0
  data[1] = MAGIC_1
  data[OFFSET_VERSION] = FORMAT_VERSION
  data[OFFSET_TYPE] = typeCode
  data[OFFSET_BAUD] = BAUD_CODES[baud]
  data[OFFSET_DEPTH] = interleaveDepth(baud)
  writeUint16BE(data, OFFSET_CODEWORDS, codewordCount(body.length, baud))
  writeUint16BE(data, OFFSET_LENGTH, body.length)
  writeUint32BE(data, OFFSET_BODY_CRC, crc32(body))
  writeUint16BE(data, OFFSET_HEADER_CRC, crc16(data.subarray(0, HEADER_CRC_SPAN)))
  return rsEncode(data)
}

/**
 * Frames a Body of 1 to 16,384 bytes into a Tape_Record (Requirement 3.1).
 *
 * @throws InputError if `body` is empty or longer than 16,384 bytes (Requirement 3.8)
 */
export function frame(body: Uint8Array, type: RecordType, baud: BaudRate): Uint8Array<ArrayBuffer> {
  checkBody(body)
  const depth = interleaveDepth(baud)
  const header = encodeHeaderFrame(body, type, baud)
  const codewords = codewordCount(body.length, baud)

  const out = new Uint8Array(RECORD_HEADER_BYTES + CODEWORD_BYTES * codewords)
  out.set(header, 0)
  out.set(header, HEADER_FRAME_BYTES)

  const groupBytes = CODEWORD_BYTES * depth
  const chunk = new Uint8Array(MAX_DATA_BYTES)
  for (let c = 0; c < codewords; c++) {
    // Zero padding: the last chunks may be partly or wholly past the Body.
    chunk.fill(0)
    const start = c * MAX_DATA_BYTES
    if (start < body.length) chunk.set(body.subarray(start, Math.min(start + MAX_DATA_BYTES, body.length)))
    const codeword = rsEncode(chunk)

    const g = Math.floor(c / depth)
    const j = c % depth
    const base = RECORD_HEADER_BYTES + g * groupBytes + j
    for (let i = 0; i < CODEWORD_BYTES; i++) out[base + i * depth] = codeword[i]!
  }
  return out
}

/**
 * Decodes one 48-byte Header_Frame copy for a decoder running at `baud`.
 * Returns null when the copy is unusable: Reed-Solomon fails, the magic,
 * version, or CRC-16 do not match, the record type is unknown, the baud code
 * or Interleave_Depth do not match `baud`, L is outside 1 to 16,384, or B is
 * not ceil(ceil(L / 223) / D) · D.
 *
 * @throws RangeError if `frame48` is not 48 bytes long (a programming error)
 */
export function parseHeaderFrame(frame48: Uint8Array, baud: BaudRate): TapeHeader | null {
  if (frame48.length !== HEADER_FRAME_BYTES) throw new RangeError('header frame must be 48 bytes')

  let decoded: { data: Uint8Array; corrected: number }
  try {
    decoded = rsDecode(frame48)
  } catch (error) {
    if (error instanceof UncorrectableError) return null
    throw error
  }
  const data = decoded.data

  if (data[0] !== MAGIC_0 || data[1] !== MAGIC_1 || data[OFFSET_VERSION] !== FORMAT_VERSION) return null
  if (readUint16BE(data, OFFSET_HEADER_CRC) !== crc16(data.subarray(0, HEADER_CRC_SPAN))) return null

  const typeCode = data[OFFSET_TYPE]
  let type: RecordType
  if (typeCode === TYPE_CODES.envelope) type = 'envelope'
  else if (typeCode === TYPE_CODES.shard) type = 'shard'
  else return null

  if (data[OFFSET_BAUD] !== BAUD_CODES[baud]) return null
  const depth = interleaveDepth(baud)
  if (data[OFFSET_DEPTH] !== depth) return null

  const bodyLength = readUint16BE(data, OFFSET_LENGTH)
  if (bodyLength < 1 || bodyLength > MAX_BODY_BYTES) return null
  const codewords = readUint16BE(data, OFFSET_CODEWORDS)
  if (codewords !== codewordCount(bodyLength, baud)) return null

  return {
    type,
    baud,
    interleaveDepth: depth,
    codewords,
    bodyLength,
    bodyCrc32: readUint32BE(data, OFFSET_BODY_CRC),
    correctedBytes: decoded.corrected,
  }
}

/**
 * Picks the Header_Frame copy to use from the first 96 bytes of a Tape_Record:
 * the first copy if it is usable, otherwise the second (Requirement 3.6).
 * Returns null when both copies are unusable.
 *
 * @throws RangeError if `bytes` is shorter than 96 bytes (a programming error)
 */
export function readHeader(bytes: Uint8Array, baud: BaudRate): { header: TapeHeader; copy: 1 | 2 } | null {
  if (bytes.length < RECORD_HEADER_BYTES) throw new RangeError('need both header frame copies')
  const first = parseHeaderFrame(bytes.subarray(0, HEADER_FRAME_BYTES), baud)
  if (first !== null) return { header: first, copy: 1 }
  const second = parseHeaderFrame(bytes.subarray(HEADER_FRAME_BYTES, RECORD_HEADER_BYTES), baud)
  if (second !== null) return { header: second, copy: 2 }
  return null
}

/**
 * De-interleaves and decodes one Interleave_Group of `255 · depth` bytes.
 * Returns the `223 · depth` data bytes in Codeword order, the bytes repaired,
 * and the positions (0 to depth − 1) within the group of every uncorrectable
 * Codeword. An uncorrectable Codeword contributes its received data bytes
 * unrepaired.
 *
 * @throws RangeError if `group` is not `255 · depth` bytes long (a programming error)
 */
export function decodeGroup(
  group: Uint8Array,
  depth: number,
): { data: Uint8Array<ArrayBuffer>; corrected: number; failed: number[] } {
  if (!Number.isInteger(depth) || depth < 1 || group.length !== CODEWORD_BYTES * depth) {
    throw new RangeError('group must be 255 bytes per codeword')
  }
  const data = new Uint8Array(MAX_DATA_BYTES * depth)
  const codeword = new Uint8Array(CODEWORD_BYTES)
  const failed: number[] = []
  let corrected = 0

  for (let j = 0; j < depth; j++) {
    for (let i = 0; i < CODEWORD_BYTES; i++) codeword[i] = group[i * depth + j]!
    try {
      const result = rsDecode(codeword)
      data.set(result.data, j * MAX_DATA_BYTES)
      corrected += result.corrected
    } catch (error) {
      if (!(error instanceof UncorrectableError)) throw error
      data.set(codeword.subarray(0, MAX_DATA_BYTES), j * MAX_DATA_BYTES)
      failed.push(j)
    }
  }
  return { data, corrected, failed }
}

/**
 * Rebuilds a Body one Interleave_Group at a time after a usable Header_Frame.
 * Every group is decoded even after a Codeword fails, so `finish` can list
 * every uncorrectable Codeword (Requirement 3.4).
 */
export class RecordAssembler {
  readonly header: TapeHeader
  readonly headerCopyUsed: 1 | 2
  /** Bytes in one Interleave_Group: 255 · D. */
  readonly groupBytes: number
  /** Number of Interleave_Groups: B / D. */
  readonly groupCount: number

  private readonly data: Uint8Array<ArrayBuffer>
  private readonly failed: number[] = []
  private groupsDone = 0
  private corrected: number

  constructor(header: TapeHeader, headerCopyUsed: 1 | 2) {
    this.header = header
    this.headerCopyUsed = headerCopyUsed
    this.groupBytes = CODEWORD_BYTES * header.interleaveDepth
    this.groupCount = header.codewords / header.interleaveDepth
    this.data = new Uint8Array(MAX_DATA_BYTES * header.codewords)
    this.corrected = header.correctedBytes
  }

  /** True once every Interleave_Group has been added. */
  get complete(): boolean {
    return this.groupsDone === this.groupCount
  }

  /** A snapshot of the progress so far. */
  get stats(): DecodeStats {
    return {
      bytesReceived: RECORD_HEADER_BYTES + this.groupsDone * this.groupBytes,
      bytesExpected: recordLength(this.header),
      codewords: this.header.codewords,
      correctedBytes: this.corrected,
      uncorrectableBlocks: [...this.failed],
      headerCopyUsed: this.headerCopyUsed,
    }
  }

  /**
   * Decodes the next Interleave_Group and returns the updated stats.
   *
   * @throws RangeError if the record is already complete or `group` has the wrong length
   */
  addGroup(group: Uint8Array): DecodeStats {
    if (this.complete) throw new RangeError('record already complete')
    const depth = this.header.interleaveDepth
    const result = decodeGroup(group, depth)
    const firstCodeword = this.groupsDone * depth
    this.data.set(result.data, firstCodeword * MAX_DATA_BYTES)
    this.corrected += result.corrected
    for (const j of result.failed) this.failed.push(firstCodeword + j)
    this.groupsDone++
    return this.stats
  }

  /**
   * Strips the padding and checks the CRC-32 once every group is in.
   *
   * @throws UncorrectableError listing every uncorrectable Codeword (Requirement 3.4)
   * @throws IntegrityError if the restored Body fails its CRC-32 (Requirement 3.7)
   * @throws RangeError if called before every group has been added
   */
  finish(): Uint8Array<ArrayBuffer> {
    if (!this.complete) throw new RangeError('record not complete')
    if (this.failed.length > 0) throw new UncorrectableError(this.failed)
    const body = this.data.slice(0, this.header.bodyLength)
    if (crc32(body) !== this.header.bodyCrc32) throw new IntegrityError()
    return body
  }
}

/**
 * Batch form of the Tape_Decoder's framing step: rebuilds the Body from a
 * complete Tape_Record. Bytes after the declared record length are ignored.
 *
 * @throws FormatError if both Header_Frame copies are unusable or the record
 *   is shorter than its header declares
 * @throws UncorrectableError listing every uncorrectable Codeword (Requirement 3.4)
 * @throws IntegrityError if the restored Body fails its CRC-32 (Requirement 3.7)
 */
export function unframe(
  record: Uint8Array,
  baud: BaudRate,
): { body: Uint8Array<ArrayBuffer>; header: TapeHeader; stats: DecodeStats } {
  if (record.length < RECORD_HEADER_BYTES) {
    throw new FormatError('tape record shorter than its header frames', record.length, 'bytes')
  }
  const chosen = readHeader(record, baud)
  if (chosen === null) throw new FormatError('no usable header frame')
  const { header, copy } = chosen

  const expected = recordLength(header)
  if (record.length < expected) {
    throw new FormatError('tape record shorter than declared length', record.length, 'bytes')
  }

  const assembler = new RecordAssembler(header, copy)
  for (let g = 0; g < assembler.groupCount; g++) {
    const start = RECORD_HEADER_BYTES + g * assembler.groupBytes
    assembler.addGroup(record.subarray(start, start + assembler.groupBytes))
  }
  const body = assembler.finish()
  return { body, header, stats: assembler.stats }
}
