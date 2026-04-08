/**
 * /api/picks — read-only access to historical picks + a summary bundle.
 *
 * Used by:
 *   - The /history page server component (full row dump for the table)
 *   - The SystemStatusCard via /api/system-status (which calls into the same
 *     summarizePicks() helper directly, not via this route)
 *
 * Query params (all optional):
 *   ?from=YYYY-MM-DD          inclusive lower bound on date
 *   ?to=YYYY-MM-DD            inclusive upper bound on date
 *   ?tier=HIGH|MEDIUM|LOW     restrict to a single tier
 *   ?resolvedOnly=true        only picks with won != null
 *   ?limit=N                  cap the row count (defaults to 500)
 *   ?bankroll=N               override the drawdown bankroll basis (default 100)
 *
 * Returns:
 *   {
 *     picks: PickRow[],
 *     summary: PickSummary,
 *     count: number,
 *   }
 *
 * Returns an empty list (not an error) if Supabase isn't configured — keeps
 * the rest of the app functional in dev environments without a DB.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabaseAdmin';
import { PicksQuery } from '@/lib/schemas';
import { badRequest, internalError } from '@/lib/apiErrors';
import {
  fetchPicks,
  summarizePicks,
  type PickHistoryFilters,
} from '@/lib/pickHistory';
import type { Tier } from '@/lib/math';

const DEFAULT_LIMIT = 500;
const DEFAULT_BANKROLL = 100;

export async function GET(request: NextRequest) {
  const supabase = getSupabaseAdmin();
  if (!supabase) {
    // Dev convenience: return an empty payload instead of 500 so the
    // /history page can still render (the UI already handles empty).
    return NextResponse.json({
      picks: [],
      summary: summarizePicks([]),
      count: 0,
    });
  }

  // Zod-validate the query params. The schema rejects bad dates, weird
  // tier strings, and nonsense `limit` values before they reach the DB.
  const params = request.nextUrl.searchParams;
  const parsed = PicksQuery.safeParse({
    from: params.get('from') ?? undefined,
    to: params.get('to') ?? undefined,
    tier: params.get('tier') ?? undefined,
    resolvedOnly: params.get('resolvedOnly') ?? undefined,
    limit: params.get('limit') ?? undefined,
    bankroll: params.get('bankroll') ?? undefined,
  });
  if (!parsed.success) {
    return badRequest(parsed.error.issues[0]?.message ?? 'Invalid query');
  }

  const filters: PickHistoryFilters = {};
  const { from, to, tier, resolvedOnly, limit, bankroll } = parsed.data;
  if (from) filters.fromDate = from;
  if (to) filters.toDate = to;
  if (tier) filters.tier = tier as Tier;
  if (resolvedOnly === 'true') filters.resolvedOnly = true;
  filters.limit = limit
    ? Math.min(parseInt(limit, 10) || DEFAULT_LIMIT, 5000)
    : DEFAULT_LIMIT;

  const bankrollNum = bankroll ? Number(bankroll) : DEFAULT_BANKROLL;
  const safeBankroll =
    Number.isFinite(bankrollNum) && bankrollNum > 0 ? bankrollNum : DEFAULT_BANKROLL;

  try {
    const picks = await fetchPicks(supabase, filters);
    const summary = summarizePicks(picks, safeBankroll);
    return NextResponse.json({
      picks,
      summary,
      count: picks.length,
    });
  } catch (err) {
    return internalError(err, 'picks fetch');
  }
}
