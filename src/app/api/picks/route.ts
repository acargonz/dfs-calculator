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
import { getSupabase } from '@/lib/supabase';
import {
  fetchPicks,
  summarizePicks,
  type PickHistoryFilters,
} from '@/lib/pickHistory';
import type { Tier } from '@/lib/math';

const DEFAULT_LIMIT = 500;
const DEFAULT_BANKROLL = 100;

export async function GET(request: NextRequest) {
  const supabase = getSupabase();
  if (!supabase) {
    // Dev convenience: return an empty payload instead of 500
    return NextResponse.json({
      picks: [],
      summary: summarizePicks([]),
      count: 0,
    });
  }

  const params = request.nextUrl.searchParams;
  const filters: PickHistoryFilters = {};

  const from = params.get('from');
  const to = params.get('to');
  const tier = params.get('tier');
  const resolvedOnly = params.get('resolvedOnly');
  const limit = params.get('limit');

  if (from) filters.fromDate = from;
  if (to) filters.toDate = to;
  if (tier && ['HIGH', 'MEDIUM', 'LOW', 'REJECT'].includes(tier)) {
    filters.tier = tier as Tier;
  }
  if (resolvedOnly === 'true') filters.resolvedOnly = true;
  filters.limit = limit ? Math.min(parseInt(limit, 10) || DEFAULT_LIMIT, 5000) : DEFAULT_LIMIT;

  const bankrollRaw = params.get('bankroll');
  const bankroll = bankrollRaw ? Number(bankrollRaw) : DEFAULT_BANKROLL;
  const safeBankroll =
    Number.isFinite(bankroll) && bankroll > 0 ? bankroll : DEFAULT_BANKROLL;

  try {
    const picks = await fetchPicks(supabase, filters);
    const summary = summarizePicks(picks, safeBankroll);
    return NextResponse.json({
      picks,
      summary,
      count: picks.length,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json(
      { error: `Failed to fetch picks: ${message}` },
      { status: 500 },
    );
  }
}
