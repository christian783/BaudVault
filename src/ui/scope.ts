// Pure geometry and timing for the oscilloscope and energy bars
// (design.md, "Deck_UI"; Requirements 7.2, 7.3, 7.4). DOM-free so it can be
// unit tested in Node.

/** Internal canvas resolution in pixels; CSS scales it to the panel width. */
export const SCOPE_WIDTH = 640
export const SCOPE_HEIGHT = 320

/** Phosphor green for both traces (design.md, "Oscilloscope"). */
export const PHOSPHOR = '#33ff66'
/** Dim phosphor for the graticule lines, never used for text. */
export const GRATICULE = 'rgba(51, 255, 102, 0.25)'
/**
 * Black drawn over the previous frame before each new frame. Old traces fade
 * by this alpha per frame, which imitates phosphor persistence.
 */
export const PERSISTENCE_FILL = 'rgba(0, 0, 0, 0.35)'

/** Redraws are capped at 60 frames per second (Requirement 7.4). */
export const MAX_FPS = 60
/**
 * Shortest gap between drawn frames. One millisecond under 1000/60 absorbs
 * timer jitter on a 60 Hz display, while a 120 Hz display draws every other
 * frame.
 */
export const MIN_FRAME_MS = 1000 / MAX_FPS - 1

/** Energy bar range in dB relative to a full-scale tone (energy 1). */
export const ENERGY_FLOOR_DB = -60

/** A horizontal strip of the canvas holding one trace. */
export type Band = { readonly top: number; readonly height: number }

/** Trace A (input audio) fills the upper half, trace B (d[n]) the lower half. */
export function traceBands(height: number = SCOPE_HEIGHT): { a: Band; b: Band } {
  const half = height / 2
  return { a: { top: 0, height: half }, b: { top: half, height: half } }
}

/** Fraction of a band's height left empty above +1 and below −1. */
const BAND_MARGIN = 0.08

/**
 * Canvas y of a trace value: +1 near the top of the band, −1 near the
 * bottom, 0 in the middle. Values outside [−1, 1] are clamped, and NaN is
 * drawn as 0.
 */
export function traceY(value: number, band: Band): number {
  const v = Number.isNaN(value) ? 0 : Math.max(-1, Math.min(1, value))
  const usable = band.height * (1 - 2 * BAND_MARGIN)
  return band.top + band.height / 2 - (v * usable) / 2
}

/** Canvas x of sample `index` of `count`, spreading the trace across the full width. */
export function traceX(index: number, count: number, width: number = SCOPE_WIDTH): number {
  if (count <= 1) return 0
  return (index * width) / (count - 1)
}

/**
 * Bar length from 0 to 1 for a normalized Goertzel energy (a tone of peak
 * A reads about A²): 0 at −60 dB or below, 1 at a full-scale tone. A
 * 0.7-amplitude Modulator tone reads about 0.95.
 */
export function energyFraction(energy: number): number {
  if (!(energy > 0)) return 0
  const db = 10 * Math.log10(energy)
  return Math.max(0, Math.min(1, (db - ENERGY_FLOOR_DB) / -ENERGY_FLOOR_DB))
}

/** Whether a frame at `now` (milliseconds) should be drawn, given the last drawn frame time. */
export function frameDue(now: number, lastDrawn: number | null): boolean {
  return lastDrawn === null || now - lastDrawn >= MIN_FRAME_MS
}
