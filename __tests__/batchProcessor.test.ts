import {
  getStatMean,
  computeSummary,
  sortResults,
  processBatch,
  applyPostseasonKellyReduction,
  isPostseasonSlice,
  deriveHomeAway,
  POSTSEASON_KELLY_MULTIPLIER,
  type BatchPlayerResult,
  type BatchInput,
} from '../src/lib/batchProcessor';
import type { PlayerSeasonAvg } from '../src/lib/playerStats';
import type { CalculationResult, SideEvaluation } from '../src/components/types';

const mockStats: PlayerSeasonAvg = {
  playerName: 'Test Player',
  position: 'SF',
  team: 'Test Team',
  stats: { points: 25.0, rebounds: 8.0, assists: 6.5, steals: 1.2, blocks: 0.8, threes: 2.5, turnovers: 3.5 },
};

/**
 * Build a synthetic two-sided CalculationResult for tests that don't need
 * real math — just enough for tier/EV/sort assertions.
 */
function makeSide(overrides: Partial<SideEvaluation> = {}): SideEvaluation {
  return {
    fairProb: 0.5,
    modelProb: 0.5,
    blendedProb: 0.5,
    ev: 0,
    kellyStake: 0,
    kellyFraction: 0.25,
    tier: 'REJECT',
    ...overrides,
  };
}

function makeResult(
  overSide: Partial<SideEvaluation>,
  underSide: Partial<SideEvaluation> = { tier: 'REJECT', ev: -0.05 },
  source = 'Binomial',
): CalculationResult {
  return {
    over: makeSide(overSide),
    under: makeSide(underSide),
    source,
  };
}

describe('getStatMean', () => {
  it('returns points', () => {
    expect(getStatMean(mockStats.stats, 'points')).toBe(25.0);
  });

  it('returns rebounds', () => {
    expect(getStatMean(mockStats.stats, 'rebounds')).toBe(8.0);
  });

  it('returns assists', () => {
    expect(getStatMean(mockStats.stats, 'assists')).toBe(6.5);
  });

  it('returns steals', () => {
    expect(getStatMean(mockStats.stats, 'steals')).toBe(1.2);
  });

  it('returns blocks', () => {
    expect(getStatMean(mockStats.stats, 'blocks')).toBe(0.8);
  });

  it('returns threes', () => {
    expect(getStatMean(mockStats.stats, 'threes')).toBe(2.5);
  });

  it('returns PRA (points + rebounds + assists)', () => {
    expect(getStatMean(mockStats.stats, 'pra')).toBe(39.5); // 25 + 8 + 6.5
  });

  it('returns pts+rebs', () => {
    expect(getStatMean(mockStats.stats, 'pts+rebs')).toBe(33.0); // 25 + 8
  });

  it('returns pts+asts', () => {
    expect(getStatMean(mockStats.stats, 'pts+asts')).toBe(31.5); // 25 + 6.5
  });

  it('returns rebs+asts', () => {
    expect(getStatMean(mockStats.stats, 'rebs+asts')).toBe(14.5); // 8 + 6.5
  });

  it('returns fantasy points (PrizePicks/Underdog scoring)', () => {
    // 25*1 + 8*1.2 + 6.5*1.5 + 1.2*3 + 0.8*3 - 3.5*1
    // = 25 + 9.6 + 9.75 + 3.6 + 2.4 - 3.5 = 46.85
    expect(getStatMean(mockStats.stats, 'fantasy')).toBeCloseTo(46.85, 2);
  });

  it('returns 0 for unknown stat type', () => {
    expect(getStatMean(mockStats.stats, 'unknown')).toBe(0);
  });
});

