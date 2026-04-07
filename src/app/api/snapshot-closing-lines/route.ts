/**
 * /api/snapshot-closing-lines — captures the closing line for every pending
 * pick that was made today.
 *
 * Triggered by:
 *   - Vercel cron (see vercel.json) on a recurring schedule
 *   - Manual GET in dev (with ?force=true to override the date filter)
 *
 * Auth:
 *   If CRON_SECRET is set in env, the route requires
 *   `Authorization: Bearer <secret>` (Vercel cron sends this automatically).
 *   If CRON_SECRET is unset (dev), the route is open.
 *
 * IO contract:
 *   1. Query Supabase for picks where date = today and closing_snapshot_at IS NULL
 *   2. Fetch all today's NBA games from The Odds API
 *   3. Fetch props for each game (one Odds API call per game)
 *   4. Build a player+stat+line lookup of currently-live props
 *   5. Use buildSnapshotPlan() to compute updates
 *   6. Apply the updates to Supabase
 *   7. Return summary stats
 *
 * Idempotent: re-running on the same picks is a no-op (already-snapshotted
 * picks are filtered out by the WHERE clause).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSupabase } from '@/lib/supabase';
import {
  transformGames,
  transformProps,
  SUPPORTED_MARKETS,
  type OddsApiEvent,
  type OddsApiEventOdds,
  type PlayerProp,
  ODDS_API_BASE,
} from '@/lib/oddsApi';
import {
  buildSnapshotPlan,
  buildPropLookup,
  type PendingPick,
} from '@/lib/closingLineSnapshot';

// Vercel Hobby tier allows 60s max duration for serverless functions.
// This route fans out to ~10 Odds API calls (1 per game) + ~50 Supabase
// updates, so 60s is plenty of headroom.
export const runtime = 'nodejs';
export const maxDuration = 60;

interface SnapshotResponse {
  ok: boolean;
  pendingPicks: number;
  gamesQueried: number;
  picksUpdated: number;
  picksUnmatched: number;
  errors: string[];
  durationMs: number;
}

export async function GET(request: NextRequest) {
  const start = Date.now();

  // Auth: in production, Vercel cron sends Authorization: Bearer <CRON_SECRET>.
  // In dev, leaving CRON_SECRET unset makes the route open.
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = request.headers.get('authorization');
    if (auth !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: 'ODDS_API_KEY not configured' },
      { status: 500 },
    );
  }

  const supabase = getSupabase();
  if (!supabase) {
    return NextResponse.json(
      { error: 'Supabase not configured' },
      { status: 500 },
    );
  }

  const errors: string[] = [];
  const today = new Date().toISOString().split('T')[0];

  // 1. Fetch pending picks for today
  const { data: rawPicks, error: pickErr } = await supabase
    .from('picks')
    .select('id, player_name, stat_type, line')
    .eq('date', today)
    .is('closing_snapshot_at', null);

  if (pickErr) {
    return NextResponse.json(
      { error: `Failed to fetch pending picks: ${pickErr.message}` },
      { status: 500 },
    );
  }

  const pendingPicks: PendingPick[] = (rawPicks ?? []).map((p) => ({
    id: p.id as string,
    player_name: p.player_name as string,
    stat_type: p.stat_type as string,
    line: Number(p.line),
  }));

  // Early exit if nothing pending
  if (pendingPicks.length === 0) {
    const response: SnapshotResponse = {
      ok: true,
      pendingPicks: 0,
      gamesQueried: 0,
      picksUpdated: 0,
      picksUnmatched: 0,
      errors: [],
      durationMs: Date.now() - start,
    };
    return NextResponse.json(response);
  }

  // 2. Fetch all today's games from Odds API
  let games: { id: string }[] = [];
  try {
    const gamesUrl = `${ODDS_API_BASE}/events?apiKey=${apiKey}`;
    const gamesRes = await fetch(gamesUrl);
    if (!gamesRes.ok) {
      throw new Error(`Odds API games error: ${gamesRes.status}`);
    }
    const rawGames: OddsApiEvent[] = await gamesRes.json();
    games = transformGames(rawGames);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown';
    return NextResponse.json(
      { error: `Failed to fetch games: ${message}` },
      { status: 500 },
    );
  }

  // 3. Fetch props for each game and accumulate
  const propArrays: PlayerProp[][] = [];
  for (const game of games) {
    try {
      const propsUrl =
        `${ODDS_API_BASE}/events/${game.id}/odds` +
        `?apiKey=${apiKey}` +
        `&regions=us` +
        `&markets=${SUPPORTED_MARKETS}` +
        `&oddsFormat=american`;
      const propsRes = await fetch(propsUrl);
      if (!propsRes.ok) {
        // Game may have no props yet, or the prop market was pulled.
        // Don't fail the whole snapshot — just record and continue.
        errors.push(`Props fetch ${game.id}: HTTP ${propsRes.status}`);
        continue;
      }
      const rawProps: OddsApiEventOdds = await propsRes.json();
      propArrays.push(transformProps(rawProps));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown';
      errors.push(`Props fetch ${game.id}: ${message}`);
    }
  }

  // 4. Build the lookup and 5. compute the plan
  const propLookup = buildPropLookup(propArrays);
  const plan = buildSnapshotPlan(pendingPicks, propLookup, new Date().toISOString());

  // 6. Apply updates
  let picksUpdated = 0;
  for (const update of plan.updates) {
    const { error: updateErr } = await supabase
      .from('picks')
      .update({
        closing_odds_over: update.closing_odds_over,
        closing_odds_under: update.closing_odds_under,
        closing_line: update.closing_line,
        closing_snapshot_at: update.closing_snapshot_at,
      })
      .eq('id', update.pickId);

    if (updateErr) {
      errors.push(`Update ${update.pickId}: ${updateErr.message}`);
    } else {
      picksUpdated++;
    }
  }

  const response: SnapshotResponse = {
    ok: true,
    pendingPicks: pendingPicks.length,
    gamesQueried: games.length,
    picksUpdated,
    picksUnmatched: plan.unmatchedCount,
    errors,
    durationMs: Date.now() - start,
  };
  return NextResponse.json(response);
}
