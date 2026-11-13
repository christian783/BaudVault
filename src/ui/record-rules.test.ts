import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { DEFAULT_CHANNEL, toChannelSettings } from './channel-controls'
import {
  isShortPassword,
  lockReadiness,
  NULL_CHARACTER_MESSAGE,
  passwordCodePoints,
  SHORT_PASSWORD_CODE_POINTS,
  utf8ByteLength,
} from './record-rules'

/**
 * Password pieces with their code-point count after NFC. Several take more
 * than one UTF-16 unit or more than one code point before NFC, so a count of
 * UTF-16 units, NFD code points, or graphemes would disagree with the rule.
 * No piece composes with a neighbour, so a Password's NFC count is the sum.
 */
const PIECES: readonly (readonly [string, number])[] = [
  ['a', 1],
  ['\u00e9', 1], // é precomposed
  ['e\u0301', 1], // é decomposed: 2 code points in, 1 after NFC
  ['😀', 1], // outside the BMP: 2 UTF-16 units
  ['👍🏽', 2], // emoji + skin-tone modifier: 1 grapheme, 2 code points
  ['\u1112\u1161\u11ab', 1], // 한 as conjoining jamo: 3 code points in, 1 after NFC
  ['\u2126', 1], // OHM SIGN, NFC maps it to U+03A9
  ['\u212b', 1], // ANGSTROM SIGN, NFC maps it to U+00C5
  ['ﬁ', 1], // ligature: NFC keeps it (only NFKC splits it)
]

describe('password length rule across Unicode forms (Requirements 7.25, 7.26)', () => {
  it('warns at 11 NFC code points and not at 12, whatever the input form', () => {
    for (const [piece, weight] of PIECES.filter(([, w]) => w === 1)) {
      const eleven = piece.repeat(11)
      const twelve = piece.repeat(12)
      expect(isShortPassword(eleven)).toBe(true)
      expect(isShortPassword(twelve)).toBe(false)
      // NFD and NFC spellings of the same Password get the same answer.
      expect(isShortPassword(eleven.normalize('NFD'))).toBe(true)
      expect(isShortPassword(twelve.normalize('NFD'))).toBe(false)
      expect(passwordCodePoints(twelve)).toBe(12 * weight)
    }
    // 11 decomposed accents are 22 code points before NFC but still short.
    expect(isShortPassword('e\u0301'.repeat(11))).toBe(true)
    // 6 skin-tone emoji look like 6 characters but are 12 code points.
    expect(isShortPassword('👍🏽'.repeat(6))).toBe(false)
  })

  it('keeps Lock enabled for every Password of 1 to 11 code points', () => {
    for (let count = 1; count < SHORT_PASSWORD_CODE_POINTS; count++) {
      for (const password of ['x'.repeat(count), '😀'.repeat(count), 'e\u0301'.repeat(count)]) {
        expect(isShortPassword(password)).toBe(true)
        expect(lockReadiness('secret', password)).toEqual({ ready: true, secretBytes: 6, problem: null })
      }
    }
  })

  it('blocks Lock for U+0000 anywhere in the Password, even when it is long', () => {
    for (const password of ['\u0000', 'a\u0000', '\u0000' + 'b'.repeat(20), '😀\u0000😀']) {
      expect(lockReadiness('secret', password)).toEqual({ ready: false, secretBytes: 6, problem: NULL_CHARACTER_MESSAGE })
    }
  })

  it('reports the missing feature before any Password problem (Requirement 10.2)', () => {
    const unavailable = 'Lock is unavailable because Web Crypto (crypto.subtle) is missing.'
    expect(lockReadiness('secret', 'a\u0000', unavailable).problem).toBe(unavailable)
    expect(lockReadiness('', '', unavailable)).toEqual({ ready: false, secretBytes: 0, problem: unavailable })
  })

  it('property: length never disables Lock, and the warning shows iff NFC code points < 12', () => {
    const piecesArb = fc
      .array(fc.constantFrom(...PIECES), { minLength: 1, maxLength: 16 })
      .map((chosen) => ({
        password: chosen.map(([piece]) => piece).join(''),
        codePoints: chosen.reduce((sum, [, weight]) => sum + weight, 0),
      }))
    const binaryArb = fc
      .string({ unit: 'binary', minLength: 1, maxLength: 24 })
      .filter((password) => !password.includes('\u0000'))
      .map((password) => ({ password, codePoints: Array.from(password.normalize('NFC')).length }))
    const secretArb = fc.string({ unit: 'binary', minLength: 1, maxLength: 64 })

    fc.assert(
      fc.property(fc.oneof(piecesArb, binaryArb), secretArb, ({ password, codePoints }, secret) => {
        const short = codePoints < SHORT_PASSWORD_CODE_POINTS
        for (const form of [password, password.normalize('NFC'), password.normalize('NFD')]) {
          expect(isShortPassword(form)).toBe(short)
          expect(lockReadiness(secret, form)).toMatchObject({ ready: true, problem: null })
        }
      }),
      { numRuns: 200 },
    )
  })
})

