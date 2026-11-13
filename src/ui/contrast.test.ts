import { describe, expect, it } from 'vitest'
import { blend, contrastRatio, parseHex, relativeLuminance } from './contrast'

// The palette in src/index.css is checked against these helpers in
// test/palette-contrast.test.ts, which can read the CSS file from disk.

const BLACK = parseHex('#000')

describe('contrast arithmetic', () => {
  it('matches the WCAG reference values', () => {
    expect(relativeLuminance(parseHex('#fff'))).toBeCloseTo(1, 10)
    expect(relativeLuminance(BLACK)).toBe(0)
    expect(contrastRatio(parseHex('#ffffff'), BLACK)).toBeCloseTo(21, 10)
    expect(contrastRatio(parseHex('#777777'), parseHex('#ffffff'))).toBeCloseTo(4.48, 2)
  })

  it('blends a translucent color over an opaque one', () => {
    expect(blend(parseHex('#ffffff'), 0.5, BLACK)).toEqual({ r: 127.5, g: 127.5, b: 127.5 })
  })

  it('rejects malformed colors', () => {
    expect(() => parseHex('33ff66')).toThrow(RangeError)
  })
})
