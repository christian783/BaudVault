// Deck panel: the cassette reels, tapes with Play and Download, WAV import,
// Listen and Stop, and the Virtual_Tape_Channel controls (design.md,
// "Controls"; Requirements 6.1, 6.2, 7.10, 7.11, 7.17 to 7.22).

import { type ChangeEvent, useId } from 'react'
import {
  type ChannelControls,
  clampPercent,
  HISS_PERCENT_MAX,
  HISS_PERCENT_STEP,
  WOW_PERCENT_MAX,
  WOW_PERCENT_STEP,
} from './channel-controls'
import { formatDuration, MODE_LABELS, type Tape } from './tapes'

export type DeckPanelProps = {
  tapes: readonly Tape[]
  playingId: number | null
  onPlay: (tape: Tape) => void
  onDownload: (tape: Tape) => void
  onImport: (files: File[]) => void
  importing: boolean
  listening: boolean
  micStarting: boolean
  onListen: () => void
  onStop: () => void
  channel: ChannelControls
  onChannelChange: (channel: ChannelControls) => void
  /** The latest Deck failure, such as "Microphone access was denied". */
  message: string | null
  /** Why the browser cannot listen (`FeatureSupport.listenProblem`), or null (Requirement 10.3). */
  listenUnavailable: string | null
}

const ACCEPTED_FILES = '.wav,audio/wav,audio/x-wav,audio/wave'

/** One cassette reel: a hub with six teeth. Spins through the `.reel-turning` CSS class. */
function Reel({ turning }: { turning: boolean }) {
  return (
    <svg viewBox="0 0 40 40" className={turning ? 'reel reel-turning' : 'reel'}>
      <circle cx="20" cy="20" r="18" fill="none" stroke="currentColor" strokeWidth="2" />
      <circle cx="20" cy="20" r="6" fill="none" stroke="currentColor" strokeWidth="2" />
      {[0, 60, 120, 180, 240, 300].map((angle) => (
        <line
          key={angle}
          x1="20"
          y1="8"
          x2="20"
          y2="14"
          stroke="currentColor"
          strokeWidth="2"
          transform={`rotate(${angle} 20 20)`}
        />
      ))}
    </svg>
  )
}

/**
 * The cassette window. Its reels turn while audio plays or the microphone
 * listens (Requirement 7.10). The animation is defined only for
 * `prefers-reduced-motion: no-preference`, so the reels stay still when the
 * operating system asks for reduced motion (Requirement 7.11). Decorative,
 * so hidden from assistive technology; the tape state is in the text.
 */
function Cassette({ turning }: { turning: boolean }) {
  return (
    <div aria-hidden="true" className="cassette">
      <Reel turning={turning} />
      <div className="cassette-window" />
      <Reel turning={turning} />
    </div>
  )
}

export function DeckPanel(props: DeckPanelProps) {
  const id = useId()
  const { channel, onChannelChange } = props
  const ids = {
    title: `${id}-title`,
    import: `${id}-import`,
    listenProblem: `${id}-listen-problem`,
    channel: `${id}-channel`,
    hiss: `${id}-hiss`,
    wow: `${id}-wow`,
  }
  const active = props.playingId !== null || props.listening || props.micStarting
  const turning = props.playingId !== null || props.listening

  const handleImport = (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget
    const files = [...(input.files ?? [])]
    // Clear the selection so choosing the same file again imports it again.
    input.value = ''
    props.onImport(files)
  }

  return (
    <section aria-labelledby={ids.title} className="panel">
      <h2 id={ids.title} className="panel-title">
        Deck
      </h2>

      <Cassette turning={turning} />

      <div className="field">
        <h3 className="subtitle">Tapes</h3>
        {props.tapes.length === 0 ? (
          <p className="hint">No tapes yet. Lock a secret to record one.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {props.tapes.map((tape) => {
              const playing = props.playingId === tape.id
              return (
                <li key={tape.id} className="tape">
                  <div className="min-w-0 grow">
                    <p className="font-bold">
                      {tape.label}
                      {playing && <span className="ml-2">[PLAYING]</span>}
                    </p>
                    <p className="hint">
                      {MODE_LABELS[tape.mode]}, {formatDuration(tape.durationSeconds)}
                      {tape.shard !== null && `, any ${tape.shard.k} unlock`}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      className="button"
                      onClick={() => props.onPlay(tape)}
                      aria-label={`Play ${tape.label}`}
                    >
                      Play
                    </button>
                    <button
                      type="button"
                      className="button"
                      onClick={() => props.onDownload(tape)}
                      aria-label={`Download ${tape.label} as WAV`}
                    >
                      Download
                    </button>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </div>

      <div className="field">
        <h3 className="subtitle">Receive</h3>
        <div className="flex flex-wrap items-center gap-3">
          <label htmlFor={ids.import} className="button cursor-pointer">
            {props.importing ? 'Importing…' : 'Import WAV'}
            <input
              id={ids.import}
              type="file"
              accept={ACCEPTED_FILES}
              multiple
              className="sr-only"
              onChange={handleImport}
              disabled={props.importing}
            />
          </label>
          <button
            type="button"
            className="button"
            onClick={props.onListen}
            disabled={props.listenUnavailable !== null || props.listening || props.micStarting}
            aria-describedby={props.listenUnavailable !== null ? ids.listenProblem : undefined}
          >
            {props.micStarting ? 'Starting…' : props.listening ? 'Listening' : 'Listen'}
          </button>
          <button type="button" className="button" onClick={props.onStop} disabled={!active}>
            Stop
          </button>
        </div>
        {props.listenUnavailable !== null && (
          <p id={ids.listenProblem} className="warning">
            {props.listenUnavailable}
          </p>
        )}
        {props.message !== null && <p className="warning">{props.message}</p>}
      </div>

      <fieldset className="field">
        <legend>Virtual Tape Channel</legend>
        <label htmlFor={ids.channel} className="choice">
          <input
            id={ids.channel}
            type="checkbox"
            role="switch"
            checked={channel.enabled}
            onChange={(event) => onChannelChange({ ...channel, enabled: event.currentTarget.checked })}
          />
          Simulate a worn tape on Play ({channel.enabled ? 'on' : 'off'})
        </label>

        <div className="slider">
          <label htmlFor={ids.hiss}>Hiss</label>
          <input
            id={ids.hiss}
            type="range"
            min={0}
            max={HISS_PERCENT_MAX}
            step={HISS_PERCENT_STEP}
            value={channel.hissPercent}
            aria-valuetext={`${channel.hissPercent} percent`}
            onChange={(event) =>
              onChannelChange({
                ...channel,
                hissPercent: clampPercent(event.currentTarget.valueAsNumber, HISS_PERCENT_MAX),
              })
            }
          />
          <output htmlFor={ids.hiss}>{channel.hissPercent}%</output>
        </div>

        <div className="slider">
          <label htmlFor={ids.wow}>Wow and flutter</label>
          <input
            id={ids.wow}
            type="range"
            min={0}
            max={WOW_PERCENT_MAX}
            step={WOW_PERCENT_STEP}
            value={channel.wowPercent}
            aria-valuetext={`${channel.wowPercent.toFixed(1)} percent`}
            onChange={(event) =>
              onChannelChange({
                ...channel,
                wowPercent: clampPercent(event.currentTarget.valueAsNumber, WOW_PERCENT_MAX),
              })
            }
          />
          <output htmlFor={ids.wow}>{channel.wowPercent.toFixed(1)}%</output>
        </div>
      </fieldset>
    </section>
  )
}
