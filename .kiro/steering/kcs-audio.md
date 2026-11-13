---
inclusion: fileMatch
fileMatchPattern: ["src/modem/**", "src/channel/**", "src/tape/**", "src/audio/**", "src/properties/**"]
---

# Kansas City Standard Audio Rules

These values define the tape format. Changing any of them makes existing WAV files unreadable. The full specification is in `.kiro/specs/baudvault-core/design.md` (sections "Modulator", "Goertzel and bit demodulator", and "Audio signal"). If a change seems necessary, update `design.md` first and tell the user.

## Fixed values

| Item | Value |
|---|---|
| Space (bit 0) | 1,200 Hz |
| Mark (bit 1) | 2,400 Hz |
| Standard_Mode | 300 baud: 4 cycles of 1,200 Hz or 8 cycles of 2,400 Hz per bit |
| Turbo_Mode | 2,400 baud: ½ cycle of 1,200 Hz or 1 cycle of 2,400 Hz per bit |
| Byte frame | 11 bits: start 0, 8 data bits LSB first, stop 1, stop 1, with no idle bits between bytes |
| Leader | 2.0 s of mark tone |
| Trailer | 0.5 s of mark tone |
| Output sample rate | 44,100 Hz |
| Tone amplitude | 0.7 of full scale |
| WAV export | RIFF, mono, 16-bit signed little-endian PCM |
| Interleave_Depth | 1 at 300 baud, 4 at 2,400 baud |

## Timing

- Samples per bit are `sampleRate / baud`: 147 at 300 baud and 18.375 at 2,400 baud. Never round this to an integer and accumulate it.
- Bit `k` starts at sample `round(k * sampleRate / baud)`. Compute every boundary from `k`.
- Use one phase accumulator in float64 for the whole signal. Never reset the phase at a bit or byte boundary, because phase jumps add clicks and spread energy into the other tone's bin.

## Demodulation

- The decoder must accept any `sampleRate` from 22,050 to 96,000 Hz. Microphones usually run at 48,000 Hz. Derive the window length and bit period from the actual rate instead of resampling.
- The Goertzel window is one bit long. The decision signal is `(E2400 − E1200) / (E2400 + E1200 + ε)`, positive for mark.
- Sample bit `i` of a frame at `t_edge + (i + 1) * T`, when the one-bit window exactly covers that bit.
- Keep the byte count exact. During Carrier_Lock, emit one byte per 11-bit frame period even when no start edge is found. Reed-Solomon fixes wrong bytes but cannot fix missing or extra ones.
- Clamp the bit-period estimate to ±10% of nominal. The Virtual_Tape_Channel can drift speed by up to 5%.

## Microphone

- Always request `echoCancellation: false`, `noiseSuppression: false`, and `autoGainControl: false`. Browser speech processing treats steady tones as noise and removes them.
- Process audio in an AudioWorklet and pass chunks to the main thread. Do not use `ScriptProcessorNode`, which is deprecated.

## Performance

The property tests decode about 15 seconds of 300-baud audio per case, and the suite must finish in under 15 seconds. Keep per-sample work in the demodulator free of allocations, use typed arrays, and avoid closures or object creation inside sample loops.
