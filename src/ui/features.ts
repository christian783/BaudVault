// Startup feature detection (design.md, "Feature detection (Requirement 10)";
// Requirements 10.2, 10.3). DOM-free: `detectFeatures` takes a plain record of
// which features are present, so every combination can be unit tested, and
// `readFeatureEnvironment` reads the real globals without throwing.
//
// Only the functions that need a missing feature are disabled:
// - Web Crypto, CompressionStream, or DecompressionStream missing: Lock and
//   Unlock (10.2).
// - AudioWorkletNode or getUserMedia missing, or not a secure context:
//   Listen (10.3).
// WAV import, tape decoding, and the Virtual_Tape_Channel need none of these
// and stay available in every combination.

/** Each browser capability BaudVault checks at startup, in display order. */
export const FEATURES = [
  'cryptoSubtle',
  'compressionStream',
  'decompressionStream',
  'audioWorkletNode',
  'getUserMedia',
  'secureContext',
] as const

export type Feature = (typeof FEATURES)[number]

/** True for each feature the browser provides. */
export type FeatureEnvironment = Readonly<Record<Feature, boolean>>

/** The functions a missing feature disables. */
export type FeatureGroup = 'vault' | 'listen'

export const FEATURE_GROUPS: Readonly<Record<Feature, FeatureGroup>> = {
  cryptoSubtle: 'vault',
  compressionStream: 'vault',
  decompressionStream: 'vault',
  audioWorkletNode: 'listen',
  getUserMedia: 'listen',
  secureContext: 'listen',
}

/** Why each missing feature matters, phrased to follow "because". */
export const FEATURE_REASONS: Readonly<Record<Feature, string>> = {
  cryptoSubtle: 'Web Crypto (crypto.subtle) is missing',
  compressionStream: 'CompressionStream is missing',
  decompressionStream: 'DecompressionStream is missing',
  audioWorkletNode: 'AudioWorkletNode is missing',
  getUserMedia: 'microphone capture (navigator.mediaDevices.getUserMedia) is missing',
  secureContext: 'the page is not a secure context (HTTPS or localhost)',
}

const GROUP_EFFECTS: Readonly<Record<FeatureGroup, string>> = {
  vault: 'Lock and Unlock are disabled.',
  listen: 'Listen is disabled.',
}

/** Shown under the notice whenever something is missing. */
export const STILL_AVAILABLE = 'WAV import, tape decoding, and the Virtual Tape Channel still work.'

export type FeatureSupport = {
  /** Every missing feature, in FEATURES order. */
  missing: readonly Feature[]
  /** Lock and Unlock can run (Requirement 10.2). */
  vaultAvailable: boolean
  /** Listen can run (Requirement 10.3). */
  listenAvailable: boolean
  /** Why Lock is disabled by a missing feature, or null. */
  lockProblem: string | null
  /** Why Unlock is disabled by a missing feature, or null. */
  unlockProblem: string | null
  /** Why Listen is disabled by a missing feature or context, or null. */
  listenProblem: string | null
  /** One line per missing feature naming it and what it disables; empty when nothing is missing. */
  notice: readonly string[]
}

/** "a", "a and b", "a, b, and c". */
function joinReasons(reasons: readonly string[]): string {
  if (reasons.length <= 2) return reasons.join(' and ')
  return `${reasons.slice(0, -1).join(', ')}, and ${reasons[reasons.length - 1]}`
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

function problem(control: string, reasons: readonly string[]): string | null {
  return reasons.length === 0 ? null : `${control} is unavailable because ${joinReasons(reasons)}.`
}

/** Which features are missing and which functions they disable. */
export function detectFeatures(env: FeatureEnvironment): FeatureSupport {
  const missing = FEATURES.filter((feature) => !env[feature])
  const reasons = (group: FeatureGroup) =>
    missing.filter((feature) => FEATURE_GROUPS[feature] === group).map((feature) => FEATURE_REASONS[feature])
  const vaultReasons = reasons('vault')
  const listenReasons = reasons('listen')
  return {
    missing,
    vaultAvailable: vaultReasons.length === 0,
    listenAvailable: listenReasons.length === 0,
    lockProblem: problem('Lock', vaultReasons),
    unlockProblem: problem('Unlock', vaultReasons),
    listenProblem: problem('Listen', listenReasons),
    notice: missing.map(
      (feature) => `${capitalize(FEATURE_REASONS[feature])}. ${GROUP_EFFECTS[FEATURE_GROUPS[feature]]}`,
    ),
  }
}

/** The globals `readFeatureEnvironment` looks at. Every one may be absent. */
type FeatureScope = {
  crypto?: { subtle?: unknown }
  CompressionStream?: unknown
  DecompressionStream?: unknown
  AudioWorkletNode?: unknown
  navigator?: { mediaDevices?: { getUserMedia?: unknown } }
  isSecureContext?: unknown
}

/** Runs `check`, treating a throwing getter as a missing feature. */
function present(check: () => boolean): boolean {
  try {
    return check()
  } catch {
    return false
  }
}

/** Reads the real globals (or `scope`, for tests). Never throws. */
export function readFeatureEnvironment(scope: object = globalThis): FeatureEnvironment {
  const s = scope as FeatureScope
  return {
    cryptoSubtle: present(() => typeof s.crypto?.subtle === 'object' && s.crypto.subtle !== null),
    compressionStream: present(() => typeof s.CompressionStream === 'function'),
    decompressionStream: present(() => typeof s.DecompressionStream === 'function'),
    audioWorkletNode: present(() => typeof s.AudioWorkletNode === 'function'),
    getUserMedia: present(() => typeof s.navigator?.mediaDevices?.getUserMedia === 'function'),
    secureContext: present(() => s.isSecureContext === true),
  }
}
