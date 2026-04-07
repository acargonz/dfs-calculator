import { NextRequest, NextResponse } from 'next/server';
import { mapPosition } from '@/lib/playerStats';
import {
  blendStats,
  computeBlendWeights,
  determineSeasonType,
  type PlayerSeasonSlice,
  type RawStatsBlock,
} from '@/lib/playerStatsBlend';

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

/**
 * The NBA Finals start date for the current season, in YYYY-MM-DD format.
 *
 * Configurable via env var `NBA_FINALS_START_DATE`. If unset, defaults to
 * June 4 of the season's calendar end-year (a reasonable historical median —
 * Finals typically start the first week of June).
 *
 * Why we need this: PBP Stats / NBA Stats has no `SeasonType=Finals` value.
 * Finals games are bundled into `SeasonType=Playoffs`. To split them out, we
 * fetch the playoffs endpoint twice with `DateTo` / `DateFrom` filters
 * relative to this date.
 */
function getFinalsStartDate(): string {
  if (process.env.NBA_FINALS_START_DATE) {
    return process.env.NBA_FINALS_START_DATE;
  }
  const now = new Date();
  const month = now.getMonth();
  const seasonEndYear = month >= 9 ? now.getFullYear() + 1 : now.getFullYear();
  return `${seasonEndYear}-06-04`;
}

/** YYYY-MM-DD → YYYY-MM-DD of the previous calendar day (UTC). */
function previousDay(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().split('T')[0];
}

function getRegularSeasonUrl(season: string): string {
  return `https://api.pbpstats.com/get-totals/nba?Season=${season}&SeasonType=Regular+Season&Type=Player`;
}

function getPlayoffsExFinalsUrl(season: string, finalsStart: string): string {
  const dateTo = previousDay(finalsStart);
  return `https://api.pbpstats.com/get-totals/nba?Season=${season}&SeasonType=Playoffs&Type=Player&DateTo=${dateTo}`;
}

function getFinalsUrl(season: string, finalsStart: string): string {
  return `https://api.pbpstats.com/get-totals/nba?Season=${season}&SeasonType=Playoffs&Type=Player&DateFrom=${finalsStart}`;
}

const BDL_BASE = 'https://api.balldontlie.io/v1';

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

// In-memory cache for the three datasets (refreshes per server restart).
// Cache key is implicit — there's only ever one entry, since the URLs are
// derived from getCurrentSeason() + getFinalsStartDate() which are stable
// for the entire server lifetime.
interface PbpCache {
  regular: PbpPlayer[] | null;
  playoffs: PbpPlayer[] | null; // playoffs EXCLUDING Finals
  finals: PbpPlayer[] | null;
  fetchedAt: number;
}

let pbpCache: PbpCache = {
  regular: null,
  playoffs: null,
  finals: null,
  fetchedAt: 0,
};

const CACHE_TTL = 1000 * 60 * 30; // 30 minutes

/**
 * Fetch a single PBP Stats URL. Returns the player rows array. On HTTP
 * error, throws so the caller can decide whether to tolerate the failure.
 */
async function fetchPbpUrl(url: string): Promise<PbpPlayer[]> {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'DFS-Calculator/1.0' },
  });
  if (!res.ok) {
    throw new Error(`PBP Stats API error (${res.status})`);
  }
  const data = await res.json();
  return (data.multi_row_table_data ?? []) as PbpPlayer[];
}

/**
 * Fetch all three datasets in parallel. Regular season is mandatory —
 * if it fails, we throw. The two postseason fetches are tolerated:
 *   - During the regular season, the playoff URLs return empty arrays.
 *   - If PBP Stats rejects the date filter (unsupported on their endpoint),
 *     we silently fall back to empty postseason data and the player's
 *     blend will be regular-season-only.
 *
 * Cached for 30 minutes per server start.
 */
async function getPbpData(): Promise<PbpCache> {
  if (
    pbpCache.regular &&
    pbpCache.playoffs &&
    pbpCache.finals &&
    Date.now() - pbpCache.fetchedAt < CACHE_TTL
  ) {
    return pbpCache;
  }

  const season = getCurrentSeason();
  const finalsStart = getFinalsStartDate();

  const [regularRes, playoffsRes, finalsRes] = await Promise.allSettled([
    fetchPbpUrl(getRegularSeasonUrl(season)),
    fetchPbpUrl(getPlayoffsExFinalsUrl(season, finalsStart)),
    fetchPbpUrl(getFinalsUrl(season, finalsStart)),
  ]);

  if (regularRes.status === 'rejected') {
    // Regular season is the must-have. Propagate the failure.
    const reason =
      regularRes.reason instanceof Error
        ? regularRes.reason.message
        : 'Unknown error';
    throw new Error(`Regular season fetch failed: ${reason}`);
  }

  pbpCache = {
    regular: regularRes.value,
    playoffs: playoffsRes.status === 'fulfilled' ? playoffsRes.value : [],
    finals: finalsRes.status === 'fulfilled' ? finalsRes.value : [],
    fetchedAt: Date.now(),
  };

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
 * Find a player in a PBP Stats dataset by fuzzy name match.
 * Used ONLY against the regular-season dataset (the user's input arrives
 * here first). Once we have the canonical name, we use exact match against
 * the playoffs / finals datasets via findExactByCanonicalName.
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
    (p) =>
      normalize(p.Name).includes(normalized) ||
      normalized.includes(normalize(p.Name)),
  );
  if (partial) return partial;

  return null;
}

