/**
 * Monitoring rules — declarative definitions for the system status engine.
 *
 * Each rule is a pure function that takes a SystemStats snapshot and returns
 * either null (rule has no opinion right now) or a RuleResult describing the
 * trigger condition. Rules know nothing about persistence or deduplication —
 * the alertEvaluator (Task 8) handles those concerns.
 *
 * The rules collectively form an early-warning system for the AI pipeline.
 * They're tuned for a real-money bettor making 3-4 picks per slate with the
 * goal of catching prompt drift, model degradation, and tilt-inducing
 * drawdowns BEFORE they cause damage.
 *
 * Why declarative?
 *   1. The full set of rules can be enumerated, documented, and reviewed.
 *   2. Adding a rule is a 20-line patch — no plumbing changes.
 *   3. The evaluator can dry-run any subset for what-if analysis.
 *   4. Each rule is independently unit-testable as a pure function.
 *
 * RULE DESIGN PRINCIPLES
 *   - Always require a minimum sample size before triggering. 10 picks of CLV
 *     data isn't enough to flag a problem — random noise will trip the rule.
 *   - Each trigger should answer "what should the user DO about this?" The
 *     message must include a clear next step (review prompt, pause betting,
 *     check input data, etc.).
 *   - Severity escalates from `info` (FYI) to `warning` (review soon) to
 *     `critical` (do not place new bets until investigated).
 *   - Metadata captures the exact metric values that caused the trigger so
 *     historical alerts can be audited.
 */

import type { PickSummary } from './pickHistory';

// ===================================================================
// Types
// ===================================================================

/** A snapshot of pick statistics across multiple time windows. */
export interface SystemStats {
  /** All resolved picks in the database. */
  allTime: PickSummary;
  /** Picks from the trailing 7 calendar days. */
  last7Days: PickSummary;
  /** Picks from the trailing 30 calendar days. */
  last30Days: PickSummary;
  /**
   * The first 50 picks chronologically — used as the calibration baseline
   * for drift detection. Null if we don't have 50 picks yet.
   */
  baseline: PickSummary | null;
}

/** What a rule returns when it triggers. */
export interface RuleResult {
  /** Pre-rendered English message for the user. */
  message: string;
  /** Captured metric values for the audit trail. */
  metadata: Record<string, unknown>;
  /**
   * Optional dedup key suffix. The evaluator dedupes by `${rule.id}:${dedupKey}`,
   * so milestone rules can fire multiple times for different milestones.
   * If absent, the rule dedupes purely by `rule.id`.
   */
  dedupKey?: string;
}

/** A single declarative monitoring rule. */
export interface MonitoringRule {
  id: string;
  name: string;
  description: string;
  severity: 'info' | 'warning' | 'critical';
  /** Returns null if the rule has no opinion (e.g., insufficient data). */
  evaluate(stats: SystemStats): RuleResult | null;
}

// ===================================================================
// Constants — tuned for a 3–4 picks/slate bettor on a 6-month horizon
// ===================================================================

/**
 * Minimum samples per metric before we'll fire a trigger. Random noise on
 * very small samples (<10) is too high to draw conclusions from.
 */
const MIN_CLV_SAMPLES = 10;
const MIN_BRIER_SAMPLES = 30;
const MIN_BASELINE_PICKS = 50;

/** CLV thresholds in implied-probability points (e.g. 0.01 = +1pp). */
const CLV_NEGATIVE_THRESHOLD = -0.01; // alert if 7-day CLV worse than -1pp

/** Drawdown thresholds as a fraction of bankroll. */
const DRAWDOWN_WARNING = 0.20; // 20% drawdown → warning
const DRAWDOWN_CRITICAL = 0.30; // 30% drawdown → critical

/** Brier degradation: alert if current is X× worse than baseline. */
const BRIER_DEGRADATION_FACTOR = 1.2; // 20% worse

/** Pick-count milestones at which to fire informational summary alerts. */
const PICK_MILESTONES = [50, 100, 250, 500, 1000, 2500, 5000];

/** Minimum picks before we stop showing the "still collecting data" banner. */
const INSUFFICIENT_DATA_THRESHOLD = 30;

// ===================================================================
// Rules
// ===================================================================

/**
 * Insufficient data: a friendly informational banner shown until we have
 * enough picks for the other rules to be meaningful. Never escalates.
 */
