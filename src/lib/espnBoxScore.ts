/**
 * Pure-math adapter that converts ESPN's game-summary box-score format into
 * the `RawBoxScore + PlayerIdentity` shape our resolver expects.
 *
 * Why this exists
 * ---------------
 * The original /api/resolve-picks route used balldontlie's /v1/stats endpoint
 * to fetch box scores. That endpoint requires balldontlie's paid ALL-STAR tier
 * ($9.99/mo) — our free key gets 401. Rather than force a paid dependency, we
 * switched to ESPN's public game-summary API which is:
 *   - Free (no auth header)
 *   - Stable (site.api.espn.com has been up for a decade)
 *   - Rich enough (gives us PTS, REB, AST, STL, BLK, TO, 3PT for every player)
 *   - DNP-aware (didNotPlay flag on each athlete)
 *
 * This module contains zero network IO and zero test skipping — it's pure
 * string → number parsing that the unit tests can exercise exhaustively.
 * The IO (fetching the scoreboard + each game summary) lives in the route.
 *
 * ESPN's format
 * -------------
 * Calling /apis/site/v2/sports/basketball/nba/summary?event=<id> returns:
 *
 *   {
 *     boxscore: {
 *       players: [
 *         {
 *           team: { displayName, abbreviation, ... },
 *           statistics: [
 *             {
 *               labels:  ['MIN','PTS','FG','3PT','FT','REB','AST','TO','STL','BLK','OREB','DREB','PF','+/-'],
 *               athletes: [
 *                 {
 *                   athlete: { displayName: 'OG Anunoby', ... },
 *                   stats: ['37','22','7-14','4-10','4-4','5','1','3','0','2','2','3','1','+10'],
 *                   didNotPlay: false,
 *                   active: true,
 *                 },
 *                 ...
 *               ]
 *             }
 *           ]
 *         },
 *         ...
 *       ]
 *     }
 *   }
 *
 * Our adapter flattens every athlete across both teams into a single array
 * so the existing resolver (which works on a flat box-score array) doesn't
 * need to know anything about ESPN.
 */

import type { PlayerIdentity, RawBoxScore } from './pickResolver';

/**
 * Minimal ESPN types we depend on. Extra fields ESPN returns are ignored,
 * so schema drift on their end doesn't break us.
 */
export interface EspnAthleteRow {
  athlete?: {
    displayName?: string;
    firstName?: string;
    lastName?: string;
  };
  stats?: string[];
  /** True when the player was on the roster but didn't see action. */
  didNotPlay?: boolean;
  /** True when the player was active (on the roster, may or may not have played). */
  active?: boolean;
  /** True when the player was a starter. */
  starter?: boolean;
}

export interface EspnTeamStats {
  labels?: string[];
  athletes?: EspnAthleteRow[];
}

export interface EspnTeamBoxScore {
  team?: { displayName?: string; abbreviation?: string };
  statistics?: EspnTeamStats[];
}

export interface EspnGameSummary {
  boxscore?: {
    players?: EspnTeamBoxScore[];
  };
}

/**
 * A single flattened box-score row that satisfies the resolver's required
 * shape: `RawBoxScore & { player: PlayerIdentity }`. The identity lets the
 * fuzzy name matcher find the right player.
 */
export interface FlatBoxScore extends RawBoxScore {
  player: PlayerIdentity;
}

/**
 * Canonical ESPN stat labels we know how to map. The label array from ESPN
 * MUST contain these keys (they've been stable for years). If ESPN ever
 * reorders or renames, parseStatsRow detects the drift and returns null for
 * the affected row — the resolver treats it as a no-match.
 */
const LABEL_MIN = 'MIN';
const LABEL_PTS = 'PTS';
const LABEL_REB = 'REB';
const LABEL_AST = 'AST';
const LABEL_STL = 'STL';
const LABEL_BLK = 'BLK';
const LABEL_TO = 'TO';
const LABEL_THREES = '3PT';

/**
 * Split "Firstname Lastname [Suffix]" on the first whitespace. Returns both
 * halves so the resolver's fuzzy matcher can use either one.
 *
 * Edge cases:
 *   "Shai Gilgeous-Alexander"  → first="Shai",  last="Gilgeous-Alexander"
 *   "LeBron James"             → first="LeBron", last="James"
 *   "Cedi Osman"               → first="Cedi",   last="Osman"
 *   "Luka Dončić"              → first="Luka",   last="Dončić" (normalizer strips diacritics downstream)
 *   "Nicolas Claxton"          → first="Nicolas", last="Claxton"
 *
 * If the input has zero spaces, we put the whole string in last_name so the
 * last-name-match fallback still has a chance.
 */
export function splitDisplayName(displayName: string): PlayerIdentity {
  const trimmed = displayName.trim();
  if (!trimmed) return { first_name: '', last_name: '' };

  // Use the LAST space as the split point so multi-word first names like
  // "Nicolas Claxton Jr." still land their last token in last_name. But
  // "Shai Gilgeous-Alexander" has only one space, so this collapses to the
  // usual first/last. The downstream normalizer strips Jr/Sr/III suffixes
  // before comparison, so those don't need special handling here.
  const idx = trimmed.lastIndexOf(' ');
  if (idx === -1) return { first_name: '', last_name: trimmed };
  return {
    first_name: trimmed.slice(0, idx),
    last_name: trimmed.slice(idx + 1),
  };
}

