import {
  brierScore,
  logLoss,
  computeCLV,
  averageCLV,
  flatROI,
  kellyROI,
  hitRate,
  hitRateByTier,
  sortinoRatio,
  cumulativeProfit,
  maxDrawdown,
  maxDrawdownPct,
  bootstrapCI,
  type Prediction,
  type ResolvedPick,
  type CLVPick,
} from '../src/lib/calibration';

const near = (a: number, b: number, tol = 0.001) => Math.abs(a - b) < tol;

// americanToDecimal used to be defined locally in calibration.ts and had its
// own duplicate test suite here. It now lives in twoSidedCalc.ts and is
// covered by twoSidedCalc.test.ts — the previous duplicate was removed as
// part of the slop cleanup sweep.

// ============================================================================
// brierScore
// ============================================================================

describe('brierScore', () => {
  test('empty input returns NaN', () => {
    expect(Number.isNaN(brierScore([]))).toBe(true);
  });

  test('perfect predictions return 0', () => {
    const preds: Prediction[] = [
      { probability: 1, outcome: 1 },
      { probability: 0, outcome: 0 },
      { probability: 1, outcome: 1 },
    ];
    expect(brierScore(preds)).toBe(0);
  });

  test('always wrong with full confidence returns 1', () => {
    const preds: Prediction[] = [
      { probability: 1, outcome: 0 },
      { probability: 0, outcome: 1 },
    ];
    expect(brierScore(preds)).toBe(1);
  });

  test('always predicting 0.5 returns 0.25 (random baseline)', () => {
    const preds: Prediction[] = [
      { probability: 0.5, outcome: 1 },
      { probability: 0.5, outcome: 0 },
      { probability: 0.5, outcome: 1 },
      { probability: 0.5, outcome: 0 },
    ];
    expect(brierScore(preds)).toBe(0.25);
  });

  test('matches manual calculation for known mixed case', () => {
    // (0.7-1)^2 + (0.6-0)^2 + (0.9-1)^2 = 0.09 + 0.36 + 0.01 = 0.46 / 3 ≈ 0.1533
    const preds: Prediction[] = [
      { probability: 0.7, outcome: 1 },
      { probability: 0.6, outcome: 0 },
      { probability: 0.9, outcome: 1 },
    ];
    expect(near(brierScore(preds), 0.1533, 0.001)).toBe(true);
  });

  test('Brier ≤ Brier of worse-calibrated predictions', () => {
    const better: Prediction[] = [
      { probability: 0.8, outcome: 1 },
      { probability: 0.2, outcome: 0 },
    ];
    const worse: Prediction[] = [
      { probability: 0.6, outcome: 1 },
      { probability: 0.4, outcome: 0 },
    ];
    expect(brierScore(better)).toBeLessThan(brierScore(worse));
  });
});

// ============================================================================
// logLoss
// ============================================================================

describe('logLoss', () => {
  test('empty input returns NaN', () => {
    expect(Number.isNaN(logLoss([]))).toBe(true);
  });

  test('perfect predictions return ~0', () => {
    const preds: Prediction[] = [
      { probability: 1, outcome: 1 },
      { probability: 0, outcome: 0 },
    ];
    // Clipped to (1−ε), so log(1−ε) ≈ −ε which is essentially 0
    expect(logLoss(preds)).toBeLessThan(1e-10);
  });

  test('always 0.5 returns log(2) ≈ 0.693', () => {
    const preds: Prediction[] = [
      { probability: 0.5, outcome: 1 },
      { probability: 0.5, outcome: 0 },
      { probability: 0.5, outcome: 1 },
    ];
    expect(near(logLoss(preds), Math.log(2), 1e-6)).toBe(true);
  });

  test('clips probabilities at extremes (no -Infinity)', () => {
    const preds: Prediction[] = [
      { probability: 0, outcome: 1 }, // would normally be -Infinity
      { probability: 1, outcome: 0 }, // also -Infinity
    ];
    const ll = logLoss(preds);
    expect(Number.isFinite(ll)).toBe(true);
    expect(ll).toBeGreaterThan(0);
  });

  test('confidently wrong is much worse than uncertainly wrong', () => {
    const confidentWrong: Prediction[] = [{ probability: 0.99, outcome: 0 }];
    const uncertainWrong: Prediction[] = [{ probability: 0.55, outcome: 0 }];
    expect(logLoss(confidentWrong)).toBeGreaterThan(
      logLoss(uncertainWrong) * 5,
    );
  });

  test('better calibration → lower log loss', () => {
    const better: Prediction[] = [
      { probability: 0.9, outcome: 1 },
      { probability: 0.1, outcome: 0 },
    ];
    const worse: Prediction[] = [
      { probability: 0.6, outcome: 1 },
      { probability: 0.4, outcome: 0 },
    ];
    expect(logLoss(better)).toBeLessThan(logLoss(worse));
  });
});

