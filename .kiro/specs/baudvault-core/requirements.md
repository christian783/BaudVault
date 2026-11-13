# Requirements Document

## Introduction

BaudVault is an offline browser application that encrypts a secret with a password and stores it as audio in the 1975 Kansas City Standard (KCS) cassette format. The audio can be saved as a WAV file or played through a speaker and captured by another device's microphone. Reed-Solomon error correction repairs bytes damaged by noise, and optional Shamir Secret Sharing splits the encrypted secret across several tapes. A Virtual Tape Channel simulates tape hiss and motor speed drift so error recovery can be tested without hardware. The application never uses the network.

Scope: this spec covers the core BaudVault web application. The Tape Librarian Kiro Crew app (ticket BV-10), production deployment steps (BV-11), and the demo package (BV-12) are tracked as tasks but specified elsewhere. Byte layouts, constants, and algorithms referenced below are defined in `design.md`.

## Glossary

- **BaudVault**: The complete web application described by this spec.
- **Plaintext**: The secret bytes the user wants to protect. Text secrets are encoded as UTF-8.
- **Password**: The user-supplied string from which the encryption key is derived.
- **Vault_Engine**: The module that compresses, encrypts, decrypts, and decompresses Plaintext.
- **Envelope**: The encrypted output of the Vault_Engine in the v1 layout defined in `design.md`.
- **Shard_Codec**: The module that splits an Envelope into Shards and combines Shards back into an Envelope.
- **Shard**: One share of an Envelope produced by Shamir Secret Sharing, in the v1 layout defined in `design.md`.
- **K**: The minimum number of Shards needed to rebuild an Envelope.
- **N**: The total number of Shards produced by one split.
- **Body**: The bytes carried by one tape: either one Envelope or one Shard.
- **FEC_Codec**: The Reed-Solomon (255, 223) encoder and decoder over GF(256).
- **Codeword**: One 255-byte Reed-Solomon block: 223 data bytes followed by 32 parity bytes.
- **Tape_Framer**: The module that turns a Body into a Tape_Record.
- **Tape_Record**: The byte stream written to tape: two Header_Frame copies followed by interleaved Codewords.
- **Interleave_Depth**: The number of Codewords whose bytes are interleaved together in one group: 1 in Standard_Mode and 4 in Turbo_Mode.
- **Interleave_Group**: One run of Interleave_Depth Codewords transmitted with their bytes interleaved.
- **Header_Frame**: A 48-byte Reed-Solomon-protected block describing the Tape_Record.
- **Standard_Mode**: Transmission at 300 baud.
- **Turbo_Mode**: Transmission at 2,400 baud.
- **Modulator**: The module that turns a Tape_Record into KCS audio samples.
- **Tape_Decoder**: The module that turns audio samples back into a Body, including bit demodulation, framing, and error correction.
- **Virtual_Tape_Channel**: The in-memory processor that adds hiss, bandpass filtering, and wow-and-flutter to audio samples.
- **Hiss_Level**: The ratio of added noise RMS to Nominal_Carrier_RMS, from 0% to 60%.
- **Wow_Level**: The peak deviation of simulated tape speed from nominal, from 0% to 5%.
- **Nominal_Carrier_RMS**: The RMS of a Modulator tone at full output amplitude: 0.7 / √2 ≈ 0.495 of full scale.
- **Deck_UI**: The React user interface, including the oscilloscope, cassette deck, and telemetry readout.
- **Carrier_Lock**: The Tape_Decoder state that begins when a leader tone is detected and ends when the record completes or the signal is lost.

## Requirements

### Requirement 1: Vault Encryption

**User Story:** As a user, I want my secret compressed and encrypted with my password before it becomes audio, so that anyone who records the tape cannot read it.

#### Acceptance Criteria

