import { describe, expect, it } from 'vitest'
import { MIC_PROCESSOR_NAME } from './mic-worklet'
import { MIC_CONSTRAINTS, MIC_FAILURE_MESSAGES, type MicEnvironment, startMicrophone } from './microphone'

class FakeTrack {
  stopped = false
  stop(): void {
    this.stopped = true
  }
}

class FakeNode {
  readonly port = {
    onmessage: null as ((event: { data: unknown }) => void) | null,
    closed: false,
    close() {
      this.closed = true
    },
  }
  readonly connections: unknown[] = []
  disconnected = false
  connect(target: unknown): void {
    this.connections.push(target)
  }
  disconnect(): void {
    this.disconnected = true
  }
}

class FakeContext {
  state: 'running' | 'closed' = 'running'
  readonly sampleRate = 48_000
  readonly destination = { kind: 'destination' }
  readonly modules: string[] = []
  readonly sources: FakeNode[] = []
  readonly audioWorklet = {
    addModule: async (url: string) => {
      this.modules.push(url)
    },
  }
  createMediaStreamSource(): FakeNode {
    const node = new FakeNode()
    this.sources.push(node)
    return node
  }
  async resume(): Promise<void> {}
  async close(): Promise<void> {
    this.state = 'closed'
  }
}

type Harness = {
  env: MicEnvironment
  context: FakeContext
  tracks: FakeTrack[]
  nodes: FakeNode[]
  requests: unknown[]
}

function harness(overrides: { getUserMedia?: () => Promise<unknown>; workletFails?: boolean; supported?: boolean } = {}): Harness {
  const context = new FakeContext()
  const tracks = [new FakeTrack(), new FakeTrack()]
  const nodes: FakeNode[] = []
  const requests: unknown[] = []
  const getUserMedia =
    overrides.getUserMedia ?? (async () => ({ getTracks: () => tracks }))
  const env: MicEnvironment = {
    mediaDevices: {
      getUserMedia: (async (constraints: unknown) => {
        requests.push(constraints)
        return getUserMedia()
      }) as MediaDevices['getUserMedia'],
    },
    createContext: () => context as unknown as AudioContext,
    createWorkletNode: (_context, name) => {
      expect(name).toBe(MIC_PROCESSOR_NAME)
      if (overrides.workletFails === true) throw new Error('worklet node failed')
      const node = new FakeNode()
      nodes.push(node)
      return node as unknown as AudioWorkletNode
    },
    moduleUrl: '/assets/mic-worklet.js',
    supported: overrides.supported ?? true,
  }
  return { env, context, tracks, nodes, requests }
}

describe('startMicrophone', () => {
  it('requests the microphone with echo cancellation, noise suppression, and AGC off (5.6)', async () => {
    const h = harness()
    const result = await startMicrophone({ onChunk: () => {}, environment: h.env })
    expect(result.ok).toBe(true)
    expect(h.requests).toEqual([MIC_CONSTRAINTS])
    expect(MIC_CONSTRAINTS.audio).toMatchObject({
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    })
    expect(h.context.modules).toEqual(['/assets/mic-worklet.js'])
  })

  it('forwards worklet chunks with the context sample rate', async () => {
    const h = harness()
    const received: Array<[Float32Array, number]> = []
    const result = await startMicrophone({ onChunk: (s, rate) => received.push([s, rate]), environment: h.env })
    expect(result.ok && result.session.sampleRate).toBe(48_000)

    const node = h.nodes[0]!
    expect(h.context.sources[0]!.connections).toEqual([node])
    expect(node.connections).toEqual([h.context.destination])
    const chunk = new Float32Array(2_048).fill(0.25)
    node.port.onmessage!({ data: chunk })
    node.port.onmessage!({ data: 'not samples' })
    expect(received).toEqual([[chunk, 48_000]])
  })

  it('stop releases every MediaStreamTrack, disconnects the nodes, and closes the context (7.21)', async () => {
    const h = harness()
    const result = await startMicrophone({ onChunk: () => {}, environment: h.env })
    if (!result.ok) throw new Error('expected the microphone to start')

    await result.session.stop()
    expect(h.tracks.every((track) => track.stopped)).toBe(true)
    expect(h.nodes[0]!.disconnected).toBe(true)
    expect(h.nodes[0]!.port.onmessage).toBeNull()
    expect(h.nodes[0]!.port.closed).toBe(true)
    expect(h.context.sources[0]!.disconnected).toBe(true)
    expect(h.context.state).toBe('closed')

    await result.session.stop() // second Stop is harmless
  })

  it('reports a denied permission as "denied" and releases the context (5.8)', async () => {
    const h = harness({
      getUserMedia: () => Promise.reject(new DOMException('Permission denied', 'NotAllowedError')),
    })
    const result = await startMicrophone({ onChunk: () => {}, environment: h.env })
    expect(result).toEqual({ ok: false, reason: 'denied' })
    expect(MIC_FAILURE_MESSAGES.denied).toBe('Microphone access was denied')
    expect(h.context.state).toBe('closed')
  })

  it('stops every track when setup fails after permission was granted', async () => {
    const h = harness({ workletFails: true })
    const result = await startMicrophone({ onChunk: () => {}, environment: h.env })
    expect(result).toEqual({ ok: false, reason: 'failed' })
    expect(h.tracks.every((track) => track.stopped)).toBe(true)
    expect(h.context.state).toBe('closed')
  })

  it('reports an unsupported browser without creating a context or asking for permission', async () => {
    const h = harness({ supported: false })
    const result = await startMicrophone({ onChunk: () => {}, environment: h.env })
    expect(result).toEqual({ ok: false, reason: 'unsupported' })
    expect(h.requests).toEqual([])
    expect(h.context.modules).toEqual([])
  })
})
