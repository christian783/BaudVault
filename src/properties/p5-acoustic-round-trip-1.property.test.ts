// Property 5, part 1 of 4. The property and its arbitraries live in
// `p5-acoustic-round-trip.ts`; the parts split its 200 runs across workers.
//
// **Validates: Requirements 4.1, 4.2, 4.3, 4.4, 4.5, 5.1, 5.2, 5.7, 6.3, 6.5**

import { describeAcousticRoundTrip } from './p5-acoustic-round-trip'

describeAcousticRoundTrip(1)
