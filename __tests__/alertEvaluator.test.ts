import { evaluateRules, type PendingAlert } from '../src/lib/alertEvaluator';
import type {
  MonitoringRule,
  SystemStats,
} from '../src/lib/monitoringRules';
import type { PickSummary } from '../src/lib/pickHistory';
import type { SystemAlertRow } from '../src/lib/supabase';

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

function makeStats(): SystemStats {
  return {
    allTime: makeSummary(),
    last7Days: makeSummary(),
    last30Days: makeSummary(),
    baseline: null,
  };
}

function makeAlert(overrides: Partial<SystemAlertRow> = {}): SystemAlertRow {
  return {
    id: 'alert-1',
    rule_id: 'test-rule',
    rule_name: 'Test Rule',
    severity: 'info',
    message: 'Test message',
    metadata: null,
    triggered_at: new Date().toISOString(),
    acknowledged_at: null,
    acknowledged_by: null,
    dismissed: false,
    auto_action_taken: null,
    ...overrides,
  };
}

// ============================================================================
// Mock rules
// ============================================================================

const alwaysFiringRule: MonitoringRule = {
  id: 'always-fires',
  name: 'Always Fires',
  description: 'Triggers on every evaluation',
  severity: 'info',
  evaluate() {
    return {
      message: 'fired',
      metadata: { value: 1 },
    };
  },
};

const neverFiringRule: MonitoringRule = {
  id: 'never-fires',
  name: 'Never Fires',
  description: 'Never triggers',
  severity: 'warning',
  evaluate() {
    return null;
  },
};

const milestoneRule: MonitoringRule = {
  id: 'milestone',
  name: 'Milestone',
  description: 'Fires once per milestone value',
  severity: 'info',
  evaluate(stats) {
    const count = stats.allTime.resolvedPicks;
    if (count < 100) return null;
    const milestone = Math.floor(count / 100) * 100;
    return {
      message: `Reached ${milestone}`,
      metadata: { milestone },
      dedupKey: String(milestone),
    };
  },
};

const criticalConditionRule: MonitoringRule = {
  id: 'critical-cond',
  name: 'Critical Condition',
  description: 'Fires when allTime.maxDrawdownPct >= 0.30',
  severity: 'critical',
  evaluate(stats) {
    if (stats.allTime.maxDrawdownPct < 0.3) return null;
    return {
      message: 'Drawdown critical',
      metadata: { dd: stats.allTime.maxDrawdownPct },
    };
  },
};

// ============================================================================
// evaluateRules
// ============================================================================

