import {
  buildEventsUrl,
  crossReferenceOdds,
  formatOddsApiTime,
  normalizeName,
  ODDS_API_BASE,
  transformGames,
  transformProps,
  type OddsApiEvent,
  type OddsApiEventOdds,
  type PlayerProp,
} from '../src/lib/oddsApi';

describe('transformGames', () => {
  it('transforms raw events into NBAGame[]', () => {
    const raw: OddsApiEvent[] = [
      {
        id: 'abc123',
        sport_key: 'basketball_nba',
        commence_time: '2026-04-05T23:00:00Z',
        home_team: 'Los Angeles Lakers',
        away_team: 'Dallas Mavericks',
      },
    ];
    const games = transformGames(raw);
    expect(games).toHaveLength(1);
    expect(games[0]).toEqual({
      id: 'abc123',
      homeTeam: 'Los Angeles Lakers',
      awayTeam: 'Dallas Mavericks',
      startTime: '2026-04-05T23:00:00Z',
    });
  });

  it('returns empty array for empty input', () => {
    expect(transformGames([])).toEqual([]);
  });

  it('handles multiple games', () => {
    const raw: OddsApiEvent[] = [
      { id: '1', sport_key: 'basketball_nba', commence_time: '2026-04-05T20:00:00Z', home_team: 'BOS', away_team: 'TOR' },
      { id: '2', sport_key: 'basketball_nba', commence_time: '2026-04-05T22:00:00Z', home_team: 'LAL', away_team: 'DAL' },
      { id: '3', sport_key: 'basketball_nba', commence_time: '2026-04-05T23:30:00Z', home_team: 'GSW', away_team: 'PHX' },
    ];
    const games = transformGames(raw);
    expect(games).toHaveLength(3);
    expect(games[0].id).toBe('1');
    expect(games[2].homeTeam).toBe('GSW');
  });
});