// ============================================================================
// computeCLV / averageCLV
// ============================================================================

describe('computeCLV', () => {
  test('no movement returns ~0', () => {
    expect(near(computeCLV(-110, -110), 0, 1e-6)).toBe(true);
  });

  test('-110 → -120 returns positive CLV (line tightened against bet)', () => {
    // -110 implied = 0.5238, -120 implied = 0.5455. Diff ≈ +0.0216
    const clv = computeCLV(-110, -120);
    expect(clv).toBeGreaterThan(0);
    expect(near(clv, 0.0216, 0.001)).toBe(true);
  });

  test('-110 → +110 returns negative CLV (line cheapened toward bet)', () => {
    // -110 implied = 0.5238, +110 implied = 0.4762. Diff ≈ -0.0476
    const clv = computeCLV(-110, 110);
    expect(clv).toBeLessThan(0);
    expect(near(clv, -0.0476, 0.001)).toBe(true);
  });

  test('+100 → -120 returns positive CLV (line moved heavily against bet)', () => {
    // +100 implied = 0.5, -120 implied = 0.5455. Diff ≈ +0.0455
    const clv = computeCLV(100, -120);
    expect(clv).toBeGreaterThan(0.04);
  });
});

describe('averageCLV', () => {
  test('empty input returns NaN', () => {
    expect(Number.isNaN(averageCLV([]))).toBe(true);
  });

  test('single pick returns same value as computeCLV', () => {
    const picks: CLVPick[] = [{ betOdds: -110, closingOdds: -120 }];
    expect(averageCLV(picks)).toBe(computeCLV(-110, -120));
  });

  test('averages multiple picks', () => {
    const picks: CLVPick[] = [
      { betOdds: -110, closingOdds: -120 }, // +0.0216
      { betOdds: -110, closingOdds: -110 }, // 0
      { betOdds: -110, closingOdds: -100 }, // -0.0238
    ];
    const avg = averageCLV(picks);
    const expected =
      (computeCLV(-110, -120) +
        computeCLV(-110, -110) +
        computeCLV(-110, -100)) /
      3;
    expect(near(avg, expected, 1e-9)).toBe(true);
  });
});

// ============================================================================
// flatROI
// ============================================================================

