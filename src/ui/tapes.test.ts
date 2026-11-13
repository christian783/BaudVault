import { describe, expect, it } from 'vitest'
import { decodeImportedWav, exportTapeWav } from '../audio/playback'
import { readUint32BE } from '../core/bytes'
import { open, PBKDF2_ITERATIONS } from '../crypto/vault'
import { modulate } from '../modem/kcs-modulator'
import { combine } from '../shamir/shamir'
import { unframe } from '../tape/framer'
import { EMPTY_RECEIVER, receiveImport } from './receiver'
import { formatDuration, lockSecret } from './tapes'

const PASSWORD = 'correct horse battery'

describe('lockSecret', () => {
  it('seals at the production iteration count and frames one vault tape without sharding', async () => {
    const plaintext = new TextEncoder().encode('seed phrase words')
    const tapes = await lockSecret(plaintext, PASSWORD, 'standard', 'none', 7)

    expect(tapes).toHaveLength(1)
    const [tape] = tapes
    expect(tape).toMatchObject({ id: 7, type: 'envelope', baud: 300, shard: null, fileName: 'baudvault-standard.wav' })

    const { body, header } = unframe(tape!.record, 300)
    expect(header.type).toBe('envelope')
    expect(readUint32BE(body, 1)).toBe(PBKDF2_ITERATIONS)
    expect(await open(body, PASSWORD)).toEqual(plaintext)
  })

  it('splits into five shard tapes for 3-of-5, any three of which rebuild the Envelope', async () => {
    const plaintext = new TextEncoder().encode('private key')
    const tapes = await lockSecret(plaintext, PASSWORD, 'turbo', '3-of-5', 1)

    expect(tapes.map((tape) => tape.id)).toEqual([1, 2, 3, 4, 5])
    expect(tapes.map((tape) => tape.shard)).toEqual([1, 2, 3, 4, 5].map((index) => ({ index, k: 3, n: 5 })))
    expect(tapes[1]).toMatchObject({ type: 'shard', baud: 2400, label: 'Shard 2 of 5' })

    const shards = tapes.map((tape) => unframe(tape.record, 2400).body)
    const envelope = combine([shards[4]!, shards[0]!, shards[2]!])
    expect(readUint32BE(envelope, 1)).toBe(PBKDF2_ITERATIONS)

    // A downloaded WAV, imported again, yields the same Shard (Requirements 4.6, 6.6, 7.19).
    const wav = exportTapeWav(modulate(tapes[3]!.record, 2400))
    const received = receiveImport(EMPTY_RECEIVER, decodeImportedWav(wav), 'shard-4.wav')
    expect(received.bodies).toHaveLength(1)
    expect(received.bodies[0]).toMatchObject({ source: 'shard-4.wav', type: 'shard', baud: 2400 })
    expect(received.bodies[0]!.body).toEqual(shards[3])
    expect(received.bodies[0]!.stats.correctedBytes).toBe(0)
  })
})

describe('receiveImport', () => {
  it('notes a file that holds no tape', () => {
    const state = receiveImport(EMPTY_RECEIVER, [], 'silence.wav')
    expect(state.bodies).toHaveLength(0)
    expect(state.notices).toEqual(['No tape found in silence.wav'])
  })
})

describe('formatDuration', () => {
  it('shows seconds under a minute and minutes above', () => {
    expect(formatDuration(7.6)).toBe('7.6 s')
    expect(formatDuration(698)).toBe('11 min 38 s')
    expect(formatDuration(59.97)).toBe('1 min 0 s')
  })
})
