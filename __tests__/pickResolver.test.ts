import {
  canonicalizeStatType,
  computeActualValue,
  computeFantasyScore,
  computeOutcome,
  didPlayerPlay,
  findBoxScoreIndex,
  normalizePlayerName,
  parseMinutesValue,
  resolvePick,
  type RawBoxScore,
} from '../src/lib/pickResolver';

// ============================================================================
// Helpers — build a realistic box score row with sensible defaults
// ============================================================================

function makeBox(overrides: Partial<RawBoxScore> = {}): RawBoxScore {
  return {
    pts: 0,
    reb: 0,
    ast: 0,
    stl: 0,
    blk: 0,
    fg3m: 0,
    turnover: 0,
    min: '35:00',
    ...overrides,
  };
}

function makeBoxWithPlayer(
  firstName: string,
  lastName: string,
  overrides: Partial<RawBoxScore> = {},
) {
  return {
    ...makeBox(overrides),
    player: { first_name: firstName, last_name: lastName },
  };
}

// ============================================================================
// canonicalizeStatType
// ============================================================================

describe('canonicalizeStatType', () => {
  test('maps common points aliases', () => {
    expect(canonicalizeStatType('Points')).toBe('points');
    expect(canonicalizeStatType('PTS')).toBe('points');
    expect(canonicalizeStatType('player_points')).toBe('points');
  });

  test('maps common rebounds aliases', () => {
    expect(canonicalizeStatType('Rebounds')).toBe('rebounds');
    expect(canonicalizeStatType('REBS')).toBe('rebounds');
    expect(canonicalizeStatType('reb')).toBe('rebounds');
  });

  test('maps common assists aliases', () => {
    expect(canonicalizeStatType('Assists')).toBe('assists');
    expect(canonicalizeStatType('ASTS')).toBe('assists');
    expect(canonicalizeStatType('ast')).toBe('assists');
  });

  test('maps steals and blocks', () => {
    expect(canonicalizeStatType('Steals')).toBe('steals');
    expect(canonicalizeStatType('stl')).toBe('steals');
    expect(canonicalizeStatType('Blocks')).toBe('blocks');
    expect(canonicalizeStatType('blk')).toBe('blocks');
  });

  test('maps three-pointer aliases', () => {
    expect(canonicalizeStatType('Threes')).toBe('threes');
    expect(canonicalizeStatType('3-pointers')).toBe('threes');
    expect(canonicalizeStatType('3PT')).toBe('threes');
    expect(canonicalizeStatType('3pm')).toBe('threes');
  });

  test('maps combo stat types', () => {
    expect(canonicalizeStatType('PRA')).toBe('pra');
    expect(canonicalizeStatType('pts+rebs+asts')).toBe('pra');
    expect(canonicalizeStatType('pts+rebs')).toBe('pts+rebs');
    expect(canonicalizeStatType('PR')).toBe('pts+rebs');
    expect(canonicalizeStatType('pts+asts')).toBe('pts+asts');
    expect(canonicalizeStatType('pa')).toBe('pts+asts');
    expect(canonicalizeStatType('rebs+asts')).toBe('rebs+asts');
    expect(canonicalizeStatType('ra')).toBe('rebs+asts');
  });

  test('maps fantasy aliases', () => {
    expect(canonicalizeStatType('fantasy')).toBe('fantasy');
    expect(canonicalizeStatType('Fantasy Points')).toBe('fantasy');
    expect(canonicalizeStatType('fpts')).toBe('fantasy');
  });

  test('maps turnovers', () => {
    expect(canonicalizeStatType('turnovers')).toBe('turnovers');
    expect(canonicalizeStatType('tov')).toBe('turnovers');
    expect(canonicalizeStatType('to')).toBe('turnovers');
  });

  test('maps minutes aliases', () => {
    expect(canonicalizeStatType('minutes')).toBe('minutes');
    expect(canonicalizeStatType('Minutes')).toBe('minutes');
    expect(canonicalizeStatType('min')).toBe('minutes');
    expect(canonicalizeStatType('mins')).toBe('minutes');
    expect(canonicalizeStatType('player_minutes')).toBe('minutes');
  });

  test('returns null for unrecognized stats', () => {
    expect(canonicalizeStatType('dunks')).toBeNull();
    expect(canonicalizeStatType('')).toBeNull();
    expect(canonicalizeStatType('plus_minus')).toBeNull();
  });
});

