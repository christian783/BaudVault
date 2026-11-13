import { describe, expect, it } from 'vitest'
import { AuthenticationError, UncorrectableError } from '../core/errors'
import { open, seal } from '../crypto/vault'
import { MIC_FAILURE_MESSAGES } from '../audio/microphone'
import {
  announce,
  type AnnouncementLog,
  announcementText,
  type AppEvent,
  EMPTY_ANNOUNCEMENTS,
  freshNotices,
  MAX_ANNOUNCEMENTS,
  UNLOCKED_ANNOUNCEMENT,
} from './announcements'

describe('announcementText (Requirements 9.4, 9.5)', () => {
  it('announces Carrier_Lock gained and lost', () => {
    expect(announcementText({ type: 'carrier', locked: true })).toBe('Carrier locked.')
    expect(announcementText({ type: 'carrier', locked: false })).toBe('Carrier lost.')
  })

  it('announces decode results with their corrected-byte counts', () => {
    const notices = ['Decoded vault tape from Microphone: 120 bytes, 7 bytes corrected']
    expect(announcementText({ type: 'received', notices })).toBe(
      'Decoded vault tape from Microphone: 120 bytes, 7 bytes corrected.',
    )
    expect(announcementText({ type: 'received', notices: [] })).toBeNull()
  })

  it('announces errors shown in the panels', () => {
    expect(announcementText({ type: 'lock-failed', error: new Error('anything') })).toBe('Lock failed: Unexpected error.')
    expect(announcementText({ type: 'unlock-failed', error: new UncorrectableError([2]) })).toBe(
      'Unlock failed: Too much damage to repair: codeword 2 failed.',
    )
    expect(announcementText({ type: 'unlock-failed', error: new AuthenticationError() })).toBe(
      'Unlock failed: Wrong password or damaged tape. The password field was cleared.',
    )
    expect(announcementText({ type: 'deck-message', message: MIC_FAILURE_MESSAGES.denied })).toBe(
      'Microphone access was denied.',
    )
  })

  it('announces the vault unlocking and tapes being recorded', () => {
    expect(announcementText({ type: 'unlocked' })).toBe(UNLOCKED_ANNOUNCEMENT)
    expect(announcementText({ type: 'tapes-recorded', count: 1 })).toBe('Recorded 1 tape.')
    expect(announcementText({ type: 'tapes-recorded', count: 5 })).toBe('Recorded 5 tapes.')
  })
})

describe('announcements never contain the Plaintext or Password (Requirement 9.7)', () => {
  it('leaves both out after a real seal, a failed open, and a successful open', async () => {
    const secret = 'correct horse battery staple seed words'
    const password = 'hunter2-tape-password'
    const envelope = await seal(new TextEncoder().encode(secret), password, { iterations: 1_000 })

    let wrong: unknown = null
    try {
      await open(envelope, 'not the password')
    } catch (error) {
      wrong = error
    }
    expect(wrong).toBeInstanceOf(AuthenticationError)

    const plaintext = await open(envelope, password)
    const revealed = new TextDecoder().decode(plaintext)
    expect(revealed).toBe(secret)

    const events: AppEvent[] = [
      { type: 'tapes-recorded', count: 1 },
      { type: 'unlock-failed', error: wrong },
      { type: 'unlocked' },
      { type: 'cleared' },
    ]
    let log: AnnouncementLog = EMPTY_ANNOUNCEMENTS
    for (const event of events) log = announce(log, event)

    expect(log.entries).toHaveLength(events.length)
    for (const entry of log.entries) {
      expect(entry.text).not.toContain(revealed)
      expect(entry.text).not.toContain(password)
      expect(entry.text).not.toContain('not the password')
    }
  })
})

describe('announce', () => {
  it('gives every entry a new id, repeats included, and keeps the newest few', () => {
    let log = EMPTY_ANNOUNCEMENTS
    for (let i = 0; i < MAX_ANNOUNCEMENTS + 2; i++) log = announce(log, { type: 'carrier', locked: true })
    expect(log.entries).toHaveLength(MAX_ANNOUNCEMENTS)
    expect(log.entries.map((entry) => entry.id)).toEqual([3, 4, 5, 6, 7])
    expect(new Set(log.entries.map((entry) => entry.text))).toEqual(new Set(['Carrier locked.']))
  })

  it('returns the same log when there is nothing to say', () => {
    expect(announce(EMPTY_ANNOUNCEMENTS, { type: 'received', notices: [] })).toBe(EMPTY_ANNOUNCEMENTS)
  })
})

describe('freshNotices', () => {
  const receiver = { notices: ['a', 'b', 'c'], noticeTotal: 9 }

  it('returns the notices added since the last total seen', () => {
    expect(freshNotices(7, receiver)).toEqual(['b', 'c'])
    expect(freshNotices(9, receiver)).toEqual([])
  })

  it('returns only the notices still kept when more were added', () => {
    expect(freshNotices(0, receiver)).toEqual(['a', 'b', 'c'])
  })

  it('returns nothing after Clear resets the total', () => {
    expect(freshNotices(9, { notices: [], noticeTotal: 0 })).toEqual([])
  })
})