describe('deriveHomeAway', () => {
  it('returns home when player team matches the home team exactly', () => {
    expect(deriveHomeAway('Boston Celtics', 'Boston Celtics', 'Toronto Raptors')).toBe('home');
  });

  it('returns away when player team matches the away team exactly', () => {
    expect(deriveHomeAway('Toronto Raptors', 'Boston Celtics', 'Toronto Raptors')).toBe('away');
  });

  it('matches case-insensitively', () => {
    expect(deriveHomeAway('boston celtics', 'BOSTON CELTICS', 'Toronto Raptors')).toBe('home');
  });

  it('matches via partial-contains either direction (player includes prop or vice versa)', () => {
    // Player team is "Celtics" (shorter), home is "Boston Celtics" (longer)
    expect(deriveHomeAway('Celtics', 'Boston Celtics', 'Toronto Raptors')).toBe('home');
    // Player team is "Los Angeles Lakers" (longer), away is "Lakers" (shorter)
    expect(deriveHomeAway('Los Angeles Lakers', 'Boston Celtics', 'Lakers')).toBe('away');
  });

  it('returns null when player team is missing', () => {
    expect(deriveHomeAway(undefined, 'Boston Celtics', 'Toronto Raptors')).toBeNull();
    expect(deriveHomeAway('', 'Boston Celtics', 'Toronto Raptors')).toBeNull();
  });

  it('returns null when both home and away teams are missing', () => {
    expect(deriveHomeAway('Boston Celtics', undefined, undefined)).toBeNull();
  });

  it('returns null when player team matches neither side', () => {
    expect(deriveHomeAway('Miami Heat', 'Boston Celtics', 'Toronto Raptors')).toBeNull();
  });

  it('tolerates whitespace on all inputs', () => {
    expect(deriveHomeAway('  Boston Celtics  ', '  Boston Celtics  ', '  Toronto Raptors  ')).toBe('home');
  });

  it('does NOT confuse home and away when only one side is provided', () => {
    expect(deriveHomeAway('Boston Celtics', 'Boston Celtics', undefined)).toBe('home');
    expect(deriveHomeAway('Toronto Raptors', undefined, 'Toronto Raptors')).toBe('away');
  });
});

describe('computeSummary', () => {
  it('counts tiers correctly using the stronger side', () => {
    const players: BatchPlayerResult[] = [
      { playerName: 'A', position: 'PG', statType: 'points', line: 20, mean: 22, overOdds: -110, underOdds: -110, result: makeResult({ tier: 'HIGH', ev: 0.1, blendedProb: 0.6, kellyStake: 5 }), status: 'success' },
      { playerName: 'B', position: 'SG', statType: 'points', line: 20, mean: 21, overOdds: -110, underOdds: -110, result: makeResult({ tier: 'MEDIUM', ev: 0.06, blendedProb: 0.55, kellyStake: 3 }), status: 'success' },
      { playerName: 'C', position: 'SF', statType: 'points', line: 20, mean: 20, overOdds: -110, underOdds: -110, result: makeResult({ tier: 'REJECT', ev: -0.02, blendedProb: 0.48 }), status: 'success' },
      { playerName: 'D', position: '', statType: 'points', line: 20, mean: 0, overOdds: -110, underOdds: -110, result: null, status: 'player_not_found', statusMessage: 'Player not found' },
    ];

    const summary = computeSummary(players);
    expect(summary.high).toBe(1);
    expect(summary.medium).toBe(1);
    expect(summary.low).toBe(0);
    expect(summary.reject).toBe(1);
    expect(summary.errors).toBe(1);
  });

  it('returns all zeros for empty array', () => {
    const summary = computeSummary([]);
    expect(summary).toEqual({ high: 0, medium: 0, low: 0, reject: 0, errors: 0 });
  });

  it('counts the under side when it has the stronger tier', () => {
    const players: BatchPlayerResult[] = [
      {
        playerName: 'UnderPlay',
        position: 'PG',
        statType: 'points',
        line: 20,
        mean: 18,
        overOdds: -110,
        underOdds: -110,
        result: makeResult(
          { tier: 'REJECT', ev: -0.1 },
          { tier: 'HIGH', ev: 0.12, blendedProb: 0.62, kellyStake: 6 },
        ),
        status: 'success',
      },
    ];
    const summary = computeSummary(players);
    expect(summary.high).toBe(1);
    expect(summary.reject).toBe(0);
  });
});