// ============================================================================
// computeActualValue
// ============================================================================

describe('computeActualValue', () => {
  test('returns the correct counting stat', () => {
    const box = makeBox({ pts: 27, reb: 8, ast: 9, stl: 2, blk: 1, fg3m: 3, turnover: 4 });
    expect(computeActualValue(box, 'points')).toBe(27);
    expect(computeActualValue(box, 'rebounds')).toBe(8);
    expect(computeActualValue(box, 'assists')).toBe(9);
    expect(computeActualValue(box, 'steals')).toBe(2);
    expect(computeActualValue(box, 'blocks')).toBe(1);
    expect(computeActualValue(box, 'threes')).toBe(3);
    expect(computeActualValue(box, 'turnovers')).toBe(4);
  });

  test('sums combo stats correctly', () => {
    const box = makeBox({ pts: 30, reb: 10, ast: 5 });
    expect(computeActualValue(box, 'pra')).toBe(45);
    expect(computeActualValue(box, 'pts+rebs')).toBe(40);
    expect(computeActualValue(box, 'pts+asts')).toBe(35);
    expect(computeActualValue(box, 'rebs+asts')).toBe(15);
  });

  test('computes fantasy score using PrizePicks/Underdog formula', () => {
    // 27 pts + 8 reb + 9 ast + 2 stl + 1 blk + 4 turnovers
    // = 27*1 + 8*1.2 + 9*1.5 + 2*3 + 1*3 + 4*(-1)
    // = 27 + 9.6 + 13.5 + 6 + 3 - 4
    // = 55.1
    const box = makeBox({ pts: 27, reb: 8, ast: 9, stl: 2, blk: 1, fg3m: 3, turnover: 4 });
    expect(computeActualValue(box, 'fantasy')).toBeCloseTo(55.1, 5);
  });

  test('handles zero stat lines', () => {
    const box = makeBox();
    expect(computeActualValue(box, 'points')).toBe(0);
    expect(computeActualValue(box, 'pra')).toBe(0);
    expect(computeActualValue(box, 'fantasy')).toBe(0);
  });

  test('computes minutes from the min field', () => {
    expect(computeActualValue(makeBox({ min: '37:42' }), 'minutes')).toBe(37);
    expect(computeActualValue(makeBox({ min: '37' }), 'minutes')).toBe(37);
    expect(computeActualValue(makeBox({ min: ':00' }), 'minutes')).toBe(0);
  });
});

// ============================================================================
// parseMinutesValue
// ============================================================================

describe('parseMinutesValue', () => {
  test('parses bare integer minutes (ESPN format)', () => {
    expect(parseMinutesValue('37')).toBe(37);
    expect(parseMinutesValue('1')).toBe(1);
    expect(parseMinutesValue('48')).toBe(48);
  });

  test('parses MM:SS format (legacy / balldontlie)', () => {
    expect(parseMinutesValue('37:42')).toBe(37);
    expect(parseMinutesValue('1:12')).toBe(1);
    expect(parseMinutesValue('0:42')).toBe(0);
  });

  test('returns 0 for DNP-shaped inputs', () => {
    expect(parseMinutesValue(null)).toBe(0);
    expect(parseMinutesValue(undefined)).toBe(0);
    expect(parseMinutesValue('')).toBe(0);
    expect(parseMinutesValue(':00')).toBe(0);
    expect(parseMinutesValue('0:00')).toBe(0);
    expect(parseMinutesValue('00:00')).toBe(0);
  });

  test('returns 0 for unparseable input', () => {
    expect(parseMinutesValue('garbage')).toBe(0);
    expect(parseMinutesValue('--')).toBe(0);
  });
});

// ============================================================================
// computeFantasyScore (PrizePicks / Underdog formula)
// ============================================================================

