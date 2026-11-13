// Audio shell: playback and the routing of tape audio (design.md, "Audio
// shell"; Requirements 4.6, 6.2, 6.6).
//
// Where the Virtual_Tape_Channel applies:
// - Play with the channel enabled: `playTape` runs `applyTapeChannel` once,
//   plays the processed buffer, and hands the processed samples to `onChunk`
//   (the UI pushes them into a TapeDecoder) at the playback position
//   (Requirement 6.2). With the channel off, the Modulator output is played
//   and handed over unchanged, so the scope still follows the audio.
// - WAV export: `exportTapeWav` always encodes the unprocessed Modulator
//   output (Requirement 4.6). It takes no channel settings at all.
// - WAV import: `decodeImportedWav` sends the file's samples straight to a
//   TapeDecoder (Requirement 6.6). It takes no channel settings either.
//
// Samples carry only the Tape_Record (ciphertext and framing), never
// Plaintext or a Password. Nothing here logs or stores them.

import { applyTapeChannel, type TapeChannelSettings } from '../channel/virtual-tape'
import { SAMPLE_RATE } from '../modem/kcs-modulator'
import { decodeWav, encodeWav } from '../modem/wav'
import { type DecoderEvent, TapeDecoder } from '../tape/tape-decoder'

export type { TapeChannelSettings }

/** How often a playing tape hands newly played samples to `onChunk`, in milliseconds. */
export const PUMP_INTERVAL_MS = 20

/** Chunk size used when an imported WAV file is fed to the decoder, matching the microphone. */
export const IMPORT_CHUNK_SAMPLES = 2_048

/**
 * The samples Play sends to the speaker and to the decoder: the Virtual_Tape_Channel
 * output when `channel` is set, otherwise `samples` itself (Requirement 6.2).
 */
export function playbackSamples(
  samples: Float32Array<ArrayBuffer>,
  sampleRate: number,
  channel: TapeChannelSettings | null,
): Float32Array<ArrayBuffer> {
  return channel === null ? samples : applyTapeChannel(samples, sampleRate, channel)
}

/**
 * Encodes Modulator output as the downloadable WAV file: mono 16-bit PCM at
 * 44,100 Hz, never processed by the Virtual_Tape_Channel (Requirement 4.6).
 */
export function exportTapeWav(samples: Float32Array): Uint8Array<ArrayBuffer> {
  return encodeWav(samples, SAMPLE_RATE)
}

/**
 * Decodes an imported WAV file with a fresh auto-baud TapeDecoder, without
 * Virtual_Tape_Channel processing (Requirement 6.6), and returns every event
 * in order. A file may hold several Tape_Records back to back.
 *
 * @throws FormatError if the file is not a supported WAV file (Requirement 5.5)
 */
export function decodeImportedWav(file: Uint8Array): DecoderEvent[] {
  const { samples, sampleRate } = decodeWav(file)
  const decoder = new TapeDecoder({ sampleRate })
  const events: DecoderEvent[] = []
  for (let at = 0; at < samples.length; at += IMPORT_CHUNK_SAMPLES) {
    for (const event of decoder.push(samples.subarray(at, at + IMPORT_CHUNK_SAMPLES))) events.push(event)
  }
  return events
}

export type PlayTapeOptions = {
  /** Context to play through; the caller creates it from a user gesture. */
  context: BaseAudioContext
  /** Modulator output. */
  samples: Float32Array<ArrayBuffer>
  /** Rate of `samples`; the Modulator writes 44,100 Hz. */
  sampleRate?: number
  /** Virtual_Tape_Channel settings when the channel is enabled, otherwise null. */
  channel: TapeChannelSettings | null
  /**
   * Receives each run of samples once it has been played, in order and
   * without gaps. The array is a view into the played buffer; copy it to keep it.
   */
  onChunk?: (samples: Float32Array, sampleRate: number) => void
  /** Called once when the tape plays to its end (not after `stop`). */
  onEnded?: () => void
  /** Hand samples over on a timer every PUMP_INTERVAL_MS. Default true. */
  autoPump?: boolean
}

export type PlaybackSession = {
  /** The samples being played: the channel output, or the Modulator output. */
  readonly played: Float32Array<ArrayBuffer>
  readonly sampleRate: number
  /** Samples handed to `onChunk` so far. */
  readonly delivered: number
  /** Hands every sample played since the last call to `onChunk`. */
  pump(): void
  /** Stops the sound, disconnects the source node, and stops the timer. */
  stop(): void
}

/**
 * Plays a tape. With `channel` set, the Virtual_Tape_Channel output is played
 * and handed to `onChunk`; otherwise the Modulator output is (Requirement 6.2).
 */
export function playTape(options: PlayTapeOptions): PlaybackSession {
  const { context, onChunk, onEnded } = options
  const sampleRate = options.sampleRate ?? SAMPLE_RATE
  const played = playbackSamples(options.samples, sampleRate, options.channel)

  // An AudioBuffer cannot be empty; a zero-length tape plays one silent sample.
  const buffer = context.createBuffer(1, Math.max(1, played.length), sampleRate)
  buffer.getChannelData(0).set(played)
  const source = context.createBufferSource()
  source.buffer = buffer
  source.connect(context.destination)

  let delivered = 0
  let finished = false
  let timer: ReturnType<typeof setInterval> | undefined
  const startAt = context.currentTime

  const deliverUpTo = (target: number): void => {
    const end = Math.min(played.length, target)
    if (end <= delivered) return
    const chunk = played.subarray(delivered, end)
    delivered = end
    onChunk?.(chunk, sampleRate)
  }

  const finish = (): void => {
    if (finished) return
    finished = true
    if (timer !== undefined) clearInterval(timer)
    timer = undefined
    source.onended = null
    source.disconnect()
  }

  const session: PlaybackSession = {
    played,
    sampleRate,
    get delivered() {
      return delivered
    },
    pump() {
      if (finished) return
      const elapsed = context.currentTime - startAt
      if (elapsed > 0) deliverUpTo(Math.floor(elapsed * sampleRate))
    },
    stop() {
      if (finished) return
      finish()
      source.stop()
    },
  }

  source.onended = () => {
    if (finished) return
    deliverUpTo(played.length)
    finish()
    onEnded?.()
  }
  source.start(startAt)
  if (options.autoPump !== false) timer = setInterval(() => session.pump(), PUMP_INTERVAL_MS)
  return session
}
