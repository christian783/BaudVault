// Record panel: secret, Password, mode, sharding, and Lock (design.md,
// "Controls" and "Password warning"; Requirements 7.1, 7.14, 7.15, 7.16,
// 7.25, 7.26, 7.27). The same Password field is used by Unlock in the
// Readout panel.
//
// The secret field turns off spell checking, autocorrect, and autocomplete:
// some browsers send spell-check text to a remote service, and autocomplete
// would store the secret. The Password field is `type="password"` with
// autocomplete off so the browser does not offer to save it.

import { useId } from 'react'
import { MAX_PLAINTEXT_BYTES } from '../crypto/vault'
import { isShortPassword, lockReadiness, SHORT_PASSWORD_WARNING } from './record-rules'
import { type Mode, MODE_LABELS, MODES, type Sharding, SHARDING_LABELS, SHARDINGS } from './tapes'

export type RecordPanelProps = {
  secret: string
  onSecretChange: (secret: string) => void
  password: string
  onPasswordChange: (password: string) => void
  mode: Mode
  onModeChange: (mode: Mode) => void
  sharding: Sharding
  onShardingChange: (sharding: Sharding) => void
  onLock: () => void
  /** A seal is running. */
  sealing: boolean
  /** A seal or open is running; Lock is disabled (Requirement 7.27). */
  busy: boolean
  /** The last Lock failure, or null. */
  lockError: string | null
  /** Why the browser cannot seal (`FeatureSupport.lockProblem`), or null (Requirement 10.2). */
  lockUnavailable: string | null
}

export function RecordPanel(props: RecordPanelProps) {
  const id = useId()
  const readiness = lockReadiness(props.secret, props.password, props.lockUnavailable)
  const shortPassword = isShortPassword(props.password)
  const ids = {
    title: `${id}-title`,
    secret: `${id}-secret`,
    secretSize: `${id}-secret-size`,
    password: `${id}-password`,
    warning: `${id}-warning`,
    problem: `${id}-problem`,
  }

  return (
    <section aria-labelledby={ids.title} className="panel">
      <h2 id={ids.title} className="panel-title">
        Record
      </h2>

      <div className="field">
        <label htmlFor={ids.secret}>Secret</label>
        <textarea
          id={ids.secret}
          className="control min-h-24 resize-y"
          value={props.secret}
          onChange={(event) => props.onSecretChange(event.currentTarget.value)}
          rows={4}
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          aria-describedby={ids.secretSize}
        />
        <p id={ids.secretSize} className="hint">
          {readiness.secretBytes.toLocaleString('en-US')} of {MAX_PLAINTEXT_BYTES.toLocaleString('en-US')} bytes
        </p>
      </div>

      <div className="field">
        <label htmlFor={ids.password}>Password</label>
        <input
          id={ids.password}
          className="control"
          type="password"
          value={props.password}
          onChange={(event) => props.onPasswordChange(event.currentTarget.value)}
          autoComplete="off"
          spellCheck={false}
          aria-describedby={shortPassword ? ids.warning : undefined}
        />
        {shortPassword && (
          <p id={ids.warning} className="warning">
            <span aria-hidden="true">⚠ </span>
            {SHORT_PASSWORD_WARNING}
          </p>
        )}
      </div>

      <fieldset className="field">
        <legend>Mode</legend>
        <div className="choices">
          {MODES.map((mode) => (
            <label key={mode} className="choice">
              <input
                type="radio"
                name={`${id}-mode`}
                value={mode}
                checked={props.mode === mode}
                onChange={() => props.onModeChange(mode)}
              />
              {MODE_LABELS[mode]}
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="field">
        <legend>Sharding</legend>
        <div className="choices">
          {SHARDINGS.map((sharding) => (
            <label key={sharding} className="choice">
              <input
                type="radio"
                name={`${id}-sharding`}
                value={sharding}
                checked={props.sharding === sharding}
                onChange={() => props.onShardingChange(sharding)}
              />
              {SHARDING_LABELS[sharding]}
            </label>
          ))}
        </div>
      </fieldset>

      {readiness.problem !== null && (
        <p id={ids.problem} className="warning">
          {readiness.problem}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          className="button"
          onClick={props.onLock}
          disabled={!readiness.ready || props.busy}
          aria-describedby={readiness.problem !== null ? ids.problem : undefined}
        >
          {props.sealing ? 'Locking…' : 'Lock'}
        </button>
        {props.busy && <span className="busy">Busy: deriving the key…</span>}
        {!props.busy && !readiness.ready && readiness.problem === null && (
          <span className="hint">Enter a secret and a password to lock.</span>
        )}
      </div>

      {props.lockError !== null && <p className="warning">Lock failed: {props.lockError}</p>}
    </section>
  )
}