1. WHEN the user seals a Plaintext of 1 to 15,360 bytes with a non-empty Password, THE Vault_Engine SHALL compress the Plaintext with Deflate, derive a 256-bit key with PBKDF2-HMAC-SHA-256 using 600,000 iterations and a new 16-byte random salt, encrypt the compressed bytes with AES-256-GCM using a new 12-byte random IV, and return an Envelope in the v1 layout.
2. WHEN the user opens an Envelope with the Password it was sealed with, THE Vault_Engine SHALL return a Plaintext identical byte for byte to the sealed Plaintext.
3. IF the Password differs from the sealing Password, or the Envelope differs from the sealed Envelope in any way not covered by criterion 4, THEN THE Vault_Engine SHALL reject the Envelope with an AuthenticationError and return no Plaintext bytes.
4. IF any Envelope given to the Vault_Engine is shorter than 50 bytes, declares a version other than 1, or declares an iteration count outside 1,000 to 5,000,000, THEN THE Vault_Engine SHALL reject it with a FormatError without deriving a key, regardless of which operation or caller supplied the Envelope.
5. IF the user requests sealing with an empty Plaintext, a Plaintext longer than 15,360 bytes, or an empty Password, THEN THE Vault_Engine SHALL reject the request with an InputError.
6. THE Vault_Engine SHALL normalize every Password to Unicode NFC and encode it as UTF-8 before key derivation.
7. IF an authenticated Envelope decompresses to more than 15,360 bytes, THEN THE Vault_Engine SHALL stop decompressing and reject the Envelope with a FormatError.
8. IF an authenticated Envelope's decrypted bytes are not a valid Deflate stream, THEN THE Vault_Engine SHALL reject the Envelope with a FormatError and return no Plaintext bytes.

### Requirement 2: Shamir Secret Sharing

**User Story:** As a user, I want to split my sealed secret across several tapes, so that any K of them restore it and a single lost or stolen tape does not.

#### Acceptance Criteria

1. WHEN the user splits an Envelope with 2 ≤ K ≤ N ≤ 16, THE Shard_Codec SHALL produce N Shards using Shamir Secret Sharing over GF(256), each carrying the same random 4-byte set ID, K, N, and a distinct index from 1 to N.
2. WHEN the user combines K or more Shards that share one set ID and have distinct indices, THE Shard_Codec SHALL return an Envelope identical byte for byte to the Envelope that was split.
3. IF the supplied Shards pass the checks in criteria 4 and 6 and number fewer than their shared K, THEN THE Shard_Codec SHALL reject the request with a ShardError stating how many more Shards are needed.
4. IF the supplied Shards differ in set ID, K, N, or length, or two Shards share an index, THEN THE Shard_Codec SHALL reject the request with a ShardError.
5. IF the user requests a split with K < 2, N < K, or N > 16, THEN THE Shard_Codec SHALL reject the request with an InputError.
6. IF a supplied Shard does not match the v1 Shard layout defined in `design.md`, or declares K and N outside 2 ≤ K ≤ N ≤ 16, or declares an index outside 1 to N, THEN THE Shard_Codec SHALL reject the request with a FormatError without combining any Shards.

### Requirement 3: Error Correction and Tape Framing

**User Story:** As a user, I want each tape to survive hiss, dropouts, and knocks, so that my secret comes back intact from imperfect audio.

#### Acceptance Criteria

1. WHEN a Body of 1 to 16,384 bytes is framed, THE Tape_Framer SHALL produce a Tape_Record consisting of two identical Header_Frames followed by the Body's Codewords in Interleave_Groups, with the block count and byte order defined in `design.md`.
2. THE FEC_Codec SHALL encode with Reed-Solomon over GF(256) using primitive polynomial 0x11D, generator α = 0x02, first consecutive root α^0, and 32 parity bytes per block.
3. WHEN a Codeword or Header_Frame contains 16 or fewer byte errors, THE FEC_Codec SHALL restore its original data bytes and report how many bytes it corrected.
4. IF the FEC_Codec determines that one or more Codewords have more errors than it can correct, THEN THE Tape_Decoder SHALL reject the Tape_Record with an UncorrectableError that lists the zero-based index of every uncorrectable Codeword in the Tape_Record.
5. WHEN the data section of a Tape_Record contains one burst of consecutive byte errors no longer than 16 × Interleave_Depth bytes and no other errors, THE Tape_Decoder SHALL restore the Body.
6. IF the first Header_Frame copy is unusable as defined in the Header_Frame section of `design.md`, THEN THE Tape_Decoder SHALL use the second copy.
7. IF the CRC-32 of a restored Body differs from the CRC-32 in its Header_Frame, THEN THE Tape_Decoder SHALL reject the Tape_Record with an IntegrityError.
8. IF an empty Body or a Body longer than 16,384 bytes is submitted for framing, THEN THE Tape_Framer SHALL reject it with an InputError.
9. IF both Header_Frame copies are unusable as defined in the Header_Frame section of `design.md`, THEN THE Tape_Decoder SHALL release Carrier_Lock, return no Body and no error, and resume searching for a leader tone.

### Requirement 4: Kansas City Standard Modulation and WAV Export

**User Story:** As a user, I want my sealed secret turned into authentic 1975-style cassette audio, so that I can save it as a file or play it through any speaker.

