// Renders UnlockSection to static HTML with react-dom/server, which runs in
// Vitest's node environment without a DOM library. Interaction (typing,
// Enter, clicks) is not reachable this way; the state transitions behind it
// are tested in passwords.test.ts.

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AuthenticationError } from '../core/errors'
import { EMPTY_PASSWORDS, passwordsReducer } from './passwords'
import { EMPTY_RECEIVER, type ReceiverState } from './receiver'
import { SHORT_PASSWORD_WARNING } from './record-rules'
import { unlockFailure, unlockReadiness } from './unlock'
import { UnlockSection, type UnlockSectionProps } from './UnlockSection'

const HELD: ReceiverState = {
  ...EMPTY_RECEIVER,
  collection: { groups: [], held: { envelope: new Uint8Array(64), origin: 'tape.wav' } },
}

function render(receiver: ReceiverState, unlockPassword: string): string {
  const props: UnlockSectionProps = {
    receiver,
    readiness: unlockReadiness(receiver.collection.held !== null, unlockPassword, false),
    unlockPassword,
    onUnlockPasswordChange: () => {},
    busy: false,
    opening: false,
    onUnlock: () => {},
    unlockError: null,
    recovered: null,
    revealed: false,
    onRevealChange: () => {},
    onClear: () => {},
  }
  return renderToStaticMarkup(<UnlockSection {...props} />)
}

function inputs(markup: string): string[] {
  return markup.match(/<input\b[^>]*>/g) ?? []
}

describe('Unlock password field (Requirement 7.29)', () => {
  it('is not shown while no Envelope is held', () => {
    const markup = render(EMPTY_RECEIVER, '')
    expect(inputs(markup)).toEqual([])
    expect(markup).not.toContain('Unlock password')
    expect(markup).toContain('No vault to unlock yet.')
  })

  it('is shown, masked and labelled, while an Envelope is held', () => {
    const markup = render(HELD, '')
    const fields = inputs(markup)
    expect(fields).toHaveLength(1)
    const field = fields[0]!
    expect(field).toContain('type="password"')
    expect(field).toContain('autoComplete="off"')
    expect(field).toContain('spellCheck="false"')
    expect(field).toContain('value=""')
    const id = /\bid="([^"]+)"/.exec(field)?.[1]
    expect(id).toBeDefined()
    expect(markup).toContain(`<label for="${id}">Unlock password</label>`)
  })

  it('shows the Unlock password prop and enables Unlock from it alone (Requirement 7.23)', () => {
    const empty = render(HELD, '')
    expect(empty).toContain('Enter the unlock password to unlock.')
    expect(empty).toMatch(/<button type="submit"[^>]*disabled=""/)

    const filled = render(HELD, 'unlock pw')
    expect(inputs(filled)[0]).toContain('value="unlock pw"')
    expect(filled).not.toMatch(/<button type="submit"[^>]*disabled=""/)
  })

  it('has no short-password warning', () => {
    for (const password of ['', 'a', 'eleven char']) {
      expect(render(HELD, password)).not.toContain(SHORT_PASSWORD_WARNING)
    }
  })
})

describe('Unlock password field after a failure or Clear (Requirements 7.13, 7.24)', () => {
  it('is empty after an AuthenticationError while the Envelope stays held', () => {
    const typed = passwordsReducer(
      passwordsReducer(EMPTY_PASSWORDS, { type: 'lock-changed', password: 'lock pw' }),
      { type: 'unlock-changed', password: 'wrong pw' },
    )
    const after = passwordsReducer(typed, { type: 'unlock-failed', failure: unlockFailure(new AuthenticationError()) })
    const markup = render(HELD, after.unlock)
    expect(inputs(markup)[0]).toContain('value=""')
    expect(markup).toContain('Ready to unlock: tape.wav.')
  })

  it('is gone after Clear empties the held Envelope', () => {
    const after = passwordsReducer({ lock: 'lock pw', unlock: 'unlock pw' }, { type: 'cleared' })
    expect(after.unlock).toBe('')
    expect(inputs(render(EMPTY_RECEIVER, after.unlock))).toEqual([])
  })
})
