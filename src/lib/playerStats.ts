import type { Position } from '../components/types';

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

export function clearCache(): void {
  cache.clear();
}

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
