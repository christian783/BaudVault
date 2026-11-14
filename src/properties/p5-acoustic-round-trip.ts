// Property 5: Acoustic round trip (design.md, "Correctness Properties").
//
// For any Body of 1 to 32 bytes, demodulating the modulated Tape_Record
// returns the original Body with zero corrected bytes at both 300 and 2,400
// baud. In Standard_Mode and in Turbo_Mode the Body also comes back unchanged
// after passing through the Virtual_Tape_Channel with any Hiss_Level from 0% to
// 30%, any Wow_Level from 0% to 2%, and any seed.
//
// Each run picks one of four channel cases to keep the run time down
// (design.md, "Testing Strategy"): clean 300 baud, clean 2,400 baud, Standard
// through the Virtual_Tape_Channel, and Turbo through the Virtual_Tape_Channel.
// The decoder runs with a fixed baud; auto-detection has its own tests in
// `src/tape` and `src/channel`. The channel reduces the seed to its low 32
// bits, so the full 32-bit integer range covers every distinct seed. Test
// Bodies are random data, never real secrets.
//
// The 200 runs are split across P5_PARTS test files of P5_RUNS_PER_PART runs
// each, so Vitest runs them on separate workers. Every part draws from the
// same arbitraries, including the four-case mix, so the split changes only the
// wall time, not what the property covers.
//
// **Validates: Requirements 4.1, 4.2, 4.3, 4.4, 4.5, 5.1, 5.2, 5.7, 6.3, 6.5**

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { applyTapeChannel, type TapeChannelSettings } from '../channel/virtual-tape'
import { type BaudRate, modulate, SAMPLE_RATE } from '../modem/kcs-modulator'
import { frame, type RecordType } from '../tape/framer'
import { type DecoderEvent, TapeDecoder } from '../tape/tape-decoder'

/** Total runs of Property 5 (design.md, "Testing Strategy": 200 runs each). */
export const P5_TOTAL_RUNS = 200
/** Number of test files the runs are split across. */
export const P5_PARTS = 4
/** Runs in each part; P5_PARTS * P5_RUNS_PER_PART equals P5_TOTAL_RUNS. */
export const P5_RUNS_PER_PART = P5_TOTAL_RUNS / P5_PARTS

/** Largest Body this property covers (design.md, Property 5). */
const MAX_PROPERTY_BODY_BYTES = 32
/** Highest Hiss_Level and Wow_Level the recovery guarantee covers (Requirement 6.5). */
const MAX_GUARANTEED_HISS = 0.3
const MAX_GUARANTEED_WOW = 0.02

const TIMEOUT_MS = 120_000

const bodyArb = fc.uint8Array({ minLength: 1, maxLength: MAX_PROPERTY_BODY_BYTES })
const typeArb = fc.constantFrom<RecordType>('envelope', 'shard')
const baudArb = fc.constantFrom<BaudRate>(300, 2400)

const channelArb: fc.Arbitrary<TapeChannelSettings> = fc.record({
  hiss: fc.double({ min: 0, max: MAX_GUARANTEED_HISS, noNaN: true }),
  wow: fc.double({ min: 0, max: MAX_GUARANTEED_WOW, noNaN: true }),
  seed: fc.integer(),
})

/** One of the four channel cases: clean at either rate, or through the tape at either rate. */
const pathArb = fc.oneof(
  fc.record({ baud: baudArb, channel: fc.constant(null) }),
  fc.record({ baud: baudArb, channel: channelArb }),
)

/** Decodes the whole tape in one push; the decoder's events do not depend on chunking. */
function decode(samples: Float32Array, baud: BaudRate): DecoderEvent[] {
  return new TapeDecoder({ sampleRate: SAMPLE_RATE, baud }).push(samples)
}

/** Registers part `part` (1 to P5_PARTS) of Property 5 with P5_RUNS_PER_PART runs. */
export function describeAcousticRoundTrip(part: number): void {
  describe(`Property 5: Acoustic round trip (part ${part} of ${P5_PARTS})`, () => {
    it(
      'recovers the Body from clean audio with zero corrected bytes, and through the Virtual_Tape_Channel',
      () => {
        fc.assert(
          fc.property(bodyArb, typeArb, pathArb, (body, type, { baud, channel }) => {
            const tape = modulate(frame(body, type, baud), baud)
            const audio = channel === null ? tape : applyTapeChannel(tape, SAMPLE_RATE, channel)
            const events = decode(audio, baud)

            const errors = events.flatMap((event) => (event.type === 'error' ? [event.error.code] : []))
            expect(errors).toEqual([])
            const records = events.flatMap((event) => (event.type === 'record' ? [event] : []))
            expect(records).toHaveLength(1)

            const { body: restored, header, stats } = records[0]!
            expect(header.type).toBe(type)
            expect(header.baud).toBe(baud)
            expect(restored).toEqual(body)
            expect(stats.uncorrectableBlocks).toEqual([])
            if (channel === null) expect(stats.correctedBytes).toBe(0)
          }),
          { numRuns: P5_RUNS_PER_PART },
        )
      },
      TIMEOUT_MS,
    )
  })
}
