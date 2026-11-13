import { describe, expect, it } from 'vitest'
import { MAX_DATA_BYTES } from '../fec/reed-solomon'
import { demodulateBytes } from '../modem/bit-demodulator'
import { modulate, SAMPLE_RATE } from '../modem/kcs-modulator'
import {
  CODEWORD_BYTES,
  codewordCount,
  frame,
  HEADER_FRAME_BYTES,
  interleaveDepth,
  RECORD_HEADER_BYTES,
} from '../tape/framer'
import { type DecoderEvent, TapeDecoder } from '../tape/tape-decoder'
import { Mulberry32 } from './prng'
import { applyTapeChannel } from './virtual-tape'

// Turbo_Mode measurement for decision D1 (design.md, "D1: Turbo_Mode detector
// at 2,400 baud"; task 7.3; Requirement 6.5).
//
// Pass criterion: every one of at least 50 random Bodies, each with its own
// random channel seed, framed and modulated at 2,400 baud and passed through
// the Virtual_Tape_Channel at 30% hiss and 2% wow, decodes to the original
// Body byte for byte: no UncorrectableError, no IntegrityError, no lost
// record, no missing header.
//
// Each case also demodulates the same processed audio a second time with
// `demodulateBytes` and compares the raw bytes with the transmitted Tape_Record,
// which gives the true byte-error count of every Codeword and Header_Frame copy
// before Reed-Solomon repair.
//
// The full measurement (60 cases, plus five margin points) takes longer than
// the `npm test` budget allows, so it runs only when the environment variable
// BAUDVAULT_TURBO_MEASUREMENT is 1. BAUDVAULT_TURBO_SEED picks another master
// seed (design.md, "D1 re-measurement" uses 0x5EEDD1B2 as the second seed):
//
//   $env:BAUDVAULT_TURBO_MEASUREMENT = '1'; npx vitest run src/channel/turbo-measurement.test.ts
//   $env:BAUDVAULT_TURBO_SEED = '0x5eedd1b2'; npx vitest run src/channel/turbo-measurement.test.ts
//
// A small always-on regression with the same pass criterion (30% hiss, 2%
// wow) runs in every `npm test`. Test Bodies are random data from a fixed
// master seed, never real secrets.

const BAUD = 2400
const DEPTH = interleaveDepth(BAUD)
/** Data bytes in one Interleave_Group at 2,400 baud: 4 · 223. */
const GROUP_DATA_BYTES = DEPTH * MAX_DATA_BYTES
/** Largest correctable byte errors per Codeword. */
const RS_LIMIT = 16
/** BAUDVAULT_TURBO_SEED (decimal or 0x hex) repeats the measurement on fresh Bodies and channel seeds. */
const MASTER_SEED = Number(import.meta.env['BAUDVAULT_TURBO_SEED'] ?? 0x7e5b_2400) >>> 0
const FULL_RUN = import.meta.env['BAUDVAULT_TURBO_MEASUREMENT'] === '1'

type Settings = { hiss: number; wow: number }
type Case = { body: Uint8Array; seed: number }

type Outcome = 'ok' | 'uncorrectable' | 'integrity' | 'lost' | 'no-header' | 'wrong-body'

type CaseResult = {
  outcome: Outcome
  autoOutcome: Outcome | null
  bodyLength: number
  codewords: number
  correctedBytes: number
  headerCopyUsed: 1 | 2 | null
  /** Raw byte errors in Header_Frame copies 1 and 2. */
  headerErrors: [number, number]
  /** Raw byte errors in each Codeword, before repair. */
  codewordErrors: number[]
  /** Raw bytes compared, and how many differed (missing bytes count as errors). */
  rawBytes: number
  rawErrors: number
  /** Longest run of consecutive wrong raw bytes, and the Tape_Record offset where it starts. */
  longestRun: number
  longestRunAt: number
}

/**
 * Bodies with random contents and random sizes: one in three spans 2 to 4
 * Interleave_Groups (893 to 3,568 bytes), the rest fit one group (1 to 892).
 */
