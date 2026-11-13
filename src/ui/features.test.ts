import { describe, expect, it } from 'vitest'
import {
  detectFeatures,
  type Feature,
  FEATURE_GROUPS,
  FEATURE_REASONS,
  FEATURES,
  type FeatureEnvironment,
  readFeatureEnvironment,
  STILL_AVAILABLE,
} from './features'

const ALL_PRESENT: FeatureEnvironment = {
  cryptoSubtle: true,
  compressionStream: true,
  decompressionStream: true,
  audioWorkletNode: true,
  getUserMedia: true,
  secureContext: true,
}

describe('detectFeatures (Requirements 10.2, 10.3)', () => {
  it('disables nothing when every feature is present', () => {
    expect(detectFeatures(ALL_PRESENT)).toEqual({
      missing: [],
      vaultAvailable: true,
      listenAvailable: true,
      lockProblem: null,
      unlockProblem: null,
      listenProblem: null,
      notice: [],
    })
  })

  it('disables only Lock and Unlock when a vault feature is missing, naming each one', () => {
    const support = detectFeatures({ ...ALL_PRESENT, cryptoSubtle: false, decompressionStream: false })
    expect(support.missing).toEqual(['cryptoSubtle', 'decompressionStream'])
    expect(support.vaultAvailable).toBe(false)
    expect(support.listenAvailable).toBe(true)
    expect(support.lockProblem).toBe(
      'Lock is unavailable because Web Crypto (crypto.subtle) is missing and DecompressionStream is missing.',
    )
    expect(support.unlockProblem).toMatch(/^Unlock is unavailable because /)
    expect(support.listenProblem).toBeNull()
    expect(support.notice).toEqual([
      'Web Crypto (crypto.subtle) is missing. Lock and Unlock are disabled.',
      'DecompressionStream is missing. Lock and Unlock are disabled.',
    ])
  })

  it('disables only Listen when a capture feature is missing, stating each reason', () => {
    const support = detectFeatures({ ...ALL_PRESENT, audioWorkletNode: false, getUserMedia: false })
    expect(support.vaultAvailable).toBe(true)
    expect(support.listenAvailable).toBe(false)
    expect(support.listenProblem).toBe(
      'Listen is unavailable because AudioWorkletNode is missing and microphone capture (navigator.mediaDevices.getUserMedia) is missing.',
    )
    expect(support.lockProblem).toBeNull()
  })

  it('applies both rules in a non-secure context, which also lacks crypto.subtle', () => {
    const support = detectFeatures({ ...ALL_PRESENT, cryptoSubtle: false, secureContext: false })
    expect(support.vaultAvailable).toBe(false)
    expect(support.listenAvailable).toBe(false)
    expect(support.notice).toEqual([
      'Web Crypto (crypto.subtle) is missing. Lock and Unlock are disabled.',
      'The page is not a secure context (HTTPS or localhost). Listen is disabled.',
    ])
  })

  it('lists three or more reasons with commas', () => {
    const none = Object.fromEntries(FEATURES.map((feature) => [feature, false])) as FeatureEnvironment
    const support = detectFeatures(none)
    expect(support.missing).toEqual([...FEATURES])
    expect(support.notice).toHaveLength(FEATURES.length)
    expect(support.lockProblem).toBe(
      'Lock is unavailable because Web Crypto (crypto.subtle) is missing, CompressionStream is missing, and DecompressionStream is missing.',
    )
  })
})

describe('detectFeatures over all 64 combinations (Requirements 10.2, 10.3)', () => {
  const VAULT: readonly Feature[] = ['cryptoSubtle', 'compressionStream', 'decompressionStream']
  const LISTEN: readonly Feature[] = ['audioWorkletNode', 'getUserMedia', 'secureContext']

  /**
   * Whether `text` names `reason` as a whole phrase. A plain substring test
   * would find "CompressionStream is missing" inside "DecompressionStream is missing".
   */
  function names(text: string | null, reason: string): boolean {
    const escaped = reason.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return text !== null && new RegExp(`(^|[^A-Za-z])${escaped}`, 'i').test(text)
  }

  it('disables exactly the functions each missing feature needs and names each one once', () => {
    for (let mask = 0; mask < 1 << FEATURES.length; mask++) {
      const env = Object.fromEntries(FEATURES.map((feature, bit) => [feature, (mask & (1 << bit)) === 0])) as FeatureEnvironment
      const missing = FEATURES.filter((feature) => !env[feature])
      const vaultMissing = VAULT.some((feature) => !env[feature])
      const listenMissing = LISTEN.some((feature) => !env[feature])
      const support = detectFeatures(env)

      expect(support.missing).toEqual(missing)
      expect(support.vaultAvailable).toBe(!vaultMissing)
      expect(support.listenAvailable).toBe(!listenMissing)
      expect(support.lockProblem === null).toBe(!vaultMissing)
      expect(support.unlockProblem === null).toBe(!vaultMissing)
      expect(support.listenProblem === null).toBe(!listenMissing)

      // One notice line per missing feature, naming it and only it.
      expect(support.notice).toHaveLength(missing.length)
      for (const feature of FEATURES) {
        const reason = FEATURE_REASONS[feature]
        const lines = support.notice.filter((line) => names(line, reason))
        expect(lines).toHaveLength(env[feature] ? 0 : 1)
        // Each problem text names exactly the missing features of its group.
        const isVault = FEATURE_GROUPS[feature] === 'vault'
        expect(names(support.lockProblem, reason)).toBe(!env[feature] && isVault)
        expect(names(support.unlockProblem, reason)).toBe(!env[feature] && isVault)
        expect(names(support.listenProblem, reason)).toBe(!env[feature] && !isVault)
      }

      // WAV import, tape decoding, and the Virtual_Tape_Channel are never disabled.
      const notice = support.notice.join(' ')
      expect(notice).not.toMatch(/import|decod|virtual|tape channel/i)
      for (const problem of [support.lockProblem, support.unlockProblem, support.listenProblem]) {
        expect(problem ?? '').not.toMatch(/import|decod|virtual|tape channel/i)
      }
    }
  })

  it('says what still works whenever something is missing', () => {
    expect(STILL_AVAILABLE).toMatch(/WAV import/)
    expect(STILL_AVAILABLE).toMatch(/tape decoding/)
    expect(STILL_AVAILABLE).toMatch(/Virtual Tape Channel/)
  })
})

