// Server-only — do NOT import into a Client Component.
import 'server-only';

import { NextRequest, NextResponse } from 'next/server';
import {
  buildEventsUrl,
  ODDS_API_BASE,
  transformGames,
  transformProps,
  SUPPORTED_MARKETS,
  type OddsApiEvent,
  type OddsApiEventOdds,
} from '@/lib/oddsApi';
import { OddsQuery } from '@/lib/schemas';
import { badRequest, misconfigured, internalError } from '@/lib/apiErrors';

/**
 * /api/odds — proxy for The Odds API.
 *
 * Why proxy instead of calling Odds API from the browser?
 *   Hiding the ODDS_API_KEY on the server side. A client-side call would
 *   require the key to be `NEXT_PUBLIC_` (bundled into the browser), which
 *   would make it trivial to extract via DevTools and burn the monthly
 *   quota. See OWASP API4:2023 — Unrestricted Resource Consumption.
 *
 * Security hardening (OWASP A03:2021 Injection / SSRF):
 *   - The `eventId` query param is validated against a strict hex regex
 *     in src/lib/schemas.ts before it's concatenated into the upstream
 *     fetch URL. Without this, an attacker could try `eventId=../../evil`
 *     or `eventId=1&other=host` and steer our server-side fetch() to an
 *     unintended endpoint. The regex ^[a-f0-9]{16,64}$ only accepts what
 *     The Odds API actually produces.
 *   - Errors from upstream are never echoed verbatim to clients — they're
 *     logged server-side via internalError() and clients get a generic
 *     500 so we don't leak response bodies that might contain hints about
 *     our infrastructure.
 */
function getApiKey(): string | null {
  return process.env.ODDS_API_KEY ?? null;
}

export async function GET(request: NextRequest) {
  // Parse + validate query params up front.
  const parsed = OddsQuery.safeParse({
    type: request.nextUrl.searchParams.get('type') ?? '',
    eventId: request.nextUrl.searchParams.get('eventId') ?? undefined,
  });
  if (!parsed.success) {
    return badRequest(parsed.error.issues[0]?.message ?? 'Invalid query');
  }

  const apiKey = getApiKey();
  if (!apiKey) return misconfigured('ODDS_API_KEY unset');

  try {
    if (parsed.data.type === 'games') {
      return await handleGames(apiKey);
    }
    // type === 'props' — eventId required (Zod already enforced this)
    return await handleProps(apiKey, parsed.data.eventId!);
  } catch (err) {
    return internalError(err, 'odds');
  }
}

async function handleGames(apiKey: string): Promise<NextResponse> {
  const url = buildEventsUrl(apiKey);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Odds API games: HTTP ${res.status}`);
  }
  const raw: OddsApiEvent[] = await res.json();
  return NextResponse.json(transformGames(raw));
}

async function handleProps(apiKey: string, eventId: string): Promise<NextResponse> {
  const url =
    `${ODDS_API_BASE}/events/${eventId}/odds` +
    `?apiKey=${apiKey}` +
    `&regions=us` +
    `&markets=${SUPPORTED_MARKETS}` +
    `&oddsFormat=american`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Odds API props: HTTP ${res.status}`);
  }
  const raw: OddsApiEventOdds = await res.json();
  return NextResponse.json(transformProps(raw));
}
