import { describe, expect, it } from 'vitest'
import { BitDemodulator, demodulateBytes, type DemodEvent } from './bit-demodulator'
import { type BaudRate, modulate, SAMPLE_RATE } from './kcs-modulator'

// Sanity checks only; the full modem tests are task 6.5.
describe('bit demodulator (sanity)', () => {
  const record = new Uint8Array(64).map((_, i) => (i * 37 + 11) & 0xff)
  record[0] = 0x00
  record[1] = 0xff

  it.each<BaudRate>([300, 2400])('recovers a clean modulated record exactly at %i baud', (baud) => {
    const samples = modulate(record, baud)
    expect(demodulateBytes(samples, SAMPLE_RATE, baud, record.length)).toEqual(record)
  })

  it.each<BaudRate>([300, 2400])('gives the same events for 2,048-sample chunks as for one push at %i baud', (baud) => {
    const samples = modulate(record, baud)
    const whole = new BitDemodulator(SAMPLE_RATE, baud).push(samples)
    const chunked = new BitDemodulator(SAMPLE_RATE, baud)
    const events: DemodEvent[] = []
    for (let i = 0; i < samples.length; i += 2_048) events.push(...chunked.push(samples.subarray(i, i + 2_048)))
    expect(events).toEqual(whole)
    expect(whole[0]?.type).toBe('lock')
  })
})
