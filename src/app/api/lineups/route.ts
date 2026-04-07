import { NextRequest, NextResponse } from 'next/server';

/**
 * Lineup / availability data for a given NBA team.
 *
 * Free ESPN APIs do not expose "probable starters" pre-game — that data is
 * paywalled on sites like RotoWire. What we CAN get for free:
 *
 *   1. Full roster with position info (ESPN team roster)
 *   2. Per-player injury status (Active, Out, Day-To-Day, etc.)
 *   3. Actual starters from the MOST RECENT game (ESPN game summary)
 *
 * We combine (1) + (2) to give the AI a reliable "who is available" snapshot.
 * For (3), the AI can request the team's last game summary if it wants
 * last-game starters as a baseline.
 *
 * Usage:
 *   GET /api/lineups?team=lal       → roster + injury status for Lakers
 *   GET /api/lineups?team=all       → all 30 teams (heavy, cached 15 min)
 *
 * Team slug is the ESPN abbreviation (e.g., lal, bos, gsw).
 */

const ESPN_TEAM_ROSTER_URL =
  'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/{team}/roster';

const ESPN_TEAMS_URL =
  'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams';

export interface LineupPlayer {
  playerName: string;
  position: string;
  jersey: string;
  status: 'Active' | 'Out' | 'Day-To-Day' | 'Questionable' | 'Doubtful' | 'Unknown';
  injuryNote: string;
}

export interface TeamLineup {
  team: string;
  teamAbbreviation: string;
  players: LineupPlayer[];
  unavailableCount: number;
}

interface EspnInjury {
  status?: string;
  details?: {
    type?: string;
    detail?: string;
    side?: string;
  };
  shortComment?: string;
  longComment?: string;
}

interface EspnAthlete {
  displayName?: string;
  jersey?: string;
  position?: { abbreviation?: string; displayName?: string };
  injuries?: EspnInjury[];
  status?: { type?: string; name?: string };
}

interface EspnRosterResponse {
  team?: { displayName?: string; abbreviation?: string };
  athletes?: EspnAthlete[];
}

interface EspnTeamsResponse {
  sports?: Array<{
    leagues?: Array<{
      teams?: Array<{
        team?: { abbreviation?: string; displayName?: string };
      }>;
    }>;
  }>;
}

// Cache 15 minutes per team
const cache = new Map<string, { data: TeamLineup; expiresAt: number }>();
const CACHE_TTL_MS = 15 * 60 * 1000;

function normalizeStatus(raw: string): LineupPlayer['status'] {
  const s = raw.toLowerCase().trim();
  if (s === 'active' || s === '' || s === 'healthy') return 'Active';
  if (s === 'out') return 'Out';
  if (s === 'day-to-day' || s === 'daytoday' || s === 'day to day') return 'Day-To-Day';
  if (s === 'questionable') return 'Questionable';
  if (s === 'doubtful') return 'Doubtful';
  return 'Unknown';
}

async function fetchTeamLineup(teamSlug: string): Promise<TeamLineup> {
  const cached = cache.get(teamSlug);
  if (cached && cached.expiresAt > Date.now()) return cached.data;

  const url = ESPN_TEAM_ROSTER_URL.replace('{team}', teamSlug.toLowerCase());
  const res = await fetch(url, { headers: { 'User-Agent': 'dfs-calculator/1.0' } });
  if (!res.ok) throw new Error(`ESPN roster API returned ${res.status} for ${teamSlug}`);

  const raw: EspnRosterResponse = await res.json();
  const athletes = raw.athletes || [];

  const players: LineupPlayer[] = athletes.map((a) => {
    const firstInjury = a.injuries?.[0];
    const statusRaw = firstInjury?.status || a.status?.type || 'Active';
    const injuryNote =
      firstInjury?.shortComment ||
      firstInjury?.longComment ||
      (firstInjury?.details
        ? `${firstInjury.details.side || ''} ${firstInjury.details.detail || firstInjury.details.type || ''}`.trim()
        : '');

    return {
      playerName: a.displayName || '',
      position: a.position?.abbreviation || '',
      jersey: a.jersey || '',
      status: normalizeStatus(statusRaw),
      injuryNote,
    };
  }).filter((p) => p.playerName);

  const unavailableCount = players.filter(
    (p) => p.status === 'Out' || p.status === 'Doubtful',
  ).length;

  const lineup: TeamLineup = {
    team: raw.team?.displayName || teamSlug,
    teamAbbreviation: raw.team?.abbreviation || teamSlug.toUpperCase(),
    players,
    unavailableCount,
  };

  cache.set(teamSlug, { data: lineup, expiresAt: Date.now() + CACHE_TTL_MS });
  return lineup;
}

async function fetchAllTeamAbbreviations(): Promise<string[]> {
  const res = await fetch(ESPN_TEAMS_URL, { headers: { 'User-Agent': 'dfs-calculator/1.0' } });
  if (!res.ok) throw new Error(`ESPN teams list returned ${res.status}`);
  const raw: EspnTeamsResponse = await res.json();
  const teams = raw.sports?.[0]?.leagues?.[0]?.teams || [];
  return teams
    .map((t) => t.team?.abbreviation?.toLowerCase())
    .filter((abbr): abbr is string => !!abbr);
}

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const team = searchParams.get('team');

  try {
    if (!team) {
      return NextResponse.json({ error: 'team parameter is required (e.g., ?team=lal)' }, { status: 400 });
    }

    if (team === 'all') {
      const abbreviations = await fetchAllTeamAbbreviations();
      const lineups = await Promise.all(
        abbreviations.map(async (abbr) => {
          try {
            return await fetchTeamLineup(abbr);
          } catch {
            return null;
          }
        }),
      );
      return NextResponse.json({ lineups: lineups.filter((l) => l !== null) });
    }

    const lineup = await fetchTeamLineup(team);
    return NextResponse.json(lineup);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
