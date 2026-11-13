import { afterEach, describe, expect, it, vi } from 'vitest'
import { concat, readUint32BE, writeUint32BE } from '../core/bytes'
import { AuthenticationError, FormatError, InputError } from '../core/errors'
import { MAX_PLAINTEXT_BYTES, open, PBKDF2_ITERATIONS, seal } from './vault'

// Tests seal at the minimum iteration count to stay fast. Only a test that
// checks the production count should use the default.
const FAST = { iterations: 1_000 } as const

const encoder = new TextEncoder()

// Envelope v1 offsets (design.md, "Envelope v1"), restated here so the tests
// check the documented layout rather than the module's own constants.
const HEADER_BYTES = 33
const TAG_BYTES = 16
const SALT = [5, 21] as const
const IV = [21, 33] as const

afterEach(() => {
  vi.restoreAllMocks()
})

/** Resolves to the rejection reason, or fails the test if the promise resolves. */
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => expect.fail('expected the promise to reject'),
    (reason: unknown) => reason,
  )
}

/** Reads a whole byte stream into one array. */
async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array<ArrayBuffer>> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
  }
  return concat(...chunks)
}

/** Deflate in the zlib format, independent of `compress.ts`. */
async function deflate(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  return readAll(new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate')))
}

async function inflate(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  return readAll(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate')))
}

/** PBKDF2-HMAC-SHA-256 to AES-256-GCM, as design.md specifies. */
async function deriveTestKey(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number) {
  const base = await crypto.subtle.importKey('raw', encoder.encode(password.normalize('NFC')), 'PBKDF2', false, [
    'deriveKey',
  ])
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

/**
 * Builds an authenticated v1 Envelope around arbitrary `payload` bytes, which
 * `seal` would never produce. Used to reach the post-authentication checks.
 */
async function buildEnvelope(payload: Uint8Array<ArrayBuffer>, password: string): Promise<Uint8Array<ArrayBuffer>> {
  const iterations = 1_000
  const header = new Uint8Array(HEADER_BYTES)
  header[0] = 0x01
  writeUint32BE(header, 1, iterations)
  const salt = header.subarray(...SALT)
  const iv = header.subarray(...IV)
  crypto.getRandomValues(salt)
  crypto.getRandomValues(iv)
  const key = await deriveTestKey(password, salt, iterations)
  const sealed = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: header, tagLength: 128 }, key, payload)
  return concat(header, new Uint8Array(sealed))
}

/** Asserts that no string property of `error` contains `secret`, and that it has no cause. */
function expectNoSecret(error: unknown, secret: string): void {
  expect(error).toBeInstanceOf(Error)
  const e = error as Error
  expect(e.message).not.toContain(secret)
  expect(e.cause).toBeUndefined()
  for (const value of Object.values(e)) {
    if (typeof value === 'string') expect(value).not.toContain(secret)
  }
}

describe('seal and open', () => {
  it('round-trips a Plaintext and writes the v1 header', async () => {
    const plaintext = encoder.encode('correct horse battery staple')
    const envelope = await seal(plaintext, 'tape password', FAST)

    expect(envelope[0]).toBe(0x01)
    expect(Array.from(envelope.subarray(1, 5))).toEqual([0x00, 0x00, 0x03, 0xe8])
    expect(envelope.length).toBeGreaterThanOrEqual(50)
    expect(await open(envelope, 'tape password')).toEqual(plaintext)
  })

  it('rejects a wrong Password with AuthenticationError', async () => {
    const envelope = await seal(encoder.encode('secret'), 'right password', FAST)
    const error = await rejectionOf(open(envelope, 'wrong password'))
    expect(error).toBeInstanceOf(AuthenticationError)
    expect((error as AuthenticationError).cause).toBeUndefined()
  })

  it('rejects an Envelope shorter than 50 bytes with FormatError', async () => {
    const envelope = await seal(encoder.encode('secret'), 'pw', FAST)
    const error = await rejectionOf(open(envelope.subarray(0, 49), 'pw'))
    expect(error).toBeInstanceOf(FormatError)
  })
})

describe('production iteration count (Requirement 1.1)', () => {
  it('seals with 600,000 PBKDF2 iterations by default', async () => {
    expect(PBKDF2_ITERATIONS).toBe(600_000)
    const envelope = await seal(encoder.encode('x'), 'pw')
    expect(readUint32BE(envelope, 1)).toBe(600_000)
  })
})

describe('Envelope layout (Requirement 1.1)', () => {
  it('is header, ciphertext of the zlib stream, and tag, with the header as AAD', async () => {
    const plaintext = encoder.encode('layout check '.repeat(20))
    const password = 'pässword'
    const envelope = await seal(plaintext, password, FAST)

    const compressed = await deflate(plaintext)
    expect(envelope.length).toBe(HEADER_BYTES + compressed.length + TAG_BYTES)
    expect(envelope[0]).toBe(0x01)
    expect(readUint32BE(envelope, 1)).toBe(1_000)

    // Decrypt with an independent implementation of the documented layout.
    const header = envelope.slice(0, HEADER_BYTES)
    const key = await deriveTestKey(password, header.slice(...SALT), 1_000)
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: header.slice(...IV), additionalData: header, tagLength: 128 },
      key,
      envelope.slice(HEADER_BYTES),
    )
    expect(await inflate(new Uint8Array(decrypted))).toEqual(plaintext)
  })

  it('draws a new salt and IV on every seal', async () => {
    const plaintext = encoder.encode('same input')
    const a = await seal(plaintext, 'pw', FAST)
    const b = await seal(plaintext, 'pw', FAST)
    expect(a.slice(...SALT)).not.toEqual(b.slice(...SALT))
    expect(a.slice(...IV)).not.toEqual(b.slice(...IV))
    expect(a).not.toEqual(b)
  })
})