#### Acceptance Criteria

1. WHEN a Tape_Record is modulated, THE Modulator SHALL send each byte as an 11-bit frame of one start bit with value 0, eight data bits least-significant bit first, and two stop bits with value 1, with no idle time between consecutive frames.
2. THE Modulator SHALL represent a 0 bit as a 1,200 Hz tone and a 1 bit as a 2,400 Hz tone, with no phase discontinuity at any bit boundary, including where the leader meets the Tape_Record and where the Tape_Record meets the trailer.
3. WHILE Standard_Mode is selected, THE Modulator SHALL transmit at 300 baud.
4. WHILE Turbo_Mode is selected, THE Modulator SHALL transmit at 2,400 baud.
5. WHEN a Tape_Record is modulated, THE Modulator SHALL precede it with 2.0 seconds of 2,400 Hz leader tone and follow it with 0.5 seconds of 2,400 Hz trailer tone.
6. WHEN the user exports a tape, THE BaudVault SHALL produce a RIFF WAV file of the Modulator output without Virtual_Tape_Channel processing, whether or not the Virtual_Tape_Channel is enabled, containing mono, 16-bit signed little-endian PCM at 44,100 Hz, with every tone a sine wave of peak amplitude 0.7 of full scale (22,937 of 32,767).

### Requirement 5: Demodulation from WAV Files and Microphone

**User Story:** As a user, I want to recover a tape from a WAV file or from live microphone audio, so that I can unlock my secret on a device that has never been online.

#### Acceptance Criteria

1. WHEN a WAV file produced by the BaudVault is decoded without passing through the Virtual_Tape_Channel, THE Tape_Decoder SHALL recover every byte of the Tape_Record at both 300 baud and 2,400 baud and report zero corrected bytes.
2. THE Tape_Decoder SHALL decide each bit by comparing sliding Goertzel energy at 1,200 Hz and 2,400 Hz over a window of one bit period.
3. WHEN the Tape_Decoder receives audio without being told the baud rate, THE Tape_Decoder SHALL attempt to decode the Header_Frame at both 300 baud and 2,400 baud and SHALL decode the rest of the Tape_Record at the rate whose Header_Frame decodes.
4. WHEN the user imports a RIFF WAV file containing 8-, 16-, 24-, or 32-bit integer PCM or 32-bit float PCM, in plain or WAVE_FORMAT_EXTENSIBLE format, in mono or stereo with stereo channels averaged, at a sample rate from 22,050 Hz to 96,000 Hz inclusive, THE Tape_Decoder SHALL recover the Body of each Tape_Record that the BaudVault modulated and that was converted to that format without added noise.
5. IF an imported file is not a RIFF WAV file or uses an encoding, channel count, or sample rate outside those in criterion 4, THEN THE BaudVault SHALL reject it with a FormatError naming the unsupported property.
6. WHEN the user starts listening, THE BaudVault SHALL capture microphone audio with echo cancellation, noise suppression, and automatic gain control disabled and stream it to the Tape_Decoder.
7. WHILE the Tape_Decoder holds Carrier_Lock, THE Tape_Decoder SHALL realign its bit clock to each start-bit edge detected within ±0.5 bit period of its expected position and SHALL emit exactly one byte per 11-bit frame period, including periods in which no start-bit edge is detected.
8. IF the browser denies microphone access, THEN THE Deck_UI SHALL state that microphone access was denied and keep WAV import available.
9. IF Carrier_Lock is lost before every Interleave_Group of a Tape_Record has been received, THEN THE Tape_Decoder SHALL report a decode error with the bytes received and corrected-byte count so far, return no Body, and resume searching for a leader tone.

### Requirement 6: Virtual Tape Channel

**User Story:** As a judge or user, I want to degrade a tape with simulated hiss and motor wobble, so that I can watch error correction work without a cassette deck.

#### Acceptance Criteria

