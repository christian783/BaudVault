// The Readout panel's vault controls: received tapes, Shard progress, Unlock,
// the masked recovered secret with Reveal, and Clear (design.md, "Deck_UI";
// Requirements 7.9, 7.12, 7.13, 7.23, 7.24, 7.27, 7.28, 7.29).
//
// Unlock opens the held Envelope with the Unlock password typed here, never
// with the Lock Password from the Record panel. The Unlock password field is
// shown only while an Envelope is held, starts empty, and does not take
// focus when it appears. It is `type="password"` with autocomplete and spell
// checking off, and has no short-password warning (design.md, "Unlock
// password field"). Enter in the field submits the form, which unlocks only
// when Unlock is ready.
//
// While the secret is masked, the DOM holds only SECRET_MASK, so assistive
// technology sees only the mask (Requirement 9.8). The Plaintext is decoded
// to text only while revealed, and only into the DOM: nothing here logs or
// stores it or either Password.

import { useId } from 'react'
import type { ReceiverState } from './receiver'
import { pendingShardSets, shardProgressText } from './shard-collection'
import { revealText, SECRET_MASK, type UnlockReadiness } from './unlock'

export type UnlockSectionProps = {
  receiver: ReceiverState
  readiness: UnlockReadiness
  /** The Unlock password, separate from the Lock Password (Requirement 7.29). */
  unlockPassword: string
  onUnlockPasswordChange: (password: string) => void
  /** A seal or open is running (Requirement 7.27). */
  busy: boolean
  /** An open is running. */
  opening: boolean
  onUnlock: () => void
  /** The last Unlock failure, or null. */
  unlockError: string | null
  /** The recovered Plaintext, or null. */
  recovered: Uint8Array | null
  revealed: boolean
  onRevealChange: (revealed: boolean) => void
  onClear: () => void
}

export function UnlockSection(props: UnlockSectionProps) {
  const id = useId()
  const ids = {
    title: `${id}-title`,
    secret: `${id}-secret`,
    problem: `${id}-problem`,
    password: `${id}-unlock-password`,
  }
  const { receiver, readiness } = props
  const held = receiver.collection.held
  const pending = pendingShardSets(receiver.collection)
  const problemId = readiness.problem !== null ? ids.problem : undefined

  return (
    <section aria-labelledby={ids.title} className="flex flex-col gap-3">
      <h3 id={ids.title} className="subtitle">
        Vault
      </h3>

      <div>
        <h4 className="font-bold">Received</h4>
        {receiver.notices.length === 0 ? (
          <p className="hint">Nothing decoded yet.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {receiver.notices.map((notice, index) => (
              <li key={`${receiver.nextId}-${index}`} className="hint">
                {notice}
              </li>
            ))}
          </ul>
        )}
      </div>

      {pending.length > 0 && (
        <ul className="flex flex-col gap-1">
          {pending.map((set) => (
            <li key={set.setId}>{shardProgressText(set)}</li>
          ))}
        </ul>
      )}

      <p>{held === null ? 'No vault to unlock yet.' : `Ready to unlock: ${held.origin}.`}</p>

      {readiness.problem !== null && (
        <p id={ids.problem} className="warning">
          {readiness.problem}
        </p>
      )}

      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault()
          if (readiness.ready) props.onUnlock()
        }}
      >
        {held !== null && (
          <div className="field">
            <label htmlFor={ids.password}>Unlock password</label>
            <input
              id={ids.password}
              className="control"
              type="password"
              value={props.unlockPassword}
              onChange={(event) => props.onUnlockPasswordChange(event.currentTarget.value)}
              autoComplete="off"
              spellCheck={false}
              aria-describedby={problemId}
            />
          </div>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <button type="submit" className="button" disabled={!readiness.ready} aria-describedby={problemId}>
            {props.opening ? 'Unlocking…' : 'Unlock'}
          </button>
          <button type="button" className="button" onClick={props.onClear}>
            Clear
          </button>
          {props.busy && <span className="busy">Busy: deriving the key…</span>}
        </div>
      </form>

      {props.unlockError !== null && <p className="warning">{props.unlockError}</p>}

      {props.recovered !== null && (
        <div role="group" aria-labelledby={ids.secret} className="flex flex-col gap-2">
          <p id={ids.secret} className="font-bold">
            Recovered secret
          </p>
          <p className="secret">
            {props.revealed ? revealText(props.recovered) : SECRET_MASK}
          </p>
          <div>
            <button type="button" className="button" onClick={() => props.onRevealChange(!props.revealed)}>
              {props.revealed ? 'Hide' : 'Reveal'}
            </button>
          </div>
        </div>
      )}
    </section>
  )
}
