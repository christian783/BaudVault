// The Deck's audio sources and their Tape_Decoders (design.md, "Audio shell";
// Requirements 4.6, 5.6, 5.8, 6.2, 6.6, 7.17 to 7.21).
//
// - Play: modulates the tape, plays it through `playTape` (with the
//   Virtual_Tape_Channel when settings are given), and pushes the played
//   samples into a fresh auto-baud TapeDecoder (Requirement 6.2).
// - Download: always encodes the unprocessed Modulator output (Requirement 4.6).
// - Import: `decodeImportedWav` on each file, never through the channel
//   (Requirement 6.6).
// - Listen: `startMicrophone`, feeding a TapeDecoder at the capture rate.
// - Stop: stops playback and releases the microphone (Requirement 7.21).
//
// One live source runs at a time: Play stops Listen and Listen stops Play.
// `decoderRef` holds the live source's decoder so the oscilloscope can read
// its scope tap, energies, and Carrier_Lock state each animation frame. With
// the Virtual_Tape_Channel on, Play feeds the decoder the processed samples,
// so trace A shows the channel output (Requirement 7.5). `telemetry` folds
// every decoder event (live and imported) into the readout (7.7, 7.8).
//
// Only Tape_Record audio (ciphertext) passes through here. Nothing is logged
// or stored outside React state.

import { useCallback, useEffect, useRef, useState } from 'react'
import { MIC_FAILURE_MESSAGES, type MicSession, startMicrophone } from '../audio/microphone'
import { decodeImportedWav, exportTapeWav, type PlaybackSession, playTape } from '../audio/playback'
import type { TapeChannelSettings } from '../channel/virtual-tape'
import { modulate, SAMPLE_RATE } from '../modem/kcs-modulator'
import { type DecoderEvent, TapeDecoder } from '../tape/tape-decoder'
import { errorText } from './messages'
import { EMPTY_RECEIVER, receiveEvents, receiveFailure, receiveImport, type ReceiverState } from './receiver'
import { IDLE_TELEMETRY, reduceTelemetry, type Telemetry, telemetryFromEvents } from './telemetry'
import type { Tape } from './tapes'

/** How long a download's object URL stays valid after the click. */
const DOWNLOAD_URL_LIFETIME_MS = 30_000

const MICROPHONE_SOURCE = 'Microphone'

export type TapeDeck = {
  receiver: ReceiverState
  /** Decode progress and the last record's totals, for the Readout panel. */
  telemetry: Telemetry
  /** Id of the tape now playing, or null. */
  playingId: number | null
  listening: boolean
  /** Waiting for microphone permission. */
  micStarting: boolean
  importing: boolean
  /** The latest Deck failure (playback, microphone, download), or null. */
  message: string | null
  /** The live source's decoder, for the scope and telemetry. */
  decoderRef: { readonly current: TapeDecoder | null }
  play(tape: Tape, channel: TapeChannelSettings | null): void
  download(tape: Tape): void
  importFiles(files: readonly File[]): Promise<void>
  listen(): Promise<void>
  /** Stops playback and microphone capture. */
  stop(): void
  stopPlayback(): void
  /**
   * Stops playback and drops every decoded Body, Shard, held Envelope, and
   * notice, and resets the telemetry (Requirement 7.13). Listening goes on.
   */
  clear(): void
}