export const insufficientDataRule: MonitoringRule = {
  id: 'insufficient-data',
  name: 'Still Collecting Data',
  description:
    'The system needs at least 30 resolved picks before calibration metrics ' +
    'are statistically meaningful. Until then, treat tier badges as the ' +
    'primary signal.',
  severity: 'info',
  evaluate(stats) {
    const { resolvedPicks } = stats.allTime;
    if (resolvedPicks >= INSUFFICIENT_DATA_THRESHOLD) return null;
    return {
      message:
        `${resolvedPicks} of ${INSUFFICIENT_DATA_THRESHOLD} picks resolved. ` +
        `Calibration metrics will become reliable after ${INSUFFICIENT_DATA_THRESHOLD} picks. ` +
        `Keep using the AI suggestions and let the data accumulate.`,
      metadata: {
        resolvedPicks,
        threshold: INSUFFICIENT_DATA_THRESHOLD,
      },
    };
  },
};

/**
 * Pick milestone: fires once each time the cumulative pick count crosses one
 * of the round numbers in PICK_MILESTONES. Uses a dedup key per milestone so
 * each is independently emitted.
 */
export const pickMilestoneRule: MonitoringRule = {
  id: 'pick-milestone',
  name: 'Pick Count Milestone',
  description:
    'Fires once each time the resolved pick count crosses a round-number ' +
    'milestone. Includes a calibration snapshot for the audit log.',
  severity: 'info',
  evaluate(stats) {
    const { resolvedPicks, brierScore, flatROI, averageCLV, hitRate } = stats.allTime;
    // Find the highest milestone we've crossed
    const crossed = [...PICK_MILESTONES].reverse().find((m) => resolvedPicks >= m);
    if (crossed === undefined) return null;
    return {
      message:
        `Milestone reached: ${crossed} resolved picks. ` +
        `Hit rate: ${formatPct(hitRate)}, ` +
        `Brier: ${formatNumber(brierScore, 4)}, ` +
        `Flat ROI: ${formatPct(flatROI)}, ` +
        `Avg CLV: ${formatPp(averageCLV)}.`,
      metadata: {
        milestone: crossed,
        resolvedPicks,
        brierScore,
        flatROI,
        averageCLV,
        hitRate,
      },
      dedupKey: String(crossed),
    };
  },
};

/**
 * 7-day CLV decline: warns if rolling-week average CLV drops below
 * −1pp with sufficient samples. CLV is the fastest leading indicator we have
 * of model drift — losing CLV means the market is moving against us, which
 * almost always precedes losing P&L.
 */
export const clv7DayNegativeRule: MonitoringRule = {
  id: 'clv-7day-negative',
  name: '7-Day CLV Below Threshold',
  description:
    'The trailing 7-day average closing-line value has dropped below -1pp. ' +
    'CLV is the leading indicator for model edge — sustained negative CLV ' +
    'usually means the lines are moving against your picks. Review the ' +
    'last 10–20 picks for systematic errors before placing new bets.',
  severity: 'warning',
  evaluate(stats) {
    const { picksWithCLV, averageCLV } = stats.last7Days;
    if (picksWithCLV < MIN_CLV_SAMPLES) return null;
    if (averageCLV >= CLV_NEGATIVE_THRESHOLD) return null;
    return {
      message:
        `7-day CLV is ${formatPp(averageCLV)} across ${picksWithCLV} picks ` +
        `(threshold ${formatPp(CLV_NEGATIVE_THRESHOLD)}). ` +
        `Pause and review the last 10-20 picks before placing new bets.`,
      metadata: {
        averageCLV,
        picksWithCLV,
        threshold: CLV_NEGATIVE_THRESHOLD,
      },
    };
  },
};

/**
 * 20% drawdown warning: trips when bankroll has dropped 20% from peak.
 * Tilt-induced overbetting is the #1 way bettors blow up — this rule's whole
 * job is to interrupt the spiral with a visible warning.
 */
