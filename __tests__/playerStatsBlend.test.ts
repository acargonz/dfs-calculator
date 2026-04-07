import {
  computePlayoffsWeight,
  computeFinalsWeight,
  computeBlendWeights,
  blendStats,
  determineSeasonType,
  determineSlateSeasonType,
  type RawStatsBlock,
  type PlayerSeasonSlice,
  type BlendInput,
} from '../src/lib/playerStatsBlend';

const ZERO: RawStatsBlock = {
  points: 0, rebounds: 0, assists: 0, steals: 0, blocks: 0, threes: 0, turnovers: 0,
};

function makeSlice(
  gamesPlayed: number,
  partial: Partial<RawStatsBlock> = {},
): PlayerSeasonSlice {
  return {
    gamesPlayed,
    stats: { ...ZERO, ...partial },
  };
}

// =============================================================================
// computePlayoffsWeight — single-knob curve, capped at 35%
// =============================================================================

describe('computePlayoffsWeight', () => {
  it('returns 0 for 0 games', () => {
    expect(computePlayoffsWeight(0)).toBe(0);
  });

  it('returns 0 for negative games (defensive)', () => {
    expect(computePlayoffsWeight(-1)).toBe(0);
    expect(computePlayoffsWeight(-100)).toBe(0);
  });

  it('returns 0 for NaN (defensive)', () => {
    expect(computePlayoffsWeight(NaN)).toBe(0);
  });

  it('ramps linearly at 2.5pp per game', () => {
    expect(computePlayoffsWeight(1)).toBeCloseTo(0.025, 5);
    expect(computePlayoffsWeight(2)).toBeCloseTo(0.05, 5);
    expect(computePlayoffsWeight(4)).toBeCloseTo(0.1, 5);
    expect(computePlayoffsWeight(10)).toBeCloseTo(0.25, 5);
  });

  it('caps at 35% by 14 games', () => {
    expect(computePlayoffsWeight(14)).toBeCloseTo(0.35, 5);
  });

  it('stays capped at 35% for higher game counts', () => {
    expect(computePlayoffsWeight(15)).toBeCloseTo(0.35, 5);
    expect(computePlayoffsWeight(28)).toBeCloseTo(0.35, 5);
    expect(computePlayoffsWeight(100)).toBeCloseTo(0.35, 5);
  });
});

// =============================================================================
// computeFinalsWeight — faster ramp, capped at 40%
// =============================================================================

describe('computeFinalsWeight', () => {
  it('returns 0 for 0 games', () => {
    expect(computeFinalsWeight(0)).toBe(0);
  });

  it('returns 0 for negative or NaN (defensive)', () => {
    expect(computeFinalsWeight(-1)).toBe(0);
    expect(computeFinalsWeight(NaN)).toBe(0);
  });

  it('ramps linearly at 8pp per game', () => {
    expect(computeFinalsWeight(1)).toBeCloseTo(0.08, 5);
    expect(computeFinalsWeight(2)).toBeCloseTo(0.16, 5);
    expect(computeFinalsWeight(3)).toBeCloseTo(0.24, 5);
    expect(computeFinalsWeight(4)).toBeCloseTo(0.32, 5);
  });

  it('caps at 40% by 5 games', () => {
    expect(computeFinalsWeight(5)).toBeCloseTo(0.4, 5);
  });

  it('stays capped at 40% through Game 7 and beyond', () => {
    expect(computeFinalsWeight(6)).toBeCloseTo(0.4, 5);
    expect(computeFinalsWeight(7)).toBeCloseTo(0.4, 5);
    expect(computeFinalsWeight(100)).toBeCloseTo(0.4, 5);
  });
});

// =============================================================================
// computeBlendWeights — three-way assembly with regular as the residual
// =============================================================================

