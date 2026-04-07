import type { Position } from '../components/types';
import type { SeasonType, BlendWeights } from './playerStatsBlend';

// Re-export for downstream consumers (batchProcessor, aiAnalysis) so they
// don't have to know about the playerStatsBlend module directly.
export type { SeasonType, BlendWeights } from './playerStatsBlend';

export interface PlayerSeasonAvg {
  playerName: string;
  position: Position;
  team: string;
  stats: {
    points: number;
    rebounds: number;
    assists: number;
    steals: number;
    blocks: number;
    threes: number;
    turnovers: number;
  };

  /**
   * Which season(s) the stats above represent. Optional for backward
   * compatibility with existing test fixtures and any pre-postseason
   * cached responses. When unset, downstream code should treat the
   * player as 'regular' season.
   *
   * - 'regular':  pre-playoffs / off-season / player on a non-playoff team
   * - 'playoffs': blend of regular season + playoffs (rounds 1-3, NOT Finals)
   * - 'finals':   blend that also includes NBA Finals games
   */
  seasonType?: SeasonType;

  /**
   * The actual blend weights used to produce the stats block above.
   * Sums to ~1.0. Useful for UI badges ("Blended: 35% playoffs / 25% finals")
   * and for the AI prompt's audit trail.
   */
  blendWeights?: BlendWeights;

  /**
   * Game counts that fed each slice. Lets the AI / UI distinguish a
   * Round-1 player (small playoff sample) from a Finals participant
   * (deeper postseason sample).
   */
  gamesPlayed?: {
    regular: number;
    playoffs: number; // playoffs EXCLUDING Finals
    finals: number;
  };
}

/**
 * Map balldontlie position codes to our Position type.
 * BDL uses: G, F, C, G-F, F-G, F-C, C-F
 */
export function mapPosition(bdlPosition: string): Position {
  const pos = bdlPosition.toUpperCase().trim();
  if (pos === 'G' || pos === 'PG') return 'PG';
  if (pos === 'SG' || pos === 'G-F' || pos === 'F-G') return 'SG';
  if (pos === 'SF') return 'SF';
  if (pos === 'F' || pos === 'PF') return 'PF';
  if (pos === 'C' || pos === 'F-C' || pos === 'C-F') return 'C';
  return 'SF'; // fallback
}

// In-memory cache to avoid re-fetching the same player
const cache = new Map<string, PlayerSeasonAvg>();

export async function fetchPlayerStats(name: string): Promise<PlayerSeasonAvg> {
  const cacheKey = name.toLowerCase().trim();
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const res = await fetch(`/api/player-stats?name=${encodeURIComponent(name)}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Failed to fetch stats for ${name}: ${res.status}`);
  }

  const data: PlayerSeasonAvg = await res.json();
  cache.set(cacheKey, data);
  return data;
}
