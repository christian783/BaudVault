// The Lock pipeline and tape descriptors (design.md, "Lock (seal and write)";
// Requirements 7.14, 7.15, 7.16). DOM-free.
//
// Lock seals the Plaintext with the production iteration count (no options
// are passed to `seal`), splits the Envelope when sharding is chosen, and
// frames each Body as one tape. A tape keeps only its Tape_Record bytes
// (ciphertext and framing); audio is modulated on demand for Play and
// Download, because a maximum-size Standard_Mode tape is about 30 million
// samples.

import { seal } from '../crypto/vault'
import { modulatedLength, SAMPLE_RATE } from '../modem/kcs-modulator'
import { split } from '../shamir/shamir'
import { type BaudRate, frame, type RecordType } from '../tape/framer'

/** Standard_Mode (300 baud) or Turbo_Mode (2,400 baud). */
export type Mode = 'standard' | 'turbo'

export const MODES: readonly Mode[] = ['standard', 'turbo']

export const MODE_BAUD: Readonly<Record<Mode, BaudRate>> = { standard: 300, turbo: 2400 }

export const MODE_LABELS: Readonly<Record<Mode, string>> = {
  standard: 'Standard, 300 baud',
  turbo: 'Turbo, 2,400 baud',
}

/** No sharding, 2-of-3, or 3-of-5 (Requirement 7.15). */
export type Sharding = 'none' | '2-of-3' | '3-of-5'

export const SHARDINGS: readonly Sharding[] = ['none', '2-of-3', '3-of-5']

export const SHARDING_SPLITS: Readonly<Record<Sharding, { k: number; n: number } | null>> = {
  none: null,
  '2-of-3': { k: 2, n: 3 },
  '3-of-5': { k: 3, n: 5 },
}

export const SHARDING_LABELS: Readonly<Record<Sharding, string>> = {
  none: 'No sharding',
  '2-of-3': '2 of 3 tapes',
  '3-of-5': '3 of 5 tapes',
}

export type Tape = {
  /** Unique within the session; used as the React key and the playing marker. */
  id: number
  type: RecordType
  mode: Mode
  baud: BaudRate
  /** The Tape_Record: Header_Frames and Codewords of an Envelope or Shard. */
  record: Uint8Array<ArrayBuffer>
  /** Shard position, or null for an Envelope tape. */
  shard: { index: number; k: number; n: number } | null
  /** Human-readable name, for example "Shard 2 of 3". */
  label: string
  /** Suggested WAV download name. */
  fileName: string
  /** Playing time including leader and trailer. */
  durationSeconds: number
}

/**
 * Seals `plaintext`, splits the Envelope if `sharding` asks for it, and
 * returns one tape per Body. The caller owns `plaintext` and zeroes it.
 * Tape ids run from `firstId` upward.
 *
 * @throws InputError from the Vault_Engine, Shard_Codec, or Tape_Framer
 */
export async function lockSecret(
  plaintext: Uint8Array,
  password: string,
  mode: Mode,
  sharding: Sharding,
  firstId = 1,
): Promise<Tape[]> {
  const baud = MODE_BAUD[mode]
  const envelope = await seal(plaintext, password)
  const splitSpec = SHARDING_SPLITS[sharding]
  if (splitSpec === null) {
    return [makeTape(firstId, frame(envelope, 'envelope', baud), mode, null)]
  }
  const { k, n } = splitSpec
  return split(envelope, k, n).map((shard, i) =>
    makeTape(firstId + i, frame(shard, 'shard', baud), mode, { index: i + 1, k, n }),
  )
}

function makeTape(
  id: number,
  record: Uint8Array<ArrayBuffer>,
  mode: Mode,
  shard: Tape['shard'],
): Tape {
  const baud = MODE_BAUD[mode]
  const label = shard === null ? 'Vault tape' : `Shard ${shard.index} of ${shard.n}`
  const fileName =
    shard === null ? `baudvault-${mode}.wav` : `baudvault-${mode}-shard-${shard.index}-of-${shard.n}.wav`
  return {
    id,
    type: shard === null ? 'envelope' : 'shard',
    mode,
    baud,
    record,
    shard,
    label,
    fileName,
    durationSeconds: modulatedLength(record.length, baud) / SAMPLE_RATE,
  }
}

/** Formats a playing time: "7.6 s" under a minute, otherwise "11 min 38 s". */
export function formatDuration(seconds: number): string {
  if (seconds < 59.95) return `${seconds.toFixed(1)} s`
  const whole = Math.round(seconds)
  return `${Math.floor(whole / 60)} min ${whole % 60} s`
}