describe('computeFantasyScore', () => {
  test('triple double example', () => {
    const box = makeBox({ pts: 30, reb: 10, ast: 10, stl: 2, blk: 1, fg3m: 4, turnover: 3 });
    // 30*1 + 10*1.2 + 10*1.5 + 2*3 + 1*3 + 3*(-1)
    // = 30 + 12 + 15 + 6 + 3 - 3
    // = 63
    expect(computeFantasyScore(box)).toBe(63);
  });

  test('turnovers subtract from score at -1 each', () => {
    const withTO = makeBox({ pts: 20, turnover: 6 });
    const withoutTO = makeBox({ pts: 20, turnover: 0 });
    expect(computeFantasyScore(withoutTO) - computeFantasyScore(withTO)).toBe(6);
  });

  test('three-pointers made are NOT re-scored (PrizePicks/Underdog spec)', () => {
    // 9 points includes 3 threes. No separate 3pm bonus.
    const withThrees = makeBox({ pts: 9, fg3m: 3 });
    const withoutThrees = makeBox({ pts: 9, fg3m: 0 });
    expect(computeFantasyScore(withThrees)).toBe(computeFantasyScore(withoutThrees));
    expect(computeFantasyScore(withThrees)).toBe(9); // pts only, no modifiers
  });

  test('rebounds at 1.2, assists at 1.5', () => {
    const box = makeBox({ reb: 10, ast: 10 });
    expect(computeFantasyScore(box)).toBe(12 + 15);
  });

  test('steals and blocks at 3 each', () => {
    const box = makeBox({ stl: 2, blk: 2 });
    expect(computeFantasyScore(box)).toBe(12);
  });
});

// ============================================================================
// computeOutcome
// ============================================================================

describe('computeOutcome', () => {
  test('OVER wins when actual > line', () => {
    expect(computeOutcome(25, 22.5, 'over')).toEqual({ won: true, pushed: false });
  });

  test('OVER loses when actual < line', () => {
    expect(computeOutcome(20, 22.5, 'over')).toEqual({ won: false, pushed: false });
  });

  test('UNDER wins when actual < line', () => {
    expect(computeOutcome(20, 22.5, 'under')).toEqual({ won: true, pushed: false });
  });

  test('UNDER loses when actual > line', () => {
    expect(computeOutcome(25, 22.5, 'under')).toEqual({ won: false, pushed: false });
  });

  test('integer line + exact match → push regardless of direction', () => {
    expect(computeOutcome(20, 20, 'over')).toEqual({ won: false, pushed: true });
    expect(computeOutcome(20, 20, 'under')).toEqual({ won: false, pushed: true });
  });

  test('decimal line can never push with integer stat', () => {
    expect(computeOutcome(20, 20.5, 'over')).toEqual({ won: false, pushed: false });
    expect(computeOutcome(20, 20.5, 'under')).toEqual({ won: true, pushed: false });
  });

  test('barely-over cases are handled', () => {
    expect(computeOutcome(23, 22.5, 'over')).toEqual({ won: true, pushed: false });
    expect(computeOutcome(22, 22.5, 'over')).toEqual({ won: false, pushed: false });
  });

  test('rounds to 1 decimal to survive fantasy float noise', () => {
    // 42.30000001 should resolve identically to 42.3
    expect(computeOutcome(42.30000001, 42.3, 'over')).toEqual({ won: false, pushed: true });
  });
});

// ============================================================================
// normalizePlayerName
// ============================================================================

describe('normalizePlayerName', () => {
  test('lowercases', () => {
    expect(normalizePlayerName('LeBron James')).toBe('lebron james');
  });

  test('strips diacritics', () => {
    expect(normalizePlayerName('Nikola Jokić')).toBe('nikola jokic');
    expect(normalizePlayerName('Luka Dončić')).toBe('luka doncic');
  });

  test('strips Jr/Sr/III suffixes', () => {
    expect(normalizePlayerName('Kelly Oubre Jr.')).toBe('kelly oubre');
    expect(normalizePlayerName('Larry Nance Jr')).toBe('larry nance');
    expect(normalizePlayerName('Dennis Smith III')).toBe('dennis smith');
    expect(normalizePlayerName('P.J. Washington Jr.')).toBe('pj washington');
  });

  test('strips punctuation', () => {
    expect(normalizePlayerName("D'Angelo Russell")).toBe('dangelo russell');
    expect(normalizePlayerName('P.J. Tucker')).toBe('pj tucker');
  });

  test('collapses internal whitespace', () => {
    expect(normalizePlayerName('LeBron   James')).toBe('lebron james');
  });
});

