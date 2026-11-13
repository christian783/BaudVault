// Error text for the UI (design.md, "Error display"; Requirements 7.24,
// 7.28, 8.9). DOM-free.
//
// Each BaudVaultError `code` maps to a fixed message that names the failure
// type, plus the safe detail the error carries: the property named by a
// FormatError, the failed block indices of an UncorrectableError, the reason
// of a ShardError, or the limit of an InputError. Those details are literals
// and safe numbers from the throw site (src/core/errors.ts), never secret
// material. Any other error gets a fixed message, because its text is not
// controlled.

import { BaudVaultError, type ErrorCode, UncorrectableError } from '../core/errors'

/** The message for each error code, before any detail. */
export const ERROR_MESSAGES: Readonly<Record<ErrorCode, string>> = {
  AUTH: 'Wrong password or damaged tape',
  FORMAT: 'Unreadable file or tape format',
  UNCORRECTABLE: 'Too much damage to repair',
  INTEGRITY: 'Integrity check failed after repair',
  SHARD: 'Shards do not combine',
  INPUT: 'Input outside the allowed limits',
}

export const UNEXPECTED_ERROR_MESSAGE = 'Unexpected error'

function blockList(blocks: readonly number[]): string {
  const noun = blocks.length === 1 ? 'codeword' : 'codewords'
  return `${noun} ${blocks.join(', ')} failed`
}

/** The UI message for `error`, following the table in design.md. */
export function errorText(error: unknown): string {
  if (!(error instanceof BaudVaultError)) return UNEXPECTED_ERROR_MESSAGE
  const base = ERROR_MESSAGES[error.code]
  switch (error.code) {
    case 'AUTH':
    case 'INTEGRITY':
      return base
    case 'UNCORRECTABLE': {
      const blocks = error instanceof UncorrectableError ? error.blocks : []
      return blocks.length === 0 ? base : `${base}: ${blockList(blocks)}`
    }
    case 'FORMAT':
    case 'SHARD':
    case 'INPUT':
      return `${base}: ${error.message}`
  }
}