describe('computeBlendWeights', () => {
  it('gives 100% regular when no postseason data', () => {
    const w = computeBlendWeights(0, 0);
    expect(w.regular).toBe(1);
    expect(w.playoffs).toBe(0);
    expect(w.finals).toBe(0);
  });

  it('gives partial playoffs weight mid-Round 1', () => {
    const w = computeBlendWeights(3, 0);
    expect(w.playoffs).toBeCloseTo(0.075, 5);
    expect(w.finals).toBe(0);
    expect(w.regular).toBeCloseTo(0.925, 5);
  });

  it('gives capped playoffs weight at end of Conference Finals', () => {
    const w = computeBlendWeights(14, 0);
    expect(w.playoffs).toBeCloseTo(0.35, 5);
    expect(w.regular).toBeCloseTo(0.65, 5);
    expect(w.finals).toBe(0);
  });

  it('mixes all three at Finals Game 1 (P=14, F=1)', () => {
    const w = computeBlendWeights(14, 1);
    expect(w.finals).toBeCloseTo(0.08, 5);
    expect(w.playoffs).toBeCloseTo(0.35, 5);
    expect(w.regular).toBeCloseTo(0.57, 5);
  });

  it('peaks at Game 7 of Finals with regular still at 25%', () => {
    const w = computeBlendWeights(14, 7);
    expect(w.finals).toBeCloseTo(0.4, 5);
    expect(w.playoffs).toBeCloseTo(0.35, 5);
    expect(w.regular).toBeCloseTo(0.25, 5);
    // Sanity: weights sum to 1
    expect(w.finals + w.playoffs + w.regular).toBeCloseTo(1, 5);
  });

  it('never lets regular weight go negative even with extreme inputs', () => {
    const w = computeBlendWeights(1000, 1000);
    expect(w.regular).toBeGreaterThanOrEqual(0);
    expect(w.regular).toBeCloseTo(0.25, 5);
  });
});

// =============================================================================
// blendStats — weighted average with redistribution for missing slices
// =============================================================================

describe('blendStats', () => {
  it('returns zero stats when all slices are missing', () => {
    expect(blendStats({}, { regular: 1, playoffs: 0, finals: 0 })).toEqual(ZERO);
  });

  it('returns zero stats when all slices have 0 games', () => {
    const input: BlendInput = {
      regular: makeSlice(0, { points: 25 }),
      playoffs: makeSlice(0, { points: 30 }),
    };
    expect(blendStats(input, { regular: 0.5, playoffs: 0.5, finals: 0 })).toEqual(ZERO);
  });

  it('uses regular only when only regular slice present', () => {
    const input: BlendInput = {
      regular: makeSlice(70, { points: 24, rebounds: 8, assists: 6 }),
    };
    const out = blendStats(input, { regular: 1, playoffs: 0, finals: 0 });
    expect(out.points).toBe(24);
    expect(out.rebounds).toBe(8);
    expect(out.assists).toBe(6);
  });

  it('blends regular + playoffs at correct ratio', () => {
    const input: BlendInput = {
      regular: makeSlice(70, { points: 20 }),
      playoffs: makeSlice(10, { points: 30 }),
    };
    // 75% regular (20) + 25% playoffs (30) = 15 + 7.5 = 22.5
    const out = blendStats(input, { regular: 0.75, playoffs: 0.25, finals: 0 });
    expect(out.points).toBeCloseTo(22.5, 5);
  });

  it('blends all three slices at Finals Game 4 weights', () => {
    const input: BlendInput = {
      regular: makeSlice(70, { points: 20 }),
      playoffs: makeSlice(14, { points: 25 }),
      finals: makeSlice(4, { points: 30 }),
    };
    // weights at P=14, F=4: r=0.33, p=0.35, f=0.32
    // 0.33*20 + 0.35*25 + 0.32*30 = 6.6 + 8.75 + 9.6 = 24.95
    const out = blendStats(input, { regular: 0.33, playoffs: 0.35, finals: 0.32 });
    expect(out.points).toBeCloseTo(24.95, 5);
  });

  it('redistributes weight when a slice has 0 games (still summing to 100% of available)', () => {
    // Caller asks for 50/50 regular/playoffs but playoffs has 0 games
    // → should fall back to 100% regular (not return 50% scaled)
    const input: BlendInput = {
      regular: makeSlice(70, { points: 24 }),
      playoffs: makeSlice(0, { points: 99 }),
    };
    const out = blendStats(input, { regular: 0.5, playoffs: 0.5, finals: 0 });
    expect(out.points).toBe(24);
  });

  it('redistributes when finals slice is missing entirely', () => {
    // Asked for 30/30/40 but finals is undefined → 30/30 split → 50/50
    const input: BlendInput = {
      regular: makeSlice(70, { points: 20 }),
      playoffs: makeSlice(14, { points: 30 }),
    };
    const out = blendStats(input, { regular: 0.3, playoffs: 0.3, finals: 0.4 });
    // Both 0.3 weights renormalize to 0.5 each: 0.5*20 + 0.5*30 = 25
    expect(out.points).toBe(25);
  });

  it('blends every stat field independently', () => {
    const input: BlendInput = {
      regular: makeSlice(70, { points: 20, rebounds: 10, assists: 5, steals: 1, blocks: 1, threes: 2, turnovers: 3 }),
      playoffs: makeSlice(10, { points: 30, rebounds: 12, assists: 6, steals: 0.5, blocks: 1.5, threes: 3, turnovers: 4 }),
    };
    const out = blendStats(input, { regular: 0.5, playoffs: 0.5, finals: 0 });
    expect(out.points).toBeCloseTo(25, 5);
    expect(out.rebounds).toBeCloseTo(11, 5);
    expect(out.assists).toBeCloseTo(5.5, 5);
    expect(out.steals).toBeCloseTo(0.75, 5);
    expect(out.blocks).toBeCloseTo(1.25, 5);
    expect(out.threes).toBeCloseTo(2.5, 5);
    expect(out.turnovers).toBeCloseTo(3.5, 5);
  });

  it('handles weight rounding drift via internal normalization', () => {
    // Weights that don't sum to exactly 1.0 (e.g., float drift from upstream)
    const input: BlendInput = {
      regular: makeSlice(70, { points: 20 }),
      playoffs: makeSlice(10, { points: 30 }),
    };
    // 0.5 + 0.4 = 0.9 (drift) → normalize → 0.5/0.9 + 0.4/0.9
    const out = blendStats(input, { regular: 0.5, playoffs: 0.4, finals: 0 });
    // Expected: (5/9)*20 + (4/9)*30 = 11.111... + 13.333... = 24.444...
    expect(out.points).toBeCloseTo(24.444, 2);
  });
});

