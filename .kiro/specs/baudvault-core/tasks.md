# Implementation Plan: BaudVault Core

## Overview

The plan follows the four waves in `tickets&specs.md`. Each top-level task is one ticket. All property tests are required, so no sub-task is marked optional. Manual checks and work outside this repository are listed under Notes, not as tasks.

## Tasks

- [x] 1. BV-01 Initialize repository, TypeScript tooling, and root `.kiro` directory
  - Vite, React 19, TypeScript (strict), Tailwind CSS 4, Vitest, fast-check, oxlint
  - MIT LICENSE in place, `.gitignore` never ignores `.kiro`
  - _Wave 1, no dependencies_

- [x] 2. BV-02 Author Kiro specs and workspace steering
  - `requirements.md` (10 EARS requirements), `design.md` (frame layout, 5 correctness properties), `tasks.md`
  - `.kiro/steering/kcs-audio.md` and `.kiro/steering/air-gap.md`
  - _Wave 1, no dependencies_

- [ ] 3. BV-03 Air-gap scanner, hooks, and DSP Auditor agent
  - _Wave 1, depends on 2_
  - [ ] 3.1 Write `scripts/airgap-scan.mjs` with a shared word list
    - Default mode: plain-text scan of every file under `src/`
    - `--dist` mode: scan `dist/**/*.js` except the service worker, using the call patterns in `design.md`
    - Exit 1 and print `file:line` for each match
    - Add `npm run airgap` and `npm run airgap:dist`; run `airgap` before Vitest in `npm test` and `airgap:dist` after `vite build` in `npm run build`
    - _Requirements: 8.1, 8.7_
  - [ ] 3.2 Write `test/airgap-scan.test.ts`
    - Cover pass and fail cases for both modes using temporary directories
    - Add `test/**/*.test.ts` to Vitest `test.include` in `vite.config.ts`
    - _Requirements: 8.1, 8.7_
  - [ ] 3.3 Write `scripts/airgap-hook.mjs` and create the pre-write hook
    - Read the pending tool input JSON from stdin; exit 2 with a stderr message when a write under `src/` contains a forbidden word
    - Create the `PreToolUse` command hook for file-writing tools with Kiro's hook tool, not by hand
    - _Requirements: 8.1_
  - [ ] 3.4 Create the save-check hook
    - Create the `PostFileSave` agent hook for `src/` paths with Kiro's hook tool; it tells the agent to run `npm run airgap` and report violations
    - _Requirements: 8.1_
  - [ ] 3.5 Create `.kiro/agents/dsp-auditor.json` with `.kiro/steering/**/*.md` and the spec files as resources

- [ ] 4. BV-04 Vault engine: compression and AES-256-GCM
  - _Wave 2, depends on 1, 2_
  - [ ] 4.1 Create `src/core/errors.ts` and `src/core/bytes.ts`
    - Error classes take fixed messages and safe numbers only
    - _Requirements: 1.3, 1.4, 1.5, 8.9_
  - [ ] 4.2 Implement `src/crypto/compress.ts`
    - Deflate compress; decompress capped at 15,360 bytes; malformed Deflate becomes `FormatError`
    - _Requirements: 1.1, 1.7, 1.8_
  - [ ] 4.3 Implement `seal` and `open` in `src/crypto/vault.ts`
    - Envelope v1 layout, header as AAD, NFC Password normalization, 600,000 PBKDF2 iterations
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 8.5_
  - [ ] 4.4 Write unit tests for the vault engine
    - Production iteration count 600,000, 15,360-byte input limit, size and version errors, decompression cap, malformed Deflate after authentication
    - _Requirements: 1.1, 1.4, 1.5, 1.7, 1.8_
  - [ ] 4.5 Write property test for seal and open round trip
    - **Property 1: Seal and open round trip**
    - **Validates: Requirements 1.1, 1.2, 1.6**
  - [ ] 4.6 Write property test for authentication
    - **Property 2: Authentication rejects every change**
    - **Validates: Requirements 1.3, 1.4**