describe('seal input limits (Requirement 1.5)', () => {
  it('seals and opens a Plaintext of exactly 15,360 bytes', async () => {
    expect(MAX_PLAINTEXT_BYTES).toBe(15_360)
    const plaintext = crypto.getRandomValues(new Uint8Array(15_360))
    const envelope = await seal(plaintext, 'pw', FAST)
    expect(await open(envelope, 'pw')).toEqual(plaintext)
  })

  it.each([
    ['an empty Plaintext', new Uint8Array(0), 'pw'],
    ['a 15,361-byte Plaintext', new Uint8Array(15_361), 'pw'],
    ['an empty Password', encoder.encode('secret'), ''],
  ])('rejects %s with InputError', async (_name, plaintext, password) => {
    const error = await rejectionOf(seal(plaintext, password, FAST))
    expect(error).toBeInstanceOf(InputError)
  })

  it('rejects a Password containing U+0000 with InputError before deriving a key', async () => {
    const importKey = vi.spyOn(crypto.subtle, 'importKey')
    const deriveKey = vi.spyOn(crypto.subtle, 'deriveKey')
    const error = await rejectionOf(seal(encoder.encode('secret'), 'a\u0000', FAST))
    expect(error).toBeInstanceOf(InputError)
    expect(importKey).not.toHaveBeenCalled()
    expect(deriveKey).not.toHaveBeenCalled()
  })

  it.each([999, 5_000_001, 1_000.5, Number.NaN])('rejects %d iterations with InputError', async (iterations) => {
    const error = await rejectionOf(seal(encoder.encode('secret'), 'pw', { iterations }))
    expect(error).toBeInstanceOf(InputError)
  })
})

describe('Envelope format checks (Requirement 1.4)', () => {
  /** Returns a copy of `envelope` with `edit` applied. */
  function edited(envelope: Uint8Array, edit: (bytes: Uint8Array) => void): Uint8Array {
    const copy = envelope.slice()
    edit(copy)
    return copy
  }

  it.each<[string, (bytes: Uint8Array) => Uint8Array]>([
    ['49 bytes long', (bytes) => bytes.slice(0, 49)],
    ['empty', () => new Uint8Array(0)],
    ['version 0', (bytes) => edited(bytes, (b) => (b[0] = 0x00))],
    ['version 2', (bytes) => edited(bytes, (b) => (b[0] = 0x02))],
    ['999 iterations', (bytes) => edited(bytes, (b) => writeUint32BE(b, 1, 999))],
    ['5,000,001 iterations', (bytes) => edited(bytes, (b) => writeUint32BE(b, 1, 5_000_001))],
  ])('rejects an Envelope that is %s with FormatError before deriving a key', async (_name, mutate) => {
    const envelope = mutate(await seal(encoder.encode('secret'), 'pw', FAST))
    const importKey = vi.spyOn(crypto.subtle, 'importKey')
    const deriveKey = vi.spyOn(crypto.subtle, 'deriveKey')

    const error = await rejectionOf(open(envelope, 'pw'))

    expect(error).toBeInstanceOf(FormatError)
    expect(importKey).not.toHaveBeenCalled()
    expect(deriveKey).not.toHaveBeenCalled()
  })

  it('rejects a malformed Envelope with FormatError even when the Password contains U+0000', async () => {
    const envelope = await seal(encoder.encode('secret'), 'pw', FAST)
    envelope[0] = 0x02
    const error = await rejectionOf(open(envelope, 'pw\u0000'))
    expect(error).toBeInstanceOf(FormatError)
  })

  it('does derive a key for a well-formed Envelope (control for the spies above)', async () => {
    const envelope = await seal(encoder.encode('secret'), 'pw', FAST)
    const deriveKey = vi.spyOn(crypto.subtle, 'deriveKey')
    await open(envelope, 'pw')
    expect(deriveKey).toHaveBeenCalledTimes(1)
  })
})