// =============================================================================
// determineSeasonType — per-player label
// =============================================================================

describe('determineSeasonType', () => {
  it('returns regular when no playoff or finals data', () => {
    expect(determineSeasonType({ regular: makeSlice(70, { points: 24 }) })).toBe('regular');
  });

  it('returns regular for empty input', () => {
    expect(determineSeasonType({})).toBe('regular');
  });

  it('returns playoffs when playoffs data present, no Finals', () => {
    expect(
      determineSeasonType({
        regular: makeSlice(70),
        playoffs: makeSlice(8),
      }),
    ).toBe('playoffs');
  });

  it('returns finals when Finals data present', () => {
    expect(
      determineSeasonType({
        regular: makeSlice(70),
        playoffs: makeSlice(14),
        finals: makeSlice(3),
      }),
    ).toBe('finals');
  });

  it('returns finals even without playoff slice (edge case)', () => {
    expect(
      determineSeasonType({
        regular: makeSlice(70),
        finals: makeSlice(2),
      }),
    ).toBe('finals');
  });

  it('treats 0-game playoff slice as absent', () => {
    expect(
      determineSeasonType({
        regular: makeSlice(70),
        playoffs: makeSlice(0),
      }),
    ).toBe('regular');
  });

  it('treats 0-game finals slice as absent (falls back to playoffs label)', () => {
    expect(
      determineSeasonType({
        regular: makeSlice(70),
        playoffs: makeSlice(8),
        finals: makeSlice(0),
      }),
    ).toBe('playoffs');
  });
});

// =============================================================================
// determineSlateSeasonType — promote per-player labels to slate level
// =============================================================================

describe('determineSlateSeasonType', () => {
  it('returns regular for empty list', () => {
    expect(determineSlateSeasonType([])).toBe('regular');
  });

  it('returns regular when all players are regular', () => {
    expect(determineSlateSeasonType(['regular', 'regular', 'regular'])).toBe('regular');
  });

  it('returns playoffs when any player has playoff data', () => {
    expect(determineSlateSeasonType(['regular', 'playoffs', 'regular'])).toBe('playoffs');
  });

  it('returns finals when any player has Finals data', () => {
    expect(determineSlateSeasonType(['regular', 'playoffs', 'finals'])).toBe('finals');
  });

  it('returns finals when all players are Finals participants', () => {
    expect(determineSlateSeasonType(['finals', 'finals'])).toBe('finals');
  });

  it('finals beats playoffs in promotion', () => {
    expect(determineSlateSeasonType(['playoffs', 'playoffs', 'finals', 'playoffs'])).toBe('finals');
  });
});
