// Shard collection and the held Envelope (design.md, "Shard collection";
// Requirements 7.9, 7.23, 7.28). DOM-free and pure, so it can run inside a
// React state updater.
//
// - A decoded Envelope becomes the held Envelope.
// - A decoded Shard is parsed and grouped by set ID. Each group keeps one
//   Shard per index; decoding the same tape twice adds nothing.
// - Once a group holds K distinct indices, the Shard_Codec combines them and
//   the rebuilt Envelope becomes the held Envelope.
// - A Shard that fails the v1 layout, or disagrees with its group's K, N, or
//   length, is rejected with the Shard_Codec's error and the group is left
//   as it was, so every Body decoded before the failure is kept.
//
// The held Envelope is always the most recent one. Everything here is
// ciphertext (Envelopes and Shards); no Plaintext passes through.

import { BaudVaultError, ShardError } from '../core/errors'
import { combine, parseShard } from '../shamir/shamir'
import type { RecordType } from '../tape/framer'

export type ShardGroup = {
  /** Set ID shared by every Shard of one split. */
  readonly setId: number
  readonly k: number
  readonly n: number
  /** Distinct indices collected, ascending. */
  readonly indices: readonly number[]
  /** The encoded Shards, in the order of `indices`. */
  readonly shards: readonly Uint8Array[]
  /** The group has been combined into the held Envelope (or an earlier one). */
  readonly combined: boolean
}

export type HeldEnvelope = {
  readonly envelope: Uint8Array
  /** Where it came from, for display. Contains no Body bytes. */
  readonly origin: string
}

export type ShardCollection = {
  readonly groups: readonly ShardGroup[]
  readonly held: HeldEnvelope | null
}

export const EMPTY_COLLECTION: ShardCollection = { groups: [], held: null }

/** What `collectBody` did with one Body. */
export type CollectOutcome =
  | { kind: 'held' }
  | { kind: 'shard-added' }
  | { kind: 'rebuilt'; shardCount: number }
  | { kind: 'duplicate' }
  | { kind: 'failed'; error: BaudVaultError }

/** A set ID as eight upper-case hex digits, for example "1A2B3C4D". */
export function formatSetId(setId: number): string {
  return (setId >>> 0).toString(16).toUpperCase().padStart(8, '0')
}

/**
 * Adds one decoded Body to the collection. `source` names where it came from
 * (a file name, "Microphone", or a tape label). Returns `collection` itself
 * when nothing changes.
 */
export function collectBody(
  collection: ShardCollection,
  type: RecordType,
  body: Uint8Array,
  source: string,
): { collection: ShardCollection; outcome: CollectOutcome } {
  if (type === 'envelope') {
    return {
      collection: { ...collection, held: { envelope: body, origin: `vault tape from ${source}` } },
      outcome: { kind: 'held' },
    }
  }

  let info: ReturnType<typeof parseShard>
  try {
    info = parseShard(body)
  } catch (error) {
    return failed(collection, error)
  }

  const at = collection.groups.findIndex((group) => group.setId === info.setId)
  const group: ShardGroup =
    at >= 0
      ? collection.groups[at]!
      : { setId: info.setId, k: info.k, n: info.n, indices: [], shards: [], combined: false }

  if (group.k !== info.k || group.n !== info.n) return failed(collection, new ShardError('different-threshold'))
  const first = group.shards[0]
  if (first !== undefined && first.length !== body.length) {
    return failed(collection, new ShardError('different-length'))
  }
  if (group.indices.includes(info.index)) return { collection, outcome: { kind: 'duplicate' } }

  const order = [...group.indices.map((index, i) => ({ index, shard: group.shards[i]! })), { index: info.index, shard: body }]
  order.sort((a, b) => a.index - b.index)
  let next: ShardGroup = {
    ...group,
    indices: order.map((entry) => entry.index),
    shards: order.map((entry) => entry.shard),
  }

  let held = collection.held
  let outcome: CollectOutcome = { kind: 'shard-added' }
  if (!group.combined && next.indices.length >= next.k) {
    let envelope: Uint8Array
    try {
      envelope = combine(next.shards)
    } catch (error) {
      return failed(collection, error)
    }
    next = { ...next, combined: true }
    held = { envelope, origin: `${next.indices.length} shards of set ${formatSetId(next.setId)}` }
    outcome = { kind: 'rebuilt', shardCount: next.indices.length }
  }

  const groups = at >= 0 ? collection.groups.map((g, i) => (i === at ? next : g)) : [...collection.groups, next]
  return { collection: { groups, held }, outcome }
}

function failed(collection: ShardCollection, error: unknown): { collection: ShardCollection; outcome: CollectOutcome } {
  // parseShard and combine throw only BaudVaultErrors; anything else is a bug.
  if (!(error instanceof BaudVaultError)) throw error
  return { collection, outcome: { kind: 'failed', error } }
}

/** One set that has at least one but fewer than K distinct Shards (Requirement 7.9). */
export type ShardProgress = { readonly setId: number; readonly have: number; readonly k: number }

export function pendingShardSets(collection: ShardCollection): ShardProgress[] {
  return collection.groups
    .filter((group) => !group.combined && group.indices.length >= 1 && group.indices.length < group.k)
    .map((group) => ({ setId: group.setId, have: group.indices.length, k: group.k }))
}

/** Text for one pending set, for example "Set 1A2B3C4D: 1 of 3 shards needed". */
export function shardProgressText(progress: ShardProgress): string {
  return `Set ${formatSetId(progress.setId)}: ${progress.have} of ${progress.k} shards needed`
}