export const drawdownWarningRule: MonitoringRule = {
  id: 'drawdown-20pct',
  name: '20% Drawdown',
  description:
    'Bankroll has dropped 20% from its peak. Consider reducing stake sizes ' +
    'or pausing for a slate review.',
  severity: 'warning',
  evaluate(stats) {
    const { maxDrawdownPct } = stats.allTime;
    if (maxDrawdownPct < DRAWDOWN_WARNING) return null;
    if (maxDrawdownPct >= DRAWDOWN_CRITICAL) return null; // critical rule handles this
    return {
      message:
        `Bankroll is down ${formatPct(maxDrawdownPct)} from peak. ` +
        `Consider halving stake sizes or taking a slate off to review.`,
      metadata: { maxDrawdownPct, threshold: DRAWDOWN_WARNING },
    };
  },
};

/**
 * 30% drawdown critical: bankroll preservation rule. The user should not
 * place new bets until they've reviewed why the drawdown happened — model
 * issue, variance, or tilt? Only critical-severity rule in v1.
 */
export const drawdownCriticalRule: MonitoringRule = {
  id: 'drawdown-30pct',
  name: '30% Drawdown',
  description:
    'Bankroll has dropped 30% from its peak. STOP betting until the cause is ' +
    'identified. Most likely culprits: prompt drift, bad input data, or tilt.',
  severity: 'critical',
  evaluate(stats) {
    const { maxDrawdownPct } = stats.allTime;
    if (maxDrawdownPct < DRAWDOWN_CRITICAL) return null;
    return {
      message:
        `CRITICAL: Bankroll is down ${formatPct(maxDrawdownPct)} from peak. ` +
        `Stop placing new bets until you've reviewed the recent picks for ` +
        `systematic errors. This rule fires above ${formatPct(DRAWDOWN_CRITICAL)}.`,
      metadata: { maxDrawdownPct, threshold: DRAWDOWN_CRITICAL },
    };
  },
};

/**
 * Brier degradation: warns if current calibration has gotten 20% worse than
 * baseline (the first 50 picks). Lower is better for Brier, so "worse" means
 * "higher". This catches model drift even when CLV looks fine.
 */
export const brierDegradationRule: MonitoringRule = {
  id: 'brier-degradation',
  name: 'Brier Score Degradation',
  description:
    'Current Brier score is significantly worse than the early-history ' +
    'baseline. The model is becoming less calibrated — review recent prompt ' +
    'or input changes that might explain the drift.',
  severity: 'warning',
  evaluate(stats) {
    if (!stats.baseline) return null;
    if (stats.allTime.resolvedPicks < MIN_BRIER_SAMPLES) return null;
    if (stats.baseline.resolvedPicks < MIN_BASELINE_PICKS) return null;
    const current = stats.allTime.brierScore;
    const baseline = stats.baseline.brierScore;
    if (!Number.isFinite(current) || !Number.isFinite(baseline)) return null;
    if (baseline <= 0) return null;
    const ratio = current / baseline;
    if (ratio < BRIER_DEGRADATION_FACTOR) return null;
    return {
      message:
        `Brier score degraded from ${formatNumber(baseline, 4)} (baseline of ${stats.baseline.resolvedPicks} picks) ` +
        `to ${formatNumber(current, 4)} (${formatPct(ratio - 1)} worse). ` +
        `Review recent prompt changes and input data quality.`,
      metadata: {
        currentBrier: current,
        baselineBrier: baseline,
        ratio,
        threshold: BRIER_DEGRADATION_FACTOR,
        baselineSize: stats.baseline.resolvedPicks,
      },
    };
  },
};

// ===================================================================
// Registry — single source of truth for the alertEvaluator
// ===================================================================

/**
 * Ordered list of all rules the evaluator runs each cycle.
 *
 * Order matters for dedup conflict resolution: when two rules with
 * overlapping coverage fire (e.g., 20% and 30% drawdown), the more severe
 * one should appear first. The 20% rule already self-suppresses above 30%
 * via its evaluate() guard.
 */
export const MONITORING_RULES: MonitoringRule[] = [
  drawdownCriticalRule,
  drawdownWarningRule,
  clv7DayNegativeRule,
  brierDegradationRule,
  pickMilestoneRule,
  insufficientDataRule,
];

// ===================================================================
// Formatting helpers (used inside rule messages)
// ===================================================================

function formatPct(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return `${(value * 100).toFixed(1)}%`;
}

function formatPp(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const sign = value >= 0 ? '+' : '';
  return `${sign}${(value * 100).toFixed(2)}pp`;
}

function formatNumber(value: number, digits: number): string {
  if (!Number.isFinite(value)) return '—';
  return value.toFixed(digits);
}