describe('open Password checks (Requirement 1.9)', () => {
  it.each(['pw\u0000', '\u0000', 'p\u0000w'])(
    'rejects a Password containing U+0000 with InputError without deriving a key (%j)',
    async (password) => {
      const envelope = await seal(encoder.encode('secret'), 'pw', FAST)
      const importKey = vi.spyOn(crypto.subtle, 'importKey')
      const deriveKey = vi.spyOn(crypto.subtle, 'deriveKey')

      const error = await rejectionOf(open(envelope, password))

      expect(error).toBeInstanceOf(InputError)
      expectNoSecret(error, password)
      expect(importKey).not.toHaveBeenCalled()
      expect(deriveKey).not.toHaveBeenCalled()
    },
  )
})

describe('post-authentication decompression (Requirements 1.7, 1.8)', () => {
  it('opens an authenticated stream that inflates to exactly 15,360 bytes', async () => {
    const envelope = await buildEnvelope(await deflate(new Uint8Array(15_360)), 'pw')
    expect(await open(envelope, 'pw')).toEqual(new Uint8Array(15_360))
  })

  it('rejects an authenticated stream that inflates past 15,360 bytes with FormatError', async () => {
    const envelope = await buildEnvelope(await deflate(new Uint8Array(15_361)), 'pw')
    const error = await rejectionOf(open(envelope, 'pw'))
    expect(error).toBeInstanceOf(FormatError)
  })

  it('rejects a much larger expansion (a small Deflate bomb) with FormatError', async () => {
    const envelope = await buildEnvelope(await deflate(new Uint8Array(1_000_000)), 'pw')
    const error = await rejectionOf(open(envelope, 'pw'))
    expect(error).toBeInstanceOf(FormatError)
  })

  it('rejects authenticated bytes that are not a Deflate stream with FormatError', async () => {
    const envelope = await buildEnvelope(new Uint8Array([0xff, 0xff, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05]), 'pw')
    const error = await rejectionOf(open(envelope, 'pw'))
    expect(error).toBeInstanceOf(FormatError)
    expect(error).not.toBeInstanceOf(AuthenticationError)
  })

  it('rejects an authenticated but truncated Deflate stream with FormatError', async () => {
    const full = await deflate(encoder.encode('a truncated secret that will not inflate completely'))
    const envelope = await buildEnvelope(full.slice(0, full.length - 6), 'pw')
    const error = await rejectionOf(open(envelope, 'pw'))
    expect(error).toBeInstanceOf(FormatError)
  })
})

describe('errors carry no secret material (Requirement 8.9)', () => {
  const password = 'hunter2-tape-password'

  it('AuthenticationError from a wrong Password', async () => {
    const envelope = await seal(encoder.encode('secret'), 'another password', FAST)
    expectNoSecret(await rejectionOf(open(envelope, password)), password)
  })

  it('FormatError from malformed Deflate after authentication', async () => {
    const envelope = await buildEnvelope(encoder.encode(password), password)
    const error = await rejectionOf(open(envelope, password))
    expect(error).toBeInstanceOf(FormatError)
    expectNoSecret(error, password)
  })

  it('InputError from an oversized Plaintext', async () => {
    expectNoSecret(await rejectionOf(seal(new Uint8Array(15_361), password, FAST)), password)
  })
})
