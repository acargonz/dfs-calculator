import {
  MONITORING_RULES,
  insufficientDataRule,
  pickMilestoneRule,
  clv7DayNegativeRule,
  drawdownWarningRule,
  drawdownCriticalRule,
  brierDegradationRule,
  type SystemStats,
} from '../src/lib/monitoringRules';
import type { PickSummary } from '../src/lib/pickHistory';

// ============================================================================
// Test fixtures
// ============================================================================

function makeSummary(overrides: Partial<PickSummary> = {}): PickSummary {
  return {
    totalPicks: 0,
    resolvedPicks: 0,
    pendingPicks: 0,
    pushedPicks: 0,
    hitRate: NaN,
    hitRateByTier: { HIGH: NaN, MEDIUM: NaN, LOW: NaN, REJECT: NaN },
    brierScore: NaN,
    logLoss: NaN,
    rawBrierScore: NaN,
    rawLogLoss: NaN,
    flatROI: NaN,
    netUnits: 0,
    maxDrawdown: 0,
    maxDrawdownPct: 0,
    picksWithCLV: 0,
    averageCLV: NaN,
    ...overrides,
  };
}

function makeStats(overrides: {
  allTime?: Partial<PickSummary>;
  last7Days?: Partial<PickSummary>;
  last30Days?: Partial<PickSummary>;
  baseline?: Partial<PickSummary> | null;
} = {}): SystemStats {
  return {
    allTime: makeSummary(overrides.allTime),
    last7Days: makeSummary(overrides.last7Days),
    last30Days: makeSummary(overrides.last30Days),
    baseline:
      overrides.baseline === null
        ? null
        : overrides.baseline === undefined
        ? null
        : makeSummary(overrides.baseline),
  };
}

// ============================================================================
// Registry sanity
// ============================================================================