describe('readFeatureEnvironment', () => {
  const COMPLETE = () => ({
    crypto: { subtle: {} },
    CompressionStream: class {},
    DecompressionStream: class {},
    AudioWorkletNode: class {},
    navigator: { mediaDevices: { getUserMedia: () => undefined } },
    isSecureContext: true,
  })

  function throwingGetter<T extends object>(target: T, key: string): T {
    Object.defineProperty(target, key, {
      get() {
        throw new Error('blocked')
      },
    })
    return target
  }

  it('isolates a throwing getter at every level to its own feature', () => {
    const cases: readonly [Feature, () => object][] = [
      ['cryptoSubtle', () => throwingGetter(COMPLETE(), 'crypto')],
      ['cryptoSubtle', () => ({ ...COMPLETE(), crypto: throwingGetter({}, 'subtle') })],
      ['compressionStream', () => throwingGetter(COMPLETE(), 'CompressionStream')],
      ['decompressionStream', () => throwingGetter(COMPLETE(), 'DecompressionStream')],
      ['audioWorkletNode', () => throwingGetter(COMPLETE(), 'AudioWorkletNode')],
      ['getUserMedia', () => throwingGetter(COMPLETE(), 'navigator')],
      ['getUserMedia', () => ({ ...COMPLETE(), navigator: throwingGetter({}, 'mediaDevices') })],
      ['getUserMedia', () => ({ ...COMPLETE(), navigator: { mediaDevices: throwingGetter({}, 'getUserMedia') } })],
      ['secureContext', () => throwingGetter(COMPLETE(), 'isSecureContext')],
    ]
    for (const [feature, scope] of cases) {
      expect(readFeatureEnvironment(scope())).toEqual({ ...ALL_PRESENT, [feature]: false })
    }
  })

  it('never throws for a scope that throws on every access', () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error('blocked')
        },
        has() {
          throw new Error('blocked')
        },
      },
    )
    expect(Object.values(readFeatureEnvironment(hostile)).every((present) => present === false)).toBe(true)
  })

  it('reports null or wrongly typed globals as missing', () => {
    expect(
      readFeatureEnvironment({
        crypto: { subtle: null },
        CompressionStream: {},
        DecompressionStream: 'DecompressionStream',
        AudioWorkletNode: null,
        navigator: { mediaDevices: null },
        isSecureContext: 'true',
      }),
    ).toEqual(Object.fromEntries(FEATURES.map((feature) => [feature, false])))
    expect(readFeatureEnvironment({ ...COMPLETE(), crypto: null, navigator: null })).toMatchObject({
      cryptoSubtle: false,
      getUserMedia: false,
      compressionStream: true,
    })
  })

  it('reports every feature of a complete scope as present', () => {
    const scope = {
      crypto: { subtle: {} },
      CompressionStream: class {},
      DecompressionStream: class {},
      AudioWorkletNode: class {},
      navigator: { mediaDevices: { getUserMedia: () => undefined } },
      isSecureContext: true,
    }
    expect(readFeatureEnvironment(scope)).toEqual(ALL_PRESENT)
  })

  it('reports absent globals as missing without throwing', () => {
    expect(Object.values(readFeatureEnvironment({})).every((present) => !present)).toBe(true)
    expect(readFeatureEnvironment({ navigator: {}, crypto: {} })).toMatchObject({
      cryptoSubtle: false,
      getUserMedia: false,
    })
  })

  it('treats a throwing getter as a missing feature', () => {
    const scope = {
      get crypto(): never {
        throw new Error('blocked')
      },
      CompressionStream: class {},
    }
    expect(readFeatureEnvironment(scope)).toMatchObject({ cryptoSubtle: false, compressionStream: true })
  })

  it('reads the real globals without throwing', () => {
    expect(() => readFeatureEnvironment()).not.toThrow()
  })
})
