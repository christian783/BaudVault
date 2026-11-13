import { describe, expect, it } from 'vitest'
import { ChunkCollector, MIC_CHUNK_SAMPLES } from './mic-worklet'

/** One render quantum of a ramp starting at `start`. */
function quantum(start: number, scale = 1): Float32Array {
  return Float32Array.from({ length: 128 }, (_, i) => ((start + i) % 1000) * scale * 1e-3)
}

describe('ChunkCollector', () => {
  it('posts one 2,048-sample chunk per 16 render quanta, in order and without gaps', () => {
    const collector = new ChunkCollector()
    const chunks: Float32Array[] = []
    for (let q = 0; q < 33; q++) collector.add([quantum(q * 128)], (chunk) => chunks.push(chunk))

    expect(chunks).toHaveLength(2)
    expect(chunks[0]).not.toBe(chunks[1])
    const joined = new Float32Array(2 * MIC_CHUNK_SAMPLES)
    joined.set(chunks[0]!, 0)
    joined.set(chunks[1]!, MIC_CHUNK_SAMPLES)
    for (let n = 0; n < joined.length; n++) expect(joined[n]).toBe(Math.fround((n % 1000) * 1e-3))
  })

  it('averages stereo input to mono', () => {
    const collector = new ChunkCollector(128)
    const chunks: Float32Array[] = []
    const left = new Float32Array(128).fill(0.5)
    const right = new Float32Array(128).fill(-0.25)
    collector.add([left, right], (chunk) => chunks.push(chunk))
    expect(chunks).toHaveLength(1)
    expect([...chunks[0]!].every((x) => x === 0.125)).toBe(true)
  })

  it('ignores a disconnected input with no channels', () => {
    const collector = new ChunkCollector(128)
    let emitted = 0
    collector.add([], () => emitted++)
    expect(emitted).toBe(0)
  })
})