describe('evaluateRules', () => {
  test('empty rules → empty result', () => {
    expect(evaluateRules([], makeStats(), [])).toEqual([]);
  });

  test('no triggering rules → empty result', () => {
    const result = evaluateRules([neverFiringRule], makeStats(), []);
    expect(result).toEqual([]);
  });

  test('one rule fires with no recent alerts → emits one PendingAlert', () => {
    const result = evaluateRules([alwaysFiringRule], makeStats(), []);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual<PendingAlert>({
      rule_id: 'always-fires',
      rule_name: 'Always Fires',
      severity: 'info',
      message: 'fired',
      metadata: { value: 1 },
    });
  });

  test('multiple rules → emits in declaration order, only those that trigger', () => {
    const result = evaluateRules(
      [neverFiringRule, alwaysFiringRule, criticalConditionRule],
      { ...makeStats(), allTime: makeSummary({ maxDrawdownPct: 0.45 }) },
      [],
    );
    expect(result.map((p) => p.rule_id)).toEqual(['always-fires', 'critical-cond']);
  });

  // ----- Window dedup (no dedupKey) -----

  test('window dedup: same rule fired within window → suppressed', () => {
    const recent = [
      makeAlert({
        rule_id: 'always-fires',
        triggered_at: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(), // 1h ago
      }),
    ];
    const result = evaluateRules([alwaysFiringRule], makeStats(), recent);
    expect(result).toEqual([]);
  });

  test('window dedup: same rule fired outside window → re-emits', () => {
    const recent = [
      makeAlert({
        rule_id: 'always-fires',
        triggered_at: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(), // 48h ago
      }),
    ];
    const result = evaluateRules([alwaysFiringRule], makeStats(), recent);
    expect(result).toHaveLength(1);
  });

  test('window dedup: different rule_id does not suppress', () => {
    const recent = [
      makeAlert({
        rule_id: 'something-else',
        triggered_at: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(),
      }),
    ];
    const result = evaluateRules([alwaysFiringRule], makeStats(), recent);
    expect(result).toHaveLength(1);
  });

  test('window dedup: respects custom dedupWindowHours', () => {
    // Recent alert 6h ago. Default 24h window suppresses, 1h window does not.
    const recent = [
      makeAlert({
        rule_id: 'always-fires',
        triggered_at: new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString(),
      }),
    ];
    const suppressed = evaluateRules([alwaysFiringRule], makeStats(), recent, {
      dedupWindowHours: 24,
    });
    const reEmitted = evaluateRules([alwaysFiringRule], makeStats(), recent, {
      dedupWindowHours: 1,
    });
    expect(suppressed).toHaveLength(0);
    expect(reEmitted).toHaveLength(1);
  });

  test('window dedup: deterministic with `now` override', () => {
    const fixedNow = new Date('2026-04-06T12:00:00Z');
    const recent = [
      makeAlert({
        rule_id: 'always-fires',
        triggered_at: '2026-04-06T11:00:00Z', // 1h before fixedNow
      }),
    ];
    const result = evaluateRules([alwaysFiringRule], makeStats(), recent, {
      now: fixedNow,
    });
    expect(result).toEqual([]);
  });

  // ----- Keyed dedup (dedupKey present) -----

  test('keyed dedup: same key in past → suppressed even after window expiry', () => {
    const stats = { ...makeStats(), allTime: makeSummary({ resolvedPicks: 100 }) };
    const recent = [
      makeAlert({
        rule_id: 'milestone',
        // Way outside any window — but the dedupKey should still match
        triggered_at: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString(),
        metadata: { __dedupKey: '100', milestone: 100 },
      }),
    ];
    const result = evaluateRules([milestoneRule], stats, recent);
    expect(result).toEqual([]);
  });

  test('keyed dedup: different key → re-emits', () => {
    const stats = { ...makeStats(), allTime: makeSummary({ resolvedPicks: 250 }) };
    const recent = [
      makeAlert({
        rule_id: 'milestone',
        triggered_at: new Date().toISOString(),
        metadata: { __dedupKey: '100', milestone: 100 },
      }),
    ];
    const result = evaluateRules([milestoneRule], stats, recent);
    expect(result).toHaveLength(1);
    expect(result[0].metadata.milestone).toBe(200);
    // The new alert carries its own __dedupKey
    expect(result[0].metadata.__dedupKey).toBe('200');
  });

  test('keyed dedup: stores __dedupKey in emitted metadata', () => {
    const stats = { ...makeStats(), allTime: makeSummary({ resolvedPicks: 500 }) };
    const result = evaluateRules([milestoneRule], stats, []);
    expect(result[0].metadata.__dedupKey).toBe('500');
    expect(result[0].metadata.milestone).toBe(500);
  });

  test('keyed dedup: gracefully handles past alerts with null metadata', () => {
    const stats = { ...makeStats(), allTime: makeSummary({ resolvedPicks: 100 }) };
    const recent = [
      makeAlert({ rule_id: 'milestone', metadata: null }),
    ];
    // Past alert has no __dedupKey field, so the new one should still emit
    const result = evaluateRules([milestoneRule], stats, recent);
    expect(result).toHaveLength(1);
    expect(result[0].metadata.__dedupKey).toBe('100');
  });

  // ----- Mixed scenarios -----

  test('mix of windowed + keyed rules in one run', () => {
    const stats = {
      ...makeStats(),
      allTime: makeSummary({ resolvedPicks: 100, maxDrawdownPct: 0.45 }),
    };
    const recent = [
      // Suppresses always-fires
      makeAlert({
        rule_id: 'always-fires',
        triggered_at: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(),
      }),
      // Suppresses milestone for the 100 key
      makeAlert({
        rule_id: 'milestone',
        triggered_at: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString(),
        metadata: { __dedupKey: '100' },
      }),
    ];
    const result = evaluateRules(
      [alwaysFiringRule, milestoneRule, criticalConditionRule],
      stats,
      recent,
    );
    // Only critical-cond fires (always-fires and milestone are suppressed)
    expect(result).toHaveLength(1);
    expect(result[0].rule_id).toBe('critical-cond');
  });
});
