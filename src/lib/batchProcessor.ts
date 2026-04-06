import type { PlayerProp } from './oddsApi';
import type { PlayerSeasonAvg } from './playerStats';
import type { CalculationResult, PlayerFormData } from '../components/types';
import { calculate } from '../components/Calculator';

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
  result: CalculationResult | null;
  status: BatchStatus;
  statusMessage?: string;
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
      // DraftKings standard NBA scoring
      const to = stats.turnovers ?? 0;
      return (stats.points * 1) + (stats.rebounds * 1.25) + (stats.assists * 1.5)
           + (stats.steals * 2) + (stats.blocks * 2) + (stats.threes * 0.5) - (to * 0.5);
    }
    default: return 0;
  }
}

/**
 * Compute summary counts from results.
 */
export function computeSummary(players: BatchPlayerResult[]): BatchResult['summary'] {
  const summary = { high: 0, medium: 0, low: 0, reject: 0, errors: 0 };
  for (const p of players) {
    if (p.status !== 'success' || !p.result) {
      summary.errors++;
    } else {
      switch (p.result.tier) {
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
 * Sort results: HIGH first, then by EV descending.
 */
const TIER_RANK: Record<string, number> = { HIGH: 0, MEDIUM: 1, LOW: 2, REJECT: 3 };

export function sortResults(players: BatchPlayerResult[]): BatchPlayerResult[] {
  return [...players].sort((a, b) => {
    // Errors go to the bottom
    if (a.status !== 'success' && b.status === 'success') return 1;
    if (a.status === 'success' && b.status !== 'success') return -1;
    if (!a.result || !b.result) return 0;

    const tierDiff = (TIER_RANK[a.result.tier] ?? 4) - (TIER_RANK[b.result.tier] ?? 4);
    if (tierDiff !== 0) return tierDiff;

    return b.result.ev - a.result.ev;
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
          result: null,
          status: 'api_error',
          statusMessage: `No ${prop.statType} average found`,
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

      const result = calculate(formData);

      results.push({
        playerName: prop.playerName,
        position: playerStats.position,
        statType: prop.statType,
        line: prop.line,
        mean,
        overOdds: prop.overOdds,
        underOdds: prop.underOdds,
        result,
        status: 'success',
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
        result: null,
        status: message.includes('not found') ? 'player_not_found' : 'api_error',
        statusMessage: message,
      });
    }
  }

  const sorted = sortResults(results);
  return { players: sorted, summary: computeSummary(sorted) };
}
