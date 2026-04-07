/**
 * Pure-math pick resolver. All functions here are deterministic and have no
 * network or DB dependencies so the unit tests can exercise every branch.
 *
 * The resolver is responsible for taking a raw balldontlie box-score stat line
 * plus a pick row, and deciding:
 *   1. What is the actual numeric value for the pick's stat type?
 *      (Simple counting stats are trivial; combo stats sum multiple columns;
 *       fantasy stats apply a platform-specific scoring formula.)
 *   2. Did the pick WIN, LOSE, or PUSH given the actual value + line +
 *      direction?
 *   3. Does a box-score player row match the pick's `player_name` string?
 *
 * The cron route (/api/resolve-picks/route.ts) orchestrates the IO around
 * these pure functions but never reimplements this logic itself.
 */

/**
 * A single raw stat line from balldontlie's /v1/stats endpoint.
 * We only model the fields we actually read — everything else is ignored
 * so future additions by balldontlie don't break our parser.
 */
export interface RawBoxScore {
  pts: number;
  reb: number;
  ast: number;
  stl: number;
  blk: number;
  fg3m: number;
  turnover: number;
  // `min` can be a string like "35:42" or ":00" or null when DNP. We tolerate
  // all three shapes and treat DNP as a non-match so the resolver doesn't
  // accidentally "resolve" a pick with a zero stat line.
  min: string | null | undefined;
}

/**
 * Canonical stat types we know how to resolve. These match the values that
 * flow from `parsers.normalizeStatType` into the `picks.stat_type` column,
 * plus the lowercase aliases that AI models sometimes emit.
 */
export type ResolvableStatType =
  | 'points'
  | 'rebounds'
  | 'assists'
  | 'steals'
  | 'blocks'
  | 'threes'
  | 'turnovers'
  | 'pra'
  | 'pts+rebs'
  | 'pts+asts'
  | 'rebs+asts'
  | 'fantasy';

/**
 * Lowercase and normalize free-form stat_type strings into one of our
 * canonical `ResolvableStatType` values. Returns null for unsupported
 * stats so the caller can skip resolution cleanly instead of crashing.
 *
 * Handles all the aliases that flow through from:
 *   - parsers.normalizeStatType (DFS paste)
 *   - the AI layer (which sometimes returns "Points" or "3-pointers")
 *   - the Odds API market keys (player_points etc — already upstream-normalized)
 */
export function canonicalizeStatType(raw: string): ResolvableStatType | null {
  const s = raw.toLowerCase().trim();

  if (s === 'points' || s === 'pts' || s === 'player_points') return 'points';
  if (s === 'rebounds' || s === 'rebs' || s === 'reb' || s === 'player_rebounds')
    return 'rebounds';
  if (s === 'assists' || s === 'asts' || s === 'ast' || s === 'player_assists')
    return 'assists';
  if (s === 'steals' || s === 'stl' || s === 'stls' || s === 'player_steals')
    return 'steals';
  if (s === 'blocks' || s === 'blk' || s === 'blks' || s === 'player_blocks')
    return 'blocks';
  if (
    s === 'threes' ||
    s === '3-pointers' ||
    s === '3pt' ||
    s === '3-pt' ||
    s === '3pm' ||
    s === 'player_threes'
  )
    return 'threes';
  if (s === 'turnovers' || s === 'tov' || s === 'to' || s === 'player_turnovers')
    return 'turnovers';

  if (s === 'pra' || s === 'pts+rebs+asts' || s === 'pts + rebs + asts') return 'pra';
  if (s === 'pr' || s === 'pts+rebs' || s === 'pts + rebs') return 'pts+rebs';
  if (s === 'pa' || s === 'pts+asts' || s === 'pts + asts') return 'pts+asts';
  if (s === 'ra' || s === 'rebs+asts' || s === 'rebs + asts') return 'rebs+asts';

  if (s === 'fantasy' || s === 'fantasy points' || s === 'fantasy score' || s === 'fpts')
    return 'fantasy';

  return null;
}

