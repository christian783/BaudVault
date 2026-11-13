import { describe, expect, it } from 'vitest'
import { UncorrectableError } from '../core/errors'
import { modulate, SAMPLE_RATE } from '../modem/kcs-modulator'
import { frame, type DecodeStats, type TapeHeader } from '../tape/framer'
import { type DecoderEvent, TapeDecoder } from '../tape/tape-decoder'
import { IDLE_TELEMETRY, reduceTelemetry, type Telemetry, telemetryFromEvents, telemetryLines } from './telemetry'

function decodeTape(record: Uint8Array, baud: 300 | 2400): DecoderEvent[] {
  const samples = modulate(record, baud)
  const decoder = new TapeDecoder({ sampleRate: SAMPLE_RATE })
  const events: DecoderEvent[] = []
  for (let at = 0; at < samples.length; at += 2_048) events.push(...decoder.push(samples.subarray(at, at + 2_048)))
  return events
}

const HEADER: TapeHeader = {
  type: 'envelope',
  baud: 2400,
  interleaveDepth: 4,
  codewords: 8,
  bodyLength: 900,
  bodyCrc32: 0,
  correctedBytes: 2,
}

const stats = (over: Partial<DecodeStats>): DecodeStats => ({
  bytesReceived: 96,
  bytesExpected: 2_136,
  codewords: 8,
  correctedBytes: 0,
  uncorrectableBlocks: [],
  headerCopyUsed: 1,
  ...over,
})

describe('telemetry from a decoded tape (Requirements 7.7, 7.8)', () => {
  it('tracks bytes per Interleave_Group, then reports the totals', () => {
    // 900 bytes at 2,400 baud: 8 Codewords in 2 groups, 96 + 2,040 = 2,136 bytes.
    const body = new Uint8Array(900).map((_, i) => (i * 37 + 5) & 0xff)
    const events = decodeTape(frame(body, 'envelope', 2400), 2400)

    const seen: Telemetry[] = []
    let state = IDLE_TELEMETRY
    for (const event of events) {
      const next = reduceTelemetry(state, event)
      if (next !== state) seen.push(next)
      state = next
    }

    expect(seen.map((t) => [t.phase, t.bytesReceived, t.bytesExpected])).toEqual([
      ['decoding', 96, 2_136],
      ['decoding', 96 + 1_020, 2_136],
      ['decoding', 2_136, 2_136],
      ['recovered', 2_136, 2_136],
    ])
    expect(state).toEqual({
      phase: 'recovered',
      baud: 2400,
      bytesReceived: 2_136,
      bytesExpected: 2_136,
      correctedBytes: 0,
      codewords: 8,
      uncorrectableCodewords: 0,
    })
  })
})

describe('reduceTelemetry', () => {
  const decoding = reduceTelemetry(IDLE_TELEMETRY, { type: 'header', header: HEADER })

  it('starts a record at the header with 96 of 96 + 255·B bytes', () => {
    expect(decoding).toMatchObject({
      phase: 'decoding',
      baud: 2400,
      bytesReceived: 96,
      bytesExpected: 2_136,
      correctedBytes: 2,
      codewords: 8,
    })
  })

  it('counts uncorrectable Codewords from an error event', () => {
    const error = new UncorrectableError([1, 6])
    const failed = reduceTelemetry(decoding, {
      type: 'error',
      error,
      stats: stats({ bytesReceived: 2_136, correctedBytes: 40, uncorrectableBlocks: [1, 6] }),
    })
    expect(failed).toMatchObject({ phase: 'failed', correctedBytes: 40, codewords: 8, uncorrectableCodewords: 2 })
  })

  it('marks a record stopped mid-way on halt and ignores halt otherwise', () => {
    const progressed = reduceTelemetry(decoding, { type: 'progress', bytesReceived: 1_116, bytesExpected: 2_136, correctedBytes: 3 })
    expect(reduceTelemetry(progressed, { type: 'halt' })).toEqual({ ...progressed, phase: 'stopped' })
    expect(reduceTelemetry(IDLE_TELEMETRY, { type: 'halt' })).toBe(IDLE_TELEMETRY)
  })

  it('returns the same state for events that change nothing', () => {
    expect(telemetryFromEvents(IDLE_TELEMETRY, [{ type: 'lock', baud: 300 }, { type: 'unlock' }])).toBe(IDLE_TELEMETRY)
    expect(
      reduceTelemetry(IDLE_TELEMETRY, { type: 'progress', bytesReceived: 1, bytesExpected: 2, correctedBytes: 0 }),
    ).toBe(IDLE_TELEMETRY)
  })
})

describe('telemetryLines', () => {
  it('spells out progress and totals as text', () => {
    expect(telemetryLines(IDLE_TELEMETRY)).toEqual([{ label: 'Status', value: 'Waiting for a tape' }])

    const finished: Telemetry = {
      phase: 'recovered',
      baud: 2400,
      bytesReceived: 19_476,
      bytesExpected: 19_476,
      correctedBytes: 31,
      codewords: 76,
      uncorrectableCodewords: 0,
    }
    expect(telemetryLines(finished)).toEqual([
      { label: 'Status', value: 'Tape recovered, 2,400 baud' },
      { label: 'Bytes', value: '19,476 of 19,476 received' },
      { label: 'Corrected', value: '31 bytes in total' },
      { label: 'Codewords', value: '76, 0 uncorrectable' },
    ])

    expect(telemetryLines({ ...finished, phase: 'decoding', bytesReceived: 1_116 })).toEqual([
      { label: 'Status', value: 'Decoding, 2,400 baud' },
      { label: 'Bytes', value: '1,116 of 19,476 received' },
      { label: 'Corrected', value: '31 bytes so far' },
    ])
  })
})
