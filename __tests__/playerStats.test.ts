import { mapPosition, type PlayerSeasonAvg } from '../src/lib/playerStats';
import type { SeasonType, BlendWeights } from '../src/lib/playerStats';

describe('mapPosition', () => {
  it('maps G to PG', () => {
    expect(mapPosition('G')).toBe('PG');
  });

  it('maps PG to PG', () => {
    expect(mapPosition('PG')).toBe('PG');
  });

  it('maps SG to SG', () => {
    expect(mapPosition('SG')).toBe('SG');
  });

  it('maps G-F to SG', () => {
    expect(mapPosition('G-F')).toBe('SG');
  });

  it('maps F-G to SG', () => {
    expect(mapPosition('F-G')).toBe('SG');
  });

  it('maps F to PF', () => {
    expect(mapPosition('F')).toBe('PF');
  });

  it('maps PF to PF', () => {
    expect(mapPosition('PF')).toBe('PF');
  });

  it('maps SF to SF', () => {
    expect(mapPosition('SF')).toBe('SF');
  });

  it('maps C to C', () => {
    expect(mapPosition('C')).toBe('C');
  });

  it('maps F-C to C', () => {
    expect(mapPosition('F-C')).toBe('C');
  });

  it('maps C-F to C', () => {
    expect(mapPosition('C-F')).toBe('C');
  });

  it('defaults to SF for unknown position', () => {
    expect(mapPosition('')).toBe('SF');
    expect(mapPosition('XYZ')).toBe('SF');
  });

  it('handles lowercase input', () => {
    expect(mapPosition('g')).toBe('PG');
    expect(mapPosition('f-c')).toBe('C');
  });

  it('handles whitespace', () => {
    expect(mapPosition(' G ')).toBe('PG');
    expect(mapPosition('  C  ')).toBe('C');
  });
});

// =============================================================================
// PlayerSeasonAvg shape — postseason fields are backwards-compatible
// =============================================================================
//
// The /api/player-stats route returns this object. The actual API handler is
// integration-tested via __tests__/playerStatsBlend.test.ts (the pure-math
// layer it depends on) — these tests document the shape contract that the
// downstream consumers (batchProcessor, aiAnalysis) rely on.
describe('PlayerSeasonAvg shape', () => {
  it('accepts a regular-season-only player without optional postseason fields', () => {
    // No seasonType, no blendWeights, no gamesPlayed → still valid (legacy
    // path or pre-postseason cached payload).
    const avg: PlayerSeasonAvg = {
      playerName: 'Regular Player',
      position: 'PG',
      team: 'BOS',
      stats: {
        points: 24.0,
        rebounds: 5.0,
        assists: 6.0,
        steals: 1.1,
        blocks: 0.4,
        threes: 2.5,
        turnovers: 2.8,
      },
    };
    expect(avg.seasonType).toBeUndefined();
    expect(avg.blendWeights).toBeUndefined();
    expect(avg.gamesPlayed).toBeUndefined();
  });

  it('accepts a playoffs-blended player with full postseason metadata', () => {
    const avg: PlayerSeasonAvg = {
      playerName: 'Playoffs Player',
      position: 'SF',
      team: 'BOS',
      stats: {
        points: 26.4,
        rebounds: 7.2,
        assists: 5.5,
        steals: 1.3,
        blocks: 0.6,
        threes: 3.1,
        turnovers: 2.9,
      },
      seasonType: 'playoffs',
      blendWeights: { regular: 0.65, playoffs: 0.35, finals: 0 },
      gamesPlayed: { regular: 78, playoffs: 14, finals: 0 },
    };
    expect(avg.seasonType).toBe('playoffs');
    expect(avg.blendWeights?.playoffs).toBeCloseTo(0.35, 5);
    expect(avg.gamesPlayed?.finals).toBe(0);
  });

  it('accepts a Finals player with all three slices in the blend', () => {
    const avg: PlayerSeasonAvg = {
      playerName: 'Finals Player',
      position: 'C',
      team: 'BOS',
      stats: {
        points: 22.1,
        rebounds: 11.0,
        assists: 4.0,
        steals: 0.8,
        blocks: 1.9,
        threes: 0.3,
        turnovers: 2.4,
      },
      seasonType: 'finals',
      blendWeights: { regular: 0.25, playoffs: 0.35, finals: 0.4 },
      gamesPlayed: { regular: 75, playoffs: 14, finals: 5 },
    };
    expect(avg.seasonType).toBe('finals');
    // Sanity: weights sum to 1
    const sum =
      (avg.blendWeights?.regular ?? 0) +
      (avg.blendWeights?.playoffs ?? 0) +
      (avg.blendWeights?.finals ?? 0);
    expect(sum).toBeCloseTo(1, 5);
  });

  it('re-exports SeasonType and BlendWeights from playerStatsBlend', () => {
    // Compile-time check: the names below must resolve. If the re-export
    // is removed from playerStats.ts, this file fails to type-check, which
    // would force downstream consumers to import from playerStatsBlend
    // directly — exactly what we are trying to avoid.
    const t: SeasonType = 'finals';
    const w: BlendWeights = { regular: 0.25, playoffs: 0.35, finals: 0.4 };
    expect(t).toBe('finals');
    expect(w.finals).toBe(0.4);
  });
});