- [ ] 5. BV-05 GF(256), Shamir Secret Sharing, Reed-Solomon (255, 223), and framer
  - _Wave 2, depends on 1, 2_
  - [ ] 5.1 Implement `src/gf256/gf256.ts` (0x11D, α = 0x02, exp/log tables)
    - _Requirements: 2.1, 3.2_
  - [ ] 5.2 Implement `src/shamir/shamir.ts`
    - Shard v1 layout validation (`FormatError`) and set checks (`ShardError`)
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 8.5_
  - [ ] 5.3 Implement `src/fec/reed-solomon.ts` and `src/fec/crc.ts`
    - _Requirements: 3.2, 3.3, 3.4_
  - [ ] 5.4 Implement `src/tape/framer.ts`
    - Header_Frame, padding, Interleave_Groups, `frame`, `parseHeaderFrame`, `unframe`; `unframe` reports every uncorrectable block
    - _Requirements: 3.1, 3.4, 3.5, 3.6, 3.7, 3.8_
  - [ ] 5.5 Write unit tests for GF(256), CRC, Reed-Solomon, framer, and Shamir
    - GF identities, CRC check values, 16 errors corrected and 17 rejected, header copy fallback, CRC integrity failure, empty and oversize Body, mismatched and duplicate Shards, bad split arguments, malformed Shard
    - _Requirements: 2.4, 2.5, 2.6, 3.3, 3.4, 3.6, 3.7, 3.8_
  - [ ] 5.6 Write property test for Shamir threshold reconstruction
    - **Property 3: Shamir threshold reconstruction**
    - **Validates: Requirements 2.1, 2.2, 2.3**
  - [ ] 5.7 Write property test for Reed-Solomon repair
    - **Property 4: Reed-Solomon repairs bounded damage**
    - **Validates: Requirements 3.1, 3.2, 3.3, 3.5, 3.6**

- [ ] 6. BV-06 Kansas City Standard modulator and Goertzel demodulator
  - _Wave 2, depends on 1, 2; task 6.4 also depends on 5.4_
  - [ ] 6.1 Implement `src/modem/kcs-modulator.ts`
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5_
  - [ ] 6.2 Implement `src/modem/wav.ts`
    - _Requirements: 4.6, 5.4, 5.5_
  - [ ] 6.3 Implement `src/modem/goertzel.ts` and `src/modem/bit-demodulator.ts`
    - _Requirements: 5.2, 5.7_
  - [ ] 6.4 Implement `src/tape/tape-decoder.ts`
    - Auto baud detection, progress events, decodes every group after a failure, silent release when both headers are unusable, error with partial stats on signal loss
    - _Requirements: 3.4, 3.6, 3.7, 3.9, 5.1, 5.3, 5.9_
  - [ ] 6.5 Write unit tests for the modulator, WAV codec, and Tape_Decoder
    - Modulated length at 2,400 baud, WAV header bytes, 8-bit, 24-bit, float, stereo, and WAVE_FORMAT_EXTENSIBLE parsing, auto baud detection, truncated record, both header copies unusable
    - _Requirements: 3.9, 4.4, 4.6, 5.3, 5.4, 5.5, 5.9_
  - [ ] 6.6 Write a benchmark test for the demodulator
    - Show that the 300-baud demodulator processes audio at least 200 times faster than real time
    - _Requirements: 5.2_

- [ ] 7. BV-07 Virtual Tape Channel
  - _Wave 3, depends on 5, 6_
  - [ ] 7.1 Implement `src/channel/prng.ts`, `src/channel/biquad.ts`, and `src/channel/virtual-tape.ts`
    - _Requirements: 6.3, 6.4_
  - [ ] 7.2 Write automated tests for the channel
    - Channel determinism for the same seed; Standard_Mode recovery at 30% hiss and 2% wow across random seeds
    - _Requirements: 6.4, 6.5_
  - [ ] 7.3 Write a Turbo_Mode measurement test and record decision D1
    - Run at 30% hiss and 2% wow over at least 50 random Bodies and seeds and report pass or fail
    - Record the result under decision D1 in `design.md`
    - _Requirements: 6.5_

- [ ] 8. BV-08 CRT oscilloscope UI and virtual cassette deck
  - _Wave 3, depends on 4, 6, 7_
  - [ ] 8.1 Implement `src/audio/playback.ts`, `src/audio/microphone.ts`, and `src/audio/mic-worklet.ts`
    - Stop releases every `MediaStreamTrack`
    - Play with the Virtual_Tape_Channel on is processed; imports and exports are not
    - _Requirements: 4.6, 5.6, 5.8, 6.2, 6.6, 7.21_
  - [ ] 8.2 Build the Record and Deck panels, including the password warning
    - _Requirements: 6.1, 6.2, 7.1, 7.14, 7.15, 7.16, 7.17, 7.18, 7.19, 7.20, 7.21, 7.22, 7.25, 7.26_
  - [ ] 8.3 Build the oscilloscope canvas, energy bars, LOCK lamp, and telemetry readout
    - _Requirements: 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 7.8_
  - [ ] 8.4 Build Shard collection, Unlock, Reveal, Clear, reduced-motion reels, busy state, and error display
    - Keep secrets out of storage, logs, and the URL
    - _Requirements: 7.9, 7.10, 7.11, 7.12, 7.13, 7.23, 7.24, 7.27, 7.28, 8.4_
  - [ ] 8.5 Implement accessibility
    - Keyboard order, focus ring, accessible names, contrast, polite live region without secrets, text equivalents for the canvas, masked secret for assistive technology
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7, 9.8_
  - [ ] 8.6 Implement startup feature detection
    - Name each missing feature and disable only the affected functions
    - _Requirements: 10.2, 10.3_
  - [ ] 8.7 Write unit tests for the pure UI helpers
    - Password length rule, error message mapping, feature detection, Shard grouping by set ID
    - _Requirements: 7.9, 7.25, 7.26, 7.28, 10.2, 10.3_

