// BaudVault's single screen (design.md, "Deck_UI"): the Record panel, the
// Deck panel, and the Readout panel (oscilloscope, telemetry, and the vault
// controls: Unlock, Reveal, Clear).
//
// The secret is held as a string only because a controlled text input needs
// one. At Lock it is encoded into a Uint8Array, sealed, and that array is
// zeroed. The recovered Plaintext stays a Uint8Array until Reveal, and Clear
// zeroes it (Requirement 7.13). JavaScript strings cannot be wiped, so Clear
// can only drop the secret, Lock Password, and Unlock password strings.
//
// The Lock Password (`passwords.lock`, Record panel) is read only by Lock.
// The Unlock password (`passwords.unlock`, Vault section) is a separate field,
// read only by Unlock, and never prefilled from the Lock Password
// (Requirements 7.23, 7.29). `passwordsReducer` owns both fields. Nothing here writes the secret, either Password, or decrypted
// bytes to the console, storage, or the URL (Requirement 8.4).

import { useCallback, useReducer, useRef, useState } from 'react'
import { open } from './crypto/vault'
import { announce, type AppEvent, EMPTY_ANNOUNCEMENTS, freshNotices } from './ui/announcements'
import { DEFAULT_CHANNEL, newChannelSeed, toChannelSettings, type ChannelControls } from './ui/channel-controls'
import { DeckPanel } from './ui/DeckPanel'
import { FeatureNotice } from './ui/FeatureNotice'
import { detectFeatures, readFeatureEnvironment } from './ui/features'
import { errorText } from './ui/messages'
import { ReadoutPanel } from './ui/ReadoutPanel'
import { RecordPanel } from './ui/RecordPanel'
import { EMPTY_PASSWORDS, passwordsReducer } from './ui/passwords'
import { lockReadiness } from './ui/record-rules'
import { lockSecret, type Mode, type Sharding, type Tape } from './ui/tapes'
import { unlockFailure, unlockReadiness, wipePlaintext } from './ui/unlock'
import { UnlockSection } from './ui/UnlockSection'
import { useTapeDeck } from './ui/use-tape-deck'

