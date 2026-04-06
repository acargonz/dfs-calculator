import {
  getStatMean,
  computeSummary,
  sortResults,
  processBatch,
  type BatchPlayerResult,
  type BatchInput,
} from '../src/lib/batchProcessor';
import type { PlayerSeasonAvg } from '../src/lib/playerStats';

const mockStats: PlayerSeasonAvg = {
  playerName: 'Test Player',
  position: 'SF',
  team: 'Test Team',
  stats: { points: 25.0, rebounds: 8.0, assists: 6.5, steals: 1.2, blocks: 0.8, threes: 2.5, turnovers: 3.5 },
};

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

  it('returns fantasy points (DK scoring)', () => {
    // 25*1 + 8*1.25 + 6.5*1.5 + 1.2*2 + 0.8*2 + 2.5*0.5 - 3.5*0.5
    // = 25 + 10 + 9.75 + 2.4 + 1.6 + 1.25 - 1.75 = 48.25
    expect(getStatMean(mockStats.stats, 'fantasy')).toBeCloseTo(48.25, 2);
  });

  it('returns 0 for unknown stat type', () => {
    expect(getStatMean(mockStats.stats, 'unknown')).toBe(0);
  });
});

describe('computeSummary', () => {
  it('counts tiers correctly', () => {
    const players: BatchPlayerResult[] = [
      { playerName: 'A', position: 'PG', statType: 'points', line: 20, mean: 22, overOdds: -110, underOdds: -110, result: { tier: 'HIGH', ev: 0.1, blendedProb: 0.6, fairOverProb: 0.5, fairUnderProb: 0.5, modelOverProb: 0.6, modelUnderProb: 0.4, kellyStake: 5, kellyFraction: 0.25, source: 'Binomial' }, status: 'success' },
      { playerName: 'B', position: 'SG', statType: 'points', line: 20, mean: 21, overOdds: -110, underOdds: -110, result: { tier: 'MEDIUM', ev: 0.06, blendedProb: 0.55, fairOverProb: 0.5, fairUnderProb: 0.5, modelOverProb: 0.55, modelUnderProb: 0.45, kellyStake: 3, kellyFraction: 0.25, source: 'Binomial' }, status: 'success' },
      { playerName: 'C', position: 'SF', statType: 'points', line: 20, mean: 20, overOdds: -110, underOdds: -110, result: { tier: 'REJECT', ev: -0.02, blendedProb: 0.48, fairOverProb: 0.5, fairUnderProb: 0.5, modelOverProb: 0.48, modelUnderProb: 0.52, kellyStake: 0, kellyFraction: 0.25, source: 'Binomial' }, status: 'success' },
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
});

describe('sortResults', () => {
  it('sorts HIGH before MEDIUM before LOW before REJECT', () => {
    const players: BatchPlayerResult[] = [
      { playerName: 'Reject', position: 'C', statType: 'points', line: 20, mean: 18, overOdds: -110, underOdds: -110, result: { tier: 'REJECT', ev: -0.05, blendedProb: 0.4, fairOverProb: 0.5, fairUnderProb: 0.5, modelOverProb: 0.4, modelUnderProb: 0.6, kellyStake: 0, kellyFraction: 0.25, source: 'Binomial' }, status: 'success' },
      { playerName: 'High', position: 'PG', statType: 'points', line: 20, mean: 25, overOdds: -110, underOdds: -110, result: { tier: 'HIGH', ev: 0.15, blendedProb: 0.65, fairOverProb: 0.5, fairUnderProb: 0.5, modelOverProb: 0.65, modelUnderProb: 0.35, kellyStake: 10, kellyFraction: 0.25, source: 'Binomial' }, status: 'success' },
      { playerName: 'Medium', position: 'SG', statType: 'points', line: 20, mean: 22, overOdds: -110, underOdds: -110, result: { tier: 'MEDIUM', ev: 0.07, blendedProb: 0.56, fairOverProb: 0.5, fairUnderProb: 0.5, modelOverProb: 0.56, modelUnderProb: 0.44, kellyStake: 4, kellyFraction: 0.25, source: 'Binomial' }, status: 'success' },
    ];

    const sorted = sortResults(players);
    expect(sorted[0].playerName).toBe('High');
    expect(sorted[1].playerName).toBe('Medium');
    expect(sorted[2].playerName).toBe('Reject');
  });

  it('sorts errors to the bottom', () => {
    const players: BatchPlayerResult[] = [
      { playerName: 'Error', position: '', statType: 'points', line: 20, mean: 0, overOdds: -110, underOdds: -110, result: null, status: 'player_not_found' },
      { playerName: 'Good', position: 'PG', statType: 'points', line: 20, mean: 25, overOdds: -110, underOdds: -110, result: { tier: 'HIGH', ev: 0.15, blendedProb: 0.65, fairOverProb: 0.5, fairUnderProb: 0.5, modelOverProb: 0.65, modelUnderProb: 0.35, kellyStake: 10, kellyFraction: 0.25, source: 'Binomial' }, status: 'success' },
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
    expect(result.players[0].result!.tier).toBeDefined();
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
    expect(result.players[0].mean).toBeCloseTo(48.25, 1);
    expect(result.players[0].result).not.toBeNull();
    expect(['HIGH', 'MEDIUM', 'LOW', 'REJECT']).toContain(result.players[0].result!.tier);
  });
});