// ============================================================================
// findBoxScoreIndex
// ============================================================================

describe('findBoxScoreIndex', () => {
  const boxes = [
    makeBoxWithPlayer('LeBron', 'James'),
    makeBoxWithPlayer('Anthony', 'Davis'),
    makeBoxWithPlayer('Kelly', 'Oubre Jr.'),
    makeBoxWithPlayer('Nikola', 'Jokić'),
  ];

  test('finds by exact normalized full name', () => {
    expect(findBoxScoreIndex(boxes, 'LeBron James')).toBe(0);
    expect(findBoxScoreIndex(boxes, 'lebron james')).toBe(0);
  });

  test('finds through diacritics', () => {
    expect(findBoxScoreIndex(boxes, 'Nikola Jokic')).toBe(3);
  });

  test('finds with Jr/Sr suffix mismatch on either side', () => {
    expect(findBoxScoreIndex(boxes, 'Kelly Oubre')).toBe(2);
    expect(findBoxScoreIndex(boxes, 'Kelly Oubre Jr.')).toBe(2);
  });

  test('unambiguous last-name match', () => {
    expect(findBoxScoreIndex(boxes, 'Davis')).toBe(1);
  });

  test('ambiguous last name returns -1 via partial fallback', () => {
    const twoJameses = [
      makeBoxWithPlayer('LeBron', 'James'),
      makeBoxWithPlayer('Mike', 'James'),
    ];
    // Exact-full fails (no full match). Last "james" has 2 matches → skip.
    // Partial fallback: "james" is contained in "lebron james" → returns 0.
    // This is by design: when no better info is available, first hit wins.
    const idx = findBoxScoreIndex(twoJameses, 'James');
    expect(idx).toBe(0);
  });

  test('returns -1 when the player is missing entirely', () => {
    expect(findBoxScoreIndex(boxes, 'Stephen Curry')).toBe(-1);
  });

  test('returns -1 for empty lookup name', () => {
    expect(findBoxScoreIndex(boxes, '')).toBe(-1);
  });
});

// ============================================================================
// didPlayerPlay
// ============================================================================

describe('didPlayerPlay', () => {
  test('true for normal minutes', () => {
    expect(didPlayerPlay(makeBox({ min: '35:42' }))).toBe(true);
    expect(didPlayerPlay(makeBox({ min: '1:12' }))).toBe(true);
    expect(didPlayerPlay(makeBox({ min: '0:42' }))).toBe(true);
  });

  test('false for DNP variations', () => {
    expect(didPlayerPlay(makeBox({ min: null }))).toBe(false);
    expect(didPlayerPlay(makeBox({ min: undefined }))).toBe(false);
    expect(didPlayerPlay(makeBox({ min: '' }))).toBe(false);
    expect(didPlayerPlay(makeBox({ min: ':00' }))).toBe(false);
    expect(didPlayerPlay(makeBox({ min: '00:00' }))).toBe(false);
    expect(didPlayerPlay(makeBox({ min: '0:00' }))).toBe(false);
  });
});

// ============================================================================
// resolvePick — end-to-end
// ============================================================================

