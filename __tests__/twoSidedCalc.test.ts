import {
  americanToDecimal,
  evaluateBothSides,
  pickBestSide,
  type TwoSidedInput,
} from '../src/lib/twoSidedCalc';

function makeInput(overrides: Partial<TwoSidedInput> = {}): TwoSidedInput {
  return {
    statType: 'points',
    position: 'SF',
    mean: 25,
    line: 24.5,
    overOdds: -110,
    underOdds: -110,
    bankroll: 100,
    kellyMode: 'standard',
    paceModifier: 0,
    injuryModifier: 0,
    ...overrides,
  };
}

describe('americanToDecimal', () => {
  it('converts negative odds correctly', () => {
    expect(americanToDecimal(-110)).toBeCloseTo(1.909, 2);
    expect(americanToDecimal(-200)).toBeCloseTo(1.5, 2);
  });

  it('converts positive odds correctly', () => {
    expect(americanToDecimal(150)).toBeCloseTo(2.5, 2);
    expect(americanToDecimal(200)).toBeCloseTo(3.0, 2);
  });
});

describe('evaluateBothSides', () => {
  it('returns both over and under evaluations', () => {
    const result = evaluateBothSides(makeInput());

    expect(result.over).toBeDefined();
    expect(result.under).toBeDefined();
    expect(result.source).toMatch(/Binomial|NegBinomial/);

    // Both sides have all the SideEvaluation fields
    for (const side of [result.over, result.under]) {
      expect(side.fairProb).toBeGreaterThanOrEqual(0);
      expect(side.fairProb).toBeLessThanOrEqual(1);
      expect(side.modelProb).toBeGreaterThanOrEqual(0);
      expect(side.modelProb).toBeLessThanOrEqual(1);
      expect(side.blendedProb).toBeGreaterThanOrEqual(0);
      expect(side.blendedProb).toBeLessThanOrEqual(1);
      expect(typeof side.ev).toBe('number');
      expect(side.kellyStake).toBeGreaterThanOrEqual(0);
      expect(['HIGH', 'MEDIUM', 'LOW', 'REJECT']).toContain(side.tier);
    }
  });

  it('over and under blended probabilities sum to ~1 at fair odds', () => {
    const result = evaluateBothSides(makeInput({ overOdds: -110, underOdds: -110 }));
    // After devig + 60/40 blend, sum should be close to 1
    expect(result.over.blendedProb + result.under.blendedProb).toBeCloseTo(1, 1);
  });

  it('uses NegBinomial source for non-points stats', () => {
    const result = evaluateBothSides(makeInput({ statType: 'rebounds', mean: 8.2 }));
    expect(result.source).toBe('NegBinomial');
  });

  it('uses Binomial source for points stats', () => {
    const result = evaluateBothSides(makeInput({ statType: 'points' }));
    expect(result.source).toBe('Binomial');
  });

  it('mean above the line favors over (higher over EV)', () => {
    const result = evaluateBothSides(makeInput({ mean: 30, line: 24.5 }));
    expect(result.over.ev).toBeGreaterThan(result.under.ev);
  });

  it('mean below the line favors under (higher under EV)', () => {
    const result = evaluateBothSides(makeInput({ mean: 18, line: 24.5 }));
    expect(result.under.ev).toBeGreaterThan(result.over.ev);
  });

  it('strong over edge produces a HIGH or MEDIUM tier on over and REJECT on under', () => {
    const result = evaluateBothSides(makeInput({ mean: 32, line: 24.5 }));
    expect(['HIGH', 'MEDIUM']).toContain(result.over.tier);
    expect(result.under.tier).toBe('REJECT');
  });

  it('strong under edge produces a HIGH or MEDIUM tier on under and REJECT on over', () => {
    const result = evaluateBothSides(makeInput({ mean: 16, line: 24.5 }));
    expect(['HIGH', 'MEDIUM']).toContain(result.under.tier);
    expect(result.over.tier).toBe('REJECT');
  });

  it('respects positive pace modifier on over and inverse on under', () => {
    const baseline = evaluateBothSides(makeInput({ mean: 25, line: 24.5 }));
    const boosted = evaluateBothSides(makeInput({ mean: 25, line: 24.5, paceModifier: 5 }));
    expect(boosted.over.blendedProb).toBeGreaterThan(baseline.over.blendedProb);
    expect(boosted.under.blendedProb).toBeLessThan(baseline.under.blendedProb);
  });

  it('respects injury modifier the same way as pace', () => {
    const baseline = evaluateBothSides(makeInput({ mean: 25, line: 24.5 }));
    const boosted = evaluateBothSides(makeInput({ mean: 25, line: 24.5, injuryModifier: 4 }));
    expect(boosted.over.blendedProb).toBeGreaterThan(baseline.over.blendedProb);
    expect(boosted.under.blendedProb).toBeLessThan(baseline.under.blendedProb);
  });

  it('zero modifiers leave the probabilities unchanged versus a no-modifier path', () => {
    const a = evaluateBothSides(makeInput({ mean: 25, line: 24.5, paceModifier: 0, injuryModifier: 0 }));
    const b = evaluateBothSides(makeInput({ mean: 25, line: 24.5 }));
    expect(a.over.blendedProb).toBeCloseTo(b.over.blendedProb, 6);
    expect(a.under.blendedProb).toBeCloseTo(b.under.blendedProb, 6);
  });

  it('handles non-symmetric odds (juiced over)', () => {
    const result = evaluateBothSides(makeInput({ overOdds: -150, underOdds: 130 }));
    // Over is more expensive → fair over prob should be higher than fair under
    expect(result.over.fairProb).toBeGreaterThan(result.under.fairProb);
  });

  it('demon kelly mode uses smaller stakes than standard', () => {
    const standard = evaluateBothSides(makeInput({ mean: 30, line: 24.5, kellyMode: 'standard' }));
    const demon = evaluateBothSides(makeInput({ mean: 30, line: 24.5, kellyMode: 'demon' }));
    if (standard.over.kellyStake > 0 && demon.over.kellyStake > 0) {
      expect(demon.over.kellyStake).toBeLessThan(standard.over.kellyStake);
    }
    expect(demon.over.kellyFraction).toBe(0.125);
    expect(standard.over.kellyFraction).toBe(0.25);
  });

  it('does not modify the math primitives (regression sanity check)', () => {
    // Calling twice should give identical results — math is pure
    const a = evaluateBothSides(makeInput({ mean: 25, line: 24.5 }));
    const b = evaluateBothSides(makeInput({ mean: 25, line: 24.5 }));
    expect(a).toEqual(b);
  });
});

