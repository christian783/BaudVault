// Readout panel: two-trace oscilloscope, energy bars, LOCK lamp, and
// telemetry (design.md, "Deck_UI"; Requirements 7.2 to 7.8).
//
// While audio plays or the microphone listens, one requestAnimationFrame loop
// (capped at 60 frames per second) reads the live decoder:
// - trace A: the last 20 ms of the decoder's input, which is the
//   Virtual_Tape_Channel output when the channel is on (Requirement 7.5);
// - trace B: the last 20 ms of d[n], the mark-minus-space decision signal;
// - the 1,200 Hz and 2,400 Hz Goertzel energies, written straight to the bar
//   elements so the bars do not re-render React each frame;
// - Carrier_Lock, which re-renders only when it changes.
// Each frame first lays translucent black over the previous one, so old
// traces fade like phosphor.
//
// The canvas and bars are aria-hidden. Lock state and telemetry are plain
// text beside them. Only Tape_Record audio reaches the scope; no secret is
// shown here.

import { type ReactNode, useEffect, useId, useRef, useState } from 'react'
import type { TapeDecoder } from '../tape/tape-decoder'
import {
  type Band,
  energyFraction,
  frameDue,
  GRATICULE,
  PERSISTENCE_FILL,
  PHOSPHOR,
  SCOPE_HEIGHT,
  SCOPE_WIDTH,
  traceBands,
  traceX,
  traceY,
} from './scope'
import { type Telemetry, telemetryLines } from './telemetry'

export type ReadoutPanelProps = {
  /** The live source's decoder, or null. */
  decoderRef: { readonly current: TapeDecoder | null }
  /** Audio is playing or the microphone is listening. */
  active: boolean
  telemetry: Telemetry
  /** Called when the LOCK lamp turns on or off, for the live region (Requirement 9.4). */
  onCarrierChange?: (locked: boolean) => void
  /** The vault controls (Unlock, Reveal, Clear), shown below the scope. */
  children?: ReactNode
}

const BANDS = traceBands(SCOPE_HEIGHT)

function drawGraticule(ctx: CanvasRenderingContext2D): void {
  ctx.strokeStyle = GRATICULE
  ctx.lineWidth = 1
  ctx.beginPath()
  for (const band of [BANDS.a, BANDS.b]) {
    const mid = traceY(0, band)
    ctx.moveTo(0, mid)
    ctx.lineTo(SCOPE_WIDTH, mid)
  }
  ctx.moveTo(0, BANDS.b.top)
  ctx.lineTo(SCOPE_WIDTH, BANDS.b.top)
  ctx.stroke()
}

function drawTrace(ctx: CanvasRenderingContext2D, trace: Float32Array, band: Band): void {
  const count = trace.length
  ctx.beginPath()
  for (let i = 0; i < count; i++) {
    const x = traceX(i, count, SCOPE_WIDTH)
    const y = traceY(trace[i]!, band)
    if (i === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  }
  ctx.stroke()
}

function setBar(bar: HTMLDivElement | null, energy: number): void {
  if (bar !== null) bar.style.transform = `scaleX(${energyFraction(energy)})`
}

export function ReadoutPanel({ decoderRef, active, telemetry, onCarrierChange, children }: ReadoutPanelProps) {
  const id = useId()
  const titleId = `${id}-title`
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const spaceBarRef = useRef<HTMLDivElement | null>(null)
  const markBarRef = useRef<HTMLDivElement | null>(null)
  const [locked, setLocked] = useState(false)

  useEffect(() => {
    if (!active) return
    const ctx = canvasRef.current?.getContext('2d') ?? null
    const spaceBar = spaceBarRef.current
    const markBar = markBarRef.current
    let request = 0
    let lastDrawn: number | null = null
    let shownLock = false
    let traceA = new Float32Array(0)
    let traceB = new Float32Array(0)

    const draw = (now: number) => {
      request = requestAnimationFrame(draw)
      if (!frameDue(now, lastDrawn)) return
      lastDrawn = now
      const decoder = decoderRef.current

      if (ctx !== null) {
        ctx.fillStyle = PERSISTENCE_FILL
        ctx.fillRect(0, 0, SCOPE_WIDTH, SCOPE_HEIGHT)
        drawGraticule(ctx)
        if (decoder !== null) {
          const { scope } = decoder
          if (traceA.length !== scope.size) {
            traceA = new Float32Array(scope.size)
            traceB = new Float32Array(scope.size)
          }
          scope.readInput(traceA)
          scope.readDecision(traceB)
          ctx.strokeStyle = PHOSPHOR
          ctx.lineWidth = 1.5
          drawTrace(ctx, traceA, BANDS.a)
          drawTrace(ctx, traceB, BANDS.b)
        }
      }

      const energies = decoder?.energies
      setBar(spaceBar, energies?.space ?? 0)
      setBar(markBar, energies?.mark ?? 0)

      const lock = decoder?.carrierLock ?? false
      if (lock !== shownLock) {
        shownLock = lock
        setLocked(lock)
      }
    }

    request = requestAnimationFrame(draw)
    return () => {
      cancelAnimationFrame(request)
      setBar(spaceBar, 0)
      setBar(markBar, 0)
      setLocked(false)
    }
  }, [active, decoderRef])

  const lampOn = active && locked

  // Report lamp changes only, so the live region announces exactly what the
  // lamp text shows. The lamp text itself is not a live region, which would
  // announce each change twice.
  const reportedLamp = useRef(false)
  useEffect(() => {
    if (lampOn === reportedLamp.current) return
    reportedLamp.current = lampOn
    onCarrierChange?.(lampOn)
  }, [lampOn, onCarrierChange])

  return (
    <section aria-labelledby={titleId} className="panel lg:col-span-2">
      <h2 id={titleId} className="panel-title">
        Readout
      </h2>

      <div className="grid gap-4 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="flex flex-col gap-2">
          <canvas
            ref={canvasRef}
            width={SCOPE_WIDTH}
            height={SCOPE_HEIGHT}
            aria-hidden="true"
            className="aspect-[2/1] w-full rounded border border-phosphor/60 bg-black"
          />
          <p className="hint">Upper trace: audio. Lower trace: mark minus space. Both show the last 20 ms.</p>

          <div aria-hidden="true" className="flex flex-col gap-1">
            <div className="energy">
              <span>1,200 Hz</span>
              <div className="energy-track">
                <div ref={spaceBarRef} className="energy-fill" />
              </div>
            </div>
            <div className="energy">
              <span>2,400 Hz</span>
              <div className="energy-track">
                <div ref={markBarRef} className="energy-fill" />
              </div>
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-3">
          <p className="flex items-center gap-2 font-bold">
            <span aria-hidden="true" className={lampOn ? 'lamp lamp-on' : 'lamp'} />
            <span>LOCK: {lampOn ? 'carrier locked' : 'no carrier'}</span>
          </p>

          <div>
            <h3 className="subtitle">Telemetry</h3>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
              {telemetryLines(telemetry).map((line) => (
                <div key={line.label} className="contents">
                  <dt>{line.label}</dt>
                  <dd>{line.value}</dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
      </div>

      {children}
    </section>
  )
}
