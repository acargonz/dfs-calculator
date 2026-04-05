import {
  transformGames,
  transformProps,
  type OddsApiEvent,
  type OddsApiEventOdds,
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