describe('MONITORING_RULES registry', () => {
  test('exports all six rules', () => {
    expect(MONITORING_RULES).toHaveLength(6);
  });

  test('all rule IDs are unique', () => {
    const ids = MONITORING_RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('every rule has required fields', () => {
    for (const rule of MONITORING_RULES) {
      expect(rule.id).toBeTruthy();
      expect(rule.name).toBeTruthy();
      expect(rule.description).toBeTruthy();
      expect(['info', 'warning', 'critical']).toContain(rule.severity);
      expect(typeof rule.evaluate).toBe('function');
    }
  });

  test('critical rule appears before its overlapping warning', () => {
    const criticalIdx = MONITORING_RULES.findIndex((r) => r.id === 'drawdown-30pct');
    const warningIdx = MONITORING_RULES.findIndex((r) => r.id === 'drawdown-20pct');
    expect(criticalIdx).toBeLessThan(warningIdx);
  });
});

// ============================================================================
// insufficientDataRule
// ============================================================================

describe('insufficientDataRule', () => {
  test('triggers below 30 resolved picks', () => {
    const result = insufficientDataRule.evaluate(makeStats({ allTime: { resolvedPicks: 5 } }));
    expect(result).not.toBeNull();
    expect(result?.message).toContain('5 of 30');
    expect(result?.metadata.resolvedPicks).toBe(5);
  });

  test('does not trigger at exactly 30 resolved picks', () => {
    const result = insufficientDataRule.evaluate(makeStats({ allTime: { resolvedPicks: 30 } }));
    expect(result).toBeNull();
  });

  test('does not trigger above threshold', () => {
    const result = insufficientDataRule.evaluate(
      makeStats({ allTime: { resolvedPicks: 100 } }),
    );
    expect(result).toBeNull();
  });
});

// ============================================================================
// pickMilestoneRule
// ============================================================================

describe('pickMilestoneRule', () => {
  test('does not trigger below the first milestone', () => {
    const result = pickMilestoneRule.evaluate(makeStats({ allTime: { resolvedPicks: 49 } }));
    expect(result).toBeNull();
  });

  test('triggers exactly at 50 picks (first milestone)', () => {
    const result = pickMilestoneRule.evaluate(makeStats({ allTime: { resolvedPicks: 50 } }));
    expect(result).not.toBeNull();
    expect(result?.metadata.milestone).toBe(50);
    expect(result?.dedupKey).toBe('50');
  });

  test('uses highest crossed milestone (e.g., 280 → 250)', () => {
    const result = pickMilestoneRule.evaluate(
      makeStats({ allTime: { resolvedPicks: 280 } }),
    );
    expect(result?.metadata.milestone).toBe(250);
    expect(result?.dedupKey).toBe('250');
  });

  test('reports highest milestone after crossing 1000', () => {
    const result = pickMilestoneRule.evaluate(
      makeStats({ allTime: { resolvedPicks: 1500 } }),
    );
    expect(result?.metadata.milestone).toBe(1000);
  });

  test('message includes calibration snapshot fields', () => {
    const result = pickMilestoneRule.evaluate(
      makeStats({
        allTime: {
          resolvedPicks: 100,
          hitRate: 0.55,
          brierScore: 0.21,
          flatROI: 0.04,
          averageCLV: 0.015,
        },
      }),
    );
    expect(result?.message).toContain('100');
    expect(result?.message).toContain('55.0%');
  });
});

// ============================================================================
// clv7DayNegativeRule
// ============================================================================

describe('clv7DayNegativeRule', () => {
  test('does not trigger with insufficient samples', () => {
    const result = clv7DayNegativeRule.evaluate(
      makeStats({ last7Days: { picksWithCLV: 5, averageCLV: -0.05 } }),
    );
    expect(result).toBeNull();
  });

  test('does not trigger when CLV is positive', () => {
    const result = clv7DayNegativeRule.evaluate(
      makeStats({ last7Days: { picksWithCLV: 20, averageCLV: 0.02 } }),
    );
    expect(result).toBeNull();
  });

  test('does not trigger when CLV is at threshold', () => {
    const result = clv7DayNegativeRule.evaluate(
      makeStats({ last7Days: { picksWithCLV: 20, averageCLV: -0.005 } }),
    );
    expect(result).toBeNull();
  });

  test('triggers below threshold with sufficient samples', () => {
    const result = clv7DayNegativeRule.evaluate(
      makeStats({ last7Days: { picksWithCLV: 15, averageCLV: -0.03 } }),
    );
    expect(result).not.toBeNull();
    expect(result?.metadata.averageCLV).toBe(-0.03);
    expect(result?.metadata.picksWithCLV).toBe(15);
  });

  test('message communicates pause-and-review intent', () => {
    const result = clv7DayNegativeRule.evaluate(
      makeStats({ last7Days: { picksWithCLV: 12, averageCLV: -0.025 } }),
    );
    expect(result?.message.toLowerCase()).toContain('pause');
  });
});

// ============================================================================
// drawdownWarningRule
// ============================================================================

describe('drawdownWarningRule', () => {
  test('does not trigger below 20% drawdown', () => {
    const result = drawdownWarningRule.evaluate(
      makeStats({ allTime: { maxDrawdownPct: 0.15 } }),
    );
    expect(result).toBeNull();
  });

  test('triggers between 20% and 30%', () => {
    const result = drawdownWarningRule.evaluate(
      makeStats({ allTime: { maxDrawdownPct: 0.25 } }),
    );
    expect(result).not.toBeNull();
    expect(result?.metadata.maxDrawdownPct).toBe(0.25);
  });

  test('does NOT trigger above 30% (critical takes over)', () => {
    const result = drawdownWarningRule.evaluate(
      makeStats({ allTime: { maxDrawdownPct: 0.35 } }),
    );
    expect(result).toBeNull();
  });
});

// ============================================================================
// drawdownCriticalRule
// ============================================================================

describe('drawdownCriticalRule', () => {
  test('does not trigger below 30%', () => {
    const result = drawdownCriticalRule.evaluate(
      makeStats({ allTime: { maxDrawdownPct: 0.29 } }),
    );
    expect(result).toBeNull();
  });

  test('triggers at exactly 30%', () => {
    const result = drawdownCriticalRule.evaluate(
      makeStats({ allTime: { maxDrawdownPct: 0.30 } }),
    );
    expect(result).not.toBeNull();
  });

  test('triggers well above 30%', () => {
    const result = drawdownCriticalRule.evaluate(
      makeStats({ allTime: { maxDrawdownPct: 0.55 } }),
    );
    expect(result).not.toBeNull();
    expect(result?.message).toContain('CRITICAL');
  });
});

// ============================================================================
// brierDegradationRule
// ============================================================================

describe('brierDegradationRule', () => {
  test('does not trigger without a baseline', () => {
    const result = brierDegradationRule.evaluate(
      makeStats({
        baseline: null,
        allTime: { resolvedPicks: 100, brierScore: 0.5 },
      }),
    );
    expect(result).toBeNull();
  });

  test('does not trigger if baseline has too few picks', () => {
    const result = brierDegradationRule.evaluate(
      makeStats({
        baseline: { resolvedPicks: 30, brierScore: 0.2 },
        allTime: { resolvedPicks: 100, brierScore: 0.5 },
      }),
    );
    expect(result).toBeNull();
  });

  test('does not trigger if all-time has too few picks', () => {
    const result = brierDegradationRule.evaluate(
      makeStats({
        baseline: { resolvedPicks: 50, brierScore: 0.2 },
        allTime: { resolvedPicks: 20, brierScore: 0.5 },
      }),
    );
    expect(result).toBeNull();
  });

  test('does not trigger if Brier improved (current < baseline)', () => {
    const result = brierDegradationRule.evaluate(
      makeStats({
        baseline: { resolvedPicks: 50, brierScore: 0.25 },
        allTime: { resolvedPicks: 100, brierScore: 0.20 },
      }),
    );
    expect(result).toBeNull();
  });

  test('does not trigger if Brier degraded but below 1.2× factor', () => {
    const result = brierDegradationRule.evaluate(
      makeStats({
        baseline: { resolvedPicks: 50, brierScore: 0.20 },
        allTime: { resolvedPicks: 100, brierScore: 0.22 }, // 1.10×
      }),
    );
    expect(result).toBeNull();
  });

  test('triggers when Brier degraded above 1.2× factor', () => {
    const result = brierDegradationRule.evaluate(
      makeStats({
        baseline: { resolvedPicks: 50, brierScore: 0.20 },
        allTime: { resolvedPicks: 100, brierScore: 0.26 }, // 1.30×
      }),
    );
    expect(result).not.toBeNull();
    expect(result?.metadata.ratio).toBeCloseTo(1.3, 5);
    expect(result?.metadata.currentBrier).toBe(0.26);
    expect(result?.metadata.baselineBrier).toBe(0.20);
  });

  test('does not trigger when scores are NaN', () => {
    const result = brierDegradationRule.evaluate(
      makeStats({
        baseline: { resolvedPicks: 50, brierScore: NaN },
        allTime: { resolvedPicks: 100, brierScore: 0.30 },
      }),
    );
    expect(result).toBeNull();
  });

  test('does not trigger when baseline Brier is zero (degenerate)', () => {
    const result = brierDegradationRule.evaluate(
      makeStats({
        baseline: { resolvedPicks: 50, brierScore: 0 },
        allTime: { resolvedPicks: 100, brierScore: 0.30 },
      }),
    );
    expect(result).toBeNull();
  });
});