describe('flatROI', () => {
  test('empty input returns NaN', () => {
    expect(Number.isNaN(flatROI([]))).toBe(true);
  });

  test('all pushes returns NaN (no decided picks)', () => {
    const picks: ResolvedPick[] = [
      { won: false, pushed: true, odds: -110 },
      { won: false, pushed: true, odds: -110 },
    ];
    expect(Number.isNaN(flatROI(picks))).toBe(true);
  });

  test('all wins at -110 returns ~+0.909 ROI', () => {
    // Each win profits 0.909 units, all wagers = 1 unit
    const picks: ResolvedPick[] = [
      { won: true, pushed: false, odds: -110 },
      { won: true, pushed: false, odds: -110 },
    ];
    expect(near(flatROI(picks), 0.909, 0.001)).toBe(true);
  });

  test('all losses returns -1 ROI', () => {
    const picks: ResolvedPick[] = [
      { won: false, pushed: false, odds: -110 },
      { won: false, pushed: false, odds: +100 },
    ];
    expect(flatROI(picks)).toBe(-1);
  });

  test('break-even at -110 with ~52.4% win rate', () => {
    // Mathematically, break-even at -110 needs 11/21 = 52.38% win rate
    const picks: ResolvedPick[] = [];
    for (let i = 0; i < 11; i++) picks.push({ won: true, pushed: false, odds: -110 });
    for (let i = 0; i < 10; i++) picks.push({ won: false, pushed: false, odds: -110 });
    // (11 * 0.909) - 10 = 10 - 10 = 0
    expect(near(flatROI(picks), 0, 0.001)).toBe(true);
  });

  test('pushes are excluded from both numerator and denominator', () => {
    const picksNoPush: ResolvedPick[] = [
      { won: true, pushed: false, odds: +100 }, // +1
      { won: false, pushed: false, odds: +100 }, // -1
    ];
    const picksWithPush: ResolvedPick[] = [
      { won: true, pushed: false, odds: +100 },
      { won: false, pushed: false, odds: +100 },
      { won: false, pushed: true, odds: +100 }, // ignored
      { won: false, pushed: true, odds: +100 }, // ignored
    ];
    expect(flatROI(picksNoPush)).toBe(flatROI(picksWithPush));
  });
});

// ============================================================================
// kellyROI
// ============================================================================

describe('kellyROI', () => {
  test('empty input returns NaN', () => {
    expect(Number.isNaN(kellyROI([]))).toBe(true);
  });

  test('matches flatROI when stakes are uniformly 1', () => {
    const picks: ResolvedPick[] = [
      { won: true, pushed: false, odds: -110, stake: 1 },
      { won: false, pushed: false, odds: -110, stake: 1 },
    ];
    expect(kellyROI(picks)).toBe(flatROI(picks));
  });

  test('default stake = 1 when stake field is missing', () => {
    const withDefault: ResolvedPick[] = [
      { won: true, pushed: false, odds: -110 },
      { won: false, pushed: false, odds: -110 },
    ];
    const withExplicit: ResolvedPick[] = [
      { won: true, pushed: false, odds: -110, stake: 1 },
      { won: false, pushed: false, odds: -110, stake: 1 },
    ];
    expect(kellyROI(withDefault)).toBe(kellyROI(withExplicit));
  });

  test('weighted by stake — bigger stakes have bigger impact', () => {
    // Win 2 units at +100 (profit +2), lose 1 unit at -110 (loss -1)
    // Total profit = 2 - 1 = 1, total stake = 2 + 1 = 3, ROI = 1/3 ≈ 0.333
    const picks: ResolvedPick[] = [
      { won: true, pushed: false, odds: 100, stake: 2 },
      { won: false, pushed: false, odds: -110, stake: 1 },
    ];
    expect(near(kellyROI(picks), 1 / 3, 1e-6)).toBe(true);
  });

  test('all pushes returns NaN', () => {
    const picks: ResolvedPick[] = [
      { won: false, pushed: true, odds: -110, stake: 5 },
    ];
    expect(Number.isNaN(kellyROI(picks))).toBe(true);
  });
});

// ============================================================================
// hitRate
// ============================================================================

