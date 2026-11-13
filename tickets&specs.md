# BaudVault Engineering Tickets & Specifications

The spec in `.kiro/specs/baudvault-core/` is the source of truth. Each ticket lists the requirement IDs it delivers. If a ticket and the spec disagree, follow the spec and update the ticket.

## Wave Overview

**Wave 1 (Foundation & Kiro Harness):** Tickets BV-01, BV-02, and BV-03 establish the repository, specs, steering files, and air-gap guard. None of them depends on product code. BV-03 needs the steering files from BV-02, so Kiro's task graph schedules it one step after BV-02.

**Wave 2 (Core Engines):** Tickets BV-04, BV-05, and BV-06 run in parallel to implement the Web Crypto vault, Reed-Solomon error correction, and Kansas City Standard audio modem. The streaming tape decoder in BV-06 also needs the framer from BV-05.

**Wave 3 (Simulation, UI & PBT):** Tickets BV-07, BV-08, and BV-09 integrate the Virtual Tape Channel simulator, the retro CRT oscilloscope UI, and the fast-check Property-Based Testing suite.

**Wave 4 (Kiro Crew & Delivery):** Tickets BV-10, BV-11, and BV-12 build the companion Tape Librarian Kiro Crew app, production deployment, and three-minute YouTube demo package.

| Ticket | Status |
|---|---|
| BV-01 | Done |
| BV-02 | In review (Analyze Requirements not yet run) |
| BV-03 to BV-12 | Not started |

---

## Wave 1 Engineering Tickets

### Ticket BV-01

**Title:** Initialize Repository, TypeScript Tooling, and Root Kiro Directory

**Wave:** Wave 1 (No Dependencies)

**Status:** Done

**Spec refs:** None (tooling only)

**Description:** Set up the Vite, React, TypeScript, and Tailwind CSS workspace with a public MIT License and ensure the root `.kiro` directory is tracked in Git.

**Implementation Steps:**
1. Initialize the project with strict TypeScript settings
2. Install `fast-check` and `Vitest` for property testing
3. Add the MIT LICENSE file
4. Verify `.gitignore` never excludes the `.kiro` folder

**Acceptance Criteria:**
- Running the build and test commands succeeds with zero warnings
- GitHub displays the MIT license in the repository About section
- `git status` confirms the `.kiro` directory is tracked

---

### Ticket BV-02

**Title:** Author Kiro Specs and Workspace Steering Directives

**Wave:** Wave 1 (No Dependencies)

**Status:** In review

**Spec refs:** All requirements, design, and tasks

**Description:** Populate `.kiro/specs/baudvault-core/` with `requirements.md`, `design.md`, and `tasks.md`, and create workspace steering files inside `.kiro/steering/`.

**Implementation Steps:**
1. Write the ten EARS requirements in `requirements.md` (the original eight plus Accessibility and Browser Support)
2. Document the frame layout and five correctness properties in `design.md`
3. Define the wave task graph, including the Task Dependency Graph section, in `tasks.md`
4. Add YAML-front-matter steering files for KCS audio timings and air-gap rules

**Acceptance Criteria:**
- Kiro IDE parses all three spec files without syntax errors
- Running Analyze Requirements in Kiro reports zero conflicting or ambiguous EARS statements

---

### Ticket BV-03

**Title:** Configure Air-Gap Guard Hooks and Custom DSP Auditor Agent

**Wave:** Wave 1 (Depends on BV-02)

**Status:** Not started

**Spec refs:** Requirements 8.1, 8.7

**Description:** Build an air-gap scanner script, wire it into the npm build and test scripts, add Kiro hooks that run it when code changes, and create a custom agent in `.kiro/agents/dsp-auditor.json` bound to the workspace steering files.