/**
 * PrizePicks / Underdog Fantasy NBA fantasy-score formula.
 *
 *   FPTS = PTS*1  +  REB*1.2  +  AST*1.5  +  STL*3  +  BLK*3  +  TO*(-1)
 *
 * Both platforms use the same multipliers for NBA fantasy score props — the
 * only other game in town is DraftKings Pick6, which does NOT offer a
 * fantasy-score prop category at all. So there's exactly ONE formula we
 * ever need to resolve for the `stat_type = 'fantasy'` case, and
 * platform-awareness isn't required in this pure-math layer.
 *
 * Three-pointers are deliberately NOT re-scored: they already count as part
 * of `pts` on the box score, and PrizePicks/Underdog do not grant a bonus
 * for them the way DK Pick6 classic scoring does.
 *
 * Double-double / triple-double bonuses are intentionally omitted — neither
 * PrizePicks nor Underdog apply a DD/TD bonus to their fantasy-score prop,
 * and adding one would push the actual value past the graded line in a way
 * the sportsbooks themselves do not.
 */
export function computeFantasyScore(box: RawBoxScore): number {
  return (
    box.pts * 1 +
    box.reb * 1.2 +
    box.ast * 1.5 +
    box.stl * 3 +
    box.blk * 3 +
    box.turnover * -1
  );
}

/**
 * Convert a box-score row + canonical stat type → actual numeric value for
 * that pick. Returns `null` only for stat types we don't recognize (the
 * caller is expected to check canonicalizeStatType first, so this is a
 * defense-in-depth fallback).
 */
export function computeActualValue(
  box: RawBoxScore,
  statType: ResolvableStatType,
): number {
  switch (statType) {
    case 'points':
      return box.pts;
    case 'rebounds':
      return box.reb;
    case 'assists':
      return box.ast;
    case 'steals':
      return box.stl;
    case 'blocks':
      return box.blk;
    case 'threes':
      return box.fg3m;
    case 'turnovers':
      return box.turnover;
    case 'pra':
      return box.pts + box.reb + box.ast;
    case 'pts+rebs':
      return box.pts + box.reb;
    case 'pts+asts':
      return box.pts + box.ast;
    case 'rebs+asts':
      return box.reb + box.ast;
    case 'fantasy':
      return computeFantasyScore(box);
  }
}

/**
 * Resolution outcome for a single pick.
 *   - won=true:  the pick is a winner
 *   - won=false: the pick is a loser
 *   - pushed=true: the actual value exactly equals the line (pick refunds)
 *
 * Important: in DFS prop betting, integer lines like 20.0 can push.
 * Decimal lines like 20.5 never push because the actual value is always
 * an integer. `computeOutcome` handles both cleanly via floating-point
 * equality (values are always whole numbers here except for fantasy).
 */
export interface PickOutcome {
  won: boolean;
  pushed: boolean;
}

/**
 * Given actual + line + direction, compute the final outcome.
 *
 * DFS convention:
 *   OVER  → wins when actual > line, loses when actual < line, push when equal
 *   UNDER → wins when actual < line, loses when actual > line, push when equal
 *
 * `pushed=true` always coexists with `won=false` because a push is NOT a win.
 * Callers should check `pushed` first when updating the picks table so the
 * `won=false` doesn't get miscategorized as a loss.
 */
export function computeOutcome(
  actual: number,
  line: number,
  direction: 'over' | 'under',
): PickOutcome {
  // Round to 1 decimal to tolerate float precision noise on fantasy scores.
  // Counting stats are always integers so this rounding is a no-op for them.
  const a = Math.round(actual * 10) / 10;
  const l = Math.round(line * 10) / 10;

  if (a === l) return { won: false, pushed: true };
  if (direction === 'over') return { won: a > l, pushed: false };
  return { won: a < l, pushed: false };
}

/**
 * Normalize a player name for comparison: lowercase, strip diacritics,
 * remove Jr/Sr/II/III/IV suffixes, collapse internal whitespace.
 *
 * Kept in sync with the normalize() helper in /api/player-stats/route.ts
 * so a name that matches one source matches the other. Both call sites
 * need suffix stripping because balldontlie, pbpstats, and the Odds API
 * inconsistently include suffixes — "Jaren Jackson Jr" from one source
 * must match "Jaren Jackson" from another.
 *
 * NOTE: ensembleConsensus.ts has its own normalizer that intentionally
 * PRESERVES suffixes, because it merges picks across LLMs where suffix
 * collisions would silently alias two different players. See the comment
 * on normalizePlayerName in that file for the rationale.
 */
