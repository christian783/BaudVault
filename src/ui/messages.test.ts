import { describe, expect, it } from 'vitest'
import {
  AuthenticationError,
  FormatError,
  InputError,
  IntegrityError,
  ShardError,
  UncorrectableError,
} from '../core/errors'
import { frame, unframe } from '../tape/framer'
import { ERROR_MESSAGES, errorText, UNEXPECTED_ERROR_MESSAGE } from './messages'

describe('errorText (design.md, "Error display")', () => {
  it('maps every error code to its message and safe detail', () => {
    expect(errorText(new AuthenticationError())).toBe('Wrong password or damaged tape')
    expect(errorText(new FormatError('unsupported sample rate', 8000, 'Hz'))).toBe(
      'Unreadable file or tape format: unsupported sample rate 8000 Hz',
    )
    expect(errorText(new UncorrectableError([3, 7]))).toBe('Too much damage to repair: codewords 3, 7 failed')
    expect(errorText(new UncorrectableError([0]))).toBe('Too much damage to repair: codeword 0 failed')
    expect(errorText(new UncorrectableError())).toBe('Too much damage to repair')
    expect(errorText(new IntegrityError())).toBe('Integrity check failed after repair')
    expect(errorText(new ShardError('too-few', 1))).toBe('Shards do not combine: need 1 more shard')
    expect(errorText(new ShardError('different-set'))).toBe('Shards do not combine: shards come from different sets')
    expect(errorText(new InputError('plaintext must be 1 to 15360 bytes'))).toBe(
      'Input outside the allowed limits: plaintext must be 1 to 15360 bytes',
    )
  })

  it('never shows the text of an error it does not control', () => {
    expect(errorText(new Error('hunter2'))).toBe(UNEXPECTED_ERROR_MESSAGE)
    expect(errorText('hunter2')).toBe(UNEXPECTED_ERROR_MESSAGE)
  })

  it('treats look-alikes of BaudVault errors as unexpected', () => {
    // Same shape or name as a BaudVaultError, but not an instance of one.
    const lookAlikes: unknown[] = [
      { code: 'FORMAT', message: 'hunter2' },
      Object.assign(new Error('hunter2'), { name: 'FormatError', code: 'FORMAT' }),
      new TypeError('hunter2'),
      new RangeError('hunter2'),
      null,
      undefined,
      42,
    ]
    for (const error of lookAlikes) expect(errorText(error)).toBe(UNEXPECTED_ERROR_MESSAGE)
  })

  it('names a distinct failure type for each decode and combine failure (Requirement 7.28)', () => {
    const failures = [
      new FormatError('shard too short', 3, 'bytes'),
      new UncorrectableError([2]),
      new IntegrityError(),
      new ShardError('duplicate-index'),
    ]
    const texts = failures.map(errorText)
    for (const [i, error] of failures.entries()) expect(texts[i]!.startsWith(ERROR_MESSAGES[error.code])).toBe(true)
    expect(new Set(failures.map((error) => ERROR_MESSAGES[error.code])).size).toBe(failures.length)
  })

  it('has one distinct message for every error code', () => {
    const codes = Object.keys(ERROR_MESSAGES)
    expect(codes.sort()).toEqual(['AUTH', 'FORMAT', 'INPUT', 'INTEGRITY', 'SHARD', 'UNCORRECTABLE'])
    expect(new Set(Object.values(ERROR_MESSAGES)).size).toBe(codes.length)
  })

  it('states the reason for every ShardError, including how many more Shards are needed', () => {
    expect(errorText(new ShardError('too-few', 2))).toBe('Shards do not combine: need 2 more shards')
    expect(errorText(new ShardError('different-threshold'))).toBe('Shards do not combine: shards declare different K or N')
    expect(errorText(new ShardError('different-length'))).toBe('Shards do not combine: shards have different lengths')
    expect(errorText(new ShardError('duplicate-index'))).toBe('Shards do not combine: two shards share an index')
  })

  it('lists every uncorrectable block from a real damaged Tape_Record (Requirement 3.4)', () => {
    const body = new Uint8Array(500).map((_, i) => i & 0xff) // 3 Codewords at 300 baud
    const record = frame(body, 'envelope', 300)
    // Damage 17 bytes, one more than RS can repair, in Codewords 0 and 2.
    for (const block of [0, 2]) {
      const start = 96 + block * 255
      for (let i = 0; i < 17; i++) record[start + i * 5]! ^= 0xff
    }
    let thrown: unknown
    try {
      unframe(record, 300)
    } catch (error) {
      thrown = error
    }
    expect(errorText(thrown)).toBe('Too much damage to repair: codewords 0, 2 failed')
  })
})