describe('pickBestSide', () => {
  it('picks the side with the higher tier', () => {
    const result = evaluateBothSides(makeInput({ mean: 32, line: 24.5 }));
    expect(pickBestSide(result)).toBe('over');
  });

  it('picks under when under has the better edge', () => {
    const result = evaluateBothSides(makeInput({ mean: 16, line: 24.5 }));
    expect(pickBestSide(result)).toBe('under');
  });

  it('still picks a side when both are REJECT so the row stays visible (Option A)', () => {
    // A line right at the mean with juiced odds → both sides REJECT
    const result = evaluateBothSides(makeInput({ mean: 24.5, line: 24.5, overOdds: -150, underOdds: -150 }));
    expect(result.over.tier).toBe('REJECT');
    expect(result.under.tier).toBe('REJECT');
    const best = pickBestSide(result);
    expect(['over', 'under']).toContain(best);
    // Whichever side we pick, its tier is still REJECT, so the row will display
    // as REJECT in the table — that's the contract for Option A.
    expect(result[best].tier).toBe('REJECT');
  });

  it('falls through to over when both tiers and both EVs are exactly equal', () => {
    // Synthetic equal-EV case: stub the evaluation directly
    const equal = {
      over: { fairProb: 0.5, modelProb: 0.5, blendedProb: 0.5, ev: 0, kellyStake: 0, kellyFraction: 0.25, tier: 'REJECT' as const },
      under: { fairProb: 0.5, modelProb: 0.5, blendedProb: 0.5, ev: 0, kellyStake: 0, kellyFraction: 0.25, tier: 'REJECT' as const },
      source: 'Binomial',
    };
    expect(pickBestSide(equal)).toBe('over');
  });
});