/**
 * Exact-match a canonical name (already known to be a real player from
 * the regular-season dataset) against a postseason dataset. We trust
 * NBA Stats to use the same name across SeasonTypes, so no fuzzy logic
 * is needed here.
 */
function findExactByCanonicalName(
  players: PbpPlayer[] | null,
  canonicalName: string,
): PbpPlayer | null {
  if (!players) return null;
  return players.find((p) => p.Name === canonicalName) ?? null;
}

/**
 * Convert a raw PBP totals row into a per-game PlayerSeasonSlice for the
 * blend layer. Returns undefined when the player has zero games (so they
 * don't contribute to the blend).
 */
function toSlice(player: PbpPlayer | null): PlayerSeasonSlice | undefined {
  if (!player || player.GamesPlayed <= 0) return undefined;
  const gp = player.GamesPlayed;
  return {
    gamesPlayed: gp,
    stats: {
      points: player.Points / gp,
      rebounds: player.Rebounds / gp,
      assists: player.Assists / gp,
      steals: player.Steals / gp,
      blocks: player.Blocks / gp,
      threes: player.FG3M / gp,
      turnovers: player.Turnovers / gp,
    },
  };
}

/**
 * Look up player position from balldontlie (free tier supports player search).
 * Falls back to 'SF' if lookup fails.
 */
async function lookupPosition(playerName: string): Promise<string> {
  try {
    const bdlKey = process.env.BALLDONTLIE_API_KEY;
    if (!bdlKey) return 'SF';

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

/** Round a float to one decimal place for display. */
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Format a RawStatsBlock with one-decimal rounding for the response. */
function roundStats(stats: RawStatsBlock): RawStatsBlock {
  return {
    points: round1(stats.points),
    rebounds: round1(stats.rebounds),
    assists: round1(stats.assists),
    steals: round1(stats.steals),
    blocks: round1(stats.blocks),
    threes: round1(stats.threes),
    turnovers: round1(stats.turnovers),
  };
}

export async function GET(request: NextRequest) {
  const name = request.nextUrl.searchParams.get('name');
  if (!name) {
    return NextResponse.json(
      { error: 'name query parameter is required' },
      { status: 400 },
    );
  }

  try {
    // Step 1: Get all three datasets (cached after first call)
    const cache = await getPbpData();

    // Step 2: Find the player in regular season — must succeed
    const regularPlayer = findPlayer(cache.regular!, name);
    if (!regularPlayer) {
      return NextResponse.json(
        { error: `Player not found: ${name}` },
        { status: 404 },
      );
    }
    if (regularPlayer.GamesPlayed <= 0) {
      return NextResponse.json(
        { error: `No regular season games for ${regularPlayer.Name}` },
        { status: 404 },
      );
    }

    // Step 3: Look up the same player in playoffs + finals datasets
    // by exact canonical name (NBA Stats uses consistent naming).
    const canonicalName = regularPlayer.Name;
    const playoffsPlayer = findExactByCanonicalName(cache.playoffs, canonicalName);
    const finalsPlayer = findExactByCanonicalName(cache.finals, canonicalName);

    // Step 4: Convert to per-game slices for the blender
    const regularSlice = toSlice(regularPlayer)!; // safe — verified GP > 0 above
    const playoffsSlice = toSlice(playoffsPlayer);
    const finalsSlice = toSlice(finalsPlayer);

    // Step 5: Compute blend weights from games played
    const playoffsGames = playoffsSlice?.gamesPlayed ?? 0;
    const finalsGames = finalsSlice?.gamesPlayed ?? 0;
    const weights = computeBlendWeights(playoffsGames, finalsGames);

    // Step 6: Run the blend
    const blendedRaw = blendStats(
      { regular: regularSlice, playoffs: playoffsSlice, finals: finalsSlice },
      weights,
    );
    const stats = roundStats(blendedRaw);

    // Step 7: Determine the per-player season type label
    const seasonType = determineSeasonType({
      regular: regularSlice,
      playoffs: playoffsSlice,
      finals: finalsSlice,
    });

    // Step 8: Look up position (best-effort from balldontlie free tier)
    const position = await lookupPosition(canonicalName);

    return NextResponse.json({
      playerName: canonicalName,
      position,
      team: regularPlayer.TeamAbbreviation,
      stats,
      seasonType,
      blendWeights: weights,
      gamesPlayed: {
        regular: regularPlayer.GamesPlayed,
        playoffs: playoffsGames,
        finals: finalsGames,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