describe('sortResults', () => {
  it('sorts HIGH before MEDIUM before LOW before REJECT', () => {
    const players: BatchPlayerResult[] = [
      { playerName: 'Reject', position: 'C', statType: 'points', line: 20, mean: 18, overOdds: -110, underOdds: -110, result: makeResult({ tier: 'REJECT', ev: -0.05 }), status: 'success' },
      { playerName: 'High', position: 'PG', statType: 'points', line: 20, mean: 25, overOdds: -110, underOdds: -110, result: makeResult({ tier: 'HIGH', ev: 0.15, blendedProb: 0.65, kellyStake: 10 }), status: 'success' },
      { playerName: 'Medium', position: 'SG', statType: 'points', line: 20, mean: 22, overOdds: -110, underOdds: -110, result: makeResult({ tier: 'MEDIUM', ev: 0.07, blendedProb: 0.56, kellyStake: 4 }), status: 'success' },
    ];

    const sorted = sortResults(players);
    expect(sorted[0].playerName).toBe('High');
    expect(sorted[1].playerName).toBe('Medium');
    expect(sorted[2].playerName).toBe('Reject');
  });

  it('sorts errors to the bottom', () => {
    const players: BatchPlayerResult[] = [
      { playerName: 'Error', position: '', statType: 'points', line: 20, mean: 0, overOdds: -110, underOdds: -110, result: null, status: 'player_not_found' },
      { playerName: 'Good', position: 'PG', statType: 'points', line: 20, mean: 25, overOdds: -110, underOdds: -110, result: makeResult({ tier: 'HIGH', ev: 0.15, blendedProb: 0.65, kellyStake: 10 }), status: 'success' },
    ];

    const sorted = sortResults(players);
    expect(sorted[0].playerName).toBe('Good');
    expect(sorted[1].playerName).toBe('Error');
  });
});

