import {
  normCDF, normPPF, americanToImplied, devigProbit,
  negBinomPMF, negBinomCDF,
  modelCountingStat, modelPoints,
  applyModifiers, blendProbabilities, kellyStake, assignTier,
} from '../src/lib/math';

const near = (a: number, b: number, tol = 0.001) => Math.abs(a - b) < tol;

// ============================================================
describe('normCDF', () => {
  test('normCDF(0) = 0.5', () => {
    expect(near(normCDF(0), 0.5)).toBe(true);
  });
  test('normCDF(1.96) ≈ 0.975', () => {
    expect(near(normCDF(1.96), 0.975, 0.001)).toBe(true);
  });
  test('normCDF(-1.96) ≈ 0.025', () => {
    expect(near(normCDF(-1.96), 0.025, 0.001)).toBe(true);
  });
  test('normCDF(3) > 0.998', () => {
    expect(normCDF(3)).toBeGreaterThan(0.998);
  });
  test('symmetry: normCDF(x) + normCDF(-x) = 1', () => {
    for (const x of [0.5, 1.0, 1.5, 2.0, 2.5]) {
      expect(near(normCDF(x) + normCDF(-x), 1.0, 1e-6)).toBe(true);
    }
  });
});

// ============================================================
describe('normPPF', () => {
  test('normPPF(0.5) = 0', () => {
    expect(normPPF(0.5)).toBe(0);
  });
  test('normPPF(0.975) ≈ 1.96', () => {
    expect(near(normPPF(0.975), 1.96, 0.01)).toBe(true);
  });
  test('normPPF(0.025) ≈ -1.96', () => {
    expect(near(normPPF(0.025), -1.96, 0.01)).toBe(true);
  });
  test('round-trip: normCDF(normPPF(p)) = p', () => {
    for (const p of [0.1, 0.25, 0.5, 0.75, 0.9]) {
      expect(near(normCDF(normPPF(p)), p, 1e-4)).toBe(true);
    }
  });
});

// ============================================================
describe('americanToImplied', () => {
  test('-110 → 0.5238', () => {
    expect(near(americanToImplied(-110), 0.5238, 0.001)).toBe(true);
  });
  test('+100 → 0.5', () => {
    expect(americanToImplied(100)).toBeCloseTo(0.5);
  });
  test('+200 → 0.333', () => {
    expect(near(americanToImplied(200), 0.333, 0.001)).toBe(true);
  });
  test('-200 → 0.667', () => {
    expect(near(americanToImplied(-200), 0.667, 0.001)).toBe(true);
  });
});

// ============================================================
describe('devigProbit', () => {
  test('symmetric -110/-110 → 50/50', () => {
    const { over, under } = devigProbit(-110, -110);
    expect(near(over, 0.5, 0.001)).toBe(true);
    expect(near(under, 0.5, 0.001)).toBe(true);
  });
  test('over+under = 1.0 (fair market)', () => {
    const { over, under } = devigProbit(-150, 130);
    expect(near(over + under, 1.0, 0.001)).toBe(true);
  });
  test('heavy favourite -300/+240 → over > 0.72', () => {
    const { over } = devigProbit(-300, 240);
    expect(over).toBeGreaterThan(0.72);
  });
  test('known value: -112/-108 symmetric ≈ 50.4% over', () => {
    const { over } = devigProbit(-112, -108);
    expect(near(over, 0.504, 0.01)).toBe(true);
  });
});

// ============================================================
describe('negBinomPMF', () => {
  test('PMF(5, n=3.2, p=0.5) ≈ 0.100', () => {
    expect(near(negBinomPMF(5, 3.2, 0.5), 0.100, 0.015)).toBe(true);
  });
  test('PMF(0, n=3.2, p=0.8) > 0', () => {
    expect(negBinomPMF(0, 3.2, 0.8)).toBeGreaterThan(0);
  });
  test('PMF sum from 0 to 30 ≈ 1.0', () => {
    let sum = 0;
    for (let k = 0; k <= 30; k++) sum += negBinomPMF(k, 5, 0.5);
    expect(near(sum, 1.0, 0.01)).toBe(true);
  });
  test('negative k returns 0', () => {
    expect(negBinomPMF(-1, 5, 0.5)).toBe(0);
  });
});

// ============================================================
describe('negBinomCDF', () => {
  test('CDF(0, ...) = PMF(0, ...)', () => {
    expect(near(negBinomCDF(0, 5, 0.5), negBinomPMF(0, 5, 0.5), 1e-10)).toBe(true);
  });
  test('CDF is monotone increasing', () => {
    let prev = 0;
    for (let k = 0; k <= 20; k++) {
      const c = negBinomCDF(k, 5, 0.5);
      expect(c).toBeGreaterThanOrEqual(prev);
      prev = c;
    }
  });
  test('CDF(large k) → 1.0', () => {
    expect(negBinomCDF(50, 5, 0.5)).toBeGreaterThan(0.999);
  });
});

