// Types for The Odds API data

export interface NBAGame {
  id: string;
  homeTeam: string;
  awayTeam: string;
  startTime: string; // ISO date string
}

export interface PlayerProp {
  playerName: string;
  statType: 'points' | 'rebounds' | 'assists' | 'steals' | 'blocks' | 'threes';
  line: number;
  overOdds: number;  // American odds
  underOdds: number; // American odds
  bookmaker: string;
}

// Market key → our stat type mapping
const MARKET_MAP: Record<string, PlayerProp['statType']> = {
  player_points: 'points',
  player_rebounds: 'rebounds',
  player_assists: 'assists',
  player_threes: 'threes',
  player_steals: 'steals',
  player_blocks: 'blocks',
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

        props.push({
          playerName,
          statType,
          line,
          overOdds: pair.over.price,
          underOdds: pair.under.price,
          bookmaker: bookmaker.key,
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