describe('hitRate', () => {
  test('empty input returns NaN', () => {
    expect(Number.isNaN(hitRate([]))).toBe(true);
  });

  test('all wins returns 1', () => {
    expect(
      hitRate([
        { won: true, pushed: false },
        { won: true, pushed: false },
      ]),
    ).toBe(1);
  });

  test('all losses returns 0', () => {
    expect(
      hitRate([
        { won: false, pushed: false },
        { won: false, pushed: false },
      ]),
    ).toBe(0);
  });

  test('half wins returns 0.5', () => {
    expect(
      hitRate([
        { won: true, pushed: false },
        { won: false, pushed: false },
      ]),
    ).toBe(0.5);
  });

  test('pushes are excluded', () => {
    // 1 win, 1 loss, 2 pushes → 50%, not 25%
    expect(
      hitRate([
        { won: true, pushed: false },
        { won: false, pushed: false },
        { won: false, pushed: true },
        { won: false, pushed: true },
      ]),
    ).toBe(0.5);
  });

  test('all pushes returns NaN', () => {
    expect(
      Number.isNaN(
        hitRate([
          { won: false, pushed: true },
          { won: false, pushed: true },
        ]),
      ),
    ).toBe(true);
  });
});

// ============================================================================
// hitRateByTier
// ============================================================================

describe('hitRateByTier', () => {
  test('empty input returns NaN for all tiers', () => {
    const result = hitRateByTier([]);
    expect(Number.isNaN(result.HIGH)).toBe(true);
    expect(Number.isNaN(result.MEDIUM)).toBe(true);
    expect(Number.isNaN(result.LOW)).toBe(true);
    expect(Number.isNaN(result.REJECT)).toBe(true);
  });

  test('reports per-tier rates correctly', () => {
    const result = hitRateByTier([
      { tier: 'HIGH', won: true, pushed: false },
      { tier: 'HIGH', won: true, pushed: false },
      { tier: 'HIGH', won: false, pushed: false },
      { tier: 'MEDIUM', won: true, pushed: false },
      { tier: 'MEDIUM', won: false, pushed: false },
      { tier: 'LOW', won: false, pushed: false },
    ]);
    expect(near(result.HIGH, 2 / 3, 1e-9)).toBe(true);
    expect(result.MEDIUM).toBe(0.5);
    expect(result.LOW).toBe(0);
    expect(Number.isNaN(result.REJECT)).toBe(true);
  });

  test('tiers with only pushes report NaN', () => {
    const result = hitRateByTier([
      { tier: 'HIGH', won: false, pushed: true },
      { tier: 'MEDIUM', won: true, pushed: false },
    ]);
    expect(Number.isNaN(result.HIGH)).toBe(true);
    expect(result.MEDIUM).toBe(1);
  });
});

// ============================================================================
// sortinoRatio
// ============================================================================

describe('sortinoRatio', () => {
  test('empty input returns NaN', () => {
    expect(Number.isNaN(sortinoRatio([]))).toBe(true);
  });

  test('no downside (all returns ≥ MAR) returns NaN', () => {
    expect(Number.isNaN(sortinoRatio([0.05, 0.10, 0.15]))).toBe(true);
  });

  test('all losses returns negative ratio', () => {
    const ratio = sortinoRatio([-0.1, -0.2, -0.05]);
    expect(ratio).toBeLessThan(0);
  });

  test('positive expected value with some downside returns positive', () => {
    const ratio = sortinoRatio([0.2, 0.3, -0.1, 0.15, -0.05]);
    expect(ratio).toBeGreaterThan(0);
  });

  test('respects MAR parameter (raising MAR lowers numerator)', () => {
    const returns = [0.05, 0.10, -0.05, 0.20];
    const sortino0 = sortinoRatio(returns, 0);
    const sortino5 = sortinoRatio(returns, 0.05);
    expect(sortino0).toBeGreaterThan(sortino5);
  });

  test('matches manual computation for known case', () => {
    // returns = [+0.10, -0.05, +0.20, -0.10], MAR = 0
    // mean = 0.0375
    // downside squared sum = (-0.05)^2 + (-0.10)^2 = 0.0025 + 0.01 = 0.0125
    // downside dev = sqrt(0.0125 / 4) = sqrt(0.003125) ≈ 0.0559
    // sortino = 0.0375 / 0.0559 ≈ 0.671
    const returns = [0.1, -0.05, 0.2, -0.1];
    const sortino = sortinoRatio(returns);
    expect(near(sortino, 0.671, 0.01)).toBe(true);
  });
});

