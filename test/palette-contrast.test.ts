// Checks the BaudVault palette in src/index.css against WCAG contrast
// (Requirements 9.1, 9.3). It lives outside src/ because it reads the CSS
// file from disk, which Vitest's CSS handling does not allow from an import.

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { blend, contrastRatio, parseHex, type Rgb } from '../src/ui/contrast'
import { PHOSPHOR } from '../src/ui/scope'

const css = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8')

/** Reads a `--name: #hex;` custom property from src/index.css. */
function cssColor(name: string): Rgb {
  const match = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{3,6})\\s*;`).exec(css)
  if (match === null) throw new Error(`--${name} not found in index.css`)
  return parseHex(match[1]!)
}

const BLACK = parseHex('#000')

describe('BaudVault palette (Requirements 9.1, 9.3)', () => {
  const phosphor = cssColor('color-phosphor')
  const dim = cssColor('color-phosphor-dim')

  it('uses the same phosphor in CSS and on the canvas', () => {
    expect(phosphor).toEqual(parseHex(PHOSPHOR))
  })

  it('keeps all text at 4.5:1 or more against its background', () => {
    // Normal text, hints, warnings, and errors: phosphor on black.
    expect(contrastRatio(phosphor, BLACK)).toBeGreaterThanOrEqual(4.5)
    // A hovered button: phosphor on a 15% phosphor fill over black.
    expect(contrastRatio(phosphor, blend(phosphor, 0.15, BLACK))).toBeGreaterThanOrEqual(4.5)
    // A disabled button: the dim phosphor on black.
    expect(contrastRatio(dim, BLACK)).toBeGreaterThanOrEqual(4.5)
  })

  it('keeps the focus ring at 3:1 or more against the black next to it', () => {
    // The ring is phosphor with a 2px offset, so the page and panels around it are black.
    expect(contrastRatio(phosphor, BLACK)).toBeGreaterThanOrEqual(3)
  })

  it('does not dim disabled buttons with opacity, which would fall below 4.5:1', () => {
    expect(contrastRatio(blend(phosphor, 0.5, BLACK), BLACK)).toBeLessThan(4.5)
    expect(css).not.toMatch(/disabled:opacity/)
  })
})
