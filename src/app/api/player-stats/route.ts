import { NextRequest, NextResponse } from 'next/server';
import { mapPosition } from '@/lib/playerStats';

const BDL_BASE = 'https://api.balldontlie.io/v1';

function getApiKey(): string {
  const key = process.env.BALLDONTLIE_API_KEY;
  if (!key) throw new Error('BALLDONTLIE_API_KEY not configured in .env.local');
  return key;
}

export async function GET(request: NextRequest) {
  const name = request.nextUrl.searchParams.get('name');
  if (!name) {
    return NextResponse.json({ error: 'name query parameter is required' }, { status: 400 });
  }

  try {
    const apiKey = getApiKey();
    const headers = { Authorization: apiKey };

    // Step 1: Search for player by name
    const searchRes = await fetch(
      `${BDL_BASE}/players?search=${encodeURIComponent(name)}&per_page=5`,
      { headers }
    );

    if (searchRes.status === 429) {
      return NextResponse.json({ error: 'Rate limited by stats API. Try again in a moment.' }, { status: 429 });
    }
    if (!searchRes.ok) {
      throw new Error(`Player search failed: ${searchRes.status}`);
    }

    const searchData = await searchRes.json();
    const players = searchData.data;

    if (!players || players.length === 0) {
      return NextResponse.json({ error: `Player not found: ${name}` }, { status: 404 });
    }

    // Take the best match (first result)
    const player = players[0];
    const playerId = player.id;
    const position = mapPosition(player.position || 'F');
    const team = player.team?.full_name || player.team?.name || 'Unknown';

    // Step 2: Get season averages
    const seasonRes = await fetch(
      `${BDL_BASE}/season_averages?season=2025&player_ids[]=${playerId}`,
      { headers }
    );

    if (seasonRes.status === 429) {
      return NextResponse.json({ error: 'Rate limited by stats API. Try again in a moment.' }, { status: 429 });
    }
    if (!seasonRes.ok) {
      throw new Error(`Season averages fetch failed: ${seasonRes.status}`);
    }

    const seasonData = await seasonRes.json();
    const averages = seasonData.data;

    if (!averages || averages.length === 0) {
      // Player exists but no season data — try previous season
      const prevRes = await fetch(
        `${BDL_BASE}/season_averages?season=2024&player_ids[]=${playerId}`,
        { headers }
      );
      const prevData = await prevRes.json();
      const prevAvg = prevData.data?.[0];

      if (!prevAvg) {
        return NextResponse.json({
          error: `No season data found for ${player.first_name} ${player.last_name}`,
        }, { status: 404 });
      }

      return NextResponse.json({
        playerName: `${player.first_name} ${player.last_name}`,
        position,
        team,
        stats: {
          points: prevAvg.pts ?? 0,
          rebounds: prevAvg.reb ?? 0,
          assists: prevAvg.ast ?? 0,
          steals: prevAvg.stl ?? 0,
          blocks: prevAvg.blk ?? 0,
          threes: prevAvg.fg3m ?? 0,
        },
      });
    }

    const avg = averages[0];
    return NextResponse.json({
      playerName: `${player.first_name} ${player.last_name}`,
      position,
      team,
      stats: {
        points: avg.pts ?? 0,
        rebounds: avg.reb ?? 0,
        assists: avg.ast ?? 0,
        steals: avg.stl ?? 0,
        blocks: avg.blk ?? 0,
        threes: avg.fg3m ?? 0,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