function makeCases(count: number, masterSeed: number): Case[] {
  const rng = new Mulberry32(masterSeed)
  const cases: Case[] = []
  for (let i = 0; i < count; i++) {
    const multiGroup = i % 3 === 0
    const length = multiGroup
      ? GROUP_DATA_BYTES + 1 + (rng.nextUint32() % (3 * GROUP_DATA_BYTES))
      : 1 + (rng.nextUint32() % GROUP_DATA_BYTES)
    const body = new Uint8Array(length)
    for (let k = 0; k < length; k++) body[k] = rng.nextUint32() & 0xff
    cases.push({ body, seed: rng.nextUint32() })
  }
  return cases
}

function decode(samples: Float32Array, auto: boolean): DecoderEvent[] {
  const decoder = new TapeDecoder(auto ? { sampleRate: SAMPLE_RATE } : { sampleRate: SAMPLE_RATE, baud: BAUD })
  const events: DecoderEvent[] = []
  // 2,048-sample chunks, the size the microphone worklet delivers.
  for (let i = 0; i < samples.length; i += 2_048) events.push(...decoder.push(samples.subarray(i, i + 2_048)))
  return events
}

function outcomeOf(events: DecoderEvent[], body: Uint8Array): { outcome: Outcome; event: DecoderEvent | undefined } {
  const record = events.find((event) => event.type === 'record')
  if (record?.type === 'record') {
    const same = record.body.length === body.length && record.body.every((b, i) => b === body[i])
    return { outcome: same ? 'ok' : 'wrong-body', event: record }
  }
  const error = events.find((event) => event.type === 'error')
  if (error?.type === 'error') {
    const code = error.error.code
    return { outcome: code === 'UNCORRECTABLE' ? 'uncorrectable' : code === 'INTEGRITY' ? 'integrity' : 'lost', event: error }
  }
  return { outcome: 'no-header', event: undefined }
}

/** Nominal time of Tape_Record byte `k` from the start of the tape, after the 2 s leader. */
function secondsIntoTape(k: number): number {
  return 2 + (k * 11) / BAUD
}

/** Offset in the Tape_Record of byte `i` of Codeword `c` (design.md, "Interleave_Group g"). */
function codewordByteOffset(c: number, i: number): number {
  const g = Math.floor(c / DEPTH)
  return RECORD_HEADER_BYTES + g * CODEWORD_BYTES * DEPTH + i * DEPTH + (c % DEPTH)
}

function runCase(testCase: Case, settings: Settings, withAuto: boolean): CaseResult {
  const { body, seed } = testCase
  const record = frame(body, 'envelope', BAUD)
  const audio = applyTapeChannel(modulate(record, BAUD), SAMPLE_RATE, { ...settings, seed })

  const fixed = outcomeOf(decode(audio, false), body)
  const autoOutcome = withAuto ? outcomeOf(decode(audio, true), body).outcome : null

  const raw = demodulateBytes(audio, SAMPLE_RATE, BAUD, record.length)
  const differs = (k: number) => k >= raw.length || raw[k] !== record[k]
  let rawErrors = 0
  let longestRun = 0
  let longestRunAt = 0
  let run = 0
  for (let k = 0; k < record.length; k++) {
    if (!differs(k)) {
      run = 0
      continue
    }
    rawErrors++
    run++
    if (run > longestRun) {
      longestRun = run
      longestRunAt = k - run + 1
    }
  }
  const headerErrors: [number, number] = [0, 0]
  for (let k = 0; k < HEADER_FRAME_BYTES; k++) {
    if (differs(k)) headerErrors[0]++
    if (differs(HEADER_FRAME_BYTES + k)) headerErrors[1]++
  }
  const codewords = codewordCount(body.length, BAUD)
  const codewordErrors: number[] = []
  for (let c = 0; c < codewords; c++) {
    let errors = 0
    for (let i = 0; i < CODEWORD_BYTES; i++) if (differs(codewordByteOffset(c, i))) errors++
    codewordErrors.push(errors)
  }

  const event = fixed.event
  const stats = event?.type === 'record' || event?.type === 'error' ? event.stats : undefined
  return {
    outcome: fixed.outcome,
    autoOutcome,
    bodyLength: body.length,
    codewords,
    correctedBytes: stats?.correctedBytes ?? 0,
    headerCopyUsed: stats?.headerCopyUsed ?? null,
    headerErrors,
    codewordErrors,
    rawBytes: record.length,
    rawErrors,
    longestRun,
    longestRunAt,
  }
}

