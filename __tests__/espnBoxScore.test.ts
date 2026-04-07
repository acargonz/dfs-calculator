/**
 * Tests for src/lib/espnBoxScore.ts — the adapter that converts ESPN's
 * game-summary JSON into our RawBoxScore shape.
 *
 * Coverage goals:
 *   - splitDisplayName: normal, hyphenated, single-word, empty
 *   - normalizeMinutes: DNP shapes, real minutes, whitespace, null/undefined
 *   - parseThreesMade: "4-10", "0-0", "--", missing
 *   - parseIntStat: numeric, "--", missing, garbage
 *   - parseStatsRow: happy path, schema drift (missing label)
 *   - convertAthlete: happy path, DNP flag override, missing athlete name
 *   - flattenGameSummary: multi-team aggregation, empty boxscore, drift
 */

import {
  splitDisplayName,
  normalizeMinutes,
  parseThreesMade,
  parseIntStat,
  parseStatsRow,
  convertAthlete,
  flattenGameSummary,
  type EspnGameSummary,
} from '../src/lib/espnBoxScore';

// ---------------------------------------------------------------------------
// splitDisplayName
// ---------------------------------------------------------------------------

describe('splitDisplayName', () => {
  it('splits a two-part name', () => {
    expect(splitDisplayName('LeBron James')).toEqual({
      first_name: 'LeBron',
      last_name: 'James',
    });
  });

  it('keeps hyphenated last names intact', () => {
    expect(splitDisplayName('Shai Gilgeous-Alexander')).toEqual({
      first_name: 'Shai',
      last_name: 'Gilgeous-Alexander',
    });
  });

  it('splits on the LAST space for multi-word first names', () => {
    // Unusual but possible: "JJ De Anda" → first="JJ De", last="Anda"
    expect(splitDisplayName('JJ De Anda')).toEqual({
      first_name: 'JJ De',
      last_name: 'Anda',
    });
  });

  it('preserves diacritics (normalization happens in the resolver)', () => {
    expect(splitDisplayName('Luka Dončić')).toEqual({
      first_name: 'Luka',
      last_name: 'Dončić',
    });
  });

  it('falls back to last_name only for single-word names', () => {
    expect(splitDisplayName('Bol')).toEqual({
      first_name: '',
      last_name: 'Bol',
    });
  });

  it('returns empty identity for empty input', () => {
    expect(splitDisplayName('')).toEqual({ first_name: '', last_name: '' });
  });

  it('trims surrounding whitespace', () => {
    expect(splitDisplayName('  LeBron James  ')).toEqual({
      first_name: 'LeBron',
      last_name: 'James',
    });
  });
});

// ---------------------------------------------------------------------------
// normalizeMinutes
// ---------------------------------------------------------------------------

describe('normalizeMinutes', () => {
  it('passes through real minutes as strings', () => {
    expect(normalizeMinutes('37')).toBe('37');
    expect(normalizeMinutes('35:42')).toBe('35:42');
  });

  it('normalizes all DNP shapes to ":00"', () => {
    expect(normalizeMinutes('0')).toBe(':00');
    expect(normalizeMinutes('0:00')).toBe(':00');
    expect(normalizeMinutes(':00')).toBe(':00');
    expect(normalizeMinutes('')).toBe(':00');
  });

  it('returns null for undefined', () => {
    expect(normalizeMinutes(undefined)).toBe(null);
  });

  it('trims whitespace before classifying', () => {
    expect(normalizeMinutes('  37  ')).toBe('37');
    expect(normalizeMinutes('  0  ')).toBe(':00');
  });
});

// ---------------------------------------------------------------------------
// parseThreesMade
// ---------------------------------------------------------------------------