describe('transformProps', () => {
  const makeEvent = (bookmakers: OddsApiEventOdds['bookmakers']): OddsApiEventOdds => ({
    id: 'event1',
    bookmakers,
  });

  it('extracts player props from bookmaker data', () => {
    const event = makeEvent([
      {
        key: 'fanduel',
        markets: [
          {
            key: 'player_points',
            outcomes: [
              { name: 'Over', description: 'LeBron James', price: -130, point: 26.5 },
              { name: 'Under', description: 'LeBron James', price: 110, point: 26.5 },
            ],
          },
        ],
      },
    ]);

    const props = transformProps(event);
    expect(props).toHaveLength(1);
    expect(props[0]).toEqual({
      playerName: 'LeBron James',
      statType: 'points',
      line: 26.5,
      overOdds: -130,
      underOdds: 110,
      bookmaker: 'fanduel',
    });
  });

  it('maps all supported market keys to stat types', () => {
    const event = makeEvent([
      {
        key: 'draftkings',
        markets: [
          {
            key: 'player_rebounds',
            outcomes: [
              { name: 'Over', description: 'Giannis', price: -110, point: 10.5 },
              { name: 'Under', description: 'Giannis', price: -110, point: 10.5 },
            ],
          },
          {
            key: 'player_assists',
            outcomes: [
              { name: 'Over', description: 'Trae Young', price: +120, point: 9.5 },
              { name: 'Under', description: 'Trae Young', price: -140, point: 9.5 },
            ],
          },
          {
            key: 'player_threes',
            outcomes: [
              { name: 'Over', description: 'Steph Curry', price: -115, point: 4.5 },
              { name: 'Under', description: 'Steph Curry', price: -105, point: 4.5 },
            ],
          },
        ],
      },
    ]);

    const props = transformProps(event);
    expect(props).toHaveLength(3);
    expect(props.find(p => p.playerName === 'Giannis')?.statType).toBe('rebounds');
    expect(props.find(p => p.playerName === 'Trae Young')?.statType).toBe('assists');
    expect(props.find(p => p.playerName === 'Steph Curry')?.statType).toBe('threes');
  });

  it('returns empty array when no bookmakers', () => {
    expect(transformProps({ id: 'x', bookmakers: [] })).toEqual([]);
  });

  it('maps combo market keys to stat types', () => {
    const event = makeEvent([
      {
        key: 'fanduel',
        markets: [
          {
            key: 'player_points_rebounds_assists',
            outcomes: [
              { name: 'Over', description: 'Giannis', price: -115, point: 48.5 },
              { name: 'Under', description: 'Giannis', price: -105, point: 48.5 },
            ],
          },
          {
            key: 'player_points_rebounds',
            outcomes: [
              { name: 'Over', description: 'LeBron', price: -110, point: 28.5 },
              { name: 'Under', description: 'LeBron', price: -110, point: 28.5 },
            ],
          },
          {
            key: 'player_points_assists',
            outcomes: [
              { name: 'Over', description: 'Trae Young', price: +120, point: 35.5 },
              { name: 'Under', description: 'Trae Young', price: -140, point: 35.5 },
            ],
          },
          {
            key: 'player_rebounds_assists',
            outcomes: [
              { name: 'Over', description: 'Jokic', price: -105, point: 22.5 },
              { name: 'Under', description: 'Jokic', price: -115, point: 22.5 },
            ],
          },
        ],
      },
    ]);

    const props = transformProps(event);
    expect(props).toHaveLength(4);
    expect(props.find(p => p.playerName === 'Giannis')?.statType).toBe('pra');
    expect(props.find(p => p.playerName === 'LeBron')?.statType).toBe('pts+rebs');
    expect(props.find(p => p.playerName === 'Trae Young')?.statType).toBe('pts+asts');
    expect(props.find(p => p.playerName === 'Jokic')?.statType).toBe('rebs+asts');
  });

  it('skips unknown market keys', () => {
    const event = makeEvent([
      {
        key: 'fanduel',
        markets: [
          {
            key: 'player_turnovers',
            outcomes: [
              { name: 'Over', description: 'Luka', price: -110, point: 4.5 },
              { name: 'Under', description: 'Luka', price: -110, point: 4.5 },
            ],
          },
        ],
      },
    ]);
    expect(transformProps(event)).toEqual([]);
  });

  it('skips outcomes missing a paired over/under', () => {
    const event = makeEvent([
      {
        key: 'bet365',
        markets: [
          {
            key: 'player_points',
            outcomes: [
              { name: 'Over', description: 'Solo Over', price: -110, point: 20.5 },
              // no matching Under
            ],
          },
        ],
      },
    ]);
    expect(transformProps(event)).toEqual([]);
  });

  it('deduplicates same player+stat across bookmakers', () => {
    const event = makeEvent([
      {
        key: 'fanduel',
        markets: [
          {
            key: 'player_points',
            outcomes: [
              { name: 'Over', description: 'LeBron James', price: -130, point: 26.5 },
              { name: 'Under', description: 'LeBron James', price: 110, point: 26.5 },
            ],
          },
        ],
      },
      {
        key: 'draftkings',
        markets: [
          {
            key: 'player_points',
            outcomes: [
              { name: 'Over', description: 'LeBron James', price: -125, point: 26.5 },
              { name: 'Under', description: 'LeBron James', price: 105, point: 26.5 },
            ],
          },
        ],
      },
    ]);

    const props = transformProps(event);
    // Should only have 1 entry for LeBron points (first bookmaker wins)
    const lebronPoints = props.filter(p => p.playerName === 'LeBron James' && p.statType === 'points');
    expect(lebronPoints).toHaveLength(1);
    expect(lebronPoints[0].bookmaker).toBe('fanduel');
  });

  it('handles multiple players from same market', () => {
    const event = makeEvent([
      {
        key: 'fanduel',
        markets: [
          {
            key: 'player_points',
            outcomes: [
              { name: 'Over', description: 'Player A', price: -110, point: 20.5 },
              { name: 'Under', description: 'Player A', price: -110, point: 20.5 },
              { name: 'Over', description: 'Player B', price: -120, point: 15.5 },
              { name: 'Under', description: 'Player B', price: 100, point: 15.5 },
            ],
          },
        ],
      },
    ]);

    const props = transformProps(event);
    expect(props).toHaveLength(2);
  });
});

describe('normalizeName', () => {
  it('lowercases and trims', () => {
    expect(normalizeName('  LeBron James  ')).toBe('lebron james');
  });

  it('strips Jr./Sr. suffixes', () => {
    expect(normalizeName('Jaren Jackson Jr.')).toBe('jaren jackson');
    expect(normalizeName('Gary Trent Jr')).toBe('gary trent');
  });

  it('strips roman numeral suffixes', () => {
    expect(normalizeName('Robert Williams III')).toBe('robert williams');
    expect(normalizeName('Walker Kessler II')).toBe('walker kessler');
  });

  it('strips diacritics', () => {
    expect(normalizeName('Nikola Jokić')).toBe('nikola jokic');
    expect(normalizeName('Luka Dončić')).toBe('luka doncic');
  });

  it('removes non-alpha characters', () => {
    expect(normalizeName("Shai Gilgeous-Alexander")).toBe('shai gilgeousalexander');
  });
});

