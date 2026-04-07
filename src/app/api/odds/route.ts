import { NextRequest, NextResponse } from 'next/server';
import {
  buildEventsUrl,
  ODDS_API_BASE,
  transformGames,
  transformProps,
  SUPPORTED_MARKETS,
  type OddsApiEvent,
  type OddsApiEventOdds,
} from '@/lib/oddsApi';

function getApiKey(): string {
  const key = process.env.ODDS_API_KEY;
  if (!key) throw new Error('ODDS_API_KEY not configured in .env.local');
  return key;
}

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const type = searchParams.get('type');

  try {
    if (type === 'games') {
      return await handleGames();
    } else if (type === 'props') {
      const eventId = searchParams.get('eventId');
      if (!eventId) {
        return NextResponse.json({ error: 'eventId is required' }, { status: 400 });
      }
      return await handleProps(eventId);
    } else {
      return NextResponse.json({ error: 'type must be "games" or "props"' }, { status: 400 });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

async function handleGames(): Promise<NextResponse> {
  const apiKey = getApiKey();
  // Explicit date range so we get the full slate (today + tomorrow), not
  // just the narrow default window. See buildEventsUrl docstring for why.
  const url = buildEventsUrl(apiKey);

  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Odds API error (${res.status}): ${text}`);
  }

  const raw: OddsApiEvent[] = await res.json();
  const games = transformGames(raw);
  return NextResponse.json(games);
}

async function handleProps(eventId: string): Promise<NextResponse> {
  const apiKey = getApiKey();
  const url =
    `${ODDS_API_BASE}/events/${eventId}/odds` +
    `?apiKey=${apiKey}` +
    `&regions=us` +
    `&markets=${SUPPORTED_MARKETS}` +
    `&oddsFormat=american`;

  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Odds API error (${res.status}): ${text}`);
  }

  const raw: OddsApiEventOdds = await res.json();
  const props = transformProps(raw);
  return NextResponse.json(props);
}