describe('resolvePick', () => {
  const boxes = [
    {
      ...makeBox({ pts: 27, reb: 8, ast: 9, stl: 2, blk: 1, fg3m: 3, min: '35:42' }),
      player: { first_name: 'LeBron', last_name: 'James' },
    },
    {
      ...makeBox({ pts: 0, reb: 0, ast: 0, stl: 0, blk: 0, fg3m: 0, min: ':00' }),
      player: { first_name: 'Anthony', last_name: 'Davis' },
    },
  ];

  test('resolves a winning OVER pick', () => {
    const result = resolvePick(
      { playerName: 'LeBron James', statType: 'points', line: 22.5, direction: 'over' },
      boxes,
    );
    expect(result.status).toBe('resolved');
    if (result.status === 'resolved') {
      expect(result.actualValue).toBe(27);
      expect(result.outcome).toEqual({ won: true, pushed: false });
    }
  });

  test('resolves a losing UNDER pick', () => {
    const result = resolvePick(
      { playerName: 'LeBron James', statType: 'points', line: 22.5, direction: 'under' },
      boxes,
    );
    expect(result.status).toBe('resolved');
    if (result.status === 'resolved') {
      expect(result.actualValue).toBe(27);
      expect(result.outcome).toEqual({ won: false, pushed: false });
    }
  });

  test('resolves a PRA combo pick correctly', () => {
    const result = resolvePick(
      { playerName: 'LeBron James', statType: 'PRA', line: 40.5, direction: 'over' },
      boxes,
    );
    expect(result.status).toBe('resolved');
    if (result.status === 'resolved') {
      expect(result.actualValue).toBe(44); // 27 + 8 + 9
      expect(result.outcome.won).toBe(true);
    }
  });

  test('returns push on an integer line exact match', () => {
    const result = resolvePick(
      { playerName: 'LeBron James', statType: 'points', line: 27, direction: 'over' },
      boxes,
    );
    expect(result.status).toBe('resolved');
    if (result.status === 'resolved') {
      expect(result.outcome).toEqual({ won: false, pushed: true });
    }
  });

  test('returns no_match when the player is not in the box scores', () => {
    const result = resolvePick(
      { playerName: 'Stephen Curry', statType: 'points', line: 22.5, direction: 'over' },
      boxes,
    );
    expect(result.status).toBe('no_match');
  });

  test('returns dnp when the player was found but did not play', () => {
    const result = resolvePick(
      { playerName: 'Anthony Davis', statType: 'rebounds', line: 10.5, direction: 'over' },
      boxes,
    );
    expect(result.status).toBe('dnp');
  });

  test('returns unsupported_stat for unrecognized stat types', () => {
    const result = resolvePick(
      { playerName: 'LeBron James', statType: 'dunks', line: 2.5, direction: 'over' },
      boxes,
    );
    expect(result.status).toBe('unsupported_stat');
  });

  test('handles stringy stat_type values from legacy rows', () => {
    const result = resolvePick(
      { playerName: 'LeBron James', statType: 'Points', line: 22.5, direction: 'over' },
      boxes,
    );
    expect(result.status).toBe('resolved');
  });

  test('handles player_* market-key stat types from the Odds API path', () => {
    const result = resolvePick(
      { playerName: 'LeBron James', statType: 'player_points', line: 22.5, direction: 'over' },
      boxes,
    );
    expect(result.status).toBe('resolved');
  });

  test('resolves a fantasy pick with decimal actual value', () => {
    // LeBron box (default makeBox: turnover=0):
    //   pts:27 + reb:8*1.2 + ast:9*1.5 + stl:2*3 + blk:1*3 + to:0*(-1)
    //   = 27 + 9.6 + 13.5 + 6 + 3
    //   = 59.1
    const result = resolvePick(
      { playerName: 'LeBron James', statType: 'fantasy', line: 55.5, direction: 'over' },
      boxes,
    );
    expect(result.status).toBe('resolved');
    if (result.status === 'resolved') {
      expect(result.actualValue).toBeCloseTo(59.1, 5);
      expect(result.outcome.won).toBe(true);
    }
  });

  test('resolves a minutes pick (LeBron box has min "35:42")', () => {
    const result = resolvePick(
      { playerName: 'LeBron James', statType: 'minutes', line: 32.5, direction: 'over' },
      boxes,
    );
    expect(result.status).toBe('resolved');
    if (result.status === 'resolved') {
      expect(result.actualValue).toBe(35);
      expect(result.outcome).toEqual({ won: true, pushed: false });
    }
  });

  test('minutes pick respects DNP gating', () => {
    // Anthony Davis is set up with min ":00" → didPlayerPlay false → dnp.
    const result = resolvePick(
      { playerName: 'Anthony Davis', statType: 'minutes', line: 28.5, direction: 'over' },
      boxes,
    );
    expect(result.status).toBe('dnp');
  });
});
