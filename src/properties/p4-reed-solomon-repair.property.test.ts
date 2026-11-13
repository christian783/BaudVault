// Property 4: Reed-Solomon repairs bounded damage (design.md, "Correctness Properties").
//
// For any Body of 1 to 4,096 bytes, either baud rate, and either damage
// pattern, unframing the damaged Tape_Record returns the original Body, and
// `correctedBytes` equals the number of bytes that were changed in the
// Header_Frame copy used plus all Codewords. The two damage patterns are:
// - (a) up to 16 changed bytes in each Codeword and in the first Header_Frame
//   copy, at random positions with random non-zero XOR masks;
// - (b) a single burst of up to 16 × D consecutive changed bytes anywhere in
//   the data section.
//
// Pattern (a) also damages the first Header_Frame copy beyond repair in some
// runs (17 to 32 changed bytes), so the second copy is used (Requirement 3.6),
// and adds up to 16 changed bytes to the second copy in every run. Only the
// copy used counts toward `correctedBytes`.
//
// **Validates: Requirements 3.1, 3.2, 3.3, 3.5, 3.6**

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  type BaudRate,
  CODEWORD_BYTES,
  codewordCount,
  frame,
  HEADER_FRAME_BYTES,
  interleaveDepth,
  RECORD_HEADER_BYTES,
  type RecordType,
  unframe,
} from '../tape/framer'

/** Largest Body this property covers (design.md, Property 4). */
const MAX_PROPERTY_BODY_BYTES = 4_096

/** Byte errors one Codeword or Header_Frame can carry and still be repaired. */
const MAX_REPAIRABLE = 16

/** First-copy damage that is always beyond repair: more than 16 changed bytes. */
const MIN_UNREPAIRABLE = MAX_REPAIRABLE + 1
const MAX_UNREPAIRABLE = 32

const TIMEOUT_MS = 60_000

/** Body of 1 to 4,096 bytes, biased toward small sizes to keep the suite fast. */
const bodyArb = fc.oneof(
  { arbitrary: fc.uint8Array({ minLength: 1, maxLength: 256 }), weight: 6 },
  { arbitrary: fc.uint8Array({ minLength: 1, maxLength: MAX_PROPERTY_BODY_BYTES }), weight: 3 },
  {
    arbitrary: fc.uint8Array({ minLength: MAX_PROPERTY_BODY_BYTES, maxLength: MAX_PROPERTY_BODY_BYTES }),
    weight: 1,
  },
)

const baudArb = fc.constantFrom<BaudRate>(300, 2400)
const typeArb = fc.constantFrom<RecordType>('envelope', 'shard')

/** A non-zero XOR mask, so every damaged byte really changes. */
const maskArb = fc.integer({ min: 1, max: 255 })

type Damage = { pos: number; mask: number }

/** `min` to `max` changes at distinct positions in a block of `blockBytes` bytes. */
function damageArb(blockBytes: number, min: number, max: number): fc.Arbitrary<Damage[]> {
  return fc.uniqueArray(fc.record({ pos: fc.integer({ min: 0, max: blockBytes - 1 }), mask: maskArb }), {
    minLength: min,
    maxLength: max,
    selector: (d) => d.pos,
    size: 'max',
  })
}

/** Record offset of byte `i` of Codeword `c` under the interleave layout (design.md, "Tape_Record"). */
function codewordByteOffset(c: number, i: number, depth: number): number {
  const g = Math.floor(c / depth)
  const j = c % depth
  return RECORD_HEADER_BYTES + g * CODEWORD_BYTES * depth + i * depth + j
}

/** Pattern (a): per-block damage for both Header_Frame copies and every Codeword. */
const scatteredArb = fc.tuple(bodyArb, baudArb, typeArb).chain(([body, baud, type]) =>
  fc.record({
    body: fc.constant(body),
    baud: fc.constant(baud),
    type: fc.constant(type),
    firstHeader: fc.oneof(
      { arbitrary: damageArb(HEADER_FRAME_BYTES, 0, MAX_REPAIRABLE), weight: 3 },
      { arbitrary: damageArb(HEADER_FRAME_BYTES, MIN_UNREPAIRABLE, MAX_UNREPAIRABLE), weight: 1 },
    ),
    secondHeader: damageArb(HEADER_FRAME_BYTES, 0, MAX_REPAIRABLE),
    codewords: fc.array(damageArb(CODEWORD_BYTES, 0, MAX_REPAIRABLE), {
      minLength: codewordCount(body.length, baud),
      maxLength: codewordCount(body.length, baud),
    }),
  }),
)

/** Pattern (b): one burst of 1 to 16·D consecutive changed bytes inside the data section. */
const burstArb = fc.tuple(bodyArb, baudArb, typeArb).chain(([body, baud, type]) => {
  const dataBytes = CODEWORD_BYTES * codewordCount(body.length, baud)
  const maxBurst = MAX_REPAIRABLE * interleaveDepth(baud)
  return fc.integer({ min: 1, max: maxBurst }).chain((length) =>
    fc.record({
      body: fc.constant(body),
      baud: fc.constant(baud),
      type: fc.constant(type),
      start: fc.integer({ min: RECORD_HEADER_BYTES, max: RECORD_HEADER_BYTES + dataBytes - length }),
      masks: fc.array(maskArb, { minLength: length, maxLength: length }),
    }),
  )
})

describe('Property 4: Reed-Solomon repairs bounded damage', () => {
  it(
    'restores the Body from up to 16 changed bytes per Codeword and Header_Frame copy',
    () => {
      fc.assert(
        fc.property(scatteredArb, ({ body, baud, type, firstHeader, secondHeader, codewords }) => {
          const record = frame(body, type, baud)
          const depth = interleaveDepth(baud)
          expect(record.length).toBe(RECORD_HEADER_BYTES + CODEWORD_BYTES * codewords.length)

          for (const { pos, mask } of firstHeader) record[pos]! ^= mask
          for (const { pos, mask } of secondHeader) record[HEADER_FRAME_BYTES + pos]! ^= mask
          let codewordChanges = 0
          codewords.forEach((damage, c) => {
            for (const { pos, mask } of damage) record[codewordByteOffset(c, pos, depth)]! ^= mask
            codewordChanges += damage.length
          })

          const firstUsable = firstHeader.length <= MAX_REPAIRABLE
          const headerChanges = firstUsable ? firstHeader.length : secondHeader.length

          const { body: restored, stats } = unframe(record, baud)
          expect(restored).toEqual(body)
          expect(stats.headerCopyUsed).toBe(firstUsable ? 1 : 2)
          expect(stats.uncorrectableBlocks).toEqual([])
          expect(stats.correctedBytes).toBe(headerChanges + codewordChanges)
        }),
        { numRuns: 200 },
      )
    },
    TIMEOUT_MS,
  )

  it(
    'restores the Body from one burst of up to 16 × D consecutive changed bytes in the data section',
    () => {
      fc.assert(
        fc.property(burstArb, ({ body, baud, type, start, masks }) => {
          const record = frame(body, type, baud)
          masks.forEach((mask, k) => {
            record[start + k]! ^= mask
          })

          const { body: restored, stats } = unframe(record, baud)
          expect(restored).toEqual(body)
          expect(stats.headerCopyUsed).toBe(1)
          expect(stats.uncorrectableBlocks).toEqual([])
          expect(stats.correctedBytes).toBe(masks.length)
        }),
        { numRuns: 200 },
      )
    },
    TIMEOUT_MS,
  )
})