export function useTapeDeck(): TapeDeck {
  const [receiver, setReceiver] = useState<ReceiverState>(EMPTY_RECEIVER)
  const [telemetry, setTelemetry] = useState<Telemetry>(IDLE_TELEMETRY)
  const [playingId, setPlayingId] = useState<number | null>(null)
  const [listening, setListening] = useState(false)
  const [micStarting, setMicStarting] = useState(false)
  const [importing, setImporting] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const contextRef = useRef<AudioContext | null>(null)
  const playbackRef = useRef<PlaybackSession | null>(null)
  const micRef = useRef<MicSession | null>(null)
  const decoderRef = useRef<TapeDecoder | null>(null)
  /** Bumped by every Listen and Stop; a pending start with an old value is discarded. */
  const micAttemptRef = useRef(0)

  const deliver = useCallback((events: DecoderEvent[], source: string) => {
    if (events.length === 0) return
    setReceiver((state) => receiveEvents(state, events, source))
    setTelemetry((state) => telemetryFromEvents(state, events))
  }, [])

  /** A live source stopped; a record still being decoded will never finish. */
  const halt = useCallback(() => setTelemetry((state) => reduceTelemetry(state, { type: 'halt' })), [])

  const stopPlayback = useCallback(() => {
    const session = playbackRef.current
    playbackRef.current = null
    if (session !== null) {
      session.stop()
      halt()
    }
    setPlayingId(null)
  }, [halt])

  const stopListening = useCallback(() => {
    micAttemptRef.current++
    const session = micRef.current
    micRef.current = null
    if (session !== null) halt()
    setListening(false)
    setMicStarting(false)
    // stop() never rejects; it releases every track, node, and the context.
    if (session !== null) void session.stop()
  }, [halt])

  const stop = useCallback(() => {
    stopPlayback()
    stopListening()
    decoderRef.current = null
  }, [stopPlayback, stopListening])

  const clear = useCallback(() => {
    stopPlayback()
    setReceiver(EMPTY_RECEIVER)
    setTelemetry(IDLE_TELEMETRY)
    setMessage(null)
  }, [stopPlayback])

  const play = useCallback(
    (tape: Tape, channel: TapeChannelSettings | null) => {
      stopPlayback()
      stopListening()
      setMessage(null)
      try {
        let context = contextRef.current
        if (context === null || context.state === 'closed') {
          context = new AudioContext()
          contextRef.current = context
        }
        void context.resume()
        const decoder = new TapeDecoder({ sampleRate: SAMPLE_RATE })
        decoderRef.current = decoder
        const source = tape.label
        const session = playTape({
          context,
          samples: modulate(tape.record, tape.baud),
          channel,
          onChunk: (chunk) => deliver(decoder.push(chunk), source),
          onEnded: () => {
            if (playbackRef.current !== session) return
            playbackRef.current = null
            setPlayingId(null)
          },
        })
        playbackRef.current = session
        setPlayingId(tape.id)
      } catch (error) {
        decoderRef.current = null
        setMessage(`Playback failed: ${errorText(error)}`)
      }
    },
    [deliver, stopPlayback, stopListening],
  )

  const download = useCallback((tape: Tape) => {
    setMessage(null)
    try {
      const wav = exportTapeWav(modulate(tape.record, tape.baud))
      const url = URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }))
      const link = document.createElement('a')
      link.href = url
      link.download = tape.fileName
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), DOWNLOAD_URL_LIFETIME_MS)
    } catch (error) {
      setMessage(`Download failed: ${errorText(error)}`)
    }
  }, [])

  const importFiles = useCallback(async (files: readonly File[]) => {
    if (files.length === 0) return
    setImporting(true)
    try {
      for (const file of files) {
        try {
          const events = decodeImportedWav(new Uint8Array(await file.arrayBuffer()))
          setReceiver((state) => receiveImport(state, events, file.name))
          setTelemetry((state) => telemetryFromEvents(state, events))
        } catch (error) {
          setReceiver((state) => receiveFailure(state, file.name, error))
        }
      }
    } finally {
      setImporting(false)
    }
  }, [])

  const listen = useCallback(async () => {
    if (micRef.current !== null) return
    stopPlayback()
    setMessage(null)
    const attempt = ++micAttemptRef.current
    setMicStarting(true)
    let decoder: TapeDecoder | null = null
    const result = await startMicrophone({
      onChunk: (chunk, sampleRate) => {
        if (attempt !== micAttemptRef.current) return
        if (decoder === null) {
          try {
            decoder = new TapeDecoder({ sampleRate })
          } catch (error) {
            setMessage(`Listening failed: ${errorText(error)}`)
            stopListening()
            return
          }
          decoderRef.current = decoder
        }
        deliver(decoder.push(chunk), MICROPHONE_SOURCE)
      },
    })
    if (attempt !== micAttemptRef.current) {
      // Stop or Play was selected while permission was pending.
      if (result.ok) void result.session.stop()
      return
    }
    setMicStarting(false)
    if (!result.ok) {
      setMessage(MIC_FAILURE_MESSAGES[result.reason])
      return
    }
    micRef.current = result.session
    setListening(true)
  }, [deliver, stopPlayback, stopListening])

  // Release audio when the Deck unmounts.
  useEffect(
    () => () => {
      playbackRef.current?.stop()
      playbackRef.current = null
      micAttemptRef.current++
      if (micRef.current !== null) void micRef.current.stop()
      micRef.current = null
      const context = contextRef.current
      contextRef.current = null
      if (context !== null && context.state !== 'closed') void context.close()
    },
    [],
  )

  return {
    receiver,
    telemetry,
    playingId,
    listening,
    micStarting,
    importing,
    message,
    decoderRef,
    play,
    download,
    importFiles,
    listen,
    stop,
    stopPlayback,
    clear,
  }
}
