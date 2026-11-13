import { describe, expect, it } from 'vitest'
import { concat, readUint16BE, readUint32BE, writeUint16BE, writeUint32BE, zeroize } from './bytes'

describe('big-endian helpers', () => {
  it('writes uint16 most significant byte first and reads it back', () => {
    const bytes = new Uint8Array(3)
    writeUint16BE(bytes, 1, 0x4256)
    expect([...bytes]).toEqual([0x00, 0x42, 0x56])
    expect(readUint16BE(bytes, 1)).toBe(0x4256)
  })

  it('writes uint32 most significant byte first and reads it back', () => {
    const bytes = new Uint8Array(5)
    writeUint32BE(bytes, 1, 600_000)
    expect([...bytes]).toEqual([0x00, 0x00, 0x09, 0x27, 0xc0])
    expect(readUint32BE(bytes, 1)).toBe(600_000)
  })

  it.each([0, 1, 0x7fff, 0x8000, 0xffff])('round-trips uint16 %i', (value) => {
    const bytes = new Uint8Array(2)
    writeUint16BE(bytes, 0, value)
    expect(readUint16BE(bytes, 0)).toBe(value)
  })

  it.each([0, 1, 0x7fffffff, 0x80000000, 0xffffffff])('round-trips uint32 %i without going negative', (value) => {
    const bytes = new Uint8Array(4)
    writeUint32BE(bytes, 0, value)
    expect(readUint32BE(bytes, 0)).toBe(value)
  })

  it('rejects offsets past the end and out-of-range values', () => {
    const bytes = new Uint8Array(4)
    expect(() => readUint16BE(bytes, 3)).toThrow(RangeError)
    expect(() => readUint32BE(bytes, 1)).toThrow(RangeError)
    expect(() => readUint32BE(bytes, -1)).toThrow(RangeError)
    expect(() => writeUint16BE(bytes, 0, 0x10000)).toThrow(RangeError)
    expect(() => writeUint32BE(bytes, 0, -1)).toThrow(RangeError)
    expect(() => writeUint32BE(bytes, 0, 1.5)).toThrow(RangeError)
  })
})

describe('concat', () => {
  it('joins parts in order into a new array', () => {
    const a = Uint8Array.of(1, 2)
    const b = Uint8Array.of(3)
    const joined = concat(a, new Uint8Array(0), b)
    expect([...joined]).toEqual([1, 2, 3])
    joined[0] = 9
    expect(a[0]).toBe(1)
    expect(concat().length).toBe(0)
  })
})

describe('zeroize', () => {
  it('overwrites every byte of every array with zero', () => {
    const a = Uint8Array.of(1, 2, 3)
    const b = Uint8Array.of(255)
    zeroize(a, b)
    expect([...a]).toEqual([0, 0, 0])
    expect([...b]).toEqual([0])
  })
})
