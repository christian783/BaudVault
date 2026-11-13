import { describe, expect, it } from 'vitest'
import { FormatError } from '../core/errors'
import { compress, decompress, MAX_DECOMPRESSED_BYTES } from './compress'

function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  return bytes
}

async function expectFormatError(promise: Promise<unknown>, message: string): Promise<void> {
  const error: unknown = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  )
  expect(error).toBeInstanceOf(FormatError)
  expect((error as FormatError).message).toBe(message)
  expect((error as FormatError).cause).toBeUndefined()
}

describe('compress', () => {
  it('writes the zlib format (RFC 1950)', async () => {
    const out = await compress(new TextEncoder().encode('hello tape'))
    // CMF 0x78 is Deflate with a 32 KiB window; CMF·256 + FLG is a multiple of 31.
    expect(out[0]).toBe(0x78)
    expect(((out[0]! << 8) | out[1]!) % 31).toBe(0)
  })

  it('shrinks repetitive input', async () => {
    const out = await compress(new Uint8Array(4096).fill(0x41))
    expect(out.length).toBeLessThan(100)
  })
})

describe('decompress', () => {
  it.each([1, 223, 4096])('round-trips %i random bytes', async (length) => {
    const input = randomBytes(length)
    expect(await decompress(await compress(input))).toEqual(input)
  })

  it('round-trips a view into a larger buffer', async () => {
    const backing = randomBytes(64)
    const view = backing.subarray(10, 40)
    expect(await decompress(await compress(view))).toEqual(view)
  })

  it('accepts output of exactly the cap', async () => {
    const input = randomBytes(MAX_DECOMPRESSED_BYTES)
    const out = await decompress(await compress(input))
    expect(out.length).toBe(15_360)
    expect(out).toEqual(input)
  })

  it('rejects output one byte over the cap', async () => {
    const packed = await compress(new Uint8Array(MAX_DECOMPRESSED_BYTES + 1))
    await expectFormatError(decompress(packed), 'decompressed output exceeds 15360 bytes')
  })

  it('stops early on a stream that expands far past the cap', async () => {
    const packed = await compress(new Uint8Array(4 * 1024 * 1024))
    await expectFormatError(decompress(packed), 'decompressed output exceeds 15360 bytes')
  })

  it('honours a custom cap', async () => {
    const packed = await compress(new Uint8Array(100))
    expect((await decompress(packed, 100)).length).toBe(100)
    await expectFormatError(decompress(packed, 99), 'decompressed output exceeds 99 bytes')
  })

  it.each([
    ['not zlib at all', Uint8Array.of(0x01, 0x02, 0x03, 0x04, 0x05, 0x06)],
    ['a zlib header with an invalid block type', Uint8Array.of(0x78, 0x9c, 0xff, 0xff, 0xff, 0xff)],
    ['empty input', new Uint8Array(0)],
  ])('rejects %s as malformed', async (_label, input) => {
    await expectFormatError(decompress(input), 'malformed deflate stream')
  })

  it('rejects a stream truncated in the middle', async () => {
    const packed = await compress(randomBytes(2048))
    await expectFormatError(decompress(packed.subarray(0, packed.length >> 1)), 'malformed deflate stream')
  })

  it('rejects a stream missing its Adler-32 trailer', async () => {
    const packed = await compress(randomBytes(512))
    await expectFormatError(decompress(packed.subarray(0, packed.length - 4)), 'malformed deflate stream')
  })

  it('rejects a stream with a corrupted Adler-32 trailer', async () => {
    const packed = await compress(randomBytes(512))
    packed[packed.length - 1]! ^= 0x01
    await expectFormatError(decompress(packed), 'malformed deflate stream')
  })

  it('rejects an invalid cap as a programming error', async () => {
    const packed = await compress(Uint8Array.of(1))
    await expect(decompress(packed, -1)).rejects.toThrow(RangeError)
    await expect(decompress(packed, 1.5)).rejects.toThrow(RangeError)
  })
})
