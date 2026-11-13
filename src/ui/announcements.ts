// Text for the polite live region (design.md, "Accessibility"; Requirements
// 9.4, 9.5, 9.7). DOM-free and pure.
//
// The region announces Carrier_Lock gained and lost, decode results (the
// Receiver notices, which carry the corrected-byte counts), errors shown in
// the panels, tapes recorded, the vault unlocked, and Clear. No event type
// carries the Plaintext or the Password: errors become text through
// `errorText`, whose details are fixed literals and safe numbers, and
// `unlocked` carries no data at all, so the recovered secret can never reach
// an announcement.
//
// Announcements are kept as a short log of separate entries. Each new entry
// is a new DOM node, so a screen reader announces it even when the same text
// repeats or two results arrive in the same frame.

import { errorText } from './messages'
import type { ReceiverState } from './receiver'
import { unlockFailure } from './unlock'

export type AppEvent =
  /** The LOCK lamp turned on or off. */
  | { type: 'carrier'; locked: boolean }
  /** New Receiver notices: decode results and decode, read, or combine failures. */
  | { type: 'received'; notices: readonly string[] }
  /** Lock finished and made this many tapes. */
  | { type: 'tapes-recorded'; count: number }
  | { type: 'lock-failed'; error: unknown }
  | { type: 'unlocked' }
  | { type: 'unlock-failed'; error: unknown }
  /** A Deck failure shown in the Deck panel, such as "Microphone access was denied". */
  | { type: 'deck-message'; message: string }
  | { type: 'cleared' }

export const UNLOCKED_ANNOUNCEMENT = 'Vault unlocked. The recovered secret is masked; select Reveal to show it.'
export const CLEARED_ANNOUNCEMENT = 'Cleared the secret, the password, the tapes, and every decoded tape.'

/** Ends `text` with a period unless it already ends with punctuation. */
function sentence(text: string): string {
  return /[.!?…]$/.test(text) ? text : `${text}.`
}

/** The announcement for one event, or null when there is nothing to say. */
export function announcementText(event: AppEvent): string | null {
  switch (event.type) {
    case 'carrier':
      return event.locked ? 'Carrier locked.' : 'Carrier lost.'
    case 'received':
      return event.notices.length === 0 ? null : event.notices.map(sentence).join(' ')
    case 'tapes-recorded':
      return event.count === 1 ? 'Recorded 1 tape.' : `Recorded ${event.count} tapes.`
    case 'lock-failed':
      return sentence(`Lock failed: ${errorText(event.error)}`)
    case 'unlocked':
      return UNLOCKED_ANNOUNCEMENT
    case 'unlock-failed': {
      const failure = unlockFailure(event.error)
      const text = sentence(`Unlock failed: ${failure.message}`)
      return failure.clearPassword ? `${text} The password field was cleared.` : text
    }
    case 'deck-message':
      return sentence(event.message)
    case 'cleared':
      return CLEARED_ANNOUNCEMENT
  }
}

export type Announcement = { readonly id: number; readonly text: string }

export type AnnouncementLog = { readonly entries: readonly Announcement[]; readonly nextId: number }

/** Entries kept in the DOM. Older ones are removed, which screen readers do not announce. */
export const MAX_ANNOUNCEMENTS = 5

export const EMPTY_ANNOUNCEMENTS: AnnouncementLog = { entries: [], nextId: 1 }

/** Adds the announcement for `event`. Returns `log` itself when there is nothing to say. */
export function announce(log: AnnouncementLog, event: AppEvent): AnnouncementLog {
  const text = announcementText(event)
  if (text === null) return log
  return {
    entries: [...log.entries, { id: log.nextId, text }].slice(-MAX_ANNOUNCEMENTS),
    nextId: log.nextId + 1,
  }
}

/**
 * The Receiver notices added since `seenTotal` notices had been seen, oldest
 * first. After Clear resets the Receiver, the total drops and nothing is new.
 */
export function freshNotices(seenTotal: number, receiver: Pick<ReceiverState, 'notices' | 'noticeTotal'>): readonly string[] {
  const added = receiver.noticeTotal - seenTotal
  if (added <= 0) return []
  return receiver.notices.slice(-Math.min(added, receiver.notices.length))
}
