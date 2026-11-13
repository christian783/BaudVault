// Folds Tape_Decoder events into the list of decoded Bodies, the Shard
// collection, and the held Envelope (Requirements 6.2, 6.6, 7.9, 7.19, 7.23,
// 7.28). DOM-free and pure, so it can run inside a React state updater.
//
// A Body is an Envelope or a Shard, which is ciphertext. Notices name the
// source (a file name, "Microphone", or a tape label), the record type, and
// safe numbers; never any Body bytes. A decode or combine failure adds a
// notice and leaves every Body decoded before it in place (Requirement 7.28).

import type { DecoderEvent } from '../tape/tape-decoder'
import type { BaudRate, DecodeStats, RecordType } from '../tape/framer'
import { errorText } from './messages'
import { collectBody, EMPTY_COLLECTION, type ShardCollection } from './shard-collection'

export type DecodedBody = {
  id: number
  /** Where the audio came from. */
  source: string
  type: RecordType
  baud: BaudRate
  body: Uint8Array
  stats: DecodeStats
}

export type ReceiverState = {
  bodies: readonly DecodedBody[]
  /** Shards grouped by set ID, and the Envelope ready to unlock. */
  collection: ShardCollection
  /** The most recent results, newest last. */
  notices: readonly string[]
  /**
   * Notices added since the state was created, including those dropped from
   * `notices`. The live region compares it with the last value it saw to
   * find the new notices (Requirement 9.5).
   */
  noticeTotal: number
  nextId: number
}

export const MAX_NOTICES = 5

export const EMPTY_RECEIVER: ReceiverState = {
  bodies: [],
  collection: EMPTY_COLLECTION,
  notices: [],
  noticeTotal: 0,
  nextId: 1,
}

const TYPE_NAMES: Readonly<Record<RecordType, string>> = { envelope: 'vault tape', shard: 'shard' }

function addNotice(state: ReceiverState, notice: string): ReceiverState {
  return { ...state, notices: [...state.notices, notice].slice(-MAX_NOTICES), noticeTotal: state.noticeTotal + 1 }
}

/** Adds a decoded Body to `bodies` and the collection, with notices for what happened. */
function receiveRecord(state: ReceiverState, event: Extract<DecoderEvent, { type: 'record' }>, source: string): ReceiverState {
  const { header, stats } = event
  const decoded: DecodedBody = { id: state.nextId, source, type: header.type, baud: header.baud, body: event.body, stats }
  let next = addNotice(
    state,
    `Decoded ${TYPE_NAMES[header.type]} from ${source}: ${event.body.length} bytes, ${stats.correctedBytes} bytes corrected`,
  )
  const { collection, outcome } = collectBody(state.collection, header.type, event.body, source)
  if (outcome.kind === 'rebuilt' && collection.held !== null) {
    next = addNotice(next, `Rebuilt the vault from ${collection.held.origin}`)
  } else if (outcome.kind === 'failed') {
    next = addNotice(next, `Shard from ${source} not used: ${errorText(outcome.error)}`)
  }
  return { ...next, bodies: [...state.bodies, decoded], collection, nextId: state.nextId + 1 }
}

/**
 * Adds every `record` to `bodies` and the collection, and a notice for each
 * `record` and `error`. Returns `state` itself when no event changes it, so
 * React can skip the render.
 */
export function receiveEvents(state: ReceiverState, events: readonly DecoderEvent[], source: string): ReceiverState {
  let next = state
  for (const event of events) {
    if (event.type === 'record') {
      next = receiveRecord(next, event, source)
    } else if (event.type === 'error') {
      next = addNotice(next, `Decode failed for ${source}: ${errorText(event.error)}`)
    }
  }
  return next
}

/** Like `receiveEvents` for a whole imported file, adding a notice when the file held no tape. */
export function receiveImport(state: ReceiverState, events: readonly DecoderEvent[], source: string): ReceiverState {
  const found = events.some((event) => event.type === 'record' || event.type === 'error')
  if (!found) return addNotice(state, `No tape found in ${source}`)
  return receiveEvents(state, events, source)
}

/** Records a failure to read or parse a source, such as an unsupported WAV file. */
export function receiveFailure(state: ReceiverState, source: string, error: unknown): ReceiverState {
  return addNotice(state, `Could not read ${source}: ${errorText(error)}`)
}
