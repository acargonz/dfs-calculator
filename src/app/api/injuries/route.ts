import { NextResponse } from 'next/server';

/**
 * Free ESPN NBA Injuries API.
 * No auth, no rate limit documented, returns structured JSON.
 *
 * Response shape (trimmed):
 * {
 *   injuries: [
 *     {
 *       displayName: "Atlanta Hawks",
 *       injuries: [
 *         {
 *           athlete: { displayName: "Jock Landale", position: { abbreviation: "C" } },
 *           status: "Out" | "Day-To-Day" | "Questionable" | ...
 *           shortComment: "ankle injury...",
 *           longComment: "detailed update...",
 *           date: "2026-04-06T..."
 *         }
 *       ]
 *     }
 *   ]
 * }
 */

const ESPN_INJURIES_URL =
  'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/injuries';

export interface InjuryEntry {
  playerName: string;
  team: string;
  position: string;
  status: string;
  comment: string;
  date: string;
}

interface EspnAthlete {
  displayName?: string;
  position?: { abbreviation?: string };
}

interface EspnInjuryItem {
  athlete?: EspnAthlete;
  status?: string;
  shortComment?: string;
  longComment?: string;
  date?: string;
}

interface EspnTeamInjuries {
  displayName?: string;
  name?: string;
  injuries?: EspnInjuryItem[];
}

interface EspnInjuriesResponse {
  injuries?: EspnTeamInjuries[];
}

// Simple in-memory cache, refreshed every 10 minutes
let cached: { data: InjuryEntry[]; expiresAt: number } | null = null;
const CACHE_TTL_MS = 10 * 60 * 1000;

export async function GET() {
  try {
    const now = Date.now();
    if (cached && cached.expiresAt > now) {
      return NextResponse.json({ injuries: cached.data, cached: true });
    }

    const res = await fetch(ESPN_INJURIES_URL, {
      headers: { 'User-Agent': 'dfs-calculator/1.0' },
    });

    if (!res.ok) {
      throw new Error(`ESPN injuries API returned ${res.status}`);
    }

    const raw: EspnInjuriesResponse = await res.json();
    const entries: InjuryEntry[] = [];

    for (const team of raw.injuries || []) {
      const teamName = team.displayName || team.name || '';
      for (const inj of team.injuries || []) {
        const name = inj.athlete?.displayName;
        if (!name) continue;
        entries.push({
          playerName: name,
          team: teamName,
          position: inj.athlete?.position?.abbreviation || '',
          status: inj.status || 'Unknown',
          comment: inj.shortComment || inj.longComment || '',
          date: inj.date || '',
        });
      }
    }

    cached = { data: entries, expiresAt: now + CACHE_TTL_MS };
    return NextResponse.json({ injuries: entries, cached: false });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
