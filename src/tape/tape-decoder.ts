// Tape_Decoder: streaming audio → Body (design.md, "Tape_Decoder" and
// "Tape_Decoder states"; Requirements 3.4, 3.6, 3.7, 3.9, 5.1, 5.3, 5.9).
//
// One BitDemodulator ("lane") runs per candidate baud rate: one lane with a
// fixed baud, or a 300-baud and a 2,400-baud lane side by side in auto mode.
//
// - Header: each lane that gains Carrier_Lock collects 96 bytes and tries both
//   Header_Frame copies (`readHeader`: copy 1, then copy 2). `parseHeaderFrame`
//   only accepts a copy whose baud code matches the lane's own rate, so the
//   first lane with a usable header wins and the other lane is discarded.
// - A lane whose two copies are both unusable is released silently. When no
//   lane holds lock any more the decoder emits `unlock` and nothing else
//   (Requirement 3.9), and the lanes keep searching for a leader.
// - Data: the winner's bytes fill Interleave_Groups of 255·D bytes. Each full
//   group goes to `RecordAssembler.addGroup`, which de-interleaves and decodes
//   every Codeword even after one fails, and the decoder emits `progress`.
//   After the last group `RecordAssembler.finish` strips the padding and runs
//   the CRC-32 only if every Codeword decoded; the decoder emits `record`, or
//   `error` with UncorrectableError (every failed block) or IntegrityError.
// - Signal loss: if the winner loses Carrier_Lock before the last group, the
//   decoder emits `error` with a FormatError and the partial DecodeStats
//   (bytes received, corrected bytes so far), no Body, then `unlock`
//   (Requirement 5.9). FormatError fits because the received Tape_Record is
//   shorter than its Header_Frame declares, the same condition `unframe`
//   reports as FormatError; its message is a fixed literal plus the byte count.
//
// Lock events. The leader is the same 2,400 Hz tone at both rates, so in auto
// mode the rate is unknown until a header decodes. With a fixed baud, `lock`
// fires when the lane gains Carrier_Lock. In auto mode, `lock` fires just
// before `header`, carrying the confirmed rate. `unlock` fires whenever the
// decoder returns to carrier search after any lane held lock, so in auto mode a
// failed header gives `unlock` with no `lock` before it.
//
// Chunk independence. Lanes are fed in blocks aligned to absolute multiples of
// ALIGN_SAMPLES, and every release the decoder requests takes effect at the
// next block boundary. Events therefore do not depend on how the caller splits
// the input (for example 2,048-sample microphone chunks).
//
// Trailer hold-off. A 0.5 s trailer plus the last stop bits is just long
// enough for a released lane to re-lock on it. After a record ends, a lock is
// accepted only if its mark tone started after the trailer would have ended;
// earlier locks are released again. A back-to-back tape's 2 s leader still
// locks well before its first start bit.
//
// Scope. Trace A is the input. Trace B is d[n] of the winning lane during a
// record, otherwise of the 300-baud lane (its one-bit window gives the
// clearer trace), or of the only lane in fixed mode.
//
// No event, error, or log carries decoded bytes except the `record` Body.

import { BaudVaultError, FormatError } from '../core/errors'
import { BitDemodulator, type DemodEvent, LOCK_SECONDS } from '../modem/bit-demodulator'
import { checkBaud } from '../modem/goertzel'
import { TRAILER_SECONDS } from '../modem/kcs-modulator'
import {
  type BaudRate,
  type DecodeStats,
  RECORD_HEADER_BYTES,
  readHeader,
  RecordAssembler,
  type TapeHeader,
} from './framer'

export type { BaudRate, DecodeStats, TapeHeader }

/** Lanes are fed in blocks aligned to multiples of this many absolute samples. */
export const ALIGN_SAMPLES = 256
/** Length of each scope trace in seconds. */
export const SCOPE_SECONDS = 0.02

export type DecoderEvent =
  | { type: 'lock'; baud: BaudRate }
  | { type: 'unlock' }
  | { type: 'header'; header: TapeHeader }
  | { type: 'progress'; bytesReceived: number; bytesExpected: number; correctedBytes: number }
  | { type: 'record'; body: Uint8Array; header: TapeHeader; stats: DecodeStats }
  | { type: 'error'; error: BaudVaultError; stats: DecodeStats }

/**
 * Ring buffers of the last 20 ms of input (trace A) and of the decision
 * signal d[n] (trace B) for the oscilloscope.
 */
export class ScopeTap {
  /** Samples per trace: round(0.02 · sampleRate). */
  readonly size: number
  /** Trace A ring buffer; the oldest sample is at `head`. */
  readonly input: Float32Array<ArrayBuffer>
  /** Trace B ring buffer; the oldest sample is at `head`. */
  readonly decision: Float32Array<ArrayBuffer>
  #head = 0

  constructor(sampleRate: number) {
    this.size = Math.max(1, Math.round(SCOPE_SECONDS * sampleRate))
    this.input = new Float32Array(this.size)
    this.decision = new Float32Array(this.size)
  }

  /** Index of the oldest sample in both rings, which is also the next write position. */
  get head(): number {
    return this.#head
  }