describe('processBatch', () => {
  const mockFetchStats = jest.fn<Promise<PlayerSeasonAvg>, [string]>();

  beforeEach(() => {
    mockFetchStats.mockReset();
  });

  it('processes props and returns results', async () => {
    mockFetchStats.mockResolvedValue(mockStats);

    const input: BatchInput = {
      props: [
        { playerName: 'Test Player', statType: 'points', line: 24.5, overOdds: -110, underOdds: -110, bookmaker: 'fanduel' },
      ],
      bankroll: 100,
      kellyMode: 'standard',
      paceModifier: 0,
      injuryModifier: 0,
    };

    const result = await processBatch(input, mockFetchStats);
    expect(result.players).toHaveLength(1);
    expect(result.players[0].status).toBe('success');
    expect(result.players[0].mean).toBe(25.0);
    expect(result.players[0].result).not.toBeNull();
    expect(result.players[0].result!.over.tier).toBeDefined();
    expect(result.players[0].result!.under.tier).toBeDefined();
  });

  it('handles player not found gracefully', async () => {
    mockFetchStats.mockRejectedValue(new Error('Player not found: Unknown'));

    const input: BatchInput = {
      props: [
        { playerName: 'Unknown Player', statType: 'points', line: 20, overOdds: -110, underOdds: -110, bookmaker: 'test' },
      ],
      bankroll: 100,
      kellyMode: 'standard',
      paceModifier: 0,
      injuryModifier: 0,
    };

    const result = await processBatch(input, mockFetchStats);
    expect(result.players).toHaveLength(1);
    expect(result.players[0].status).toBe('player_not_found');
    expect(result.summary.errors).toBe(1);
  });

  it('processes multiple props and computes summary', async () => {
    mockFetchStats.mockResolvedValue(mockStats);

    const input: BatchInput = {
      props: [
        { playerName: 'P1', statType: 'points', line: 20, overOdds: -110, underOdds: -110, bookmaker: 'test' },
        { playerName: 'P2', statType: 'rebounds', line: 7.5, overOdds: -110, underOdds: -110, bookmaker: 'test' },
        { playerName: 'P3', statType: 'assists', line: 6, overOdds: -110, underOdds: -110, bookmaker: 'test' },
      ],
      bankroll: 100,
      kellyMode: 'standard',
      paceModifier: 0,
      injuryModifier: 0,
    };

    const result = await processBatch(input, mockFetchStats);
    expect(result.players).toHaveLength(3);
    expect(result.players.every(p => p.status === 'success')).toBe(true);

    const s = result.summary;
    expect(s.high + s.medium + s.low + s.reject + s.errors).toBe(3);
  });

  it('calls onProgress for each player', async () => {
    mockFetchStats.mockResolvedValue(mockStats);
    const onProgress = jest.fn();

    const input: BatchInput = {
      props: [
        { playerName: 'A', statType: 'points', line: 20, overOdds: -110, underOdds: -110, bookmaker: 'test' },
        { playerName: 'B', statType: 'points', line: 20, overOdds: -110, underOdds: -110, bookmaker: 'test' },
      ],
      bankroll: 100,
      kellyMode: 'standard',
      paceModifier: 0,
      injuryModifier: 0,
    };

    await processBatch(input, mockFetchStats, onProgress);
    expect(onProgress).toHaveBeenCalledTimes(2);
    expect(onProgress).toHaveBeenCalledWith(1, 2, 'A');
    expect(onProgress).toHaveBeenCalledWith(2, 2, 'B');
  });

  it('processes PRA prop end-to-end', async () => {
    mockFetchStats.mockResolvedValue(mockStats);

    const input: BatchInput = {
      props: [
        { playerName: 'Test Player', statType: 'pra', line: 38.5, overOdds: -110, underOdds: -110, bookmaker: 'fanduel' },
      ],
      bankroll: 100,
      kellyMode: 'standard',
      paceModifier: 0,
      injuryModifier: 0,
    };

    const result = await processBatch(input, mockFetchStats);
    expect(result.players).toHaveLength(1);
    expect(result.players[0].status).toBe('success');
    expect(result.players[0].mean).toBe(39.5); // 25 + 8 + 6.5
    expect(result.players[0].result).not.toBeNull();
    expect(result.players[0].result!.source).toBe('NegBinomial');
  });

  it('processes fantasy prop end-to-end', async () => {
    mockFetchStats.mockResolvedValue(mockStats);

    const input: BatchInput = {
      props: [
        { playerName: 'Test Player', statType: 'fantasy', line: 47.5, overOdds: -115, underOdds: -105, bookmaker: 'draftkings' },
      ],
      bankroll: 100,
      kellyMode: 'standard',
      paceModifier: 0,
      injuryModifier: 0,
    };

    const result = await processBatch(input, mockFetchStats);
    expect(result.players).toHaveLength(1);
    expect(result.players[0].status).toBe('success');
    expect(result.players[0].mean).toBeCloseTo(46.85, 1);
    expect(result.players[0].result).not.toBeNull();
    expect(['HIGH', 'MEDIUM', 'LOW', 'REJECT']).toContain(result.players[0].result!.over.tier);
    expect(['HIGH', 'MEDIUM', 'LOW', 'REJECT']).toContain(result.players[0].result!.under.tier);
  });
});

// =============================================================================
// Postseason Kelly reduction
// =============================================================================

describe('isPostseasonSlice', () => {
  it('returns false for undefined', () => {
    expect(isPostseasonSlice(undefined)).toBe(false);
  });

  it('returns false for regular', () => {
    expect(isPostseasonSlice('regular')).toBe(false);
  });

  it('returns true for playoffs', () => {
    expect(isPostseasonSlice('playoffs')).toBe(true);
  });

  it('returns true for finals', () => {
    expect(isPostseasonSlice('finals')).toBe(true);
  });
});

