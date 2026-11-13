// The Readout panel's vault controls: received tapes, Shard progress, Unlock,
// the masked recovered secret with Reveal, and Clear (design.md, "Deck_UI";
// Requirements 7.9, 7.12, 7.13, 7.23, 7.24, 7.27, 7.28).
//
// Unlock uses the Password entered in the Record panel, the only Password
// field. While the secret is masked, the DOM holds only SECRET_MASK, so
// assistive technology sees only the mask (Requirement 9.8). The Plaintext is
// decoded to text only while revealed, and only into the DOM: nothing here
// logs or stores it.

import { useId } from 'react'
import type { ReceiverState } from './receiver'
import { pendingShardSets, shardProgressText } from './shard-collection'
import { revealText, SECRET_MASK, type UnlockReadiness } from './unlock'

export type UnlockSectionProps = {
  receiver: ReceiverState
  readiness: UnlockReadiness
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
  const ids = { title: `${id}-title`, secret: `${id}-secret`, problem: `${id}-problem` }
  const { receiver, readiness } = props
  const held = receiver.collection.held
  const pending = pendingShardSets(receiver.collection)

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

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          className="button"
          onClick={props.onUnlock}
          disabled={!readiness.ready}
          aria-describedby={readiness.problem !== null ? ids.problem : undefined}
        >
          {props.opening ? 'Unlocking…' : 'Unlock'}
        </button>
        <button type="button" className="button" onClick={props.onClear}>
          Clear
        </button>
        {props.busy && <span className="busy">Busy: deriving the key…</span>}
      </div>
      {held !== null && <p className="hint">Unlock uses the password entered in the Record panel.</p>}

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