**Implementation Steps:**
1. Write `scripts/airgap-scan.mjs`:
   - Default mode searches every file under `src/` for the six forbidden identifiers as plain text: `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `sendBeacon`, `RTCPeerConnection`
   - `--dist` mode searches built JavaScript in `dist/` for network calls, using the patterns in `design.md`
   - It exits with code 1 and lists each match by file and line
2. Add `npm run airgap` and `npm run airgap:dist`. Run `airgap` before Vitest in `npm test`, and `airgap:dist` after `vite build` in `npm run build`.
3. Create the Kiro hooks with Kiro's hook tool or UI, not by hand:
   - A `PreToolUse` command hook on file-writing tools. It reads the pending write from stdin and exits 2 to block any write under `src/` that contains a forbidden identifier.
   - A `PostFileSave` agent hook for files under `src/` that tells the agent to run `npm run airgap` and report violations, covering edits you make yourself
4. Bind steering markdown resources in `dsp-auditor.json`

**Acceptance Criteria:**
- An agent write of a file containing a `fetch` call under `src/crypto/` is blocked by the `PreToolUse` hook
- Saving such a file yourself makes the `PostFileSave` hook report the violation
- With such a file present, `npm test` and `npm run airgap` exit with a non-zero code
- An automated test in `test/` covers the scanner's pass and fail cases

---

## Wave 2 Engineering Tickets

### Ticket BV-04

**Title:** Build Compression and Web Crypto AES-256-GCM Vault Engine

**Wave:** Wave 2 (Depends on BV-01, BV-02)

**Status:** Not started

**Spec refs:** Requirements 1.1 to 1.7, 8.4, 8.5; Properties 1 and 2

**Description:** Implement local payload compression, PBKDF2 key derivation, and AES-256-GCM authenticated encryption and decryption using the browser Web Crypto API.

**Implementation Steps:**
1. Use `CompressionStream` for Deflate compression
2. Derive a 256-bit `CryptoKey` via PBKDF2 with 600,000 iterations and a 16-byte random salt (raised from 310,000, see decision D2 in `design.md`)
3. Encrypt with AES-256-GCM using a 12-byte random initialization vector

**Acceptance Criteria:**
- Any payload of 1 to 15,360 bytes decrypts back to exactly the original bytes, offline. Encryption itself is not deterministic, because every seal draws a new salt and IV.
- Wrong passwords or single-bit mutations of the sealed envelope throw an explicit authentication error
- A payload that decompresses to more than 15,360 bytes is rejected

---

### Ticket BV-05

**Title:** Implement Shamir Secret Sharing and Reed-Solomon (255, 223) Codec

**Wave:** Wave 2 (Depends on BV-01, BV-02)

**Status:** Not started

**Spec refs:** Requirements 2.1 to 2.5, 3.1 to 3.8, 8.5; Properties 3 and 4

**Description:** Build Galois Field GF(256) arithmetic to support K-of-N secret splitting and Reed-Solomon block forward error correction, and the tape framer that applies them.

**Implementation Steps:**
1. Implement GF(256) polynomial evaluation and Lagrange interpolation for Shamir shards
2. Build the Reed-Solomon generator polynomial
3. Implement Berlekamp-Massey / Forney error locator to append 32 parity bytes per 223-byte data chunk
4. Implement the tape framer: two header copies, padding, and interleaving

**Acceptance Criteria:**
- Any 2-of-3 or 3-of-5 shard combination reconstructs the exact ciphertext
- Mismatched, duplicated, or too few shards are rejected with a shard error
- Corrupting up to 16 random bytes in any 255-byte block is repaired with 100% bit accuracy

---

### Ticket BV-06

**Title:** Build 1975 Kansas City Standard AFSK Modulator and Goertzel Demodulator

**Wave:** Wave 2 (Depends on BV-01, BV-02; the streaming tape decoder also depends on BV-05's framer)

**Status:** Not started

**Spec refs:** Requirements 4.1 to 4.6, 5.1 to 5.5, 5.7; Property 5 (clean cases)

**Description:** Synthesize phase-continuous 1,200 Hz and 2,400 Hz audio waveforms exported as 44.1 kHz WAV files and decode incoming audio via a sliding Goertzel filter.

**Implementation Steps:**
1. Convert each byte into an 11-bit UART frame:
   - One start bit (zero)
   - Eight LSB-first data bits
   - Two stop bits (one)
2. Synthesize 300 baud and 2,400 baud Turbo PCM buffers
3. Build the Goertzel energy detector for microphone and WAV inputs
4. Benchmark the demodulator. It must process 300-baud audio at least 200 times faster than real time to fit the BV-09 test budget.

**Acceptance Criteria:**
- Encoding a byte array to a 44.1 kHz WAV buffer and passing it directly into the Goertzel demodulator recovers 100% of the bytes at both 300 baud and 2,400 baud

**Note:** Turbo stays at 2,400 baud unless the BV-07 measurement fails (decision D1 in `design.md`). In that case, Turbo becomes 1,200 baud and this ticket's 2,400-baud references change to 1,200.

---

## Wave 3 Engineering Tickets

### Ticket BV-07

**Title:** Build Virtual Analog Tape Channel Distortion Simulator

**Wave:** Wave 3 (Depends on BV-05, BV-06)

**Status:** Not started

**Spec refs:** Requirements 6.3 to 6.5; decision D1

**Description:** Create an in-memory distortion processor that adds adjustable tape hiss, bandpass roll-off, and motor wow-and-flutter speed drift so judges can test error recovery without external hardware. The processor is a pure function over audio samples. Web Audio only plays its output.

**Implementation Steps:**
1. Implement white-noise injection controlled by a Hiss slider (0 to 60%, where higher means more noise)
2. Implement time-varying resampling controlled by a Wow-and-Flutter slider (0 to 5%) between the modulator and demodulator
3. Measure Turbo mode through the channel at 30% hiss and 2% wow, and settle decision D1

**Acceptance Criteria:**
- Setting tape hiss to 30% and motor wobble to 2% visibly distorts the audio waveform
- In Standard mode (300 baud), the Reed-Solomon decoder still heals all corrupted bytes and unlocks the vault at those settings
- The Turbo measurement result is recorded under decision D1 in `design.md`

---

### Ticket BV-08

**Title:** Build 1970s CRT Oscilloscope UI and Tactile Virtual Cassette Deck

**Wave:** Wave 3 (Depends on BV-04, BV-06, BV-07)

**Status:** Not started

**Spec refs:** Requirements 5.6, 5.8, 6.1, 6.2, 7.1 to 7.27, 8.4, 9.1 to 9.6, 10.2, 10.3

**Description:** Construct the React frontend featuring a dual-trace green phosphor oscilloscope canvas, animated cassette reels, microphone listener controls, and a Reed-Solomon telemetry readout.

**Implementation Steps:**
1. Render real-time time-domain waveforms and 1,200/2,400 Hz Goertzel energy bars at 60 frames per second on HTML5 Canvas
2. Wire up WAV file export/import and live microphone capture
3. Display live parity repair counters
4. Warn when the password is shorter than 12 characters, without blocking Lock
5. Make every control keyboard-operable and labeled, and announce lock and decode results to screen readers
6. Detect missing browser features at startup and disable only the functions that need them

**Acceptance Criteria:**
- Users can lock a secret, download or play the WAV track
- Users can watch live frequency lock on the CRT oscilloscope during microphone playback
- Users can see the exact count of healed bytes on screen
- The whole flow works with the keyboard alone

**Manual check:** phone-to-laptop playback in Standard mode, including a desk tap

---

### Ticket BV-09

**Title:** Implement fast-check Property-Based Testing Suite

**Wave:** Wave 3 (Depends on BV-04, BV-05, BV-06, BV-07)

**Status:** Not started

**Spec refs:** Properties 1 to 5; Requirement 8.1

**Description:** Write automated `fast-check` property tests mapped 1-to-1 to the five Correctness Properties defined in `design.md`.

**Implementation Steps:**
1. Create property test suites executing 200 randomized runs per property across:
   - Arbitrary `Uint8Array` payloads
   - Random passwords
   - Shard subsets
   - Injected byte errors (1 to 16 bytes per block)
   - Noisy PCM buffers
2. Add `test/no-network.setup.ts`, which makes every network API throw during tests

**Acceptance Criteria:**
- All five property test suites pass 200 randomized iterations per run in under 15 seconds
- Zero counterexamples
- Zero outbound network calls

---

## Wave 4 Engineering Tickets

### Ticket BV-10

**Title:** Build Companion Tape Librarian Kiro Crew App ($1,000 Bonus Track)

**Wave:** Wave 4 (Depends on BV-05, BV-06)

**Status:** Not started

**Spec refs:** Reuses the framer, Reed-Solomon, and modem from Requirements 3 to 5. Its own spec lives in its repository.

**Description:** Create a standalone public GitHub repository containing the Tape Librarian Kiro Crew application that performs scheduled zero-knowledge parity audits on saved WAV files.

**Implementation Steps:**
1. Author the `app.json` manifest with a 30-minute cron schedule
2. Write the `SKILL.md` instructions
3. Implement the header/parity scanner script that repairs degraded WAV files without decryption keys
4. Build the React status page

**Acceptance Criteria:**
- The Kiro Crew app installs cleanly
- Detects and repairs a manually corrupted WAV file during a scheduled run
- Exposes zero plaintext or encryption keys in its logs

---

### Ticket BV-11

**Title:** Deploy Production Application to Netlify and Verify Offline PWA Capability

**Wave:** Wave 4 (Depends on BV-08, BV-09)

**Status:** Not started

**Spec refs:** Requirements 8.2, 8.3, 8.6, 8.7, 10.1

**Description:** Deploy BaudVault to a public production URL on Netlify with offline service-worker support for the judging window through January 29, 2027.

**Implementation Steps:**
1. Configure production build bundling. The Vite module-preload polyfill is already disabled, so the bundle makes no network calls.
2. Add `netlify.toml` (build command and publish directory) and `public/_headers` with the Content-Security-Policy rules from `design.md`
3. Add the offline service worker through the build plugin
4. Enable HTTPS for Web Audio microphone permissions and Web Crypto API access (Netlify serves HTTPS by default)
5. Verify full functionality when the browser is switched to offline mode after initial load

**Acceptance Criteria:**
- The live deployment URL loads in an unauthenticated browser session
- Passes the Air-Gap Guard check, including `npm run airgap:dist`
- The deployed page's response headers include `connect-src 'none'`
- Completes both virtual-tape and phone-to-laptop microphone recovery offline

---

### Ticket BV-12

**Title:** Record Under-3-Minute YouTube Demo and Finalize Devpost Package

**Wave:** Wave 4 (Depends on BV-10, BV-11)

**Status:** Not started

**Spec refs:** None (delivery only)

**Description:** Record the public YouTube demonstration video showing live Airplane Mode phone-to-laptop acoustic recovery and complete the eight Kiro engineering write-up sections on Devpost.

**Implementation Steps:**
1. Film a 170-second demo covering:
   - Secret encoding
   - Airplane Mode phone-to-laptop acoustic unlock with intentional desk-tap noise recovery
   - Virtual Tape slider testing
   - The Kiro IDE spec-to-PBT workflow

**Acceptance Criteria:**
- YouTube video is public and under 3 minutes
- Both GitHub repositories display open-source licenses in the About section and retain the root `.kiro` directory
- Devpost form is submitted before December 4, 2026