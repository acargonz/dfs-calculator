// Server-only — do NOT import from client components.
import 'server-only';

import { NextResponse, type NextRequest } from 'next/server';
import { timingSafeEqual } from 'node:crypto';

/**
 * Constant-time Bearer-token auth for Vercel cron routes.
 *
 * Why this exists (security finding C4):
 *   The previous inline check was `if (cronSecret) { ... }` which FAILS OPEN
 *   whenever CRON_SECRET is unset — leaving /api/resolve-picks and
 *   /api/snapshot-closing-lines world-callable in any environment that
 *   forgot to configure the env var. This helper fails CLOSED: if
 *   CRON_SECRET is missing in production, every call is rejected with 503.
 *
 * Additional hardening:
 *   - Uses node:crypto.timingSafeEqual so a string-comparison side-channel
 *     can't leak the secret a byte at a time. (Node's === is short-circuit
 *     and its wall-clock time depends on the first differing byte.)
 *   - Length-equalizes the compared buffers before calling timingSafeEqual
 *     (the function throws on mismatched lengths, which would itself be a
 *     timing oracle if we let it).
 *   - Dev convenience: when NODE_ENV !== 'production' AND CRON_SECRET is
 *     unset, we allow the call but emit a clear warning so the dev loop
 *     isn't blocked on localhost. Production is always fail-closed.
 *
 * Canonical Vercel pattern this implements:
 *   https://vercel.com/docs/cron-jobs/manage-cron-jobs
 *   `Authorization: Bearer <CRON_SECRET>`
 */
export function verifyCronAuth(request: NextRequest): NextResponse | null {
  const cronSecret = process.env.CRON_SECRET;

  // Production: CRON_SECRET must be set. Anything else is a misconfiguration,
  // not an auth failure — return 503 so it's obvious in logs and can't be
  // mistaken for a legit unauthorized hit.
  if (!cronSecret) {
    if (process.env.NODE_ENV === 'production') {
      return NextResponse.json(
        { error: 'Service misconfigured: CRON_SECRET unset' },
        { status: 503 },
      );
    }
    // Dev convenience — warn once per process.
    if (!warnedAboutMissingSecret) {
      // eslint-disable-next-line no-console
      console.warn(
        '[cronAuth] CRON_SECRET not set — cron routes are OPEN in development. ' +
          'This will fail-closed once NODE_ENV=production.',
      );
      warnedAboutMissingSecret = true;
    }
    return null;
  }

  const authHeader = request.headers.get('authorization') ?? '';
  const expected = `Bearer ${cronSecret}`;

  // Length-equalize to avoid throwing from timingSafeEqual on mismatch.
  // If the lengths differ, we still run a fake comparison with padded buffers
  // so the wall-clock time doesn't leak "length was wrong" vs "content was
  // wrong". The final `matches && sameLength` gate gives the real answer.
  const maxLen = Math.max(authHeader.length, expected.length);
  const aBuf = Buffer.alloc(maxLen);
  const bBuf = Buffer.alloc(maxLen);
  aBuf.write(authHeader);
  bBuf.write(expected);

  const matches = timingSafeEqual(aBuf, bBuf);
  const sameLength = authHeader.length === expected.length;

  if (!matches || !sameLength) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Null signals "auth OK, proceed with the route".
  return null;
}

let warnedAboutMissingSecret = false;