type Summary = {
  cases: number
  passed: number
  failures: string[]
  autoPassed: number
  autoRuns: number
  multiGroupCases: number
  bodyMin: number
  bodyMax: number
  codewords: number
  codewordsWithErrors: number
  codewordsOverLimit: number
  worstCodeword: number
  meanErrorsPerCodeword: number
  /** Number of Codewords with 0, 1, 2, … raw byte errors. */
  histogram: number[]
  worstHeaderCopy1: number
  headerFallbacks: number
  totalCorrected: number
  maxCorrectedPerRecord: number
  rawByteErrorRate: number
  seconds: number
}

function measure(cases: Case[], settings: Settings, withAuto: boolean): { summary: Summary; results: CaseResult[] } {
  const start = performance.now()
  const results = cases.map((testCase) => runCase(testCase, settings, withAuto))
  const seconds = (performance.now() - start) / 1_000

  const all = results.flatMap((result) => result.codewordErrors)
  const histogram: number[] = []
  for (const errors of all) histogram[errors] = (histogram[errors] ?? 0) + 1
  for (let i = 0; i < histogram.length; i++) histogram[i] ??= 0
  const rawBytes = results.reduce((sum, result) => sum + result.rawBytes, 0)
  const rawErrors = results.reduce((sum, result) => sum + result.rawErrors, 0)

  const summary: Summary = {
    cases: results.length,
    passed: results.filter((result) => result.outcome === 'ok').length,
    failures: results.flatMap((result, i) =>
      result.outcome === 'ok'
        ? []
        : [
            `case ${i}: ${result.outcome}, L=${result.bodyLength}, B=${result.codewords}, ` +
              `codeword errors [${result.codewordErrors.join(',')}], raw errors ${result.rawErrors}, ` +
              `longest run ${result.longestRun} B at record byte ${result.longestRunAt} ` +
              `(${secondsIntoTape(result.longestRunAt).toFixed(2)} s into the tape)`,
          ],
    ),
    autoPassed: results.filter((result) => result.autoOutcome === 'ok').length,
    autoRuns: results.filter((result) => result.autoOutcome !== null).length,
    multiGroupCases: results.filter((result) => result.codewords > DEPTH).length,
    bodyMin: Math.min(...results.map((result) => result.bodyLength)),
    bodyMax: Math.max(...results.map((result) => result.bodyLength)),
    codewords: all.length,
    codewordsWithErrors: all.filter((errors) => errors > 0).length,
    codewordsOverLimit: all.filter((errors) => errors > RS_LIMIT).length,
    worstCodeword: Math.max(...all),
    meanErrorsPerCodeword: all.reduce((sum, errors) => sum + errors, 0) / all.length,
    histogram,
    worstHeaderCopy1: Math.max(...results.map((result) => result.headerErrors[0])),
    headerFallbacks: results.filter((result) => result.headerCopyUsed === 2).length,
    totalCorrected: results.reduce((sum, result) => sum + result.correctedBytes, 0),
    maxCorrectedPerRecord: Math.max(...results.map((result) => result.correctedBytes)),
    rawByteErrorRate: rawErrors / rawBytes,
    seconds,
  }
  return { summary, results }
}

