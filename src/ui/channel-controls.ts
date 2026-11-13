// Virtual_Tape_Channel controls (Requirements 6.1, 6.2, 7.22). DOM-free.
//
// The sliders work in percent: Hiss 0% to 60% and Wow-and-Flutter 0% to 5%.
// `toChannelSettings` turns them into the fractions `applyTapeChannel`
// takes, or null when the channel is off, which is what `playTape` expects.

import { MAX_HISS, MAX_WOW, type TapeChannelSettings } from '../channel/virtual-tape'

export type ChannelControls = {
  enabled: boolean
  /** Hiss_Level in percent, 0 to 60. */
  hissPercent: number
  /** Wow_Level in percent, 0 to 5. */
  wowPercent: number
}

export const HISS_PERCENT_MAX = 60
export const HISS_PERCENT_STEP = 1
export const WOW_PERCENT_MAX = 5
export const WOW_PERCENT_STEP = 0.1

/** Off, with the sliders at the levels Requirement 6.5 guarantees recovery for. */
export const DEFAULT_CHANNEL: ChannelControls = { enabled: false, hissPercent: 30, wowPercent: 2 }

/** Clamps a slider value to 0..max; anything that is not a finite number becomes 0. */
export function clampPercent(value: number, max: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0
  return Math.min(value, max)
}

/** The settings for one Play, or null when the channel is off. */
export function toChannelSettings(controls: ChannelControls, seed: number): TapeChannelSettings | null {
  if (!controls.enabled) return null
  return {
    hiss: Math.min(MAX_HISS, clampPercent(controls.hissPercent, HISS_PERCENT_MAX) / 100),
    wow: Math.min(MAX_WOW, clampPercent(controls.wowPercent, WOW_PERCENT_MAX) / 100),
    seed,
  }
}

/**
 * A fresh seed for the simulated hiss on each Play. The seed is not a
 * security value; it is drawn from `crypto.getRandomValues` anyway so the
 * code has a single source of randomness.
 */
export function newChannelSeed(): number {
  const value = new Uint32Array(1)
  crypto.getRandomValues(value)
  return value[0]!
}
