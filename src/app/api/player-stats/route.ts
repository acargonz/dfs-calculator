import { NextRequest, NextResponse } from 'next/server';
import { mapPosition } from '@/lib/playerStats';

/**
 * Compute the current NBA season string (e.g., "2025-26").
 * NBA seasons start in October and end in June.
 *   - Oct–Dec 2025 → "2025-26"
 *   - Jan–Sep 2026 → "2025-26"
 */
function getCurrentSeason(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth(); // 0-indexed: 0=Jan, 9=Oct

  // If Oct-Dec, season starts this year. Otherwise, season started last year.
  const startYear = month >= 9 ? year : year - 1;
  const endYear = startYear + 1;
  return `${startYear}-${String(endYear).slice(-2)}`;
}

function getPbpStatsUrl(): string {
  const season = getCurrentSeason();
  return `https://api.pbpstats.com/get-totals/nba?Season=${season}&SeasonType=Regular+Season&Type=Player`;
}

/**
 * Position mapping from team abbreviation context.
 * PBP Stats doesn't include position directly, so we use balldontlie
 * for position lookup, or default to a reasonable guess.
 * For now, we fetch position from balldontlie's free player search.
 */
const BDL_BASE = 'https://api.balldontlie.io/v1';

// In-memory cache for the full PBP Stats dataset (refreshes per server restart)
let pbpCache: PbpPlayer[] | null = null;
let pbpCacheTime = 0;
const CACHE_TTL = 1000 * 60 * 30; // 30 minutes

interface PbpPlayer {
  Name: string;
  TeamAbbreviation: string;
  GamesPlayed: number;
  Points: number;
  Rebounds: number;
  Assists: number;
  Steals: number;
  Blocks: number;
  FG3M: number;
  Turnovers: number;
}

/**
 * Fetch and cache all NBA player season totals from PBP Stats.
 * Single request gets all ~500 players — no per-player API calls needed.
 */
async function getPbpData(): Promise<PbpPlayer[]> {
  if (pbpCache && Date.now() - pbpCacheTime < CACHE_TTL) {
    return pbpCache;
  }

  const res = await fetch(getPbpStatsUrl(), {
    headers: { 'User-Agent': 'DFS-Calculator/1.0' },
  });

  if (!res.ok) {
    throw new Error(`PBP Stats API error (${res.status})`);
  }

  const data = await res.json();
  pbpCache = data.multi_row_table_data as PbpPlayer[];
  pbpCacheTime = Date.now();
  return pbpCache;
}

/**
 * Normalize a name for comparison: lowercase, strip diacritics, remove suffixes.
 */
function normalize(name: string): string {
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
 * Find a player in the PBP Stats dataset by name.
 * Tries exact match first, then last-name match.
 */
function findPlayer(players: PbpPlayer[], searchName: string): PbpPlayer | null {
  const normalized = normalize(searchName);

  // 1. Exact normalized name match
  const exact = players.find((p) => normalize(p.Name) === normalized);
  if (exact) return exact;

  // 2. Last name match (only if unambiguous)
  const searchLast = normalized.split(' ').pop() || '';
  const lastMatches = players.filter((p) => {
    const pLast = normalize(p.Name).split(' ').pop() || '';
    return pLast === searchLast;
  });
  if (lastMatches.length === 1) return lastMatches[0];

  // 3. Partial match — search name contained in player name or vice versa
  const partial = players.find(
    (p) => normalize(p.Name).includes(normalized) || normalized.includes(normalize(p.Name))
  );
  if (partial) return partial;

  return null;
}

/**
 * Look up player position from balldontlie (free tier supports player search).
 * Falls back to 'SF' if lookup fails.
 */
async function lookupPosition(playerName: string): Promise<string> {
  try {
    const bdlKey = process.env.BALLDONTLIE_API_KEY;
    if (!bdlKey) return 'SF';

    // Split into first and last name for better search
    const parts = playerName.trim().split(/\s+/);
    let url: string;
    if (parts.length >= 2) {
      const firstName = parts[0];
      const lastName = parts.slice(1).join(' ');
      url = `${BDL_BASE}/players?first_name=${encodeURIComponent(firstName)}&last_name=${encodeURIComponent(lastName)}&per_page=1`;
    } else {
      url = `${BDL_BASE}/players?search=${encodeURIComponent(playerName)}&per_page=1`;
    }

    const res = await fetch(url, {
      headers: { Authorization: bdlKey },
    });

    if (!res.ok) return 'SF';

    const data = await res.json();
    if (data.data && data.data.length > 0 && data.data[0].position) {
      return mapPosition(data.data[0].position);
    }
  } catch {
    // Position lookup is best-effort
  }
  return 'SF';
}

export async function GET(request: NextRequest) {
  const name = request.nextUrl.searchParams.get('name');
  if (!name) {
    return NextResponse.json({ error: 'name query parameter is required' }, { status: 400 });
  }

  try {
    // Step 1: Get all player stats (cached — single API call for all players)
    const allPlayers = await getPbpData();

    // Step 2: Find the player
    const player = findPlayer(allPlayers, name);
    if (!player) {
      return NextResponse.json({ error: `Player not found: ${name}` }, { status: 404 });
    }

    if (player.GamesPlayed <= 0) {
      return NextResponse.json({ error: `No games played for ${player.Name}` }, { status: 404 });
    }

    // Step 3: Compute per-game averages from season totals
    const gp = player.GamesPlayed;
    const stats = {
      points: Math.round((player.Points / gp) * 10) / 10,
      rebounds: Math.round((player.Rebounds / gp) * 10) / 10,
      assists: Math.round((player.Assists / gp) * 10) / 10,
      steals: Math.round((player.Steals / gp) * 10) / 10,
      blocks: Math.round((player.Blocks / gp) * 10) / 10,
      threes: Math.round((player.FG3M / gp) * 10) / 10,
      turnovers: Math.round((player.Turnovers / gp) * 10) / 10,
    };

    // Step 4: Look up position (best-effort from balldontlie free tier)
    const position = await lookupPosition(player.Name);

    return NextResponse.json({
      playerName: player.Name,
      position,
      team: player.TeamAbbreviation,
      stats,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
