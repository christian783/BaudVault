// The startup notice for missing browser features (design.md, "Feature
// detection (Requirement 10)"; Requirements 10.2, 10.3). It names each
// missing feature and the function it disables, as text, and says what still
// works. Rendered only when something is missing. Phosphor text on black, so
// it meets 4.5:1 (Requirement 9.3); the heading and wording carry the state,
// not color (Requirement 9.6).

import { useId } from 'react'
import { type FeatureSupport, STILL_AVAILABLE } from './features'

export function FeatureNotice({ support }: { support: FeatureSupport }) {
  const titleId = useId()
  if (support.notice.length === 0) return null
  return (
    <section aria-labelledby={titleId} className="notice">
      <h2 id={titleId} className="subtitle">
        Browser support
      </h2>
      <p>This browser lacks features BaudVault needs:</p>
      <ul className="list-disc pl-6">
        {support.notice.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <p>{STILL_AVAILABLE}</p>
    </section>
  )
}