function format(label: string, s: Summary): string {
  return [
    `${label}: ${s.passed}/${s.cases} passed (fixed 2,400 baud)` +
      (s.autoRuns > 0 ? `, auto-detect ${s.autoPassed}/${s.autoRuns}` : ''),
    `  bodies ${s.bodyMin}..${s.bodyMax} B, ${s.multiGroupCases} multi-group, ${s.codewords} codewords`,
    `  raw byte error rate ${(100 * s.rawByteErrorRate).toFixed(3)}%, ` +
      `mean ${s.meanErrorsPerCodeword.toFixed(2)} errors per codeword`,
    `  worst codeword ${s.worstCodeword}/${RS_LIMIT}, codewords with errors ${s.codewordsWithErrors}, ` +
      `over limit ${s.codewordsOverLimit}`,
    `  histogram (errors: codewords) ${s.histogram.flatMap((n, e) => (n > 0 ? [`${e}:${n}`] : [])).join(' ')}`,
    `  corrected bytes total ${s.totalCorrected}, max per record ${s.maxCorrectedPerRecord}`,
    `  worst header copy 1 ${s.worstHeaderCopy1}/${RS_LIMIT}, header copy 2 fallbacks ${s.headerFallbacks}`,
    `  run time ${s.seconds.toFixed(1)} s`,
    ...s.failures.map((failure) => `  FAIL ${failure}`),
  ].join('\n')
}

/** Checks the pass criterion and the measurement's own consistency. */
function expectAllRecovered(results: CaseResult[], summary: Summary): void {
  expect(summary.failures).toEqual([])
  for (const result of results) {
    if (result.autoOutcome !== null) expect(result.autoOutcome).toBe('ok')
    // The decoder's corrected-byte count must match the raw errors in the
    // header copy it used plus every Codeword.
    const copy = result.headerCopyUsed === 2 ? 1 : 0
    const expected = result.headerErrors[copy] + result.codewordErrors.reduce((sum, errors) => sum + errors, 0)
    expect(result.correctedBytes).toBe(expected)
  }
}

describe('Turbo_Mode through the Virtual_Tape_Channel (decision D1)', () => {
  // Always on: the D1 criterion (30% hiss, 2% wow) on three Bodies, one of
  // them two Interleave_Groups long, with fixed and auto-detected baud. The
  // seeds are fixed, so this does not move with BAUDVAULT_TURBO_SEED.
  it('recovers Bodies at 30% hiss and 2% wow (D1 criterion, small set)', ({ annotate }) => {
    const cases = makeCases(2, 0x7e5b_2400 ^ 0x5a5a)
    cases.push({ body: makeCases(1, 0x7e5b_2400 ^ 0xa5a5)[0]!.body.subarray(0, GROUP_DATA_BYTES + 100), seed: 77 })
    const { summary, results } = measure(cases, { hiss: 0.3, wow: 0.02 }, true)
    void annotate(format('regression 30% hiss, 2% wow', summary))
    expect(summary.multiGroupCases).toBeGreaterThanOrEqual(1)
    expectAllRecovered(results, summary)
  })

  describe.skipIf(!FULL_RUN)('full measurement (BAUDVAULT_TURBO_MEASUREMENT=1)', () => {
    it(
      'recovers 60 random Bodies at 30% hiss and 2% wow (D1 pass criterion)',
      { timeout: 600_000 },
      ({ annotate }) => {
        const { summary, results } = measure(makeCases(60, MASTER_SEED), { hiss: 0.3, wow: 0.02 }, true)
        const text = format('D1 criterion 30% hiss, 2% wow', summary)
        console.info(text)
        void annotate(text)
        expect(summary.cases).toBeGreaterThanOrEqual(50)
        expectAllRecovered(results, summary)
      },
    )

    // Margin and diagnostic points: reported, not asserted. Hiss alone and wow
    // alone separate the two causes of failure.
    it.for([
      { hiss: 0.3, wow: 0 },
      { hiss: 0, wow: 0.02 },
      { hiss: 0.15, wow: 0.01 },
      { hiss: 0.4, wow: 0.02 },
      { hiss: 0.3, wow: 0.03 },
    ])(
      'margin point $hiss hiss, $wow wow (report only)',
      { timeout: 600_000 },
      (settings, { annotate }) => {
        const { summary } = measure(makeCases(30, MASTER_SEED + 1), settings, false)
        const text = format(`margin ${100 * settings.hiss}% hiss, ${100 * settings.wow}% wow`, summary)
        console.info(text)
        void annotate(text)
        expect(summary.cases).toBe(30)
      },
    )
  })
})
