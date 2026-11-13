import { describe, expect, it } from 'vitest'
import { open, seal } from '../crypto/vault'
import { FormatError } from '../core/errors'
import { NULL_CHARACTER_MESSAGE } from './record-rules'
import { revealText, SECRET_MASK, unlockFailure, unlockReadiness, wipePlaintext } from './unlock'

describe('unlockReadiness (Requirements 1.9, 7.23, 7.27)', () => {
  it('needs a held Envelope and a usable Password', () => {
    expect(unlockReadiness(false, 'pw', false).ready).toBe(false)
    expect(unlockReadiness(true, '', false).ready).toBe(false)
    expect(unlockReadiness(true, 'a\u0000', false)).toEqual({ ready: false, problem: NULL_CHARACTER_MESSAGE })
    expect(unlockReadiness(true, 'pw', false)).toEqual({ ready: true, problem: null })
  })

  it('is disabled with the feature message when the browser cannot open (Requirement 10.2)', () => {
    const unavailable = 'Unlock is unavailable because Web Crypto (crypto.subtle) is missing.'
    expect(unlockReadiness(true, 'pw', false, unavailable)).toEqual({ ready: false, problem: unavailable })
    expect(unlockReadiness(false, 'pw', false, unavailable)).toEqual({ ready: false, problem: unavailable })
  })

  it('is disabled while a seal or open runs', () => {
    expect(unlockReadiness(true, 'pw', true)).toEqual({ ready: false, problem: null })
  })
})

describe('unlockFailure (Requirement 7.24)', () => {
  it('clears the Password only after a wrong Password', async () => {
    const envelope = await seal(new TextEncoder().encode('seed words'), 'right password', { iterations: 1_000 })
    const error = await open(envelope, 'wrong password').catch((caught: unknown) => caught)
    expect(unlockFailure(error)).toEqual({ message: 'Wrong password or damaged tape', clearPassword: true })
    expect(unlockFailure(new FormatError('envelope shorter than', 50, 'bytes')).clearPassword).toBe(false)
  })
})

describe('recovered secret (Requirements 7.12, 7.13)', () => {
  it('decodes only on Reveal, and the mask carries no length', async () => {
    const envelope = await seal(new TextEncoder().encode('ünïcode ✓'), 'pw', { iterations: 1_000 })
    const plaintext = await open(envelope, 'pw')
    expect(revealText(plaintext)).toBe('ünïcode ✓')
    expect(SECRET_MASK).not.toContain('ü')
    expect([...SECRET_MASK].every((char) => char === '•')).toBe(true)
  })

  it('wipePlaintext overwrites every byte with zero', () => {
    const a = Uint8Array.of(1, 2, 3)
    const b = Uint8Array.of(9)
    wipePlaintext(a, null, b)
    expect([...a, ...b]).toEqual([0, 0, 0, 0])
  })
})