1. THE Deck_UI SHALL provide a Hiss slider that sets Hiss_Level from 0% to 60% and a Wow-and-Flutter slider that sets Wow_Level from 0% to 5%.
2. WHILE the Virtual_Tape_Channel is enabled, WHEN the user selects Play on a tape, THE BaudVault SHALL pass that tape's audio through the Virtual_Tape_Channel, play the processed audio, and send the processed audio to the Tape_Decoder.
3. WHEN the Virtual_Tape_Channel processes audio, THE Virtual_Tape_Channel SHALL apply a 300 Hz to 5,000 Hz bandpass filter, resample with a time-varying speed whose peak deviation equals Wow_Level, and add white noise whose RMS equals Hiss_Level multiplied by the Nominal_Carrier_RMS.
4. WHEN the Virtual_Tape_Channel processes the same samples with the same settings and seed, THE Virtual_Tape_Channel SHALL produce identical output.
5. WHILE Standard_Mode is selected, Hiss_Level is at most 30%, and Wow_Level is at most 2%, THE BaudVault SHALL recover byte for byte every Body that passed through the Virtual_Tape_Channel, for any seed and any Plaintext of 1 to 15,360 bytes, and unlock the secret with the sealing Password.
6. WHEN the user imports a WAV file, THE BaudVault SHALL send the file's audio to the Tape_Decoder without Virtual_Tape_Channel processing, whether or not the Virtual_Tape_Channel is enabled.

### Requirement 7: Retro Deck Interface and Telemetry

**User Story:** As a user, I want a 1970s oscilloscope and cassette deck interface with live repair statistics, so that I can see the signal and know how much damage was healed.

#### Acceptance Criteria

1. THE Deck_UI SHALL provide a text input for the secret and a masked input for the Password.
2. THE Deck_UI SHALL draw a two-trace oscilloscope on an HTML canvas, where trace A shows the most recent 20 ms of audio and trace B shows the Tape_Decoder's mark-minus-space energy signal over the same 20 ms.
3. THE Deck_UI SHALL show one bar for the current 1,200 Hz Goertzel energy and one bar for the current 2,400 Hz Goertzel energy.
4. WHILE audio is playing or the microphone is listening, THE Deck_UI SHALL redraw the oscilloscope and energy bars once per animation frame, up to 60 frames per second.
5. WHILE the Virtual_Tape_Channel is enabled, THE Deck_UI SHALL draw the Virtual_Tape_Channel output, not the unprocessed audio, on trace A.
6. WHILE the Tape_Decoder holds Carrier_Lock, THE Deck_UI SHALL light a LOCK indicator.
7. WHILE a Tape_Record is being decoded, THE Deck_UI SHALL show bytes received, bytes expected, and the running count of corrected bytes, updated each time an Interleave_Group completes.
8. WHEN a Tape_Record finishes decoding, THE Deck_UI SHALL show the total corrected bytes, the number of Codewords, and the number of uncorrectable Codewords.
9. WHILE at least one but fewer than K Shards with distinct indices from one set have been decoded, THE Deck_UI SHALL show how many distinct Shard indices from that set have been decoded and the set's K.
10. WHILE audio is playing or the microphone is listening and the operating system does not request reduced motion, THE Deck_UI SHALL rotate the cassette reels.
11. WHILE the operating system requests reduced motion, THE Deck_UI SHALL NOT animate the cassette reels.
12. WHEN the vault unlocks, THE Deck_UI SHALL display the recovered secret masked until the user selects Reveal.
13. WHEN the user selects Clear, THE Deck_UI SHALL remove the Plaintext, Password, and Envelopes from application state and overwrite Plaintext byte arrays with zeros.
14. THE Deck_UI SHALL let the user choose Standard_Mode or Turbo_Mode before locking.
15. THE Deck_UI SHALL let the user choose no sharding, 2-of-3, or 3-of-5 before locking.
16. WHEN the user selects Lock, THE Deck_UI SHALL seal the secret, split the Envelope if sharding is chosen, and show one tape for each resulting Body.
17. WHEN the user selects Play on a tape, THE Deck_UI SHALL play that tape's audio.
18. WHEN the user selects Download on a tape, THE Deck_UI SHALL save that tape as a WAV file in the format defined in Requirement 4.6.
19. WHEN the user imports one or more WAV files, THE Deck_UI SHALL decode each file with the Tape_Decoder.
20. WHEN the user selects Listen, THE Deck_UI SHALL start microphone capture as defined in Requirement 5.6.
21. WHEN the user selects Stop while the microphone is listening, THE Deck_UI SHALL stop microphone capture and release the microphone.
22. THE Deck_UI SHALL provide a control that enables and disables the Virtual_Tape_Channel.
23. WHILE an Envelope that was decoded or rebuilt from K Shards is held, WHEN the user selects Unlock, THE Deck_UI SHALL open the Envelope with the entered Password.
24. IF opening an Envelope fails with an AuthenticationError, THEN THE Deck_UI SHALL show "Wrong password or damaged tape", clear the Password field, and keep the Envelope for another attempt.
25. WHILE the Password contains fewer than 12 Unicode code points after NFC normalization, THE Deck_UI SHALL show a warning that a short password can be guessed offline by anyone who records the tape.
26. WHILE the Password contains 1 to 11 Unicode code points after NFC normalization, THE Deck_UI SHALL NOT disable Lock because of the Password's length.
27. WHILE a seal or open operation is running, THE Deck_UI SHALL show a busy indicator and disable Lock and Unlock.
28. IF decoding a WAV file or combining Shards fails with a FormatError, UncorrectableError, IntegrityError, or ShardError, THEN THE Deck_UI SHALL show a message naming the failure type and keep every Body decoded before the failure.

