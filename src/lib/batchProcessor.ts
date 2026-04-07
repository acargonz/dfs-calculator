import type { PlayerProp } from './oddsApi';
import type { PlayerSeasonAvg, SeasonType } from './playerStats';
import type { CalculationResult, PlayerFormData } from '../components/types';
import { calculate } from '../components/Calculator';
import { pickBestSide } from './twoSidedCalc';
import type { Tier } from './math';

/**
 * Postseason Kelly multiplier.
 *
 * NBA playoffs and Finals games carry more variance per pick than the regular
 * season — rotations tighten, defensive scheming intensifies, single-game
 * results are more impactful for the slate. The math layer (math.ts) is
 * deliberately read-only and unaware of season context, so we apply the
 * postseason discipline here at the orchestration boundary by scaling the
 * already-quarter-Kelly stake by 0.75 (effectively 3/16 Kelly for postseason).
 *
 * Applied identically to the over and under sides so the relative comparison
 * the AI sees is unchanged — only the absolute stake shrinks.
 */
export const POSTSEASON_KELLY_MULTIPLIER = 0.75;

/**
 * Returns true when the player's stat blend already includes postseason
 * games — the calculator's Kelly stakes for that row should be reduced.
 */
export function isPostseasonSlice(seasonType: SeasonType | undefined): boolean {
  return seasonType === 'playoffs' || seasonType === 'finals';
}

/**
 * Apply the postseason Kelly multiplier to a CalculationResult, returning a
 * new result with both sides' kellyStake scaled. Pure function — no mutation.
 * The other fields (probabilities, EV, tier) are intentionally untouched
 * because the model itself is unchanged; we only resize the wager.
 */
export function applyPostseasonKellyReduction(
  result: CalculationResult,
  seasonType: SeasonType | undefined,
): CalculationResult {
  if (!isPostseasonSlice(seasonType)) return result;
  return {
    ...result,
    over: {
      ...result.over,
      kellyStake: result.over.kellyStake * POSTSEASON_KELLY_MULTIPLIER,
    },
    under: {
      ...result.under,
      kellyStake: result.under.kellyStake * POSTSEASON_KELLY_MULTIPLIER,
    },
  };
}

export interface BatchInput {
  props: PlayerProp[];
  bankroll: number;
  kellyMode: 'standard' | 'demon';
  paceModifier: number;
  injuryModifier: number;
}

export type BatchStatus = 'success' | 'player_not_found' | 'api_error';

export interface BatchPlayerResult {
  playerName: string;
  position: string;
  statType: string;
  line: number;
  mean: number;
  overOdds: number;
  underOdds: number;
  /** Sportsbook this prop came from (optional for legacy/test fixtures). */
  bookmaker?: string;
  result: CalculationResult | null;
  status: BatchStatus;
  statusMessage?: string;

  /**
   * Which season(s) the player's stats represent. Mirrors the value from
   * PlayerSeasonAvg.seasonType. Optional so legacy fixtures and pre-postseason
   * cached payloads still type-check. When 'playoffs' or 'finals', the Kelly
   * stake on result.over/under has already been multiplied by
   * POSTSEASON_KELLY_MULTIPLIER (0.75).
   */
  seasonType?: SeasonType;
}

export interface BatchResult {
  players: BatchPlayerResult[];
  summary: {
    high: number;
    medium: number;
    low: number;
    reject: number;
    errors: number;
  };
}

/**
 * Pick the correct season average for a given stat type.
 */
export function getStatMean(
  stats: PlayerSeasonAvg['stats'],
  statType: string
): number {
  switch (statType) {
    case 'points': return stats.points;
    case 'rebounds': return stats.rebounds;
    case 'assists': return stats.assists;
    case 'steals': return stats.steals;
    case 'blocks': return stats.blocks;
    case 'threes': return stats.threes;
    case 'pra': return stats.points + stats.rebounds + stats.assists;
    case 'pts+rebs': return stats.points + stats.rebounds;
    case 'pts+asts': return stats.points + stats.assists;
    case 'rebs+asts': return stats.rebounds + stats.assists;
    case 'fantasy': {
      // PrizePicks / Underdog Fantasy NBA scoring — identical formula on
      // both platforms. DraftKings Pick6 does not offer a fantasy-score
      // prop, so there's only one formula we ever need to compute here.
      //   FPTS = PTS*1 + REB*1.2 + AST*1.5 + STL*3 + BLK*3 + TO*(-1)
      // Three-pointers are intentionally NOT re-scored — neither platform
      // grants a bonus for them beyond the points already baked into PTS.
      const to = stats.turnovers ?? 0;
      return (stats.points * 1) + (stats.rebounds * 1.2) + (stats.assists * 1.5)
           + (stats.steals * 3) + (stats.blocks * 3) - (to * 1);
    }
    default: return 0;
  }
}

