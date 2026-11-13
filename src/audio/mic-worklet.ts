// AudioWorklet processor for microphone capture (design.md, "Audio shell";
// Requirement 5.6; kcs-audio steering, "Microphone").
//
// Runs on the audio rendering thread. It mixes each 128-frame render quantum
// down to mono, collects MIC_CHUNK_SAMPLES samples, and posts each full chunk
// to the main thread through the node's message port, transferring the
// buffer. The main thread pushes the chunks into a TapeDecoder. The processor
// writes nothing to its output, so the microphone is never played back.
//
// `microphone.ts` loads this file through Vite's `?worker&url`, which bundles
// it into a same-origin script. Registration is guarded so that Node tests can
// import `ChunkCollector` without the AudioWorklet globals.

/** Samples per chunk posted to the main thread. */
export const MIC_CHUNK_SAMPLES = 2_048
/** Name the processor is registered under. */
export const MIC_PROCESSOR_NAME = 'baudvault-mic'

/** Collects mono samples into fixed-size chunks. */
export class ChunkCollector {
  readonly size: number
  #chunk: Float32Array<ArrayBuffer>
  #fill = 0

  constructor(size: number = MIC_CHUNK_SAMPLES) {
    this.size = size
    this.#chunk = new Float32Array(size)
  }

  /**
   * Appends one block of channel data mixed down to mono by averaging, and
   * calls `emit` with every chunk that fills up. A chunk handed to `emit`
   * belongs to the receiver; the collector starts a new array afterwards.
   */
  add(channels: readonly Float32Array[], emit: (chunk: Float32Array<ArrayBuffer>) => void): void {
    const count = channels.length
    if (count === 0) return
    const first = channels[0]!
    const frames = first.length
    const scale = 1 / count
    for (let i = 0; i < frames; i++) {
      let x = first[i]!
      for (let c = 1; c < count; c++) x += channels[c]![i]!
      this.#chunk[this.#fill++] = count === 1 ? x : x * scale
      if (this.#fill === this.size) {
        const full = this.#chunk
        this.#chunk = new Float32Array(this.size)
        this.#fill = 0
        emit(full)
      }
    }
  }
}

// AudioWorkletGlobalScope members. The DOM library does not declare them.
declare const registerProcessor: ((name: string, processor: new () => object) => void) | undefined
declare const AudioWorkletProcessor: (new () => { readonly port: MessagePort }) | undefined

if (typeof registerProcessor === 'function' && typeof AudioWorkletProcessor === 'function') {
  class MicProcessor extends AudioWorkletProcessor {
    readonly #collector = new ChunkCollector()
    readonly #post = (chunk: Float32Array<ArrayBuffer>): void => {
      this.port.postMessage(chunk, [chunk.buffer])
    }

    process(inputs: Float32Array[][]): boolean {
      const input = inputs[0]
      if (input !== undefined) this.#collector.add(input, this.#post)
      // Keep running while the node exists; the main thread disconnects it on Stop.
      return true
    }
  }
  registerProcessor(MIC_PROCESSOR_NAME, MicProcessor)
}