// ============================================================
describe('modelCountingStat', () => {
  test('returns overProb + underProb ≤ 1.0', () => {
    const r = modelCountingStat(8, 7, 'PG', 'assists');
    expect(r.overProb + r.underProb).toBeLessThanOrEqual(1.001);
  });
  test('high mean vs low line → high overProb', () => {
    const r = modelCountingStat(10, 7, 'C', 'rebounds');
    expect(r.overProb).toBeGreaterThan(0.75);
  });
  test('low mean vs high line → low overProb', () => {
    const r = modelCountingStat(4, 8, 'PG', 'assists');
    expect(r.overProb).toBeLessThan(0.10);
  });
  test('line at mean → overProb near 0.5', () => {
    const r = modelCountingStat(8, 8, 'SF', 'rebounds');
    expect(r.overProb).toBeGreaterThan(0.30);
    expect(r.overProb).toBeLessThan(0.70);
  });
  test('user-supplied std works without crashing', () => {
    const r = modelCountingStat(8, 7, 'PG', 'assists', 2.5);
    expect(r.overProb).toBeGreaterThan(0);
    expect(r.overProb).toBeLessThan(1);
  });
});

// ============================================================
describe('modelPoints', () => {
  test('mean well above line → high overProb', () => {
    const r = modelPoints(28, 22, 'SG');
    expect(r.overProb).toBeGreaterThan(0.70);
  });
  test('mean well below line → low overProb', () => {
    const r = modelPoints(15, 24, 'PG');
    expect(r.overProb).toBeLessThan(0.10);
  });
  test('mean at line → near 50%', () => {
    const r = modelPoints(22, 22, 'SF');
    expect(r.overProb).toBeGreaterThan(0.30);
    expect(r.overProb).toBeLessThan(0.70);
  });
  test('source is Binomial', () => {
    expect(modelPoints(22, 22, 'SF').source).toBe('Binomial');
  });
});

// ============================================================
describe('applyModifiers', () => {
  test('+3pp modifier adds 0.03 to decimal prob', () => {
    expect(near(applyModifiers(0.55, [{ name: 'pace', ppDelta: 3 }]), 0.58)).toBe(true);
  });
  test('-6pp modifier subtracts 0.06', () => {
    expect(near(applyModifiers(0.55, [{ name: 'blowout', ppDelta: -6 }]), 0.49)).toBe(true);
  });
  test('multiple modifiers sum correctly', () => {
    const r = applyModifiers(0.50, [
      { name: 'pace', ppDelta: 3 },
      { name: 'injury', ppDelta: 5 },
      { name: 'b2b', ppDelta: -2 },
    ]);
    expect(near(r, 0.56)).toBe(true);
  });
  test('clamps to 0.99 maximum', () => {
    expect(applyModifiers(0.95, [{ name: 'boost', ppDelta: 10 }])).toBe(0.99);
  });
  test('clamps to 0.01 minimum', () => {
    expect(applyModifiers(0.05, [{ name: 'crush', ppDelta: -10 }])).toBe(0.01);
  });
});

// ============================================================
describe('blendProbabilities', () => {
  test('60/40 blend', () => {
    expect(near(blendProbabilities(0.70, 0.50, 0.6), 0.62)).toBe(true);
  });
});

// ============================================================
describe('kellyStake', () => {
  test('standard 1/4 Kelly stake calculation', () => {
    expect(near(kellyStake(0.55, 2.0, 1, 'standard').stake, 0.025)).toBe(true);
  });
  test('demon 1/8 Kelly is half of standard', () => {
    const s = kellyStake(0.55, 2.0, 1, 'standard').stake;
    const d = kellyStake(0.55, 2.0, 1, 'demon').stake;
    expect(near(d, s / 2)).toBe(true);
  });
  test('negative EV → zero stake', () => {
    expect(kellyStake(0.40, 2.0, 1, 'standard').stake).toBe(0);
  });
  test('fraction is 0.25 for standard', () => {
    expect(kellyStake(0.55, 2.0, 1, 'standard').fraction).toBe(0.25);
  });
});

// ============================================================
describe('assignTier', () => {
  test('HIGH: prob>0.60, EV>0.10, 0 major flags', () => {
    expect(assignTier({ prob: 0.62, ev: 0.12, majorFlags: 0, minorFlags: 0 })).toBe('HIGH');
  });
  test('MEDIUM: prob 0.56, EV 0.07, 0 flags', () => {
    expect(assignTier({ prob: 0.56, ev: 0.07, majorFlags: 0, minorFlags: 0 })).toBe('MEDIUM');
  });
  test('LOW: prob 0.52, EV 0.03', () => {
    expect(assignTier({ prob: 0.52, ev: 0.03, majorFlags: 0, minorFlags: 0 })).toBe('LOW');
  });
  test('REJECT: prob below 0.50', () => {
    expect(assignTier({ prob: 0.48, ev: 0.10, majorFlags: 0, minorFlags: 0 })).toBe('REJECT');
  });
  test('REJECT: EV below 0.02', () => {
    expect(assignTier({ prob: 0.55, ev: 0.01, majorFlags: 0, minorFlags: 0 })).toBe('REJECT');
  });
  test('HIGH→MEDIUM when major flag present', () => {
    expect(assignTier({ prob: 0.62, ev: 0.12, majorFlags: 1, minorFlags: 0 })).toBe('MEDIUM');
  });
  test('MEDIUM→LOW when 2+ minor flags', () => {
    expect(assignTier({ prob: 0.56, ev: 0.07, majorFlags: 0, minorFlags: 2 })).toBe('LOW');
  });
});