/**
 * Returns the "stronger" side of a two-sided result, used for summary counts
 * and sorting. The actual betting decision is left to the AI ensemble — this
 * helper only governs how the row appears in the calculator table.
 */
export function bestTier(result: CalculationResult): Tier {
  return result[pickBestSide(result)].tier;
}

export function bestEV(result: CalculationResult): number {
  return result[pickBestSide(result)].ev;
}

/**
 * Compute summary counts from results. The tier shown for a row is the tier
 * of whichever side (over/under) has the stronger edge.
 */
export function computeSummary(players: BatchPlayerResult[]): BatchResult['summary'] {
  const summary = { high: 0, medium: 0, low: 0, reject: 0, errors: 0 };
  for (const p of players) {
    if (p.status !== 'success' || !p.result) {
      summary.errors++;
    } else {
      switch (bestTier(p.result)) {
        case 'HIGH': summary.high++; break;
        case 'MEDIUM': summary.medium++; break;
        case 'LOW': summary.low++; break;
        case 'REJECT': summary.reject++; break;
      }
    }
  }
  return summary;
}

/**
 * Sort results: HIGH first, then by EV descending. Both metrics use the
 * stronger side from the two-sided evaluation.
 */
const TIER_RANK: Record<string, number> = { HIGH: 0, MEDIUM: 1, LOW: 2, REJECT: 3 };

export function sortResults(players: BatchPlayerResult[]): BatchPlayerResult[] {
  return [...players].sort((a, b) => {
    // Errors go to the bottom
    if (a.status !== 'success' && b.status === 'success') return 1;
    if (a.status === 'success' && b.status !== 'success') return -1;
    if (!a.result || !b.result) return 0;

    const tierDiff =
      (TIER_RANK[bestTier(a.result)] ?? 4) - (TIER_RANK[bestTier(b.result)] ?? 4);
    if (tierDiff !== 0) return tierDiff;

    return bestEV(b.result) - bestEV(a.result);
  });
}

/**
 * Process a batch of player props.
 * fetchStatsFn is injected for testability.
 */
export async function processBatch(
  input: BatchInput,
  fetchStatsFn: (name: string) => Promise<PlayerSeasonAvg>,
  onProgress?: (current: number, total: number, playerName: string) => void
): Promise<BatchResult> {
  const results: BatchPlayerResult[] = [];
  const total = input.props.length;

  for (let i = 0; i < total; i++) {
    const prop = input.props[i];
    onProgress?.(i + 1, total, prop.playerName);

    try {
      const playerStats = await fetchStatsFn(prop.playerName);
      const mean = getStatMean(playerStats.stats, prop.statType);

      if (mean <= 0) {
        results.push({
          playerName: prop.playerName,
          position: playerStats.position,
          statType: prop.statType,
          line: prop.line,
          mean: 0,
          overOdds: prop.overOdds,
          underOdds: prop.underOdds,
          bookmaker: prop.bookmaker,
          result: null,
          status: 'api_error',
          statusMessage: `No ${prop.statType} average found`,
          seasonType: playerStats.seasonType,
        });
        continue;
      }

      const formData: PlayerFormData = {
        playerName: prop.playerName,
        position: playerStats.position,
        statType: prop.statType as PlayerFormData['statType'],
        mean,
        line: prop.line,
        overOdds: prop.overOdds,
        underOdds: prop.underOdds,
        bankroll: input.bankroll,
        kellyMode: input.kellyMode,
        paceModifier: input.paceModifier,
        injuryModifier: input.injuryModifier,
      };

      // Run the (regular-season-blind) math, then apply postseason
      // discipline by scaling the Kelly stake. Math layer stays untouched.
      const rawResult = calculate(formData);
      const result = applyPostseasonKellyReduction(rawResult, playerStats.seasonType);

      results.push({
        playerName: prop.playerName,
        position: playerStats.position,
        statType: prop.statType,
        line: prop.line,
        mean,
        overOdds: prop.overOdds,
        underOdds: prop.underOdds,
        bookmaker: prop.bookmaker,
        result,
        status: 'success',
        seasonType: playerStats.seasonType,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      results.push({
        playerName: prop.playerName,
        position: '',
        statType: prop.statType,
        line: prop.line,
        mean: 0,
        overOdds: prop.overOdds,
        underOdds: prop.underOdds,
        bookmaker: prop.bookmaker,
        result: null,
        status: message.includes('not found') ? 'player_not_found' : 'api_error',
        statusMessage: message,
      });
    }
  }

  const sorted = sortResults(results);
  return { players: sorted, summary: computeSummary(sorted) };
}