  /** Appends `count` samples of input and of d[n]. */
  write(input: Float32Array, decision: Float32Array, count: number): void {
    const size = this.size
    let head = this.#head
    // Samples older than the last `size` would be overwritten within this call; skip them.
    let from = 0
    if (count > size) {
      from = count - size
      head = (head + from) % size
    }
    // Block copies up to the ring's end, then wrap; same contents and head as one sample at a time.
    while (from < count) {
      const n = Math.min(size - head, count - from)
      this.input.set(input.subarray(from, from + n), head)
      this.decision.set(decision.subarray(from, from + n), head)
      from += n
      head += n
      if (head === size) head = 0
    }
    this.#head = head
  }

  /** Copies trace A into `out`, oldest first. `out` must hold `size` samples. */
  readInput(out: Float32Array): void {
    this.#unroll(this.input, out)
  }

  /** Copies trace B into `out`, oldest first. `out` must hold `size` samples. */
  readDecision(out: Float32Array): void {
    this.#unroll(this.decision, out)
  }

  #unroll(ring: Float32Array, out: Float32Array): void {
    const tail = this.size - this.#head
    out.set(ring.subarray(this.#head), 0)
    out.set(ring.subarray(0, this.#head), tail)
  }
}

/** One BitDemodulator and its header-collection state. */
type Lane = {
  readonly baud: BaudRate
  readonly demod: BitDemodulator
  /** Absolute sample index of the demodulator's sample 0. */
  readonly offset: number
  /** Holds an accepted Carrier_Lock and is counting bytes. */
  active: boolean
  /** Ignore events until the next block boundary, then call `release()`. */
  pendingRelease: boolean
  /** Another lane won the header; rebuild this one after the record. */
  discarded: boolean
  readonly headerBytes: Uint8Array
  headerFill: number
}

export class TapeDecoder {
  readonly sampleRate: number
  /** The fixed baud rate, or undefined in auto-detect mode. */
  readonly baud: BaudRate | undefined
  readonly scope: ScopeTap

  readonly #lanes: Lane[]
  readonly #decisions = new Float32Array(ALIGN_SAMPLES)
  readonly #holdOffSamples: number

  /** Absolute index of the next input sample. */
  #n = 0
  /** Some lane has held an accepted lock since the decoder last emitted `unlock`. */
  #carrier = false
  /** Locks starting earlier than this absolute sample are released (trailer hold-off). */
  #lockAllowedFrom = -Infinity
  #rebuild = false

  #winner: Lane | null = null
  #assembler: RecordAssembler | null = null
  #group: Uint8Array = new Uint8Array(0)
  #groupFill = 0

  /**
   * @param options.sampleRate input rate, 22,050 to 96,000 Hz
   * @param options.baud fixed rate; omit to detect 300 or 2,400 baud from the header
   * @throws InputError for an unsupported sample rate or baud
   */
  constructor(options: { sampleRate: number; baud?: BaudRate }) {
    const { sampleRate, baud } = options
    if (baud !== undefined) checkBaud(baud)
    this.sampleRate = sampleRate
    this.baud = baud
    const rates: BaudRate[] = baud === undefined ? [300, 2400] : [baud]
    this.#lanes = rates.map((rate) => this.#newLane(rate))
    this.scope = new ScopeTap(sampleRate)
    this.#holdOffSamples = Math.round((TRAILER_SECONDS + LOCK_SECONDS) * sampleRate)
  }

  /**
   * True while some lane holds an accepted Carrier_Lock, from leader
   * detection until the record ends or the signal is lost. In auto mode this
   * turns on at the leader, before the `lock` event (which waits for the
   * header). Read-only view for the UI's LOCK lamp.
   */
  get carrierLock(): boolean {
    return this.#carrier
  }

  /**
   * Latest 1,200 Hz (`space`) and 2,400 Hz (`mark`) Goertzel energies of the
   * lane that drives trace B, for the UI energy bars. The object is updated in
   * place by the demodulator; treat it as read-only.
   */
  get energies(): Readonly<{ mark: number; space: number }> {
    return this.#scopeLane().demod.energies
  }

  /** The lane whose d[n] feeds trace B: the same choice `push` makes. */
  #scopeLane(): Lane {
    if (this.#winner !== null) return this.#winner
    const lanes = this.#lanes.filter((lane) => !lane.discarded)
    return lanes.find((lane) => lane.baud === 300) ?? lanes[0] ?? this.#lanes[0]!
  }

  /**
   * Feeds samples and returns the events they produced, in order. Chunk
   * boundaries do not affect the result.
   */
  push(samples: Float32Array): DecoderEvent[] {
    const out: DecoderEvent[] = []
    const decisions = this.#decisions
    const len = samples.length
    let pos = 0

    while (pos < len) {
      const end = Math.min(len, pos + ALIGN_SAMPLES - (this.#n % ALIGN_SAMPLES))
      const piece = samples.subarray(pos, end)
      const count = end - pos

      const winner = this.#winner
      const lanes = winner === null ? this.#lanes.filter((lane) => !lane.discarded) : [winner]
      const source = winner ?? lanes.find((lane) => lane.baud === 300) ?? lanes[0]!
      for (const lane of lanes) {
        const events = lane.demod.push(piece, lane === source ? decisions : undefined)
        for (const event of events) this.#handle(lane, event, out)
      }
      this.scope.write(piece, decisions, count)

      this.#n += count
      pos = end
      if (this.#n % ALIGN_SAMPLES === 0) this.#atBoundary()
    }
    return out
  }

  #newLane(baud: BaudRate): Lane {
    return {
      baud,
      demod: new BitDemodulator(this.sampleRate, baud),
      offset: this.#n,
      active: false,
      pendingRelease: false,
      discarded: false,
      headerBytes: new Uint8Array(RECORD_HEADER_BYTES),
      headerFill: 0,
    }
  }

  /** Applies pending releases and rebuilds discarded lanes. */
  #atBoundary(): void {
    const lanes = this.#lanes
    for (let i = 0; i < lanes.length; i++) {
      const lane = lanes[i]!
      if (this.#rebuild && lane.discarded) {
        lanes[i] = this.#newLane(lane.baud)
      } else if (lane.pendingRelease) {
        lane.demod.release()
        lane.pendingRelease = false
      }
    }
    this.#rebuild = false
  }

  #handle(lane: Lane, event: DemodEvent, out: DecoderEvent[]): void {
    if (lane.pendingRelease || lane.discarded) return
    if (this.#winner !== null && lane !== this.#winner) return

    if (event.type === 'lock') {
      if (lane.offset + event.sample < this.#lockAllowedFrom) {
        lane.pendingRelease = true // re-lock on the previous record's trailer
        return
      }
      lane.active = true
      lane.headerFill = 0
      if (!this.#carrier && this.baud !== undefined) out.push({ type: 'lock', baud: lane.baud })
      this.#carrier = true
      return
    }

    if (!lane.active) return

    if (event.type === 'unlock') {
      lane.active = false
      if (lane === this.#winner) this.#signalLost(out)
      else this.#idleCheck(out)
      return
    }

    if (lane === this.#winner) {
      this.#dataByte(event.value, event.sample + lane.offset, out)
      return
    }

    lane.headerBytes[lane.headerFill++] = event.value
    if (lane.headerFill === RECORD_HEADER_BYTES) this.#tryHeader(lane, out)
  }

  #tryHeader(lane: Lane, out: DecoderEvent[]): void {
    const chosen = readHeader(lane.headerBytes, lane.baud)
    lane.headerBytes.fill(0)
    if (chosen === null) {
      lane.active = false
      lane.pendingRelease = true
      this.#idleCheck(out)
      return
    }
    for (const other of this.#lanes) {
      if (other === lane) continue
      other.active = false
      other.discarded = true
    }
    this.#winner = lane
    this.#assembler = new RecordAssembler(chosen.header, chosen.copy)
    if (this.#group.length !== this.#assembler.groupBytes) this.#group = new Uint8Array(this.#assembler.groupBytes)
    this.#groupFill = 0
    if (this.baud === undefined) out.push({ type: 'lock', baud: lane.baud })
    out.push({ type: 'header', header: chosen.header })
  }

  #dataByte(value: number, sample: number, out: DecoderEvent[]): void {
    const assembler = this.#assembler!
    const group = this.#group
    group[this.#groupFill++] = value
    if (this.#groupFill < group.length) return

    this.#groupFill = 0
    const stats = assembler.addGroup(group)
    out.push({
      type: 'progress',
      bytesReceived: stats.bytesReceived,
      bytesExpected: stats.bytesExpected,
      correctedBytes: stats.correctedBytes,
    })
    if (!assembler.complete) return

    try {
      const body = assembler.finish()
      out.push({ type: 'record', body, header: assembler.header, stats })
    } catch (error) {
      if (!(error instanceof BaudVaultError)) throw error
      out.push({ type: 'error', error, stats })
    }
    const winner = this.#winner!
    winner.active = false
    winner.pendingRelease = true
    this.#lockAllowedFrom = sample + this.#holdOffSamples
    this.#endRecord(out)
  }

  /** Carrier_Lock lost mid-record: report the partial stats, no Body (Requirement 5.9). */
  #signalLost(out: DecoderEvent[]): void {
    const partial = this.#assembler!.stats
    const stats: DecodeStats = { ...partial, bytesReceived: partial.bytesReceived + this.#groupFill }
    out.push({
      type: 'error',
      error: new FormatError('signal lost before end of tape record', stats.bytesReceived, 'bytes'),
      stats,
    })
    this.#endRecord(out)
  }

  #endRecord(out: DecoderEvent[]): void {
    this.#group.fill(0)
    this.#groupFill = 0
    this.#winner = null
    this.#assembler = null
    this.#rebuild = true
    this.#idleCheck(out)
  }

  /** Emits `unlock` once no lane holds an accepted lock. */
  #idleCheck(out: DecoderEvent[]): void {
    if (!this.#carrier) return
    for (const lane of this.#lanes) if (lane.active) return
    this.#carrier = false
    out.push({ type: 'unlock' })
  }
}
