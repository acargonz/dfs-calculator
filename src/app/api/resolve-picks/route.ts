/**
 * /api/resolve-picks — nightly cron that resolves yesterday's (and any older
 * unresolved) picks against balldontlie box scores.
 *
 * Triggered by:
 *   - Vercel cron (see vercel.json) once per day after all NBA games end
 *   - Manual GET in dev (auth skipped when CRON_SECRET is unset)
 *
 * Auth:
 *   Same pattern as /api/snapshot-closing-lines — requires
 *   `Authorization: Bearer <CRON_SECRET>` in production; open in dev.
 *
 * IO contract:
 *   1. Query Supabase for all picks where won IS NULL and date < today.
 *   2. Group by date so we only fetch each box-score day once.
 *   3. For each date, page through balldontlie /v1/stats?dates[]=<date>
 *      until meta.next_cursor is null.
 *   4. For each pending pick, call resolvePick() from src/lib/pickResolver
 *      against the fetched box scores. Collect outcomes and DNPs.
 *   5. Batch-update the picks table with actual_value / won / pushed /
 *      resolved_at.
 *   6. Return a summary json for the cron log.
 *
 * All business logic (stat math, name match, push handling) lives in the
 * pure-math library. This route is IO-only. That's enforced by keeping the
 * route zero-test-coverage and all tests on pickResolver.ts.
 *
 * Idempotent: re-running is a no-op for already-resolved rows because the
 * WHERE clause filters `won IS NULL`.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSupabase } from '@/lib/supabase';
import {
  resolvePick,
  type PlayerIdentity,
  type RawBoxScore,
} from '@/lib/pickResolver';

const BDL_BASE = 'https://api.balldontlie.io/v1';

/**
 * Upper bound on how far back to search for unresolved picks. Prevents the
 * cron from thrashing if it has been offline for weeks (which would pile up
 * thousands of stale rows). 14 days is plenty for typical recovery.
 */
const MAX_BACKFILL_DAYS = 14;

/**
 * Max pages per date (balldontlie caps per_page at 100 for the stats endpoint).
 * A normal slate of 10 games has ~240 player-game rows, so 3 pages is enough.
 * Set to 10 to cover double-header nights + margin.
 */
const MAX_PAGES_PER_DATE = 10;

/**
 * Typed subset of the balldontlie /v1/stats response. We only pull the
 * fields the resolver actually reads — `RawBoxScore` + `player` identity.
 */
interface BdlStatRow extends RawBoxScore {
  player: PlayerIdentity & { id: number };
}

interface BdlStatsResponse {
  data: BdlStatRow[];
  meta: { next_cursor: number | null; per_page: number };
}

interface ResolveResponse {
  ok: boolean;
  scannedDates: string[];
  pendingPicks: number;
  resolved: number;
  pushed: number;
  dnp: number;
  noMatch: number;
  unsupportedStat: number;
  errors: string[];
  durationMs: number;
}

/**
 * Compute today's YYYY-MM-DD in UTC. Using UTC (vs local) makes the cron
 * deterministic regardless of where Vercel schedules it from, and the
 * picks.date column is stored as a UTC date already by /api/analyze.
 */
function todayUTC(): string {
  return new Date().toISOString().split('T')[0];
}

/**
 * Subtract N calendar days from a UTC date string.
 */
function daysAgoUTC(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().split('T')[0];
}

/**
 * Page through balldontlie's /v1/stats endpoint for a given date, collecting
 * every player-game row. Returns the full concatenated array.
 *
 * Handles pagination via the cursor token. Breaks on empty data or after
 * MAX_PAGES_PER_DATE pages as a safety guard.
 */
async function fetchBoxScoresForDate(
  date: string,
  apiKey: string,
): Promise<BdlStatRow[]> {
  const all: BdlStatRow[] = [];
  let cursor: number | null = null;

  for (let page = 0; page < MAX_PAGES_PER_DATE; page++) {
    const url = new URL(`${BDL_BASE}/stats`);
    url.searchParams.set('dates[]', date);
    url.searchParams.set('per_page', '100');
    if (cursor !== null) url.searchParams.set('cursor', String(cursor));

    const res = await fetch(url.toString(), {
      headers: { Authorization: apiKey },
    });
    if (!res.ok) {
      throw new Error(`balldontlie stats error (${res.status}) for ${date}`);
    }
    const json = (await res.json()) as BdlStatsResponse;
    all.push(...(json.data ?? []));

    if (!json.meta?.next_cursor) break;
    cursor = json.meta.next_cursor;
  }

  return all;
}

