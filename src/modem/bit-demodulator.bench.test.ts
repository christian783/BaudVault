import { describe, expect, it } from 'vitest'
import { demodulateBytes } from './bit-demodulator'
import { modulate, SAMPLE_RATE } from './kcs-modulator'

// Speed check for the 300-baud demodulator (design.md, "Testing Strategy",
// Budget; Requirement 5.2). Property 5 decodes about 2,000 seconds of
// 300-baud audio, so the demodulator must run at least 200 times faster than
// real time for `npm test` to stay under 15 seconds.

/** Required speed: seconds of audio demodulated per second of wall time. */
const MIN_SPEEDUP = 200
/** 400 bytes give about 17.2 s of audio (760,000 samples), close to one P5 case. */
const RECORD_BYTES = 400
/**
 * Timed runs after the warm-up. Timer noise and GC pauses only ever add time,
 * so the fastest run is the best estimate. The `bench` project in
 * vite.config.ts runs this file alone, after the unit tests, so other test
 * files do not compete for the CPU.
 */
const TIMED_RUNS = 3

describe('bit demodulator speed', () => {
  // Deterministic bytes that exercise every bit pattern, including 0x00 and 0xFF.
  const record = new Uint8Array(RECORD_BYTES).map((_, i) => (i * 167 + 13) & 0xff)
  record[0] = 0x00
  record[1] = 0xff

  it(`demodulates 300-baud audio at least ${MIN_SPEEDUP} times faster than real time`, ({ annotate }) => {
    const samples = modulate(record, 300)
    const audioSeconds = samples.length / SAMPLE_RATE

    // Warm-up so JIT compilation does not count against the timed runs. Each
    // run's output is checked, so the work cannot be skipped.
    expect(demodulateBytes(samples, SAMPLE_RATE, 300, record.length)).toEqual(record)

    let bestMs = Infinity
    for (let run = 0; run < TIMED_RUNS; run++) {
      const start = performance.now()
      const bytes = demodulateBytes(samples, SAMPLE_RATE, 300, record.length)
      const elapsed = performance.now() - start
      expect(bytes).toEqual(record)
      if (elapsed < bestMs) bestMs = elapsed
    }

    // Guard against a zero reading on a coarse timer.
    const speedup = audioSeconds / (Math.max(bestMs, 0.001) / 1_000)
    const summary =
      `${audioSeconds.toFixed(1)} s of audio in ${bestMs.toFixed(1)} ms ` +
      `(${Math.round(speedup)}x real time, best of ${TIMED_RUNS} runs)`
    annotate(summary)
    expect(speedup, `demodulator too slow: ${summary}, need ${MIN_SPEEDUP}x`).toBeGreaterThanOrEqual(MIN_SPEEDUP)
  })
})
