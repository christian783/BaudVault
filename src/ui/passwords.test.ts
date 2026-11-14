import { describe, expect, it } from 'vitest'
import { FormatError } from '../core/errors'
import { open, seal } from '../crypto/vault'
import { EMPTY_PASSWORDS, passwordsReducer, type Passwords } from './passwords'
import { unlockFailure, unlockReadiness } from './unlock'

const LOCK = 'lock password 123'
const UNLOCK = 'unlock password 456'

function typed(lock: string, unlock: string): Passwords {
  let state = passwordsReducer(EMPTY_PASSWORDS, { type: 'lock-changed', password: lock })
  state = passwordsReducer(state, { type: 'unlock-changed', password: unlock })
  return state
}

describe('passwordsReducer: separate Lock and Unlock fields (Requirements 7.23, 7.29)', () => {
  it('starts with both fields empty', () => {
    expect(EMPTY_PASSWORDS).toEqual({ lock: '', unlock: '' })
  })

  it('never prefills the Unlock password from the Lock Password', () => {
    const state = passwordsReducer(EMPTY_PASSWORDS, { type: 'lock-changed', password: LOCK })
    expect(state).toEqual({ lock: LOCK, unlock: '' })
    expect(passwordsReducer(state, { type: 'unlock-changed', password: UNLOCK })).toEqual({ lock: LOCK, unlock: UNLOCK })
  })

  it('Unlock readiness follows the Unlock password, not the Lock Password', () => {
    const lockOnly = passwordsReducer(EMPTY_PASSWORDS, { type: 'lock-changed', password: LOCK })
    expect(unlockReadiness(true, lockOnly.unlock, false)).toEqual({
      ready: false,
      problem: 'Enter the unlock password to unlock.',
    })
    expect(unlockReadiness(true, typed('', UNLOCK).unlock, false)).toEqual({ ready: true, problem: null })
  })

  it('opens with the Unlock password even when the Lock Password field holds something else', async () => {
    const envelope = await seal(new TextEncoder().encode('seed words'), UNLOCK, { iterations: 1_000 })
    const state = typed('a different lock password', UNLOCK)
    const plaintext = await open(envelope, state.unlock)
    expect(new TextDecoder().decode(plaintext)).toBe('seed words')
  })
})

describe('passwordsReducer: clearing the Unlock password (Requirements 7.13, 7.24)', () => {
  it('empties only the Unlock password after an AuthenticationError', async () => {
    const envelope = await seal(new TextEncoder().encode('seed words'), LOCK, { iterations: 1_000 })
    const state = typed(LOCK, 'wrong unlock password')
    const error = await open(envelope, state.unlock).catch((caught: unknown) => caught)
    const after = passwordsReducer(state, { type: 'unlock-failed', failure: unlockFailure(error) })
    expect(after).toEqual({ lock: LOCK, unlock: '' })
  })

  it('keeps the Unlock password after a failure that is not an AuthenticationError', () => {
    const state = typed(LOCK, UNLOCK)
    const failure = unlockFailure(new FormatError('envelope shorter than', 50, 'bytes'))
    expect(passwordsReducer(state, { type: 'unlock-failed', failure })).toBe(state)
  })

  it('Clear empties both fields', () => {
    expect(passwordsReducer(typed(LOCK, UNLOCK), { type: 'cleared' })).toEqual({ lock: '', unlock: '' })
  })
})