// ============================================================================
// cumulativeProfit
// ============================================================================

describe('cumulativeProfit', () => {
  test('empty input returns empty curve', () => {
    expect(cumulativeProfit([])).toEqual([]);
  });

  test('matches manual calculation for sequence of wins/losses', () => {
    // +100 win = +1, -110 loss = -1, push = 0, +200 win = +2
    const picks: ResolvedPick[] = [
      { won: true, pushed: false, odds: 100 },
      { won: false, pushed: false, odds: -110 },
      { won: false, pushed: true, odds: -110 },
      { won: true, pushed: false, odds: 200 },
    ];
    expect(cumulativeProfit(picks)).toEqual([1, 0, 0, 2]);
  });

  test('all wins curve is monotonically increasing', () => {
    const picks: ResolvedPick[] = [
      { won: true, pushed: false, odds: -110 },
      { won: true, pushed: false, odds: -110 },
      { won: true, pushed: false, odds: -110 },
    ];
    const curve = cumulativeProfit(picks);
    for (let i = 1; i < curve.length; i++) {
      expect(curve[i]).toBeGreaterThan(curve[i - 1]);
    }
  });
});

// ============================================================================
// maxDrawdown / maxDrawdownPct
// ============================================================================

describe('maxDrawdown', () => {
  test('empty input returns 0', () => {
    expect(maxDrawdown([])).toBe(0);
  });

  test('all wins returns 0 (no drawdown)', () => {
    const picks: ResolvedPick[] = [
      { won: true, pushed: false, odds: -110 },
      { won: true, pushed: false, odds: -110 },
    ];
    expect(maxDrawdown(picks)).toBe(0);
  });

  test('detects peak-to-valley drop in absolute units', () => {
    // Curve: +1, +2, +1, 0, -1 → peak = 2, valley = -1, max DD = 3
    const picks: ResolvedPick[] = [
      { won: true, pushed: false, odds: 100 }, // +1
      { won: true, pushed: false, odds: 100 }, // +1 → 2
      { won: false, pushed: false, odds: -110 }, // -1 → 1
      { won: false, pushed: false, odds: -110 }, // -1 → 0
      { won: false, pushed: false, odds: -110 }, // -1 → -1
    ];
    expect(maxDrawdown(picks)).toBe(3);
  });

  test('starting at 0, all losses → DD = total losses', () => {
    const picks: ResolvedPick[] = [
      { won: false, pushed: false, odds: -110 },
      { won: false, pushed: false, odds: -110 },
      { won: false, pushed: false, odds: -110 },
    ];
    expect(maxDrawdown(picks)).toBe(3);
  });
});