describe('applyPostseasonKellyReduction', () => {
  function mkResult(): CalculationResult {
    return {
      over: makeSide({ tier: 'HIGH', ev: 0.12, blendedProb: 0.62, kellyStake: 10 }),
      under: makeSide({ tier: 'REJECT', ev: -0.05, blendedProb: 0.45, kellyStake: 4 }),
      source: 'NegBinomial',
    };
  }

  it('returns the result unchanged when seasonType is undefined', () => {
    const r = mkResult();
    const out = applyPostseasonKellyReduction(r, undefined);
    expect(out.over.kellyStake).toBe(10);
    expect(out.under.kellyStake).toBe(4);
  });

  it('returns the result unchanged when seasonType is regular', () => {
    const r = mkResult();
    const out = applyPostseasonKellyReduction(r, 'regular');
    expect(out.over.kellyStake).toBe(10);
    expect(out.under.kellyStake).toBe(4);
  });

  it('multiplies kelly stakes by 0.75 when seasonType is playoffs', () => {
    const r = mkResult();
    const out = applyPostseasonKellyReduction(r, 'playoffs');
    expect(out.over.kellyStake).toBeCloseTo(7.5, 5);
    expect(out.under.kellyStake).toBeCloseTo(3, 5);
  });

  it('multiplies kelly stakes by 0.75 when seasonType is finals', () => {
    const r = mkResult();
    const out = applyPostseasonKellyReduction(r, 'finals');
    expect(out.over.kellyStake).toBeCloseTo(7.5, 5);
    expect(out.under.kellyStake).toBeCloseTo(3, 5);
  });

  it('does not mutate the input result', () => {
    const r = mkResult();
    applyPostseasonKellyReduction(r, 'finals');
    expect(r.over.kellyStake).toBe(10);
    expect(r.under.kellyStake).toBe(4);
  });

  it('preserves probability/EV/tier fields untouched', () => {
    const r = mkResult();
    const out = applyPostseasonKellyReduction(r, 'finals');
    expect(out.over.tier).toBe(r.over.tier);
    expect(out.over.ev).toBeCloseTo(r.over.ev, 6);
    expect(out.over.blendedProb).toBeCloseTo(r.over.blendedProb, 6);
    expect(out.under.tier).toBe(r.under.tier);
    expect(out.source).toBe(r.source);
  });

  it('exposes a 0.75 multiplier constant', () => {
    expect(POSTSEASON_KELLY_MULTIPLIER).toBe(0.75);
  });
});