### Requirement 8: Air Gap and Offline Operation

**User Story:** As a security-conscious user, I want proof that BaudVault cannot send my secret anywhere, so that I can trust it with keys and seed phrases.

#### Acceptance Criteria

1. THE BaudVault source files under `src/` SHALL NOT contain the text `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `sendBeacon`, or `RTCPeerConnection` anywhere, including in comments, strings, test files, and longer identifiers that contain one of these words.
2. THE BaudVault SHALL load every script, stylesheet, font, and image from its own origin.
3. WHEN the BaudVault has been loaded once, THE BaudVault SHALL perform every function in Requirements 1 to 7 while the browser is offline, including after the page is reloaded or opened in a new tab while offline.
4. THE BaudVault SHALL NOT write Plaintext, Passwords, derived keys, or decrypted bytes, including decrypted bytes that have not yet been decompressed, to the console, `localStorage`, `sessionStorage`, IndexedDB, cookies, or the page URL.
5. THE BaudVault SHALL take every salt, IV, Shard set ID, and Shamir coefficient from `crypto.getRandomValues`.
6. WHERE the BaudVault is served from the production deployment, THE BaudVault SHALL serve every HTML response with a Content-Security-Policy header that includes `connect-src 'none'`.
7. THE BaudVault production build SHALL contain no call to `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `navigator.sendBeacon`, or `RTCPeerConnection` in any emitted JavaScript file other than the offline service worker script, as detected by the call patterns defined in `design.md`.
8. WHERE the BaudVault is served from the production deployment, THE BaudVault offline service worker SHALL request and serve only same-origin URLs from its precache list.
9. THE BaudVault SHALL NOT include Plaintext, Password, derived key, or decrypted bytes in the message or any property of an error it raises.

### Requirement 9: Accessibility

**User Story:** As a user who relies on a keyboard or a screen reader, I want to lock and unlock secrets without a mouse or sight of the oscilloscope, so that BaudVault works for me too.

#### Acceptance Criteria

1. THE Deck_UI SHALL make every control operable with the keyboard alone, move focus between controls in visual reading order (left to right within a row, rows from top to bottom), and show a focus indicator on the focused control with a contrast ratio of at least 3:1 against adjacent colors.
2. THE Deck_UI SHALL give every input, button, slider, and switch an accessible name.
3. THE Deck_UI SHALL render all text and control labels with a contrast ratio of at least 4.5:1 against their background.
4. WHEN Carrier_Lock is gained or lost, THE Deck_UI SHALL announce the change through a polite live region.
5. WHEN a Tape_Record finishes decoding, an error is shown, or the vault unlocks, THE Deck_UI SHALL announce the result through a polite live region.
6. THE Deck_UI SHALL show Carrier_Lock state, decode progress, and corrected-byte counts as text outside the oscilloscope canvas, and SHALL NOT convey any state by color alone.
7. THE Deck_UI SHALL NOT include the Plaintext or the Password in any live-region announcement.
8. WHILE the recovered secret is masked, THE Deck_UI SHALL expose only the masked form of the secret to assistive technology.

### Requirement 10: Browser Support

**User Story:** As a user, I want to know before I start whether my browser can run BaudVault, so that I don't lose a secret halfway through.

#### Acceptance Criteria

1. THE BaudVault SHALL meet Requirements 1 to 9 in each of the two most recent stable major versions, at the time of testing, of desktop Chrome, Edge, Firefox, and Safari, of Chrome on Android, and of Safari on iOS.
2. IF the browser lacks `crypto.subtle`, `CompressionStream`, or `DecompressionStream`, THEN THE Deck_UI SHALL name each missing feature, disable Lock and Unlock, and keep WAV import and the Virtual_Tape_Channel available.
3. IF the browser lacks `AudioWorkletNode` or `navigator.mediaDevices.getUserMedia`, or the page is not a secure context, THEN THE Deck_UI SHALL disable Listen, state each reason that applies, and keep WAV import and the Virtual_Tape_Channel available, including when criterion 2 has also disabled Lock and Unlock.
