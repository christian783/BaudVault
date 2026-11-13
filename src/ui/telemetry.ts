// Telemetry readout state (Requirements 7.7, 7.8). DOM-free and pure, so it
// can run inside a React state updater.
//
// - `header` starts a record: bytes received is the 96 header bytes, bytes
//   expected is 96 + 255·B.
// - `progress` (once per Interleave_Group) updates the running counts.
// - `record` and `error` end the record with the totals: corrected bytes,
//   Codewords, and uncorrectable Codewords.
// - `halt` (the source stopped mid-record) keeps the counts reached so far.
//
// Only safe numbers are kept; never any Body bytes.

import { RECORD_HEADER_BYTES, recordLength, type BaudRate } from '../tape/framer'
import type { DecoderEvent } from '../tape/tape-decoder'

export type TelemetryPhase = 'idle' | 'decoding' | 'recovered' | 'failed' | 'stopped'

export type Telemetry = {
  readonly phase: TelemetryPhase
  /** Rate of the current or last record, or null before the first header. */
  readonly baud: BaudRate | null
  readonly bytesReceived: number
  readonly bytesExpected: number
  readonly correctedBytes: number
  /** Codeword count B of the current or last record. */
  readonly codewords: number
  /** Uncorrectable Codewords found by the end of the record. */
  readonly uncorrectableCodewords: number
}

export type TelemetryAction = DecoderEvent | { type: 'halt' }

export const IDLE_TELEMETRY: Telemetry = {
  phase: 'idle',
  baud: null,
  bytesReceived: 0,
  bytesExpected: 0,
  correctedBytes: 0,
  codewords: 0,
  uncorrectableCodewords: 0,
}

/** Applies one decoder event or `halt`. Returns `state` itself when nothing changes. */
export function reduceTelemetry(state: Telemetry, action: TelemetryAction): Telemetry {
  switch (action.type) {
    case 'header':
      return {
        phase: 'decoding',
        baud: action.header.baud,
        bytesReceived: RECORD_HEADER_BYTES,
        bytesExpected: recordLength(action.header),
        // Bytes repaired in the Header_Frame copy used count from the start.
        correctedBytes: action.header.correctedBytes,
        codewords: action.header.codewords,
        uncorrectableCodewords: 0,
      }
    case 'progress':
      if (state.phase !== 'decoding') return state
      return {
        ...state,
        bytesReceived: action.bytesReceived,
        bytesExpected: action.bytesExpected,
        correctedBytes: action.correctedBytes,
      }
    case 'record':
    case 'error': {
      const { stats } = action
      return {
        phase: action.type === 'record' ? 'recovered' : 'failed',
        baud: state.baud,
        bytesReceived: stats.bytesReceived,
        bytesExpected: stats.bytesExpected,
        correctedBytes: stats.correctedBytes,
        codewords: stats.codewords,
        uncorrectableCodewords: stats.uncorrectableBlocks.length,
      }
    }
    case 'halt':
      return state.phase === 'decoding' ? { ...state, phase: 'stopped' } : state
    default:
      return state
  }
}

/** Applies a batch of events in order. Returns `state` itself when nothing changes. */
export function telemetryFromEvents(state: Telemetry, events: readonly TelemetryAction[]): Telemetry {
  let next = state
  for (const event of events) next = reduceTelemetry(next, event)
  return next
}

const count = (value: number) => value.toLocaleString('en-US')

/** One labelled line of the readout. */
export type ReadoutLine = { readonly label: string; readonly value: string }

/** Text lines for the readout. All state is spelled out, never shown by color alone (Requirement 9.6). */
export function telemetryLines(state: Telemetry): ReadoutLine[] {
  const rate = state.baud === null ? '' : `, ${count(state.baud)} baud`
  switch (state.phase) {
    case 'idle':
      return [{ label: 'Status', value: 'Waiting for a tape' }]
    case 'decoding':
    case 'stopped':
      return [
        { label: 'Status', value: (state.phase === 'decoding' ? 'Decoding' : 'Stopped before the end') + rate },
        { label: 'Bytes', value: `${count(state.bytesReceived)} of ${count(state.bytesExpected)} received` },
        { label: 'Corrected', value: `${count(state.correctedBytes)} bytes so far` },
      ]
    case 'recovered':
    case 'failed':
      return [
        { label: 'Status', value: (state.phase === 'recovered' ? 'Tape recovered' : 'Tape failed') + rate },
        { label: 'Bytes', value: `${count(state.bytesReceived)} of ${count(state.bytesExpected)} received` },
        { label: 'Corrected', value: `${count(state.correctedBytes)} bytes in total` },
        { label: 'Codewords', value: `${count(state.codewords)}, ${count(state.uncorrectableCodewords)} uncorrectable` },
      ]
  }
}
