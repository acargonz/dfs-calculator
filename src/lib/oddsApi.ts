// Types for The Odds API data

/** Base URL for the basketball_nba sport namespace on The Odds API. */
export const ODDS_API_BASE = 'https://api.the-odds-api.com/v4/sports/basketball_nba';

/**
 * Format a Date for The Odds API's `commenceTimeFrom` / `commenceTimeTo`
 * query params. The API requires ISO 8601 in UTC with NO milliseconds:
 *   YYYY-MM-DDTHH:MM:SSZ
 *
 * `Date.toISOString()` produces `YYYY-MM-DDTHH:MM:SS.sssZ`, so we strip the
 * `.sss` segment.
 */
export function formatOddsApiTime(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Build the `/events` URL for the games endpoint.
 *
 * Without explicit date range params, The Odds API returns only a narrow
 * window of upcoming events (we observed ~5 events back even when 10+ were
 * scheduled the next day). Passing `commenceTimeFrom` / `commenceTimeTo`
 * forces the full slate to come back. The window is:
 *   - from: 6 hours before `now` (so in-progress games are included)
 *   - to:   60 hours after `now` (so today + tomorrow + a buffer fits)
 *
 * `dateFormat=iso` is included so the response uses ISO strings consistently.
 *
 * Exported so it can be unit tested independently of `fetch`.
 */
export function buildEventsUrl(apiKey: string, now: Date = new Date()): string {
  const HOUR_MS = 60 * 60 * 1000;
  const from = new Date(now.getTime() - 6 * HOUR_MS);
  const to = new Date(now.getTime() + 60 * HOUR_MS);
  const params = new URLSearchParams({
    apiKey,
    commenceTimeFrom: formatOddsApiTime(from),
    commenceTimeTo: formatOddsApiTime(to),
    dateFormat: 'iso',
  });
  return `${ODDS_API_BASE}/events?${params.toString()}`;
}

export interface NBAGame {
  id: string;
  homeTeam: string;
  awayTeam: string;
  startTime: string; // ISO date string
}

export interface PlayerProp {
  playerName: string;
  statType: 'points' | 'rebounds' | 'assists' | 'steals' | 'blocks' | 'threes' | 'fantasy' | 'pra' | 'pts+rebs' | 'pts+asts' | 'rebs+asts';
  line: number;
  overOdds: number;  // American odds
  underOdds: number; // American odds
  bookmaker: string;
  /**
   * Home team for the game this prop belongs to. Optional because legacy
   * fixtures and crossReferenceOdds fallbacks don't carry it. When present,
   * batchProcessor uses it (along with the player's team from balldontlie)
   * to derive the home/away column persisted on each pick row — that
   * column unblocks all home-vs-away calibration analysis.
   */
  homeTeam?: string;
  /** Away team for the game this prop belongs to. See homeTeam. */
  awayTeam?: string;
}

// Market key → our stat type mapping
const MARKET_MAP: Record<string, PlayerProp['statType']> = {
  player_points: 'points',
  player_rebounds: 'rebounds',
  player_assists: 'assists',
  player_threes: 'threes',
  player_steals: 'steals',
  player_blocks: 'blocks',
  player_points_rebounds_assists: 'pra',
  player_points_rebounds: 'pts+rebs',
  player_points_assists: 'pts+asts',
  player_rebounds_assists: 'rebs+asts',
};

export const SUPPORTED_MARKETS = Object.keys(MARKET_MAP).join(',');

/**
 * Transform raw Odds API game events into typed NBAGame[].
 */
export function transformGames(rawEvents: OddsApiEvent[]): NBAGame[] {
  return rawEvents.map((event) => ({
    id: event.id,
    homeTeam: event.home_team,
    awayTeam: event.away_team,
    startTime: event.commence_time,
  }));
}

/**
 * Transform raw Odds API event odds into PlayerProp[].
 * Takes the first bookmaker that has each market, extracts over/under pairs.
 */
export function transformProps(rawEvent: OddsApiEventOdds): PlayerProp[] {
  const props: PlayerProp[] = [];

  if (!rawEvent.bookmakers || rawEvent.bookmakers.length === 0) {
    return props;
  }

  // Collect all props across all bookmakers, prefer the first one found per player+stat
  const seen = new Set<string>();

  for (const bookmaker of rawEvent.bookmakers) {
    for (const market of bookmaker.markets) {
      const statType = MARKET_MAP[market.key];
      if (!statType) continue;

      // Group outcomes by player name + point line
      const playerOutcomes = new Map<string, { over?: OddsApiOutcome; under?: OddsApiOutcome }>();

      for (const outcome of market.outcomes) {
        const name = outcome.description || '';
        if (!name) continue;

        const key = `${name}_${outcome.point}`;
        if (!playerOutcomes.has(key)) {
          playerOutcomes.set(key, {});
        }
        const entry = playerOutcomes.get(key)!;

        if (outcome.name === 'Over') {
          entry.over = outcome;
        } else if (outcome.name === 'Under') {
          entry.under = outcome;
        }
      }

      // Build props from paired outcomes
      for (const [, pair] of playerOutcomes) {
        if (!pair.over || !pair.under) continue;

        const playerName = pair.over.description || '';
        const line = pair.over.point ?? 0;
        const uniqueKey = `${playerName}_${statType}_${line}`;

        if (seen.has(uniqueKey)) continue;
        seen.add(uniqueKey);

        // Attach home/away team only when the source event carries them
        // (production always does; some test fixtures don't). Spreading
        // the conditional object keeps the prop shape clean for existing
        // toEqual() assertions in oddsApi.test.ts.
        const teamMeta: { homeTeam?: string; awayTeam?: string } = {};
        if (rawEvent.home_team) teamMeta.homeTeam = rawEvent.home_team;
        if (rawEvent.away_team) teamMeta.awayTeam = rawEvent.away_team;

        props.push({
          playerName,
          statType,
          line,
          overOdds: pair.over.price,
          underOdds: pair.under.price,
          bookmaker: bookmaker.key,
          ...teamMeta,
        });
      }
    }
  }

  return props;
}

// --- Raw Odds API response types ---

export interface OddsApiEvent {
  id: string;
  sport_key: string;
  commence_time: string;
  home_team: string;
  away_team: string;
}

export interface OddsApiOutcome {
  name: string;        // "Over" or "Under"
  description?: string; // Player name
  price: number;       // American odds
  point?: number;      // Line (e.g., 26.5)
}

export interface OddsApiMarket {
  key: string;         // e.g., "player_points"
  outcomes: OddsApiOutcome[];
}

export interface OddsApiBookmaker {
  key: string;
  markets: OddsApiMarket[];
}

export interface OddsApiEventOdds {
  id: string;
  bookmakers: OddsApiBookmaker[];
  /**
   * The Odds API returns these on every event-odds response. They're
   * optional in the type because some legacy test fixtures pre-date the
   * field; runtime production responses always include them.
   */
  home_team?: string;
  away_team?: string;
}

// --- Cross-reference: match pasted players to real sportsbook odds ---

export interface OddsMatch {
  /** The prop with real odds applied (or -110/-110 fallback) */
  prop: PlayerProp;
  /** Whether real sportsbook odds were found */
  matched: boolean;
}

/**
 * Normalize a player name for fuzzy matching.
 * Strips accents, lowercases, removes suffixes like Jr./III/II.
 */
export function normalizeName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip diacritics
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv)\b\.?/g, '')
    .replace(/[^a-z ]/g, '')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Cross-reference parsed DFS players against real sportsbook props.
 *
 * For each parsed player+stat:
 *   1. Look for an exact name+stat match in the sportsbook props
 *   2. If not found, try fuzzy matching (last name + stat type)
 *   3. Use the DFS line (from paste) but the sportsbook odds (from API)
 *   4. Fall back to -110/-110 if no match found
 */