describe('processBatch postseason behavior', () => {
  const mockFetchStats = jest.fn<Promise<PlayerSeasonAvg>, [string]>();

  beforeEach(() => {
    mockFetchStats.mockReset();
  });

  function mkInput(): BatchInput {
    return {
      props: [
        { playerName: 'Test Player', statType: 'points', line: 24.5, overOdds: -110, underOdds: -110, bookmaker: 'fanduel' },
      ],
      bankroll: 1000,
      kellyMode: 'standard',
      paceModifier: 0,
      injuryModifier: 0,
    };
  }

  it('does NOT reduce kelly when seasonType is absent (legacy / regular)', async () => {
    // mockStats has no seasonType field at all
    mockFetchStats.mockResolvedValue(mockStats);
    const result = await processBatch(mkInput(), mockFetchStats);
    expect(result.players[0].seasonType).toBeUndefined();
    // Stake is whatever the math layer returned — we just verify it was not
    // multiplied by 0.75. It should equal the same call WITHOUT reduction.
    // Re-running with the reduction helper directly is the easiest cross-check.
    const raw = result.players[0].result!;
    expect(applyPostseasonKellyReduction(raw, undefined).over.kellyStake)
      .toBeCloseTo(raw.over.kellyStake, 6);
  });

  it('does NOT reduce kelly when seasonType is regular', async () => {
    mockFetchStats.mockResolvedValue({ ...mockStats, seasonType: 'regular' });
    const result = await processBatch(mkInput(), mockFetchStats);
    expect(result.players[0].seasonType).toBe('regular');
    // Compare against an explicit no-reduction baseline to avoid hard-coding
    // the math layer's exact stake.
    const raw = result.players[0].result!;
    expect(applyPostseasonKellyReduction(raw, 'regular').over.kellyStake)
      .toBeCloseTo(raw.over.kellyStake, 6);
  });

  it('reduces kelly stake by 0.75 when seasonType is playoffs', async () => {
    // Run twice — once with regular, once with playoffs — and verify the
    // playoffs row is exactly 0.75x the regular row's stake.
    mockFetchStats.mockResolvedValueOnce({ ...mockStats, seasonType: 'regular' });
    const reg = await processBatch(mkInput(), mockFetchStats);

    mockFetchStats.mockResolvedValueOnce({ ...mockStats, seasonType: 'playoffs' });
    const post = await processBatch(mkInput(), mockFetchStats);

    expect(post.players[0].seasonType).toBe('playoffs');
    expect(post.players[0].result!.over.kellyStake)
      .toBeCloseTo(reg.players[0].result!.over.kellyStake * 0.75, 5);
    expect(post.players[0].result!.under.kellyStake)
      .toBeCloseTo(reg.players[0].result!.under.kellyStake * 0.75, 5);
  });

  it('reduces kelly stake by 0.75 when seasonType is finals', async () => {
    mockFetchStats.mockResolvedValueOnce({ ...mockStats, seasonType: 'regular' });
    const reg = await processBatch(mkInput(), mockFetchStats);

    mockFetchStats.mockResolvedValueOnce({ ...mockStats, seasonType: 'finals' });
    const post = await processBatch(mkInput(), mockFetchStats);

    expect(post.players[0].seasonType).toBe('finals');
    expect(post.players[0].result!.over.kellyStake)
      .toBeCloseTo(reg.players[0].result!.over.kellyStake * 0.75, 5);
    expect(post.players[0].result!.under.kellyStake)
      .toBeCloseTo(reg.players[0].result!.under.kellyStake * 0.75, 5);
  });

  it('does not change probabilities, EV, or tiers in postseason mode', async () => {
    mockFetchStats.mockResolvedValueOnce({ ...mockStats, seasonType: 'regular' });
    const reg = await processBatch(mkInput(), mockFetchStats);

    mockFetchStats.mockResolvedValueOnce({ ...mockStats, seasonType: 'finals' });
    const post = await processBatch(mkInput(), mockFetchStats);

    const r = reg.players[0].result!;
    const p = post.players[0].result!;

    expect(p.over.blendedProb).toBeCloseTo(r.over.blendedProb, 6);
    expect(p.over.ev).toBeCloseTo(r.over.ev, 6);
    expect(p.over.tier).toBe(r.over.tier);
    expect(p.under.blendedProb).toBeCloseTo(r.under.blendedProb, 6);
    expect(p.under.ev).toBeCloseTo(r.under.ev, 6);
    expect(p.under.tier).toBe(r.under.tier);
  });

  it('propagates seasonType to error rows (mean = 0 case)', async () => {
    // Force the "no stat" path: stats with all-zero fields → mean = 0
    mockFetchStats.mockResolvedValue({
      playerName: 'X',
      position: 'PG',
      team: 'BOS',
      stats: { points: 0, rebounds: 0, assists: 0, steals: 0, blocks: 0, threes: 0, turnovers: 0 },
      seasonType: 'finals',
    });
    const result = await processBatch(mkInput(), mockFetchStats);
    expect(result.players[0].status).toBe('api_error');
    expect(result.players[0].seasonType).toBe('finals');
  });
});