export function normalizePlayerName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv)\b\.?/g, '')
    .replace(/[^a-z ]/g, '')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Minimum shape required to identify a player in a box-score dataset.
 * Matches the balldontlie stats response's nested `player` object.
 */
export interface PlayerIdentity {
  first_name: string;
  last_name: string;
}

/**
 * Try to find a box score whose player matches `pickPlayerName`. Uses the
 * same fuzzy-match ladder as /api/player-stats:
 *   1. Exact normalized full-name match
 *   2. Unambiguous last-name match
 *   3. Partial contains match (either direction)
 *
 * Returns the index of the match in `boxes`, or -1 if no match.
 * Index-based return lets the caller pull both the box score and its
 * companion metadata (game id, team id, etc.) from parallel arrays.
 */
export function findBoxScoreIndex<
  T extends { player: PlayerIdentity },
>(boxes: T[], pickPlayerName: string): number {
  const target = normalizePlayerName(pickPlayerName);
  if (!target) return -1;
  const targetLast = target.split(' ').pop() || '';

  // 1. Exact full-name
  for (let i = 0; i < boxes.length; i++) {
    const full = normalizePlayerName(
      `${boxes[i].player.first_name} ${boxes[i].player.last_name}`,
    );
    if (full === target) return i;
  }

  // 2. Last-name — only if unambiguous
  const lastMatches: number[] = [];
  for (let i = 0; i < boxes.length; i++) {
    const last = normalizePlayerName(boxes[i].player.last_name);
    if (last === targetLast) lastMatches.push(i);
  }
  if (lastMatches.length === 1) return lastMatches[0];

  // 3. Partial contains — either direction
  for (let i = 0; i < boxes.length; i++) {
    const full = normalizePlayerName(
      `${boxes[i].player.first_name} ${boxes[i].player.last_name}`,
    );
    if (full.includes(target) || target.includes(full)) return i;
  }

  return -1;
}

/**
 * True when a box score represents a player who actually played the game.
 * DNP / inactive / coach's decision rows show `min = ":00"`, `min = null`,
 * or `min = ""`. We treat those as non-matches so the resolver doesn't
 * incorrectly resolve a pick to a 0 stat line.
 */
export function didPlayerPlay(box: RawBoxScore): boolean {
  const m = box.min;
  if (m === null || m === undefined) return false;
  const trimmed = m.toString().trim();
  if (trimmed === '' || trimmed === ':00' || trimmed === '00:00' || trimmed === '0:00')
    return false;
  // Anything else (e.g. "35:42", "1:12") counts as played.
  return true;
}

/**
 * Public resolver entry point. Takes a pick (name + line + direction + stat
 * type) and a list of raw box scores from that game day, and returns:
 *   - `{ status: 'resolved', actualValue, outcome }` on success
 *   - `{ status: 'no_match' }` when the player wasn't found in the box scores
 *   - `{ status: 'dnp' }` when the player was found but didn't play
 *   - `{ status: 'unsupported_stat' }` when the stat type isn't resolvable
 *
 * No IO — purely transforms its arguments. The cron route consumes this
 * result and performs the Supabase update.
 */
export type ResolveResult =
  | {
      status: 'resolved';
      actualValue: number;
      outcome: PickOutcome;
    }
  | { status: 'no_match' }
  | { status: 'dnp' }
  | { status: 'unsupported_stat' };

export interface PickToResolve {
  playerName: string;
  statType: string;
  line: number;
  direction: 'over' | 'under';
}

export function resolvePick<T extends { player: PlayerIdentity } & RawBoxScore>(
  pick: PickToResolve,
  boxes: T[],
): ResolveResult {
  const stat = canonicalizeStatType(pick.statType);
  if (!stat) return { status: 'unsupported_stat' };

  const idx = findBoxScoreIndex(boxes, pick.playerName);
  if (idx === -1) return { status: 'no_match' };

  const box = boxes[idx];
  if (!didPlayerPlay(box)) return { status: 'dnp' };

  const actualValue = computeActualValue(box, stat);
  const outcome = computeOutcome(actualValue, pick.line, pick.direction);
  return { status: 'resolved', actualValue, outcome };
}
