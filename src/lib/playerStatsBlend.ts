/**
 * Postseason-aware player stat blending.
 *
 * The DFS Calculator pulls player season averages from PBP Stats. During
 * the regular season, that's all we need. Once the playoffs start, the
 * regular-season average no longer reflects current form (rotations
 * shrink, defenses tighten, pace slows, stars play more minutes). Once
 * the NBA Finals start, the gap widens further — Finals games are the
 * most defensively-tuned basketball of the year.
 *
 * This module is the pure-math layer that:
 *   1. Takes up to three slices of stats for a single player —
 *      regular season, playoffs (excluding Finals), and Finals
 *   2. Computes a blend weight for each slice based on games played
 *   3. Produces a single weighted-average per-game stat block
 *
 * The blend weights ramp linearly with games played and CAP so the
 * regular-season slice always retains some weight as a stabilizing
 * prior. Even at Game 7 of the Finals, regular season holds ~25%.
 *
 * NO I/O HERE. NO API CALLS. Pure functions only — fully unit testable.
 */

/**
 * Per-game stat block. Same shape used by PlayerSeasonAvg in playerStats.ts.
 * Kept here without an import to preserve "pure module, no dependencies".
 */
export interface RawStatsBlock {
  points: number;
  rebounds: number;
  assists: number;
  steals: number;
  blocks: number;
  threes: number;
  turnovers: number;
}

/**
 * One slice of a player's season — could be regular, playoffs, or Finals.
 * Always paired with the games-played count so we can compute weights.
 */
export interface PlayerSeasonSlice {
  /** Per-game averages for this slice (e.g., {points: 28.4, ...}) */
  stats: RawStatsBlock;
  /** Number of games this slice represents */
  gamesPlayed: number;
}

/**
 * The label we attach to the blended result so downstream code (UI,
 * AI message, audit log) knows which season(s) drove the numbers.
 *
 * - 'regular':  Only regular-season data — pre-playoffs or off-season
 * - 'playoffs': Player has playoff data (rounds 1-3, NOT Finals)
 * - 'finals':   Player has Finals data (highest weight on most-recent games)
 *
 * 'finals' implies all three slices may be in the blend. 'playoffs'
 * implies regular + playoffs slices. 'regular' is regular-season only.
 */
export type SeasonType = 'regular' | 'playoffs' | 'finals';

/**
 * The fraction of the final blend that each slice contributes.
 * regular + playoffs + finals always sums to ~1.0 (rounding tolerance).
 */
export interface BlendWeights {
  regular: number;
  playoffs: number;
  finals: number;
}

/**
 * Input bag for the blender. Any slice may be undefined when the player
 * has no data for that season type yet (e.g., regular season only).
 */
export interface BlendInput {
  regular?: PlayerSeasonSlice;
  playoffs?: PlayerSeasonSlice; // playoffs EXCLUDING Finals
  finals?: PlayerSeasonSlice;
}

/**
 * Compute the playoff (excluding Finals) blend weight from games played.
 *
 * Linear ramp: 2.5pp per playoff game, capped at 35%.
 *
 *   0 games  → 0%   (no playoff data, all weight goes to regular)
 *   3 games  → 7.5% (mid Round 1)
 *   8 games  → 20%  (Round 2 in progress)
 *  12 games  → 30%  (Conference Finals in progress)
 *  14 games  → 35%  (cap reached — Conference Finals complete)
 *  20+ games → 35%  (still capped — even a deep playoff run doesn't push it higher)
 *
 * The cap exists because even 14+ playoff games is a noisy sample
 * compared to 70+ regular-season games. We never want playoff data
 * alone to dominate.
 */
export function computePlayoffsWeight(playoffGames: number): number {
  if (!Number.isFinite(playoffGames) || playoffGames <= 0) return 0;
  return Math.min(0.35, playoffGames * 0.025);
}

/**
 * Compute the Finals-only blend weight from Finals games played.
 *
 * Linear ramp: 8pp per Finals game, capped at 40%.
 *
 *   0 games → 0%   (no Finals data — Finals not yet started or team eliminated)
 *   1 game  → 8%
 *   2 games → 16%
 *   3 games → 24%
 *   4 games → 32%
 *   5 games → 40%  (cap reached)
 *   7 games → 40%  (still capped — Game 7 of Finals)
 *
 * Finals data ramps faster than playoff data because:
 *   - It's the most-recent + highest-context information available
 *   - Finals are the most representative sample of "current form" in
 *     the highest-stakes environment
 *   - Sample tops out at 7 games so we want to plateau early
 *
 * The 40% cap leaves room for playoff weight (35% max) + regular
 * season weight (25% min) so even at peak Finals, regular season
 * still anchors a quarter of the blend.
 */
export function computeFinalsWeight(finalsGames: number): number {
  if (!Number.isFinite(finalsGames) || finalsGames <= 0) return 0;
  return Math.min(0.4, finalsGames * 0.08);
}