- [ ] 9. BV-09 fast-check property suite
  - _Wave 3, depends on 4, 5, 6, 7_
  - [ ] 9.1 Add `test/no-network.setup.ts` (outside `src/`) and register it in `vite.config.ts`
    - _Requirements: 8.1_
  - [ ] 9.2 Confirm that the P1 to P4 suites from tasks 4 and 5 live in `src/properties/` and run 200 times each
  - [ ] 9.3 Write property test for the acoustic round trip
    - **Property 5: Acoustic round trip**
    - **Validates: Requirements 4.1, 4.2, 4.3, 4.4, 4.5, 5.1, 5.2, 5.7, 6.3, 6.5**
  - [ ] 9.4 Run `npm test` and optimize until it finishes in under 15 seconds with zero counterexamples

- [ ] 10. Checkpoint: all tests pass, build has zero warnings, `npm run airgap` and `npm run airgap:dist` pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 11. BV-11 Netlify configuration and offline service worker
  - _Wave 4, depends on 8, 9, 10_
  - [ ] 11.1 Add `netlify.toml` and `public/_headers`
    - `netlify.toml`: build command `npm run build`, publish directory `dist`
    - `public/_headers`: the per-path CSP from `design.md`, with no `/*` CSP rule
    - _Requirements: 8.2, 8.6_
  - [ ] 11.2 Add the offline service worker through the build plugin
    - Precache only same-origin files, and exclude the service worker from the `--dist` scan
    - _Requirements: 8.3, 8.7, 8.8_
  - [ ] 11.3 Write a test for `public/_headers`
    - Assert `connect-src 'none'` on `/` and `/index.html`, `default-src 'self'` on the service worker path, and no `/*` CSP rule
    - _Requirements: 8.6, 8.8_

## Notes

- Decisions: D2 is settled (600,000 iterations, task 4.3). D1 is settled except for its measurement in task 7.3, which either extends Requirement 6.5 and Property 5 to Turbo_Mode or triggers the 1,200-baud fallback listed in `design.md`.
- Manual checks, not run by the agent: phone-to-laptop playback in Standard_Mode with a desk tap (BV-08); offline reload and phone-to-laptop recovery on the deployed site, and the live response headers (BV-11); the browser matrix in Requirement 10.1.
- Out of this spec: BV-10 Tape Librarian lives in its own repository and reuses `src/fec`, `src/tape/framer.ts`, and `src/modem`. BV-12 demo video and Devpost package are delivery work. Both are tracked in `tickets&specs.md`.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["3.1", "3.4", "3.5", "4.1", "5.1", "6.1"] },
    { "id": 1, "tasks": ["3.2", "3.3", "4.2", "5.2", "5.3", "6.2", "6.3"] },
    { "id": 2, "tasks": ["4.3", "5.4"] },
    { "id": 3, "tasks": ["4.4", "4.5", "4.6", "5.5", "5.6", "5.7", "6.4"] },
    { "id": 4, "tasks": ["6.5", "6.6"] },
    { "id": 5, "tasks": ["7.1"] },
    { "id": 6, "tasks": ["7.2", "7.3"] },
    { "id": 7, "tasks": ["8.1", "9.1"] },
    { "id": 8, "tasks": ["8.2", "9.2"] },
    { "id": 9, "tasks": ["8.3", "9.3"] },
    { "id": 10, "tasks": ["8.4"] },
    { "id": 11, "tasks": ["8.5"] },
    { "id": 12, "tasks": ["8.6"] },
    { "id": 13, "tasks": ["8.7"] },
    { "id": 14, "tasks": ["9.4"] },
    { "id": 15, "tasks": ["11.1", "11.2"] },
    { "id": 16, "tasks": ["11.3"] }
  ]
}
```
