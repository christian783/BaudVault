// Microphone capture (design.md, "Audio shell"; Requirements 5.6, 5.8, 7.21;
// kcs-audio steering, "Microphone").
//
// `startMicrophone` creates its own AudioContext, loads the same-origin
// AudioWorklet module, requests the microphone with echo cancellation, noise
// suppression, and automatic gain control off, and wires
// MediaStreamAudioSourceNode → AudioWorkletNode → destination. The worklet
// writes silence, so nothing is heard. Each 2,048-sample chunk it posts goes
// to `onChunk` with the context's sample rate, for `TapeDecoder.push`.
//
// Failures come back as a typed result, never as a thrown error, so the UI
// can show "Microphone access was denied" and keep WAV import available
// (Requirement 5.8). Whatever was acquired before a failure is released.
//
// `stop` releases everything: every MediaStreamTrack is stopped, both nodes
// are disconnected, the port handler is removed, and the context is closed
// (Requirement 7.21).

import workletUrl from './mic-worklet.ts?worker&url'
import { MIC_CHUNK_SAMPLES, MIC_PROCESSOR_NAME } from './mic-worklet'

export { MIC_CHUNK_SAMPLES }

/** Browser speech processing treats steady tones as noise, so all of it stays off. */
export const MIC_CONSTRAINTS = {
  audio: {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    channelCount: 1,
  },
} as const satisfies MediaStreamConstraints

/** Why listening could not start. */
export type MicFailure =
  /** The user or the browser refused permission (Requirement 5.8). */
  | 'denied'
  /** No usable microphone was found, or it is in use elsewhere. */
  | 'no-device'
  /** The browser lacks AudioWorkletNode or getUserMedia, or the page is not a secure context. */
  | 'unsupported'
  /** Anything else, such as the worklet module failing to load. */
  | 'failed'

/** Messages the UI shows for each failure. */
export const MIC_FAILURE_MESSAGES: Readonly<Record<MicFailure, string>> = {
  denied: 'Microphone access was denied',
  'no-device': 'No microphone is available',
  unsupported: 'This browser cannot capture microphone audio',
  failed: 'The microphone could not be started',
}

export type MicSession = {
  /** The capture rate; pass it to the TapeDecoder. */
  readonly sampleRate: number
  /** Stops every track, disconnects the nodes, and closes the context. Safe to call twice. */
  stop(): Promise<void>
}

export type MicStartResult = { ok: true; session: MicSession } | { ok: false; reason: MicFailure }

/** The browser objects `startMicrophone` uses; tests replace them with fakes. */
export type MicEnvironment = {
  mediaDevices: Pick<MediaDevices, 'getUserMedia'> | undefined
  createContext: () => AudioContext
  createWorkletNode: (context: AudioContext, name: string, options: AudioWorkletNodeOptions) => AudioWorkletNode
  /** Same-origin URL of the bundled worklet module. */
  moduleUrl: string
  /** False when AudioWorkletNode is missing or the page is not a secure context. */
  supported: boolean
}

function browserEnvironment(): MicEnvironment {
  const scope = globalThis as typeof globalThis & { isSecureContext?: boolean }
  return {
    mediaDevices: scope.navigator?.mediaDevices,
    createContext: () => new AudioContext(),
    createWorkletNode: (context, name, options) => new AudioWorkletNode(context, name, options),
    moduleUrl: workletUrl,
    supported: typeof scope.AudioWorkletNode === 'function' && scope.isSecureContext === true,
  }
}

/** Maps a getUserMedia rejection to a failure reason by its DOMException name. */
export function classifyMicError(error: unknown): MicFailure {
  const name = typeof error === 'object' && error !== null && 'name' in error ? String(error.name) : ''
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') return 'denied'
  if (name === 'NotFoundError' || name === 'NotReadableError' || name === 'OverconstrainedError') return 'no-device'
  return 'failed'
}

export type StartMicrophoneOptions = {
  /** Receives each captured chunk of mono samples. The array belongs to the receiver. */
  onChunk: (samples: Float32Array, sampleRate: number) => void
  /** Browser objects; defaults to the real ones. */
  environment?: MicEnvironment
}

/**
 * Starts listening (Requirement 5.6). Call it from a user gesture so the new
 * AudioContext may run.
 */
export async function startMicrophone(options: StartMicrophoneOptions): Promise<MicStartResult> {
  const env = options.environment ?? browserEnvironment()
  if (!env.supported || typeof env.mediaDevices?.getUserMedia !== 'function') return { ok: false, reason: 'unsupported' }

  let context: AudioContext
  try {
    context = env.createContext()
  } catch {
    return { ok: false, reason: 'unsupported' }
  }

  let stream: MediaStream | undefined
  let source: MediaStreamAudioSourceNode | undefined
  let node: AudioWorkletNode | undefined
  let stopped = false

  const release = async (): Promise<void> => {
    if (stopped) return
    stopped = true
    if (stream !== undefined) for (const track of stream.getTracks()) track.stop()
    if (node !== undefined) {
      node.port.onmessage = null
      node.port.close()
      node.disconnect()
    }
    source?.disconnect()
    if (context.state !== 'closed') {
      try {
        await context.close()
      } catch {
        // Already closing; nothing else to release.
      }
    }
  }

  try {
    await context.audioWorklet.addModule(env.moduleUrl)
  } catch {
    await release()
    return { ok: false, reason: 'failed' }
  }

  try {
    stream = await env.mediaDevices.getUserMedia(MIC_CONSTRAINTS)
  } catch (error) {
    await release()
    return { ok: false, reason: classifyMicError(error) }
  }

  try {
    const sampleRate = context.sampleRate
    source = context.createMediaStreamSource(stream)
    node = env.createWorkletNode(context, MIC_PROCESSOR_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    })
    node.port.onmessage = (event: MessageEvent<unknown>) => {
      if (event.data instanceof Float32Array) options.onChunk(event.data, sampleRate)
    }
    source.connect(node)
    node.connect(context.destination)
    await context.resume()
    return { ok: true, session: { sampleRate, stop: release } }
  } catch {
    await release()
    return { ok: false, reason: 'failed' }
  }
}