/**
 * Convert an ESPN minutes string to the string form our resolver's
 * `didPlayerPlay` expects. ESPN sends plain integer minutes like "37" for
 * players who played and "0" / "" / undefined for DNPs. The resolver's
 * helper treats ":00", "0:00", "" and null as DNP, so we normalize "0"
 * to ":00" for consistency.
 */
export function normalizeMinutes(raw: string | undefined): string | null {
  if (raw === undefined || raw === null) return null;
  const trimmed = String(raw).trim();
  if (trimmed === '' || trimmed === '0' || trimmed === '0:00' || trimmed === ':00') {
    return ':00';
  }
  return trimmed;
}

/**
 * Parse a single ESPN "3PT" field like "4-10" and return just the made
 * portion. Returns 0 for empty / "--" / invalid input so the resolver
 * doesn't crash on DNPs and the `threes` stat type still sums correctly.
 *
 * ESPN uses "--" sometimes for players who played 0 minutes but appear in
 * the roster with empty stat cells.
 */
export function parseThreesMade(raw: string | undefined): number {
  if (!raw) return 0;
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed === '--') return 0;
  const [made] = trimmed.split('-');
  const n = Number(made);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Parse a single integer stat field. ESPN sends "--" for DNPs and numeric
 * strings like "22" otherwise. Returns 0 for unparseable so the resolver's
 * `didPlayerPlay` filter (not this function) decides whether to use the
 * row at all.
 */
export function parseIntStat(raw: string | undefined): number {
  if (!raw) return 0;
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed === '--') return 0;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Given ESPN's `labels` array and the corresponding `stats` array for one
 * athlete, extract all the fields our resolver needs. Returns null when the
 * labels array is missing a required stat (e.g. ESPN schema drift) — the
 * caller treats null as a skip.
 *
 * The label order ESPN returns is stable (MIN first, then PTS, etc.) but
 * we look up by label rather than index so a reorder won't break us.
 */
export function parseStatsRow(
  labels: string[] | undefined,
  stats: string[] | undefined,
): RawBoxScore | null {
  if (!labels || !stats) return null;

  const idx = (label: string): number => labels.indexOf(label);
  const get = (label: string): string | undefined => {
    const i = idx(label);
    return i === -1 ? undefined : stats[i];
  };

  // All of these are required. Missing any one means schema drift — bail.
  const minIdx = idx(LABEL_MIN);
  const ptsIdx = idx(LABEL_PTS);
  const rebIdx = idx(LABEL_REB);
  const astIdx = idx(LABEL_AST);
  const stlIdx = idx(LABEL_STL);
  const blkIdx = idx(LABEL_BLK);
  const toIdx = idx(LABEL_TO);
  const threesIdx = idx(LABEL_THREES);

  if (
    minIdx === -1 ||
    ptsIdx === -1 ||
    rebIdx === -1 ||
    astIdx === -1 ||
    stlIdx === -1 ||
    blkIdx === -1 ||
    toIdx === -1 ||
    threesIdx === -1
  ) {
    return null;
  }

  return {
    min: normalizeMinutes(get(LABEL_MIN)),
    pts: parseIntStat(get(LABEL_PTS)),
    reb: parseIntStat(get(LABEL_REB)),
    ast: parseIntStat(get(LABEL_AST)),
    stl: parseIntStat(get(LABEL_STL)),
    blk: parseIntStat(get(LABEL_BLK)),
    turnover: parseIntStat(get(LABEL_TO)),
    fg3m: parseThreesMade(get(LABEL_THREES)),
  };
}

/**
 * Convert one ESPN athlete row into a flat box score + player identity.
 * Returns null when the row is unparseable (missing athlete, missing stats,
 * or ESPN schema drift that made parseStatsRow fail).
 *
 * DNP handling:
 *   - If `didNotPlay === true`, we still emit a row with `min = ':00'` so
 *     the resolver's `didPlayerPlay` flags it correctly downstream.
 *   - Some rows have `stats: ['--', '--', ...]` for bench DNPs — parseIntStat
 *     returns 0 for those, and normalizeMinutes converts the empty min to ":00".
 */
export function convertAthlete(
  row: EspnAthleteRow,
  labels: string[] | undefined,
): FlatBoxScore | null {
  const name = row.athlete?.displayName;
  if (!name) return null;

  const box = parseStatsRow(labels, row.stats);
  if (!box) return null;

  // Explicit DNP override: ESPN sometimes sends "--" stats for players who
  // played 0 minutes, and sometimes sends real zeros. The didNotPlay flag
  // is authoritative, so we force min to ':00' when it's set.
  const finalBox: RawBoxScore =
    row.didNotPlay === true ? { ...box, min: ':00' } : box;

  return {
    ...finalBox,
    player: splitDisplayName(name),
  };
}

/**
 * Flatten every athlete across both teams in an ESPN game summary into a
 * single array of `FlatBoxScore`. Unparseable rows are silently skipped
 * (the resolver will treat them as no-matches and continue).
 *
 * This is the main entry point the /api/resolve-picks route calls: one
 * ESPN summary → one flat array. The route concatenates arrays across all
 * the day's games to feed the resolver.
 */
export function flattenGameSummary(summary: EspnGameSummary): FlatBoxScore[] {
  const result: FlatBoxScore[] = [];
  const teams = summary.boxscore?.players ?? [];
  for (const team of teams) {
    const stats = team.statistics?.[0];
    const labels = stats?.labels;
    const athletes = stats?.athletes ?? [];
    for (const row of athletes) {
      const converted = convertAthlete(row, labels);
      if (converted) result.push(converted);
    }
  }
  return result;
}
