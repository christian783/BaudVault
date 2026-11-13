import { describe, expect, it } from 'vitest'
import {
  AuthenticationError,
  BaudVaultError,
  FormatError,
  InputError,
  IntegrityError,
  ShardError,
  UncorrectableError,
} from './errors'

describe('error classes', () => {
  it.each([
    [new InputError('password must not be empty'), 'INPUT', 'InputError'],
    [new FormatError('unsupported sample rate', 8000, 'Hz'), 'FORMAT', 'FormatError'],
    [new AuthenticationError(), 'AUTH', 'AuthenticationError'],
    [new ShardError('duplicate-index'), 'SHARD', 'ShardError'],
    [new UncorrectableError([2]), 'UNCORRECTABLE', 'UncorrectableError'],
    [new IntegrityError(), 'INTEGRITY', 'IntegrityError'],
  ])('%s has a stable code, a fixed name, and extends BaudVaultError and Error', (error, code, name) => {
    expect(error.code).toBe(code)
    expect(error.name).toBe(name)
    expect(error).toBeInstanceOf(BaudVaultError)
    expect(error).toBeInstanceOf(Error)
    expect(error.cause).toBeUndefined()
  })

  it('keeps subclasses distinct for instanceof checks', () => {
    expect(new FormatError('bad layout')).not.toBeInstanceOf(InputError)
    expect(new AuthenticationError()).not.toBeInstanceOf(FormatError)
  })

  it('FormatError names the property with an optional safe number and unit', () => {
    const error = new FormatError('unsupported sample rate', 8000, 'Hz')
    expect(error.message).toBe('unsupported sample rate 8000 Hz')
    expect(error.detail).toBe('unsupported sample rate')
    expect(error.value).toBe(8000)
    expect(new FormatError('unsupported channel count', 6).message).toBe('unsupported channel count 6')
    expect(new FormatError('not a RIFF WAV file').message).toBe('not a RIFF WAV file')
  })

  it('InputError carries its limit description and value', () => {
    const error = new InputError('plaintext must be 1 to 15360 bytes, got', 15_361, 'bytes')
    expect(error.message).toBe('plaintext must be 1 to 15360 bytes, got 15361 bytes')
    expect(error.value).toBe(15_361)
  })

  it('ShardError states how many more Shards are needed', () => {
    const one = new ShardError('too-few', 1)
    expect(one.message).toBe('need 1 more shard')
    expect(one.reason).toBe('too-few')
    expect(one.missing).toBe(1)
    expect(new ShardError('too-few', 2).message).toBe('need 2 more shards')
    const mismatch = new ShardError('different-set')
    expect(mismatch.missing).toBeUndefined()
    expect(mismatch.message).toBe('shards come from different sets')
  })

  it('UncorrectableError carries a frozen copy of the block indices', () => {
    const blocks = [0, 3, 7]
    const error = new UncorrectableError(blocks)
    blocks.push(9)
    expect(error.blocks).toEqual([0, 3, 7])
    expect(Object.isFrozen(error.blocks)).toBe(true)
    expect(error.message).toBe('uncorrectable codewords: 0, 3, 7')
    expect(new UncorrectableError().blocks).toEqual([])
  })
})
