// WCAG 2.x contrast arithmetic for checking the palette (Requirements 9.1,
// 9.3). DOM-free.
//
// - Relative luminance and contrast ratio follow the WCAG 2.2 definitions.
// - `blend` composites a translucent color over an opaque one in sRGB, which
//   is how the browser paints a Tailwind `/15` fill over the black page.

/** An opaque sRGB color, each channel 0 to 255. */
export type Rgb = { readonly r: number; readonly g: number; readonly b: number }

/** Parses `#rgb` or `#rrggbb` (any case). */
export function parseHex(hex: string): Rgb {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim())
  if (match === null) throw new RangeError('expected a #rgb or #rrggbb color')
  let digits = match[1]!
  if (digits.length === 3) digits = [...digits].map((d) => d + d).join('')
  const value = Number.parseInt(digits, 16)
  return { r: (value >> 16) & 0xff, g: (value >> 8) & 0xff, b: value & 0xff }
}

function channelLuminance(channel: number): number {
  const c = channel / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

/** WCAG relative luminance, 0 (black) to 1 (white). */
export function relativeLuminance(color: Rgb): number {
  return 0.2126 * channelLuminance(color.r) + 0.7152 * channelLuminance(color.g) + 0.0722 * channelLuminance(color.b)
}

/** WCAG contrast ratio between two opaque colors, 1 to 21. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/** `color` at opacity `alpha` (0 to 1) painted over the opaque `background`. */
export function blend(color: Rgb, alpha: number, background: Rgb): Rgb {
  const mix = (fg: number, bg: number) => fg * alpha + bg * (1 - alpha)
  return { r: mix(color.r, background.r), g: mix(color.g, background.g), b: mix(color.b, background.b) }
}
