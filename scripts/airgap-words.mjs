// Shared air-gap word list (Requirements 8.1, 8.7).
//
// Imported by scripts/airgap-scan.mjs and scripts/airgap-hook.mjs so both
// checks always agree. This file sits outside src/, so it may name the words.

/** Words that must never appear anywhere in a file under src/. */
export const FORBIDDEN_WORDS = Object.freeze([
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'EventSource',
  'sendBeacon',
  'RTCPeerConnection',
])

/**
 * Call patterns for the built bundle in dist/ (design.md, "Build rule").
 * `\bfetch\s*\(` ignores React DOM's `fetchPriority` and `prefetchDNS`, which
 * make no request unless called.
 */
export const DIST_PATTERNS = Object.freeze([
  { word: 'fetch', pattern: /\bfetch\s*\(/ },
  { word: 'XMLHttpRequest', pattern: /\bXMLHttpRequest\b/ },
  { word: 'WebSocket', pattern: /\bWebSocket\b/ },
  { word: 'EventSource', pattern: /\bEventSource\b/ },
  { word: 'sendBeacon', pattern: /\bsendBeacon\b/ },
  { word: 'RTCPeerConnection', pattern: /\bRTCPeerConnection\b/ },
])

/** Plain-text matchers for src/: any occurrence, including inside longer identifiers. */
export const SOURCE_MATCHERS = Object.freeze(
  FORBIDDEN_WORDS.map((word) => ({ word, test: (line) => line.includes(word) })),
)

/** Matchers for dist/ built from DIST_PATTERNS. */
export const DIST_MATCHERS = Object.freeze(
  DIST_PATTERNS.map(({ word, pattern }) => ({ word, test: (line) => pattern.test(line) })),
)

/**
 * Returns every match in `text` as `{ line, word }`, with 1-based line numbers.
 * One entry per matching word per line.
 */
export function findMatches(text, matchers) {
  const matches = []
  const lines = text.split(/\r\n|\r|\n/)
  for (let i = 0; i < lines.length; i++) {
    for (const { word, test } of matchers) {
      if (test(lines[i])) matches.push({ line: i + 1, word })
    }
  }
  return matches
}
