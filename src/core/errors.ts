// Error classes for every failure BaudVault reports (design.md, "Errors").
//
// Requirement 8.9: no error may carry Plaintext, a Password, key material, or
// decrypted bytes. Every constructor therefore takes either nothing, a fixed
// reason from a closed set, or a short description written as a literal at the
// throw site plus safe numbers (sizes, limits, indices, sample rates). Never
// build a description from decoded or user-supplied data, and never attach a
// `cause`, because a cause could hold a buffer or a key.

/** Stable codes the UI maps to messages (design.md, "Error display"). */
export type ErrorCode = 'INPUT' | 'FORMAT' | 'AUTH' | 'SHARD' | 'UNCORRECTABLE' | 'INTEGRITY'

/** Base class for every error BaudVault throws on purpose. */
export abstract class BaudVaultError extends Error {
  readonly code: ErrorCode

  protected constructor(code: ErrorCode, name: string, message: string) {
    super(message)
    this.code = code
    // Set explicitly: minified builds rename classes, so `constructor.name` is unreliable.
    this.name = name
  }
}

/** Formats a description and an optional safe number, for example `"unsupported sample rate 8000 Hz"`. */
function describe(description: string, value: number | undefined, unit: string | undefined): string {
  if (value === undefined) return description
  return unit === undefined ? `${description} ${value}` : `${description} ${value} ${unit}`
}

/**
 * The caller passed invalid arguments: a size outside its limit, an empty
 * Password, or K and N out of range.
 */
export class InputError extends BaudVaultError {
  /** The literal description given at the throw site. */
  readonly detail: string
  readonly value: number | undefined

  /**
   * @param description a literal such as `"plaintext must be 1 to 15360 bytes"`
   * @param value an optional safe number, such as the rejected length
   * @param unit an optional literal unit for `value`, such as `"bytes"`
   */
  constructor(description: string, value?: number, unit?: string) {
    super('INPUT', 'InputError', describe(description, value, unit))
    this.detail = description
    this.value = value
  }
}

/**
 * Bytes or a file do not match a defined layout, or decompressed output
 * exceeds the cap. The message names the unsupported property.
 */
export class FormatError extends BaudVaultError {
  /** The literal property description given at the throw site, for the UI. */
  readonly detail: string
  readonly value: number | undefined

  /**
   * @param description a literal naming the property, such as `"unsupported sample rate"`
   * @param value an optional safe number, such as `8000`
   * @param unit an optional literal unit for `value`, such as `"Hz"`
   */
  constructor(description: string, value?: number, unit?: string) {
    super('FORMAT', 'FormatError', describe(description, value, unit))
    this.detail = description
    this.value = value
  }
}

/** AES-GCM rejected the Envelope: wrong Password or a tampered tape. */
export class AuthenticationError extends BaudVaultError {
  constructor() {
    super('AUTH', 'AuthenticationError', 'envelope failed authentication')
  }
}

/** Why a set of Shards cannot be combined. */
export type ShardErrorReason =
  | 'too-few'
  | 'different-set'
  | 'different-threshold'
  | 'different-length'
  | 'duplicate-index'

const SHARD_MESSAGES: Record<Exclude<ShardErrorReason, 'too-few'>, string> = {
  'different-set': 'shards come from different sets',
  'different-threshold': 'shards declare different K or N',
  'different-length': 'shards have different lengths',
  'duplicate-index': 'two shards share an index',
}

/** Shards are too few, from different sets, inconsistent, or duplicated. */
export class ShardError extends BaudVaultError {
  readonly reason: ShardErrorReason
  /** How many more Shards are needed; set only when `reason` is `'too-few'`. */
  readonly missing: number | undefined

  constructor(reason: 'too-few', missing: number)
  constructor(reason: Exclude<ShardErrorReason, 'too-few'>)
  constructor(reason: ShardErrorReason, missing?: number) {
    const message =
      reason === 'too-few'
        ? `need ${missing} more shard${missing === 1 ? '' : 's'}`
        : SHARD_MESSAGES[reason]
    super('SHARD', 'ShardError', message)
    this.reason = reason
    this.missing = reason === 'too-few' ? missing : undefined
  }
}

/**
 * One or more Codewords have more than 16 byte errors. `rsDecode` throws it
 * with no blocks; the framer, which knows the block indices, throws a new one
 * listing every failed Codeword.
 */
export class UncorrectableError extends BaudVaultError {
  /** Zero-based indices of the uncorrectable Codewords in the Tape_Record. */
  readonly blocks: readonly number[]

  constructor(blocks: readonly number[] = []) {
    super(
      'UNCORRECTABLE',
      'UncorrectableError',
      blocks.length === 0 ? 'uncorrectable codeword' : `uncorrectable codewords: ${blocks.join(', ')}`,
    )
    this.blocks = Object.freeze([...blocks])
  }
}

/** The restored Body does not match the CRC-32 in its Header_Frame. */
export class IntegrityError extends BaudVaultError {
  constructor() {
    super('INTEGRITY', 'IntegrityError', 'body failed CRC-32 check')
  }
}
