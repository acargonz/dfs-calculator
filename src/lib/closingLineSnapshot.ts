/**
 * Closing-line snapshot — pure logic.
 *
 * The /api/snapshot-closing-lines route is responsible for IO:
 *   1. Querying Supabase for picks made today that haven't been snapshotted yet
 *   2. Fetching today's games + props from The Odds API
 *   3. Calling buildSnapshotPlan() (this file) to figure out what to update
 *   4. Pushing the updates back to Supabase
 *
 * This file holds only the pure step (3) so it can be unit-tested without any
 * network or database mocking. Given a list of pending picks and a lookup of
 * currently-live props, it returns the exact updates to apply and the count
 * of picks that couldn't be matched (i.e. the prop was pulled or moved).
 *
 * Why this matters:
 *   Closing Line Value (CLV) is the fastest signal we have for whether the
 *   AI ensemble is finding edge. Sharp markets converge on the right price
 *   right before tip-off — if our picks consistently beat that closing
 *   number, we have a real edge regardless of which specific bets won. CLV
 *   converges in dozens of picks; raw win/loss takes hundreds.
 */

import { matchKey } from './ensembleConsensus';

/** A pick row that hasn't been snapshotted yet (subset of fields we need). */
export interface PendingPick {
  id: string;
  player_name: string;
  stat_type: string;
  line: number;
}

/** Currently-live odds for a single prop, keyed by player+stat+line in the lookup. */
export interface PropSnapshot {
  overOdds: number;
  underOdds: number;
  /** The current line — may differ from the bet-time line if the book moved it. */
  line: number;
}

/** A single Supabase update payload, ready to .update().eq('id', pickId). */
export interface SnapshotUpdate {
  pickId: string;
  closing_odds_over: number;
  closing_odds_under: number;
  closing_line: number;
  closing_snapshot_at: string;
}

export interface SnapshotPlan {
  updates: SnapshotUpdate[];
  unmatchedCount: number;
  /** IDs of picks that couldn't be matched — useful for logging. */
  unmatchedPickIds: string[];
}

/**
 * Build the list of updates to apply to the picks table.
 *
 * For each pending pick, look up the matching live prop (by canonical
 * player+stat+line key). If found, emit an update payload. If not found,
 * the pick is recorded as unmatched (likely because the prop was pulled
 * before the snapshot ran — common when injuries are announced late).
 *
 * Pure: no IO, no Date.now(). Caller passes snapshotTime explicitly so the
 * function is deterministic and easily testable.
 */
export function buildSnapshotPlan(
  pendingPicks: PendingPick[],
  propLookup: Map<string, PropSnapshot>,
  snapshotTime: string,
): SnapshotPlan {
  const updates: SnapshotUpdate[] = [];
  const unmatchedPickIds: string[] = [];

  for (const pick of pendingPicks) {
    const key = matchKey(pick.player_name, pick.stat_type, Number(pick.line));
    const matched = propLookup.get(key);
    if (!matched) {
      unmatchedPickIds.push(pick.id);
      continue;
    }
    updates.push({
      pickId: pick.id,
      closing_odds_over: matched.overOdds,
      closing_odds_under: matched.underOdds,
      closing_line: matched.line,
      closing_snapshot_at: snapshotTime,
    });
  }

  return {
    updates,
    unmatchedCount: unmatchedPickIds.length,
    unmatchedPickIds,
  };
}

/**
 * Helper for the route handler: build the prop lookup from a list of
 * `PlayerProp[]` arrays (one per game). The lookup uses the same canonical
 * matchKey() as the rest of the codebase so reads/writes always agree.
 *
 * If the same player+stat+line appears in multiple games (shouldn't happen
 * in practice, but defensive), the LAST one wins.
 */
export function buildPropLookup(
  propArrays: Array<Array<{ playerName: string; statType: string; line: number; overOdds: number; underOdds: number }>>,
): Map<string, PropSnapshot> {
  const lookup = new Map<string, PropSnapshot>();
  for (const props of propArrays) {
    for (const p of props) {
      lookup.set(matchKey(p.playerName, p.statType, p.line), {
        overOdds: p.overOdds,
        underOdds: p.underOdds,
        line: p.line,
      });
    }
  }
  return lookup;
}
