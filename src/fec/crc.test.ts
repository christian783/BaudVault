import { describe, expect, it } from 'vitest'
import { crc16, crc32 } from './crc'

const CHECK_INPUT = new TextEncoder().encode('123456789')

describe('crc32', () => {
  it('matches the IEEE / zlib check value', () => {
    expect(crc32(CHECK_INPUT)).toBe(0xcbf43926)
  })

  it('returns 0 for empty input', () => {
    expect(crc32(new Uint8Array(0))).toBe(0)
  })

  it('returns an unsigned value', () => {
    expect(crc32(Uint8Array.of(0xff, 0xff, 0xff, 0xff))).toBe(0xffffffff)
  })

  it('changes when one bit flips', () => {
    const flipped = CHECK_INPUT.slice()
    flipped[4]! ^= 0x01
    expect(crc32(flipped)).not.toBe(0xcbf43926)
  })
})

describe('crc16 (CCITT-FALSE)', () => {
  it('matches the check value', () => {
    expect(crc16(CHECK_INPUT)).toBe(0x29b1)
  })

  it('returns the init value for empty input', () => {
    expect(crc16(new Uint8Array(0))).toBe(0xffff)
  })

  it('changes when one bit flips', () => {
    const flipped = CHECK_INPUT.slice()
    flipped[0]! ^= 0x80
    expect(crc16(flipped)).not.toBe(0x29b1)
  })
})