/**
 * Compute the three-way blend weights for a player.
 *
 * The Finals weight is computed first (it's the most aggressive ramp),
 * then Playoffs, then Regular fills whatever remains. Regular always
 * gets at least 25% when both Finals and Playoffs are at their caps:
 *   regular = 1 - 0.40 - 0.35 = 0.25
 *
 * Examples:
 *   Regular season       (P=0,  F=0):  {regular: 1.00, playoffs: 0.00, finals: 0.00}
 *   Round 1 mid          (P=3,  F=0):  {regular: 0.93, playoffs: 0.075, finals: 0.00}
 *   Round 2 mid          (P=10, F=0):  {regular: 0.75, playoffs: 0.25, finals: 0.00}
 *   Conf Finals end      (P=14, F=0):  {regular: 0.65, playoffs: 0.35, finals: 0.00}
 *   Finals Game 1        (P=14, F=1):  {regular: 0.57, playoffs: 0.35, finals: 0.08}
 *   Finals Game 4        (P=14, F=4):  {regular: 0.33, playoffs: 0.35, finals: 0.32}
 *   Finals Game 7 (peak) (P=14, F=7):  {regular: 0.25, playoffs: 0.35, finals: 0.40}
 */
export function computeBlendWeights(
  playoffGames: number,
  finalsGames: number,
): BlendWeights {
  const finals = computeFinalsWeight(finalsGames);
  const playoffs = computePlayoffsWeight(playoffGames);
  // Clamp to [0, 1] so float drift can't push us negative
  const regular = Math.max(0, Math.min(1, 1 - finals - playoffs));
  return { regular, playoffs, finals };
}

/**
 * Linearly blend up to three stat blocks by the supplied weights.
 *
 * Behaviour:
 *   - A slice that is missing OR has zero games OR has zero weight
 *     is treated as absent. Its weight is redistributed proportionally
 *     across the remaining slices (so the result still sums to the
 *     original "100%" of available data).
 *   - If ALL slices are absent, returns a zero-filled stat block.
 *   - Internally normalizes the weight sum to 1.0 to absorb rounding
 *     drift from the weight-computation helpers.
 *
 * The output is per-game averages (NOT season totals).
 */
export function blendStats(
  input: BlendInput,
  weights: BlendWeights,
): RawStatsBlock {
  const usable: Array<{ slice: PlayerSeasonSlice; weight: number }> = [];
  if (input.regular && input.regular.gamesPlayed > 0 && weights.regular > 0) {
    usable.push({ slice: input.regular, weight: weights.regular });
  }
  if (input.playoffs && input.playoffs.gamesPlayed > 0 && weights.playoffs > 0) {
    usable.push({ slice: input.playoffs, weight: weights.playoffs });
  }
  if (input.finals && input.finals.gamesPlayed > 0 && weights.finals > 0) {
    usable.push({ slice: input.finals, weight: weights.finals });
  }

  if (usable.length === 0) {
    return zeroStats();
  }

  // Normalize so weights sum to exactly 1.0
  const totalWeight = usable.reduce((sum, s) => sum + s.weight, 0);
  if (totalWeight <= 0) {
    return zeroStats();
  }

  const out: RawStatsBlock = zeroStats();
  for (const { slice, weight } of usable) {
    const w = weight / totalWeight;
    out.points += slice.stats.points * w;
    out.rebounds += slice.stats.rebounds * w;
    out.assists += slice.stats.assists * w;
    out.steals += slice.stats.steals * w;
    out.blocks += slice.stats.blocks * w;
    out.threes += slice.stats.threes * w;
    out.turnovers += slice.stats.turnovers * w;
  }
  return out;
}

/**
 * Decide which SeasonType label to attach to the blended result.
 *
 * Rules:
 *   - Any Finals data present → 'finals'
 *   - Else any playoffs data present → 'playoffs'
 *   - Else → 'regular'
 *
 * This is per-player, not slate-wide. A player on a Finals team would
 * be 'finals'; a teammate of someone whose team lost in Round 2 would
 * be 'playoffs'; a player on a non-playoff team would be 'regular'.
 */
export function determineSeasonType(input: BlendInput): SeasonType {
  if (input.finals && input.finals.gamesPlayed > 0) return 'finals';
  if (input.playoffs && input.playoffs.gamesPlayed > 0) return 'playoffs';
  return 'regular';
}

/**
 * Promote a per-player SeasonType up to the slate level.
 *
 * The slate is "in Finals" if ANY player has Finals data, "in playoffs"
 * if any player has playoffs data, and "regular" otherwise. This is the
 * label the AI prompt's postseason rules key off of.
 */
export function determineSlateSeasonType(playerTypes: SeasonType[]): SeasonType {
  let hasPlayoffs = false;
  for (const t of playerTypes) {
    if (t === 'finals') return 'finals';
    if (t === 'playoffs') hasPlayoffs = true;
  }
  return hasPlayoffs ? 'playoffs' : 'regular';
}

// ---------- internal helpers ----------

function zeroStats(): RawStatsBlock {
  return {
    points: 0,
    rebounds: 0,
    assists: 0,
    steals: 0,
    blocks: 0,
    threes: 0,
    turnovers: 0,
  };
}
