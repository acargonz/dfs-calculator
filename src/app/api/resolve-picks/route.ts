/**
 * /api/resolve-picks — nightly cron that resolves yesterday's (and any older
 * unresolved) picks against ESPN game-summary box scores.
 *
 * Triggered by:
 *   - Vercel cron (see vercel.json) once per day after all NBA games end
 *   - Manual GET in dev (auth skipped when CRON_SECRET is unset)
 *
 * Auth:
 *   Same pattern as /api/snapshot-closing-lines — requires
 *   `Authorization: Bearer <CRON_SECRET>` in production; open in dev.
 *
 * Data source: ESPN public scoreboard + game summary endpoints.
 *
 * Why not balldontlie /v1/stats?
 *   It was the original source, but that endpoint requires the paid
 *   ALL-STAR tier ($9.99/mo). Our free key gets 401. Rather than force a
 *   paid dependency, we switched to ESPN's public game-summary API which
 *   is completely free, no-auth, documented, and stable. The per-pick
 *   resolver logic is unchanged — only the box-score ingestion layer was
 *   swapped out. See src/lib/espnBoxScore.ts for the ESPN → RawBoxScore
 *   adapter and its unit tests.
 *
 * IO contract:
 *   1. Query Supabase for all picks where won IS NULL and date < today.
 *   2. Group by date so we only fetch each ESPN scoreboard once.
 *   3. For each date:
 *        a. Fetch the ESPN scoreboard to enumerate game IDs.
 *        b. Fetch each game's /summary in parallel (sequentially per date
 *           to stay polite, but parallel within the date's games).
 *        c. Flatten every athlete into a single box-score array via
 *           flattenGameSummary().
 *   4. For each pending pick, call resolvePick() from src/lib/pickResolver
 *      against the fetched box scores. Collect outcomes and DNPs.
 *   5. Batch-update the picks table with actual_value / won / pushed /
 *      resolved_at.
 *   6. Return a summary json for the cron log.
 *
 * All business logic (stat math, name match, push handling) lives in the
 * pure-math library. This route is IO-only. That's enforced by keeping the
 * route zero-test-coverage and all tests on pickResolver.ts + espnBoxScore.ts.
 *
 * Idempotent: re-running is a no-op for already-resolved rows because the
 * WHERE clause filters `won IS NULL AND pushed = false`.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabaseAdmin';
import { verifyCronAuth } from '@/lib/cronAuth';
import { misconfigured, internalError } from '@/lib/apiErrors';
import { resolvePick } from '@/lib/pickResolver';
import {
  flattenGameSummary,
  type EspnGameSummary,
  type FlatBoxScore,
} from '@/lib/espnBoxScore';

// Vercel Hobby tier allows 60s max duration for serverless functions.
// This route makes ~11 outbound requests per date (1 scoreboard + ~10
// summaries) and ~50 Supabase updates, so 60s is plenty of headroom.
export const runtime = 'nodejs';
export const maxDuration = 60;

const ESPN_BASE = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba';

/**
 * Upper bound on how far back to search for unresolved picks. Prevents the
 * cron from thrashing if it has been offline for weeks (which would pile up
 * thousands of stale rows). 14 days is plenty for typical recovery.
 */
const MAX_BACKFILL_DAYS = 14;

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
 * Convert a YYYY-MM-DD date to ESPN's compact YYYYMMDD scoreboard param.
 */
function isoToCompact(iso: string): string {
  return iso.replaceAll('-', '');
}

/**
 * Fetch every box score for a given date by:
 *   1. Calling the ESPN scoreboard to get that day's game IDs
 *   2. Fetching each game's summary in parallel
 *   3. Flattening all athletes across all games into a single array
 *
 * Returns a single flat array regardless of how many games were played.
 * An empty array means ESPN had no games for that date (off-day or schema
 * drift). The resolver will treat that as no-match for every pending pick.
 */
async function fetchBoxScoresForDate(
  date: string,
): Promise<{ boxes: FlatBoxScore[]; gameCount: number }> {
  const scoreboardUrl = `${ESPN_BASE}/scoreboard?dates=${isoToCompact(date)}`;
  const scoreboardRes = await fetch(scoreboardUrl);
  if (!scoreboardRes.ok) {
    throw new Error(`ESPN scoreboard error (${scoreboardRes.status}) for ${date}`);
  }
  const scoreboard = (await scoreboardRes.json()) as {
    events?: Array<{ id?: string | number }>;
  };
  const events = scoreboard.events ?? [];
  const gameIds = events
    .map((e) => (e.id !== undefined ? String(e.id) : null))
    .filter((id): id is string => id !== null);

  if (gameIds.length === 0) {
    return { boxes: [], gameCount: 0 };
  }

  // Fetch all game summaries in parallel — ESPN can handle it and we want
  // the whole date's data batched together.
  const summaryResults = await Promise.all(
    gameIds.map(async (id) => {
      const summaryUrl = `${ESPN_BASE}/summary?event=${id}`;
      const res = await fetch(summaryUrl);
      if (!res.ok) {
        throw new Error(`ESPN summary error (${res.status}) for game ${id}`);
      }
      return (await res.json()) as EspnGameSummary;
    }),
  );

  const boxes: FlatBoxScore[] = [];
  for (const summary of summaryResults) {
    boxes.push(...flattenGameSummary(summary));
  }
  return { boxes, gameCount: gameIds.length };
}

export async function GET(request: NextRequest) {
  const start = Date.now();
  const errors: string[] = [];

  // Auth — fail-CLOSED cron Bearer check. Fixes security finding C4
  // (previous inline check was fail-open when CRON_SECRET was unset).
  const authFailure = verifyCronAuth(request);
  if (authFailure) return authFailure;

  const supabase = getSupabaseAdmin();
  if (!supabase) {
    return misconfigured('Supabase admin client not configured');
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
    return internalError(pickErr, 'resolve-picks: fetch pending');
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

  // 2. Group picks by date so each ESPN scoreboard is fetched once
  const byDate = new Map<string, typeof pendingPicks>();
  for (const p of pendingPicks) {
    const list = byDate.get(p.date) ?? [];
    list.push(p);
    byDate.set(p.date, list);
  }

  // 3. Fetch box scores for each unique date. Dates are fetched sequentially
  //    (we're polite to ESPN — it's free) but each date's games are fetched
  //    in parallel inside fetchBoxScoresForDate.
  const boxScoresByDate = new Map<string, FlatBoxScore[]>();
  for (const date of byDate.keys()) {
    try {
      const { boxes } = await fetchBoxScoresForDate(date);
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
        // (e.g. ESPN lag). MAX_BACKFILL_DAYS provides the upper bound.
        break;

      case 'unsupported_stat':
        unsupportedCount++;
        // Leave untouched — a future resolver version may add support.
        break;
    }
  }

  // 5. Apply updates in sequence. Each row takes ~50ms on Supabase free tier
  //    so batches of 100 complete in ~5 seconds — well under the 60-second
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