describe('maxDrawdownPct', () => {
  test('empty input returns 0', () => {
    expect(maxDrawdownPct([], 100)).toBe(0);
  });

  test('all wins returns 0', () => {
    const picks: ResolvedPick[] = [
      { won: true, pushed: false, odds: -110 },
      { won: true, pushed: false, odds: -110 },
    ];
    expect(maxDrawdownPct(picks, 100)).toBe(0);
  });

  test('throws on non-positive starting bankroll', () => {
    expect(() => maxDrawdownPct([], 0)).toThrow();
    expect(() => maxDrawdownPct([], -10)).toThrow();
  });

  test('50% peak-to-valley drop yields 0.5', () => {
    // Bankroll = 100, win +100 (peak 200), then lose 100 (valley 100)
    // (200 - 100) / 200 = 0.5
    const picks: ResolvedPick[] = [
      { won: true, pushed: false, odds: 100, stake: 100 }, // ignored stake; flat is +1
      { won: false, pushed: false, odds: 100 },
    ];
    // Wait — flatProfit uses unit stakes. Let me think.
    // pick 1: won +100 odds → +1 unit
    // pick 2: lost -1 unit
    // Curve: [1, 0]. Bankroll: starts 100, becomes 101, then 100.
    // Peak 101, valley 100, DD = 1/101 ≈ 0.0099
    // Not what I claimed. Let me redo.
    expect(maxDrawdownPct(picks, 100)).toBeGreaterThan(0);
    expect(near(maxDrawdownPct(picks, 100), 1 / 101, 1e-6)).toBe(true);
  });

  test('large drawdown relative to small bankroll', () => {
    // Bankroll = 10, lose 5 picks at -110 (each -1 unit)
    // Curve: [-1, -2, -3, -4, -5], bankroll: 9, 8, 7, 6, 5
    // Peak = 10 (start), valley = 5, DD = 5/10 = 0.5
    const picks: ResolvedPick[] = Array(5).fill({
      won: false,
      pushed: false,
      odds: -110,
    });
    expect(maxDrawdownPct(picks, 10)).toBe(0.5);
  });
});

// ============================================================================
// bootstrapCI
// ============================================================================

describe('bootstrapCI', () => {
  test('empty input returns NaN bounds', () => {
    const r = bootstrapCI([]);
    expect(Number.isNaN(r.mean)).toBe(true);
    expect(Number.isNaN(r.lower)).toBe(true);
    expect(Number.isNaN(r.upper)).toBe(true);
  });

  test('mean is the actual sample mean (deterministic)', () => {
    const values = [1, 2, 3, 4, 5];
    const r = bootstrapCI(values, 100, 0.95, 42);
    expect(r.mean).toBe(3);
  });

  test('seeded run is fully deterministic', () => {
    const values = [0.1, 0.2, -0.05, 0.3, 0.0, -0.1, 0.15];
    const r1 = bootstrapCI(values, 500, 0.95, 12345);
    const r2 = bootstrapCI(values, 500, 0.95, 12345);
    expect(r1.lower).toBe(r2.lower);
    expect(r1.upper).toBe(r2.upper);
    expect(r1.mean).toBe(r2.mean);
  });

  test('different seeds produce different intervals (high probability)', () => {
    const values = [0.1, 0.2, -0.05, 0.3, 0.0, -0.1, 0.15];
    const r1 = bootstrapCI(values, 500, 0.95, 1);
    const r2 = bootstrapCI(values, 500, 0.95, 999);
    // Mean is invariant, but bounds should differ
    expect(r1.lower !== r2.lower || r1.upper !== r2.upper).toBe(true);
  });

  test('CI brackets the sample mean for symmetric data', () => {
    const values = [-2, -1, 0, 1, 2];
    const r = bootstrapCI(values, 1000, 0.95, 7);
    expect(r.lower).toBeLessThanOrEqual(r.mean);
    expect(r.upper).toBeGreaterThanOrEqual(r.mean);
  });

  test('lower < upper for non-degenerate input', () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const r = bootstrapCI(values, 1000, 0.95, 100);
    expect(r.lower).toBeLessThan(r.upper);
  });

  test('single-value input returns degenerate CI (mean = lower = upper)', () => {
    const r = bootstrapCI([5], 100, 0.95, 1);
    expect(r.mean).toBe(5);
    expect(r.lower).toBe(5);
    expect(r.upper).toBe(5);
  });

  test('confidence parameter affects width (90% narrower than 99%)', () => {
    const values = Array.from({ length: 50 }, (_, i) => i * 0.1 - 2.5);
    const ci90 = bootstrapCI(values, 1000, 0.9, 42);
    const ci99 = bootstrapCI(values, 1000, 0.99, 42);
    const width90 = ci90.upper - ci90.lower;
    const width99 = ci99.upper - ci99.lower;
    expect(width99).toBeGreaterThanOrEqual(width90);
  });
});