describe('password length rule', () => {
  it('counts code points after NFC normalization', () => {
    // Twelve "e" + combining acute accents: 24 code points in NFD, 12 in NFC.
    const decomposed = 'e\u0301'.repeat(12)
    expect(passwordCodePoints(decomposed)).toBe(12)
    expect(isShortPassword(decomposed)).toBe(false)
    // A character outside the BMP is one code point, not two UTF-16 units.
    expect(passwordCodePoints('😀'.repeat(11))).toBe(11)
    expect(isShortPassword('😀'.repeat(11))).toBe(true)
    expect(isShortPassword('')).toBe(true)
  })
})

describe('utf8ByteLength', () => {
  it('matches TextEncoder, including a lone surrogate', () => {
    for (const text of ['', 'abc', 'é€', '😀 key', 'x\uD800y']) {
      expect(utf8ByteLength(text)).toBe(new TextEncoder().encode(text).length)
    }
  })
})

describe('lockReadiness', () => {
  it('never blocks Lock because the Password is short', () => {
    expect(lockReadiness('secret', 'a')).toEqual({ ready: true, secretBytes: 6, problem: null })
  })

  it('blocks Lock for an empty secret or Password without a problem message', () => {
    expect(lockReadiness('', 'password').ready).toBe(false)
    expect(lockReadiness('secret', '')).toMatchObject({ ready: false, problem: null })
  })

  it('blocks Lock and explains a Password containing U+0000', () => {
    expect(lockReadiness('secret', 'pass\u0000word')).toMatchObject({ ready: false, problem: NULL_CHARACTER_MESSAGE })
  })

  it('blocks Lock with the feature message when the browser cannot seal (Requirement 10.2)', () => {
    const unavailable = 'Lock is unavailable because CompressionStream is missing.'
    expect(lockReadiness('secret', 'pw', unavailable)).toEqual({ ready: false, secretBytes: 6, problem: unavailable })
    expect(lockReadiness('secret', 'pw', null).ready).toBe(true)
  })

  it('blocks Lock for a secret over 15,360 bytes', () => {
    expect(lockReadiness('a'.repeat(15_360), 'pw').ready).toBe(true)
    const tooLong = lockReadiness('a'.repeat(15_361), 'pw')
    expect(tooLong.ready).toBe(false)
    expect(tooLong.problem).toBe('The secret is 15,361 bytes; the limit is 15,360 bytes.')
  })
})

describe('toChannelSettings', () => {
  it('is null while the channel is off and converts percent to fractions when on', () => {
    expect(toChannelSettings(DEFAULT_CHANNEL, 1)).toBeNull()
    expect(toChannelSettings({ enabled: true, hissPercent: 60, wowPercent: 5 }, 9)).toEqual({
      hiss: 0.6,
      wow: 0.05,
      seed: 9,
    })
  })
})