describe('crossReferenceOdds', () => {
  const realProps: PlayerProp[] = [
    { playerName: 'LeBron James', statType: 'points', line: 26.5, overOdds: -130, underOdds: 110, bookmaker: 'fanduel' },
    { playerName: 'LeBron James', statType: 'rebounds', line: 7.5, overOdds: -115, underOdds: -105, bookmaker: 'fanduel' },
    { playerName: 'Stephen Curry', statType: 'points', line: 28.5, overOdds: -120, underOdds: 100, bookmaker: 'draftkings' },
    { playerName: 'Stephen Curry', statType: 'threes', line: 4.5, overOdds: -110, underOdds: -110, bookmaker: 'draftkings' },
    { playerName: 'Nikola Jokić', statType: 'assists', line: 9.5, overOdds: +105, underOdds: -125, bookmaker: 'fanduel' },
  ];

  it('matches exact name + stat type', () => {
    const parsed = [{ playerName: 'LeBron James', statType: 'points', line: 25.5 }];
    const results = crossReferenceOdds(parsed, realProps);
    expect(results).toHaveLength(1);
    expect(results[0].matched).toBe(true);
    expect(results[0].prop.overOdds).toBe(-130);
    expect(results[0].prop.underOdds).toBe(110);
    // Uses the DFS line, not the sportsbook line
    expect(results[0].prop.line).toBe(25.5);
  });

  it('matches different stat types for same player independently', () => {
    const parsed = [
      { playerName: 'LeBron James', statType: 'points', line: 26.5 },
      { playerName: 'LeBron James', statType: 'rebounds', line: 8.5 },
    ];
    const results = crossReferenceOdds(parsed, realProps);
    expect(results[0].matched).toBe(true);
    expect(results[0].prop.overOdds).toBe(-130);
    expect(results[1].matched).toBe(true);
    expect(results[1].prop.overOdds).toBe(-115);
  });

  it('matches by last name when unambiguous', () => {
    const parsed = [{ playerName: 'Curry', statType: 'points', line: 27.5 }];
    // Only one "Curry" with points — should fuzzy match
    const results = crossReferenceOdds(parsed, realProps);
    expect(results[0].matched).toBe(true);
    expect(results[0].prop.overOdds).toBe(-120);
  });

  it('falls back to -110/-110 when no match found', () => {
    const parsed = [{ playerName: 'Unknown Player', statType: 'points', line: 20.5 }];
    const results = crossReferenceOdds(parsed, realProps);
    expect(results[0].matched).toBe(false);
    expect(results[0].prop.overOdds).toBe(-110);
    expect(results[0].prop.underOdds).toBe(-110);
    expect(results[0].prop.bookmaker).toBe('no-match');
  });

  it('falls back when stat type does not match', () => {
    const parsed = [{ playerName: 'LeBron James', statType: 'steals', line: 1.5 }];
    const results = crossReferenceOdds(parsed, realProps);
    expect(results[0].matched).toBe(false);
  });

  it('handles diacritics in parsed name vs API name', () => {
    const parsed = [{ playerName: 'Nikola Jokic', statType: 'assists', line: 9.5 }];
    const results = crossReferenceOdds(parsed, realProps);
    expect(results[0].matched).toBe(true);
    expect(results[0].prop.overOdds).toBe(105);
  });

  it('returns empty array for empty input', () => {
    expect(crossReferenceOdds([], realProps)).toEqual([]);
  });

  it('handles multiple parsed players with mixed match results', () => {
    const parsed = [
      { playerName: 'LeBron James', statType: 'points', line: 25.5 },
      { playerName: 'Nobody Real', statType: 'points', line: 15.5 },
      { playerName: 'Stephen Curry', statType: 'threes', line: 4.5 },
    ];
    const results = crossReferenceOdds(parsed, realProps);
    expect(results[0].matched).toBe(true);
    expect(results[1].matched).toBe(false);
    expect(results[2].matched).toBe(true);
  });

  it('matches combo stat type (PRA) against real props', () => {
    const comboProps: PlayerProp[] = [
      { playerName: 'Giannis Antetokounmpo', statType: 'pra', line: 48.5, overOdds: -115, underOdds: -105, bookmaker: 'fanduel' },
    ];
    const parsed = [{ playerName: 'Giannis Antetokounmpo', statType: 'pra', line: 47.5 }];
    const results = crossReferenceOdds(parsed, comboProps);
    expect(results[0].matched).toBe(true);
    expect(results[0].prop.overOdds).toBe(-115);
    expect(results[0].prop.line).toBe(47.5); // keeps DFS line
  });

  it('fantasy stat falls back to -110/-110 (no Odds API market)', () => {
    // Odds API doesn't have fantasy props, so they always fall back
    const parsed = [{ playerName: 'LeBron James', statType: 'fantasy', line: 47.5 }];
    const results = crossReferenceOdds(parsed, realProps);
    expect(results[0].matched).toBe(false);
    expect(results[0].prop.overOdds).toBe(-110);
    expect(results[0].prop.underOdds).toBe(-110);
  });
});

