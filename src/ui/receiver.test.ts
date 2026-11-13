import { describe, expect, it } from 'vitest'
import { UncorrectableError } from '../core/errors'
import { split } from '../shamir/shamir'
import type { DecodeStats, TapeHeader } from '../tape/framer'
import type { DecoderEvent } from '../tape/tape-decoder'
import { EMPTY_RECEIVER, receiveEvents } from './receiver'

const STATS: DecodeStats = {
  bytesReceived: 351,
  bytesExpected: 351,
  codewords: 1,
  correctedBytes: 0,
  uncorrectableBlocks: [],
  headerCopyUsed: 1,
}

const HEADER: TapeHeader = {
  type: 'shard',
  baud: 300,
  interleaveDepth: 1,
  codewords: 1,
  bodyLength: 0,
  bodyCrc32: 0,
  correctedBytes: 0,
}

const record = (body: Uint8Array): DecoderEvent => ({ type: 'record', body, header: HEADER, stats: STATS })

describe('receiveEvents with Shards (Requirements 7.9, 7.23, 7.28)', () => {
  it('keeps every Body across a failure and rebuilds the Envelope from K Shards', () => {
    const envelope = new Uint8Array(60).map((_, i) => i)
    const [one, two] = split(envelope, 2, 3)
    const failure: DecoderEvent = {
      type: 'error',
      error: new UncorrectableError([0]),
      stats: { ...STATS, uncorrectableBlocks: [0] },
    }

    let state = receiveEvents(EMPTY_RECEIVER, [record(one!)], 'Microphone')
    state = receiveEvents(state, [failure], 'Microphone')
    expect(state.bodies).toHaveLength(1)
    expect(state.notices.at(-1)).toBe('Decode failed for Microphone: Too much damage to repair: codeword 0 failed')

    state = receiveEvents(state, [record(two!)], 'shard-2.wav')
    expect(state.bodies).toHaveLength(2)
    expect(state.collection.held?.envelope).toEqual(envelope)
    expect(state.notices.at(-1)).toMatch(/^Rebuilt the vault from 2 shards of set [0-9A-F]{8}$/)
    // Decoded, failed, decoded, rebuilt: the live region finds new notices by this total.
    expect(state.noticeTotal).toBe(4)
  })
})