describe('parseThreesMade', () => {
  it('extracts made threes from "M-A" format', () => {
    expect(parseThreesMade('4-10')).toBe(4);
    expect(parseThreesMade('0-0')).toBe(0);
    expect(parseThreesMade('7-7')).toBe(7);
  });

  it('returns 0 for "--" (DNP filler)', () => {
    expect(parseThreesMade('--')).toBe(0);
  });

  it('returns 0 for empty/undefined', () => {
    expect(parseThreesMade('')).toBe(0);
    expect(parseThreesMade(undefined)).toBe(0);
  });

  it('returns 0 for unparseable input', () => {
    expect(parseThreesMade('garbage')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// parseIntStat
// ---------------------------------------------------------------------------

describe('parseIntStat', () => {
  it('parses numeric strings', () => {
    expect(parseIntStat('22')).toBe(22);
    expect(parseIntStat('0')).toBe(0);
    expect(parseIntStat('  5  ')).toBe(5);
  });

  it('returns 0 for "--"', () => {
    expect(parseIntStat('--')).toBe(0);
  });

  it('returns 0 for empty/undefined', () => {
    expect(parseIntStat('')).toBe(0);
    expect(parseIntStat(undefined)).toBe(0);
  });

  it('returns 0 for garbage', () => {
    expect(parseIntStat('NaN')).toBe(0);
    expect(parseIntStat('abc')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// parseStatsRow
// ---------------------------------------------------------------------------

describe('parseStatsRow', () => {
  const CANONICAL_LABELS = [
    'MIN',
    'PTS',
    'FG',
    '3PT',
    'FT',
    'REB',
    'AST',
    'TO',
    'STL',
    'BLK',
    'OREB',
    'DREB',
    'PF',
    '+/-',
  ];

  it('parses a happy-path OG Anunoby row', () => {
    const stats = [
      '37',
      '22',
      '7-14',
      '4-10',
      '4-4',
      '5',
      '1',
      '3',
      '0',
      '2',
      '2',
      '3',
      '1',
      '+10',
    ];
    expect(parseStatsRow(CANONICAL_LABELS, stats)).toEqual({
      min: '37',
      pts: 22,
      reb: 5,
      ast: 1,
      stl: 0,
      blk: 2,
      turnover: 3,
      fg3m: 4,
    });
  });

  it('handles a DNP row with "--" stats', () => {
    const stats = [
      '',
      '--',
      '--',
      '--',
      '--',
      '--',
      '--',
      '--',
      '--',
      '--',
      '--',
      '--',
      '--',
      '--',
    ];
    expect(parseStatsRow(CANONICAL_LABELS, stats)).toEqual({
      min: ':00',
      pts: 0,
      reb: 0,
      ast: 0,
      stl: 0,
      blk: 0,
      turnover: 0,
      fg3m: 0,
    });
  });

  it('returns null when labels are missing a required stat (schema drift)', () => {
    const badLabels = ['MIN', 'PTS', 'FG']; // missing REB, AST, etc.
    const stats = ['37', '22', '7-14'];
    expect(parseStatsRow(badLabels, stats)).toBe(null);
  });

  it('returns null when labels or stats are undefined', () => {
    expect(parseStatsRow(undefined, ['37', '22'])).toBe(null);
    expect(parseStatsRow(['MIN'], undefined)).toBe(null);
  });

  it('is resilient to label reordering (looks up by name)', () => {
    // Swap REB and AST order; real ESPN does not do this, but we shouldn't
    // assume positional indexes.
    const shuffled = [
      'MIN',
      'PTS',
      'FG',
      '3PT',
      'FT',
      'AST', // was REB
      'REB', // was AST
      'TO',
      'STL',
      'BLK',
      'OREB',
      'DREB',
      'PF',
      '+/-',
    ];
    const stats = [
      '37',
      '22',
      '7-14',
      '4-10',
      '4-4',
      '1', // ← at the REB position but labeled AST
      '5', // ← at the AST position but labeled REB
      '3',
      '0',
      '2',
      '2',
      '3',
      '1',
      '+10',
    ];
    // The resolver should read by label, so reb=5 and ast=1 (same as happy path).
    expect(parseStatsRow(shuffled, stats)).toEqual({
      min: '37',
      pts: 22,
      reb: 5,
      ast: 1,
      stl: 0,
      blk: 2,
      turnover: 3,
      fg3m: 4,
    });
  });
});

// ---------------------------------------------------------------------------
// convertAthlete
// ---------------------------------------------------------------------------

describe('convertAthlete', () => {
  const LABELS = [
    'MIN',
    'PTS',
    'FG',
    '3PT',
    'FT',
    'REB',
    'AST',
    'TO',
    'STL',
    'BLK',
    'OREB',
    'DREB',
    'PF',
    '+/-',
  ];

  it('converts a normal athlete row', () => {
    const row = {
      athlete: { displayName: 'LeBron James' },
      stats: [
        '35',
        '30',
        '11-20',
        '3-7',
        '5-6',
        '8',
        '9',
        '4',
        '2',
        '1',
        '1',
        '7',
        '2',
        '+15',
      ],
      didNotPlay: false,
      active: true,
    };
    expect(convertAthlete(row, LABELS)).toEqual({
      player: { first_name: 'LeBron', last_name: 'James' },
      min: '35',
      pts: 30,
      reb: 8,
      ast: 9,
      stl: 2,
      blk: 1,
      turnover: 4,
      fg3m: 3,
    });
  });

  it('forces min=":00" when didNotPlay is true, even if stats are non-empty', () => {
    // Sanity check: some ESPN feeds send real numbers on rows flagged DNP.
    // The flag is authoritative.
    const row = {
      athlete: { displayName: 'Edge Case' },
      stats: [
        '0',
        '5',
        '2-3',
        '1-1',
        '0-0',
        '2',
        '1',
        '0',
        '0',
        '0',
        '0',
        '2',
        '0',
        '0',
      ],
      didNotPlay: true,
      active: false,
    };
    const result = convertAthlete(row, LABELS);
    expect(result?.min).toBe(':00');
    // The other fields are still populated (ESPN may want to show the numbers)
    // but the DNP min is what our resolver filters on.
    expect(result?.player).toEqual({ first_name: 'Edge', last_name: 'Case' });
  });

  it('returns null for rows without an athlete name', () => {
    const row = {
      athlete: {},
      stats: ['37', '22', '7-14', '4-10', '4-4', '5', '1', '3', '0', '2', '2', '3', '1', '+10'],
    };
    expect(convertAthlete(row, LABELS)).toBe(null);
  });

  it('returns null when labels are malformed (schema drift)', () => {
    const row = {
      athlete: { displayName: 'LeBron James' },
      stats: ['37', '22'],
    };
    expect(convertAthlete(row, ['MIN', 'PTS'])).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// flattenGameSummary
// ---------------------------------------------------------------------------

describe('flattenGameSummary', () => {
  const LABELS = [
    'MIN',
    'PTS',
    'FG',
    '3PT',
    'FT',
    'REB',
    'AST',
    'TO',
    'STL',
    'BLK',
    'OREB',
    'DREB',
    'PF',
    '+/-',
  ];

  function athleteRow(
    name: string,
    stats: Record<string, string | number>,
    didNotPlay = false,
  ) {
    const s = (k: string, d: string | number = '0') => String(stats[k] ?? d);
    return {
      athlete: { displayName: name },
      stats: [
        s('MIN'),
        s('PTS'),
        s('FG', '0-0'),
        s('3PT', '0-0'),
        s('FT', '0-0'),
        s('REB'),
        s('AST'),
        s('TO'),
        s('STL'),
        s('BLK'),
        s('OREB'),
        s('DREB'),
        s('PF'),
        s('+/-', '0'),
      ],
      didNotPlay,
    };
  }

  it('flattens athletes from both teams into one array', () => {
    const summary: EspnGameSummary = {
      boxscore: {
        players: [
          {
            team: { displayName: 'Team A' },
            statistics: [
              {
                labels: LABELS,
                athletes: [
                  athleteRow('Alice One', { MIN: '30', PTS: 20, REB: 5, AST: 4 }),
                  athleteRow('Alice Two', { MIN: '25', PTS: 15, REB: 7, AST: 2 }),
                ],
              },
            ],
          },
          {
            team: { displayName: 'Team B' },
            statistics: [
              {
                labels: LABELS,
                athletes: [
                  athleteRow('Bob One', { MIN: '40', PTS: 35, REB: 10, AST: 6 }),
                ],
              },
            ],
          },
        ],
      },
    };

    const result = flattenGameSummary(summary);
    expect(result).toHaveLength(3);
    expect(result.map((r) => r.player.last_name)).toEqual(['One', 'Two', 'One']);
    expect(result[0].pts).toBe(20);
    expect(result[2].pts).toBe(35);
  });

  it('returns an empty array when boxscore is missing', () => {
    expect(flattenGameSummary({})).toEqual([]);
    expect(flattenGameSummary({ boxscore: {} })).toEqual([]);
    expect(flattenGameSummary({ boxscore: { players: [] } })).toEqual([]);
  });

  it('skips unparseable rows but keeps parseable ones', () => {
    const summary: EspnGameSummary = {
      boxscore: {
        players: [
          {
            team: { displayName: 'Team A' },
            statistics: [
              {
                labels: LABELS,
                athletes: [
                  // Good row
                  athleteRow('Good Player', { MIN: '30', PTS: 10 }),
                  // Missing athlete → null
                  {
                    athlete: {},
                    stats: ['30', '10', '0-0', '0-0', '0-0', '0', '0', '0', '0', '0', '0', '0', '0', '0'],
                  },
                  // Good row again
                  athleteRow('Another Good', { MIN: '20', PTS: 8 }),
                ],
              },
            ],
          },
        ],
      },
    };
    const result = flattenGameSummary(summary);
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.player.first_name)).toEqual(['Good', 'Another']);
  });

  it('flags DNPs so the resolver will skip them', () => {
    const summary: EspnGameSummary = {
      boxscore: {
        players: [
          {
            team: { displayName: 'Team A' },
            statistics: [
              {
                labels: LABELS,
                athletes: [
                  athleteRow('Played Player', { MIN: '30', PTS: 10 }),
                  athleteRow('DNP Player', {}, true),
                ],
              },
            ],
          },
        ],
      },
    };
    const result = flattenGameSummary(summary);
    expect(result).toHaveLength(2);
    expect(result[0].min).toBe('30');
    expect(result[1].min).toBe(':00');
  });
});