export async function GET(request: NextRequest) {
  const start = Date.now();
  const errors: string[] = [];

  // Auth — mirror snapshot route pattern
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = request.headers.get('authorization');
    if (auth !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  const bdlKey = process.env.BALLDONTLIE_API_KEY;
  if (!bdlKey) {
    return NextResponse.json(
      { error: 'BALLDONTLIE_API_KEY not configured' },
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

  // 1. Fetch all unresolved picks in the backfill window
  const today = todayUTC();
  const earliest = daysAgoUTC(MAX_BACKFILL_DAYS);

  // The `pushed` column defaults to `false`, not NULL. A fresh pick sits
  // at (won=null, pushed=false). After one resolution pass — whether a
  // normal win/loss, a push, or a DNP — at least one of those fields is
  // no longer at its starting value, so this filter cleanly excludes it
  // on subsequent runs. That's what makes the cron idempotent.
  const { data: rawPicks, error: pickErr } = await supabase
    .from('picks')
    .select('id, date, player_name, stat_type, line, direction')
    .is('won', null)
    .eq('pushed', false)
    .gte('date', earliest)
    .lt('date', today);

  if (pickErr) {
    return NextResponse.json(
      { error: `Failed to fetch pending picks: ${pickErr.message}` },
      { status: 500 },
    );
  }

  const pendingPicks = (rawPicks ?? []).map((p) => ({
    id: p.id as string,
    date: p.date as string,
    playerName: p.player_name as string,
    statType: p.stat_type as string,
    line: Number(p.line),
    direction: p.direction as 'over' | 'under',
  }));

  if (pendingPicks.length === 0) {
    const emptyResponse: ResolveResponse = {
      ok: true,
      scannedDates: [],
      pendingPicks: 0,
      resolved: 0,
      pushed: 0,
      dnp: 0,
      noMatch: 0,
      unsupportedStat: 0,
      errors: [],
      durationMs: Date.now() - start,
    };
    return NextResponse.json(emptyResponse);
  }

  // 2. Group picks by date so each box-score day is fetched once
  const byDate = new Map<string, typeof pendingPicks>();
  for (const p of pendingPicks) {
    const list = byDate.get(p.date) ?? [];
    list.push(p);
    byDate.set(p.date, list);
  }

  // 3. Fetch box scores for each unique date (sequentially to stay under
  //    balldontlie's free-tier rate limit of 5 req/min)
  const boxScoresByDate = new Map<string, BdlStatRow[]>();
  for (const date of byDate.keys()) {
    try {
      const boxes = await fetchBoxScoresForDate(date, bdlKey);
      boxScoresByDate.set(date, boxes);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown';
      errors.push(`fetch ${date}: ${msg}`);
      boxScoresByDate.set(date, []); // ensure subsequent logic doesn't crash
    }
  }

  // 4. Run the pure resolver on each pending pick
  let resolvedCount = 0;
  let pushedCount = 0;
  let dnpCount = 0;
  let noMatchCount = 0;
  let unsupportedCount = 0;

  const updates: Array<{
    id: string;
    actual_value: number | null;
    won: boolean | null;
    pushed: boolean;
  }> = [];

  for (const pick of pendingPicks) {
    const boxes = boxScoresByDate.get(pick.date) ?? [];
    const result = resolvePick(
      {
        playerName: pick.playerName,
        statType: pick.statType,
        line: pick.line,
        direction: pick.direction,
      },
      boxes,
    );

    switch (result.status) {
      case 'resolved':
        resolvedCount++;
        if (result.outcome.pushed) pushedCount++;
        updates.push({
          id: pick.id,
          actual_value: result.actualValue,
          won: result.outcome.won,
          pushed: result.outcome.pushed,
        });
        break;

      case 'dnp':
        dnpCount++;
        // DNP is a final state but NOT a resolved bet. Most DFS platforms
        // refund DNP props. We mark pushed=true so the pick exits the
        // pending pool without being counted as a loss in ROI math.
        updates.push({
          id: pick.id,
          actual_value: null,
          won: null,
          pushed: true,
        });
        break;

      case 'no_match':
        noMatchCount++;
        // Leave untouched — the player may show up in a later cron run
        // (e.g. balldontlie lag). MAX_BACKFILL_DAYS provides the upper bound.
        break;

      case 'unsupported_stat':
        unsupportedCount++;
        // Leave untouched — a future resolver version may add support.
        break;
    }
  }

  // 5. Apply updates in sequence. Each row takes ~50ms on Supabase free tier
  //    so batches of 100 complete in ~5 seconds — well under the 10-second
  //    Vercel cron timeout. Sequential not parallel to avoid hammering the
  //    connection pool on the anon role.
  const resolvedAt = new Date().toISOString();
  let updateOk = 0;
  let updateFail = 0;

  for (const update of updates) {
    const { error: updateErr } = await supabase
      .from('picks')
      .update({
        actual_value: update.actual_value,
        won: update.won,
        pushed: update.pushed,
        resolved_at: resolvedAt,
      })
      .eq('id', update.id);

    if (updateErr) {
      updateFail++;
      errors.push(`update ${update.id}: ${updateErr.message}`);
    } else {
      updateOk++;
    }
  }

  const response: ResolveResponse = {
    ok: updateFail === 0,
    scannedDates: Array.from(byDate.keys()).sort(),
    pendingPicks: pendingPicks.length,
    resolved: resolvedCount,
    pushed: pushedCount,
    dnp: dnpCount,
    noMatch: noMatchCount,
    unsupportedStat: unsupportedCount,
    errors,
    durationMs: Date.now() - start,
  };

  return NextResponse.json(response);
}