// ============================================================================
// URL builder helpers — these guarantee the games endpoint asks for a wide
// enough date window that we get the full slate, not the narrow default 5.
// ============================================================================

describe('formatOddsApiTime', () => {
  it('strips milliseconds from an ISO string', () => {
    // toISOString() yields YYYY-MM-DDTHH:MM:SS.sssZ. The Odds API requires
    // the truncated form YYYY-MM-DDTHH:MM:SSZ.
    const date = new Date('2026-04-07T18:30:45.123Z');
    expect(formatOddsApiTime(date)).toBe('2026-04-07T18:30:45Z');
  });

  it('handles a date with .000 milliseconds', () => {
    const date = new Date('2026-04-07T18:30:45.000Z');
    expect(formatOddsApiTime(date)).toBe('2026-04-07T18:30:45Z');
  });

  it('produces a string the API regex accepts', () => {
    const formatted = formatOddsApiTime(new Date('2026-04-07T18:30:45.999Z'));
    expect(formatted).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });
});

describe('buildEventsUrl', () => {
  const FIXED_NOW = new Date('2026-04-06T20:00:00.000Z');

  it('hits the basketball_nba events endpoint', () => {
    const url = buildEventsUrl('test-key', FIXED_NOW);
    expect(url.startsWith(`${ODDS_API_BASE}/events?`)).toBe(true);
  });

  it('includes the api key', () => {
    const url = buildEventsUrl('test-key', FIXED_NOW);
    expect(url).toContain('apiKey=test-key');
  });

  it('includes commenceTimeFrom 6 hours before now', () => {
    // 2026-04-06T20:00:00Z minus 6h = 2026-04-06T14:00:00Z
    const url = buildEventsUrl('k', FIXED_NOW);
    const decoded = decodeURIComponent(url);
    expect(decoded).toContain('commenceTimeFrom=2026-04-06T14:00:00Z');
  });

  it('includes commenceTimeTo 60 hours after now', () => {
    // 2026-04-06T20:00:00Z plus 60h = 2026-04-09T08:00:00Z (covers today,
    // tomorrow, and a buffer for late-night Pacific tip-offs).
    const url = buildEventsUrl('k', FIXED_NOW);
    const decoded = decodeURIComponent(url);
    expect(decoded).toContain('commenceTimeTo=2026-04-09T08:00:00Z');
  });

  it('includes dateFormat=iso', () => {
    const url = buildEventsUrl('k', FIXED_NOW);
    expect(url).toContain('dateFormat=iso');
  });

  it('produces millisecond-free timestamps in the URL', () => {
    // The Odds API rejects timestamps with milliseconds (.123Z). Make sure
    // we never accidentally encode them.
    const url = buildEventsUrl('k', new Date('2026-04-06T20:00:00.456Z'));
    expect(url).not.toMatch(/\.\d{3}Z/);
    expect(url).not.toMatch(/%2E\d{3}Z/i); // url-encoded form
  });

  it('window is wide enough to cover at least 36 hours of upcoming games', () => {
    // The user reported 5/10 games — the gap was the missing date range.
    // 60 hours forward should comfortably catch tomorrow's full slate even
    // when the user opens the app at 11pm local.
    const url = buildEventsUrl('k', FIXED_NOW);
    const fromMatch = decodeURIComponent(url).match(/commenceTimeFrom=([^&]+)/);
    const toMatch = decodeURIComponent(url).match(/commenceTimeTo=([^&]+)/);
    expect(fromMatch).not.toBeNull();
    expect(toMatch).not.toBeNull();
    const from = new Date(fromMatch![1]).getTime();
    const to = new Date(toMatch![1]).getTime();
    const hours = (to - from) / (60 * 60 * 1000);
    expect(hours).toBeGreaterThanOrEqual(36);
  });

  it('defaults the now arg to the current Date when omitted', () => {
    const before = Date.now();
    const url = buildEventsUrl('k');
    const after = Date.now();

    const fromMatch = decodeURIComponent(url).match(/commenceTimeFrom=([^&]+)/);
    expect(fromMatch).not.toBeNull();
    const fromMs = new Date(fromMatch![1]).getTime();

    // The "from" should be 6h before some moment in [before, after]
    const sixHoursMs = 6 * 60 * 60 * 1000;
    expect(fromMs).toBeGreaterThanOrEqual(before - sixHoursMs - 1000);
    expect(fromMs).toBeLessThanOrEqual(after - sixHoursMs + 1000);
  });
});
