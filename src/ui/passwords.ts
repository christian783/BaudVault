// The two Password fields as one piece of state (design.md, "Unlock password
// field"; Requirements 7.13, 7.23, 7.24, 7.29). DOM-free and pure, so App.tsx
// runs it through `useReducer` and the transitions can be unit tested.
//
// The Lock Password (Record panel) is read only by Lock; the Unlock password
// (Vault section) is read only by Unlock. Each field changes only through its
// own action, so neither is ever prefilled from the other. Nothing here logs
// or stores either Password.

import type { UnlockFailure } from './unlock'

export type Passwords = {
  /** The Lock Password, typed in the Record panel. */
  readonly lock: string
  /** The Unlock password, typed in the Vault section. */
  readonly unlock: string
}

export const EMPTY_PASSWORDS: Passwords = { lock: '', unlock: '' }

export type PasswordAction =
  | { type: 'lock-changed'; password: string }
  | { type: 'unlock-changed'; password: string }
  /** A failed `open`; the Unlock password is emptied only after an AuthenticationError (Requirement 7.24). */
  | { type: 'unlock-failed'; failure: UnlockFailure }
  /** Clear drops both Passwords (Requirement 7.13). */
  | { type: 'cleared' }

export function passwordsReducer(state: Passwords, action: PasswordAction): Passwords {
  switch (action.type) {
    case 'lock-changed':
      return { ...state, lock: action.password }
    case 'unlock-changed':
      return { ...state, unlock: action.password }
    case 'unlock-failed':
      return action.failure.clearPassword ? { ...state, unlock: '' } : state
    case 'cleared':
      return EMPTY_PASSWORDS
  }
}