function App() {
  const [secret, setSecret] = useState('')
  /** The Lock Password, used only by Lock, and the Unlock password, used only by Unlock (Requirement 7.29). */
  const [passwords, dispatchPasswords] = useReducer(passwordsReducer, EMPTY_PASSWORDS)
  const password = passwords.lock
  const unlockPassword = passwords.unlock
  const [mode, setMode] = useState<Mode>('standard')
  const [sharding, setSharding] = useState<Sharding>('none')
  const [sealing, setSealing] = useState(false)
  const [opening, setOpening] = useState(false)
  const [lockError, setLockError] = useState<string | null>(null)
  const [unlockError, setUnlockError] = useState<string | null>(null)
  const [tapes, setTapes] = useState<readonly Tape[]>([])
  const [recovered, setRecovered] = useState<Uint8Array | null>(null)
  const [revealed, setRevealed] = useState(false)
  const [channel, setChannel] = useState<ChannelControls>(DEFAULT_CHANNEL)
  const nextTapeId = useRef(1)
  /** The recovered Plaintext, also kept here so Clear and a new Unlock can zero it. */
  const recoveredRef = useRef<Uint8Array | null>(null)
  /** Bumped by Clear; a seal or open that started before it discards its result. */
  const generation = useRef(0)
  const deck = useTapeDeck()
  /** Browser features, checked once at startup (Requirements 10.2, 10.3). */
  const [features] = useState(() => detectFeatures(readFeatureEnvironment()))
  /** The polite live region's entries (Requirements 9.4, 9.5, 9.7). */
  const [announcements, setAnnouncements] = useState(EMPTY_ANNOUNCEMENTS)
  const say = useCallback((event: AppEvent) => setAnnouncements((log) => announce(log, event)), [])
  /** The Receiver notice total and Deck message already announced. */
  const [seen, setSeen] = useState<{ noticeTotal: number; message: string | null }>({ noticeTotal: 0, message: null })

  // Announce new decode results and failures, and new Deck failures such as a
  // denied microphone. Adjusting state while rendering, as React recommends
  // for state derived from other state, avoids an extra effect pass.
  if (deck.receiver.noticeTotal !== seen.noticeTotal || deck.message !== seen.message) {
    const notices = freshNotices(seen.noticeTotal, deck.receiver)
    const message = deck.message !== seen.message ? deck.message : null
    setSeen({ noticeTotal: deck.receiver.noticeTotal, message: deck.message })
    if (notices.length > 0) say({ type: 'received', notices })
    if (message !== null) say({ type: 'deck-message', message })
  }

  const busy = sealing || opening
  const held = deck.receiver.collection.held
  const unlock = unlockReadiness(held !== null, unlockPassword, busy, features.unlockProblem)

  const showRecovered = (plaintext: Uint8Array | null) => {
    wipePlaintext(recoveredRef.current)
    recoveredRef.current = plaintext
    setRecovered(plaintext)
    setRevealed(false)
  }

  const handleLock = async () => {
    if (busy || !lockReadiness(secret, password, features.lockProblem).ready) return
    const started = generation.current
    setSealing(true)
    setLockError(null)
    deck.stopPlayback()
    const plaintext = new TextEncoder().encode(secret)
    try {
      const made = await lockSecret(plaintext, password, mode, sharding, nextTapeId.current)
      if (started !== generation.current) return
      nextTapeId.current += made.length
      setTapes(made)
      say({ type: 'tapes-recorded', count: made.length })
    } catch (error) {
      if (started === generation.current) {
        setLockError(errorText(error))
        say({ type: 'lock-failed', error })
      }
    } finally {
      plaintext.fill(0)
      setSealing(false)
    }
  }

  const handleUnlock = async () => {
    if (held === null || !unlock.ready) return
    const started = generation.current
    setOpening(true)
    setUnlockError(null)
    try {
      const plaintext = await open(held.envelope, unlockPassword)
      if (started !== generation.current) {
        wipePlaintext(plaintext)
        return
      }
      showRecovered(plaintext)
      // The event carries no data, so the secret cannot reach the live region (Requirement 9.7).
      say({ type: 'unlocked' })
    } catch (error) {
      if (started !== generation.current) return
      // The held Envelope stays, so another Unlock password can be tried, and
      // only the Unlock password field is emptied (Requirement 7.24).
      const failure = unlockFailure(error)
      dispatchPasswords({ type: 'unlock-failed', failure })
      setUnlockError(failure.message)
      say({ type: 'unlock-failed', error })
    } finally {
      setOpening(false)
    }
  }

  const handleClear = () => {
    generation.current++
    showRecovered(null)
    setSecret('')
    dispatchPasswords({ type: 'cleared' })
    setTapes([])
    setLockError(null)
    setUnlockError(null)
    deck.clear()
    say({ type: 'cleared' })
  }

  return (
    <main className="min-h-svh bg-black p-4 font-mono text-phosphor sm:p-6">
      <header className="mb-6">
        <h1 className="text-3xl tracking-widest">BAUDVAULT</h1>
        <p>Encrypted cassette tapes, made and read offline.</p>
      </header>
      <FeatureNotice support={features} />
      <div className="grid gap-6 lg:grid-cols-2">
        <RecordPanel
          secret={secret}
          onSecretChange={setSecret}
          password={password}
          onPasswordChange={(value) => dispatchPasswords({ type: 'lock-changed', password: value })}
          mode={mode}
          onModeChange={setMode}
          sharding={sharding}
          onShardingChange={setSharding}
          onLock={() => void handleLock()}
          sealing={sealing}
          busy={busy}
          lockError={lockError}
          lockUnavailable={features.lockProblem}
        />
        <DeckPanel
          tapes={tapes}
          playingId={deck.playingId}
          onPlay={(tape) => deck.play(tape, toChannelSettings(channel, newChannelSeed()))}
          onDownload={deck.download}
          onImport={(files) => void deck.importFiles(files)}
          importing={deck.importing}
          listening={deck.listening}
          micStarting={deck.micStarting}
          onListen={() => {
            if (features.listenAvailable) void deck.listen()
          }}
          listenUnavailable={features.listenProblem}
          onStop={deck.stop}
          channel={channel}
          onChannelChange={setChannel}
          message={deck.message}
        />
        <ReadoutPanel
          decoderRef={deck.decoderRef}
          active={deck.playingId !== null || deck.listening}
          telemetry={deck.telemetry}
          onCarrierChange={(locked) => say({ type: 'carrier', locked })}
        >
          <UnlockSection
            receiver={deck.receiver}
            readiness={unlock}
            unlockPassword={unlockPassword}
            onUnlockPasswordChange={(value) => dispatchPasswords({ type: 'unlock-changed', password: value })}
            busy={busy}
            opening={opening}
            onUnlock={() => void handleUnlock()}
            unlockError={unlockError}
            recovered={recovered}
            revealed={revealed}
            onRevealChange={setRevealed}
            onClear={handleClear}
          />
        </ReadoutPanel>
      </div>
      {/* The single polite live region (Requirements 9.4, 9.5). Each entry is
          a new node, so repeats and same-frame results are all announced.
          Its text is built by announcementText, which never sees the
          Plaintext or either Password (Requirement 9.7). Visually hidden: every
          entry repeats text the panels already show. */}
      <div role="log" aria-live="polite" aria-label="Announcements" className="sr-only">
        {announcements.entries.map((entry) => (
          <p key={entry.id}>{entry.text}</p>
        ))}
      </div>
    </main>
  )
}

export default App