export function crossReferenceOdds(
  parsedPlayers: { playerName: string; statType: string; line: number }[],
  realProps: PlayerProp[]
): OddsMatch[] {
  // Build lookup maps for fast matching
  // Key: "normalizedName_statType" → PlayerProp[]
  const exactMap = new Map<string, PlayerProp[]>();
  // Key: "lastName_statType" → PlayerProp[]
  const lastNameMap = new Map<string, PlayerProp[]>();

  for (const prop of realProps) {
    const normalized = normalizeName(prop.playerName);
    const exactKey = `${normalized}_${prop.statType}`;
    if (!exactMap.has(exactKey)) exactMap.set(exactKey, []);
    exactMap.get(exactKey)!.push(prop);

    const lastName = normalized.split(' ').pop() || normalized;
    const lastKey = `${lastName}_${prop.statType}`;
    if (!lastNameMap.has(lastKey)) lastNameMap.set(lastKey, []);
    lastNameMap.get(lastKey)!.push(prop);
  }

  return parsedPlayers.map((parsed) => {
    const normalizedParsed = normalizeName(parsed.playerName);
    const stat = parsed.statType;

    // 1. Exact name match
    const exactKey = `${normalizedParsed}_${stat}`;
    const exactMatches = exactMap.get(exactKey);
    if (exactMatches && exactMatches.length > 0) {
      // Pick the one with the closest line
      const best = closestByLine(exactMatches, parsed.line);
      return {
        prop: { ...best, line: parsed.line, bookmaker: `${best.bookmaker} (matched)` },
        matched: true,
      };
    }

    // 2. Last-name fuzzy match
    const parsedLast = normalizedParsed.split(' ').pop() || normalizedParsed;
    const lastKey = `${parsedLast}_${stat}`;
    const lastMatches = lastNameMap.get(lastKey);
    if (lastMatches && lastMatches.length === 1) {
      // Only use if unambiguous (one player with that last name + stat)
      const best = lastMatches[0];
      return {
        prop: { ...best, line: parsed.line, bookmaker: `${best.bookmaker} (fuzzy)` },
        matched: true,
      };
    }

    // 3. No match — fall back to -110/-110
    return {
      prop: {
        playerName: parsed.playerName,
        statType: stat as PlayerProp['statType'],
        line: parsed.line,
        overOdds: -110,
        underOdds: -110,
        bookmaker: 'no-match',
      },
      matched: false,
    };
  });
}

/** Pick the prop whose line is closest to the target. */
function closestByLine(props: PlayerProp[], targetLine: number): PlayerProp {
  let best = props[0];
  let bestDiff = Math.abs(props[0].line - targetLine);
  for (let i = 1; i < props.length; i++) {
    const diff = Math.abs(props[i].line - targetLine);
    if (diff < bestDiff) {
      best = props[i];
      bestDiff = diff;
    }
  }
  return best;
}

// --- Client-side fetch helpers ---

export async function fetchGames(): Promise<NBAGame[]> {
  const res = await fetch('/api/odds?type=games');
  if (!res.ok) throw new Error(`Failed to fetch games: ${res.status}`);
  return res.json();
}

export async function fetchProps(eventId: string): Promise<PlayerProp[]> {
  const res = await fetch(`/api/odds?type=props&eventId=${eventId}`);
  if (!res.ok) throw new Error(`Failed to fetch props: ${res.status}`);
  return res.json();
}
