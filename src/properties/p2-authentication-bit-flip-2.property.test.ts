// Property 2, bit-flip check, part 2 of 2. The property and its arbitraries
// live in `p2-authentication.ts`; the parts split its 200 runs across workers.
//
// **Validates: Requirements 1.3, 1.4**

import { describeBitFlip } from './p2-authentication'

describeBitFlip(2)
