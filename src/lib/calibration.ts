/**
 * Calibration metrics — pure scoring functions for evaluating bet quality.
 *
 * These functions answer different "is the strategy working?" questions:
 *   - Brier Score / Log Loss → are predicted probabilities well calibrated?
 *   - CLV (Closing Line Value) → are we beating the closing market consensus?
 *   - Flat ROI / Kelly ROI → are we profitable in dollars?
 *   - Hit Rate (overall + by tier) → are tier definitions matching reality?
 *   - Sortino Ratio → profitability per unit of downside risk?
 *   - Drawdown → how deep is the worst peak-to-valley losing run?
 *   - Bootstrap CI → how confident are we in any of the above point estimates?
 *
 * All functions are pure and deterministic. Empty inputs return NaN
 * (semantically: "no data, no answer"). The caller decides how to display NaN
 * — typically as "—" or "n/a" in the UI.
 *
 * The functions intentionally take minimal record types so they can be used
 * with anything that has the right shape, not just Supabase PickRow objects.
 * pickHistory.ts is the bridge between PickRow and these calibration inputs.
 *
 * Why these specific metrics?
 *   CLV converges in dozens of picks; raw ROI takes hundreds. Brier+LogLoss
 *   together catch both over- and under-confidence. Hit-rate-by-tier verifies
 *   the calibration matches what we *promised* (HIGH should win at the rate
 *   the threshold implies). Together they form an early-warning system for
 *   model drift before raw P&L tells the story.
 *
 * ROADMAP NOTE
 *   kellyROI, sortinoRatio, and bootstrapCI are deliberately retained even
 *   though no route currently consumes them. They are Phase 2 calibration-
 *   dashboard primitives (see memory/project_roadmap.md — "verify edge vs
 *   variance"). Their unit tests lock in correctness so they're wire-ready
 *   when the dashboard lands. Do NOT delete them as dead code.
 */

import { americanToImplied, type Tier } from './math';
import { americanToDecimal } from './twoSidedCalc';

// ===================================================================
// Types
// ===================================================================

/** A single calibration data point: predicted probability + binary outcome. */
export interface Prediction {
  /** Probability the bet wins, in [0, 1]. */
  probability: number;
  /** 1 = won, 0 = lost. Pushes should be excluded by the caller. */
  outcome: 0 | 1;
}

/** A resolved bet for ROI / win-rate calculation. */
export interface ResolvedPick {
  won: boolean;
  pushed: boolean;
  /** American odds at bet time. */
  odds: number;
  /** Stake in units (used by Kelly ROI; flatROI ignores). Defaults to 1. */
  stake?: number;
}

/** A pick with both bet-time and closing-time odds (for CLV). */
export interface CLVPick {
  /** American odds when the bet was placed. */
  betOdds: number;
  /** American odds at market close (snapshot time). */
  closingOdds: number;
}

/** Result of a bootstrap confidence interval. */
export interface BootstrapResult {
  /** The unbootstrapped sample mean (deterministic regardless of seed). */
  mean: number;
  /** Lower bound of the confidence interval. */
  lower: number;
  /** Upper bound of the confidence interval. */
  upper: number;
}

// ===================================================================
// Local helpers
// ===================================================================

/** Probability clip to avoid log(0) → -Infinity in cross-entropy. */
const EPSILON = 1e-15;

/** Mean of an array. NaN for empty input. */
function meanOf(values: number[]): number {
  if (values.length === 0) return NaN;
  let total = 0;
  for (const v of values) total += v;
  return total / values.length;
}

// ===================================================================
// Brier Score
// ===================================================================

/**
 * Brier Score: mean squared error between predicted probability and outcome.
 *
 *   BS = (1/N) Σ (p_i − y_i)²
 *
 * Lower is better. Always in [0, 1].
 *   - 0    = perfect predictions (every probability nailed the outcome)
 *   - 0.25 = always predicting 0.5 (the random baseline for binary outcomes)
 *   - 1    = always wrong with full confidence
 *
 * Useful for measuring whether predicted probabilities are well calibrated.
 * Brier penalizes confidence symmetrically (a prediction of 0.9 with outcome 0
 * is just as bad as 0.1 with outcome 1).
 */
export function brierScore(predictions: Prediction[]): number {
  if (predictions.length === 0) return NaN;
  let sumSquaredErrors = 0;
  for (const p of predictions) {
    const diff = p.probability - p.outcome;
    sumSquaredErrors += diff * diff;
  }
  return sumSquaredErrors / predictions.length;
}

// ===================================================================
// Log Loss (Cross-Entropy)
// ===================================================================

/**
 * Logarithmic loss / binary cross-entropy:
 *
 *   LL = −(1/N) Σ [ y_i · log(p_i) + (1−y_i) · log(1−p_i) ]
 *
 * Lower is better. Range [0, ∞).
 *   - 0           = perfect predictions
 *   - log(2)≈0.69 = always predicting 0.5 (random baseline)
 *
 * Penalizes confident-wrong predictions exponentially (0.99 with outcome 0 is
 * MUCH worse than 0.6 with outcome 0). Brier penalizes them quadratically.
 * Both metrics together give a fuller picture than either alone — Brier alone
 * can hide overconfidence, Log Loss alone can punish a single outlier too hard.
 *
 * Probabilities are clipped to [EPSILON, 1−EPSILON] so log(0) doesn't blow up.
 */
export function logLoss(predictions: Prediction[]): number {
  if (predictions.length === 0) return NaN;
  let sumLogLoss = 0;
  for (const p of predictions) {
    const clipped = Math.max(EPSILON, Math.min(1 - EPSILON, p.probability));
    sumLogLoss +=
      p.outcome * Math.log(clipped) + (1 - p.outcome) * Math.log(1 - clipped);
  }
  return -sumLogLoss / predictions.length;
}

// ===================================================================
// Closing Line Value (CLV)
// ===================================================================

/**
 * Compute CLV for a single bet as the difference in implied probability:
 *
 *   CLV = implied(closingOdds) − implied(betOdds)
 *
 * Returns a decimal (0.024 = +2.4 percentage points of CLV).
 *
 * Positive CLV means the line moved AGAINST your bet (your side became more
 * expensive after you placed it) — a signal you took the right side at the
 * right time. Sharp bettors typically average +1pp to +3pp CLV. CLV converges
 * in ~30–50 picks vs ~700+ for raw ROI, making it the fastest edge signal.
 *
 * NOTE: Uses raw vig-included implied probability for simplicity. For a
 * stricter measure that backs out the vig, use computeCLVDevigged() with both
 * sides of the market at bet time and close.
 */
export function computeCLV(betOdds: number, closingOdds: number): number {
  const betImplied = americanToImplied(betOdds);
  const closeImplied = americanToImplied(closingOdds);
  return closeImplied - betImplied;
}

/**
 * Average CLV across many picks. Returns NaN for empty input.
 */
export function averageCLV(picks: CLVPick[]): number {
  if (picks.length === 0) return NaN;
  return meanOf(picks.map((p) => computeCLV(p.betOdds, p.closingOdds)));
}

// ===================================================================
// ROI
// ===================================================================

/**
 * Profit (in units) from a single resolved pick at $1 flat stake.
 *   - Push → 0
 *   - Win  → decimal_odds − 1 (the profit, not the payout)
 *   - Loss → −1
 */
function flatProfit(pick: ResolvedPick): number {
  if (pick.pushed) return 0;
  if (pick.won) return americanToDecimal(pick.odds) - 1;
  return -1;
}

/**
 * Flat-staking ROI: total profit divided by total wagered.
 *
 *   ROI = Σ profit_i / Σ stake_i        (each non-push pick stakes 1 unit)
 *
 * Returns the ROI as a decimal (0.05 = +5% per dollar staked). Pushes don't
 * count toward stake or profit.
 *
 * Flat staking neutralizes the variance Kelly introduces, so ROI converges
 * faster — making it the preferred metric for evaluating prediction quality
 * separate from money-management decisions.
 *
 * Returns NaN if the input is empty OR every pick pushed (no decisions).
 */
export function flatROI(picks: ResolvedPick[]): number {
  if (picks.length === 0) return NaN;
  let wagered = 0;
  let profit = 0;
  for (const p of picks) {
    if (p.pushed) continue;
    wagered += 1;
    profit += flatProfit(p);
  }
  if (wagered === 0) return NaN;
  return profit / wagered;
}

/**
 * Kelly-staking ROI: total profit divided by total wagered (using actual stakes).
 *
 *   ROI = Σ profit_i / Σ stake_i
 *
 * Differs from flatROI in that each pick contributes a variable stake. Picks
 * without a `stake` field default to 1 unit (so this degenerates to flatROI).
 *
 * Returns NaN if the input is empty OR total stake is zero.
 */
export function kellyROI(picks: ResolvedPick[]): number {
  if (picks.length === 0) return NaN;
  let totalStaked = 0;
  let totalProfit = 0;
  for (const p of picks) {
    if (p.pushed) continue;
    const stake = p.stake ?? 1;
    totalStaked += stake;
    if (p.won) totalProfit += stake * (americanToDecimal(p.odds) - 1);
    else totalProfit -= stake;
  }
  if (totalStaked === 0) return NaN;
  return totalProfit / totalStaked;
}

// ===================================================================
// Hit rate
// ===================================================================

/**
 * Win rate: wins / (wins + losses). Pushes excluded.
 *
 * Returns NaN for empty input or all-pushes input.
 */
export function hitRate(
  picks: Array<{ won: boolean; pushed: boolean }>,
): number {
  if (picks.length === 0) return NaN;
  let decided = 0;
  let wins = 0;
  for (const p of picks) {
    if (p.pushed) continue;
    decided += 1;
    if (p.won) wins += 1;
  }
  if (decided === 0) return NaN;
  return wins / decided;
}

/**
 * Win rate broken down by tier. Useful for verifying that the calibration
 * matches the tier definitions (HIGH should win at the rate the threshold
 * implies, MEDIUM at its rate, etc.). Tiers with no picks are reported as NaN.
 */
export function hitRateByTier(
  picks: Array<{ tier: Tier; won: boolean; pushed: boolean }>,
): Record<Tier, number> {
  const result: Record<Tier, number> = {
    HIGH: NaN,
    MEDIUM: NaN,
    LOW: NaN,
    REJECT: NaN,
  };
  const tiers: Tier[] = ['HIGH', 'MEDIUM', 'LOW', 'REJECT'];
  for (const t of tiers) {
    result[t] = hitRate(picks.filter((p) => p.tier === t));
  }
  return result;
}

// ===================================================================
// Sortino Ratio
// ===================================================================

/**
 * Sortino ratio:
 *
 *   Sortino = (mean_return − MAR) / downside_deviation
 *
 * where MAR is the minimum acceptable return (default 0) and the downside
 * deviation only counts returns BELOW MAR. Treats upside volatility as
 * neutral and only penalizes downside — a better fit than Sharpe for skewed
 * return distributions like betting (where the upside is bounded but losses
 * can cluster).
 *
 *   Sortino > 1 = good
 *   Sortino > 2 = great
 *   Sortino > 3 = exceptional
 *
 * Returns NaN for empty input or zero downside deviation (no losing periods).
 * The denominator uses N (not N−1); both conventions exist in the literature.
 */
export function sortinoRatio(returns: number[], mar: number = 0): number {
  if (returns.length === 0) return NaN;
  const meanReturn = meanOf(returns);
  let downsideSquaredSum = 0;
  for (const r of returns) {
    const diff = r - mar;
    if (diff < 0) downsideSquaredSum += diff * diff;
  }
  const downsideDev = Math.sqrt(downsideSquaredSum / returns.length);
  if (downsideDev === 0) return NaN;
  return (meanReturn - mar) / downsideDev;
}

// ===================================================================
// Cumulative profit + drawdown
// ===================================================================

/**
 * Compute the cumulative profit curve given an ordered list of resolved picks.
 * Each entry is the running profit after that pick is settled. Used as the
 * input to drawdown calculations and equity-curve plotting.
 *
 * Profit is in flat units (1 unit per non-push pick). For Kelly-stake equity
 * curves, build the curve from the kelly profit explicitly.
 */
export function cumulativeProfit(picks: ResolvedPick[]): number[] {
  const curve: number[] = [];
  let running = 0;
  for (const p of picks) {
    running += flatProfit(p);
    curve.push(running);
  }
  return curve;
}

/**
 * Maximum drawdown in profit units (NOT a percentage).
 *
 *   maxDD = max( peak_so_far − current_profit )
 *
 * Walks the cumulative profit curve and tracks the largest peak-to-valley
 * drop in absolute units. Returns 0 for an empty input or a monotonically
 * non-decreasing curve.
 *
 * To express as a fraction of bankroll, use maxDrawdownPct() — that variant
 * needs the starting bankroll so it can compute peak-bankroll percentages.
 */
export function maxDrawdown(picks: ResolvedPick[]): number {
  const curve = cumulativeProfit(picks);
  if (curve.length === 0) return 0;
  let peak = 0; // we begin at zero profit
  let maxDD = 0;
  for (const point of curve) {
    if (point > peak) peak = point;
    const dd = peak - point;
    if (dd > maxDD) maxDD = dd;
  }
  return maxDD;
}

/**
 * Maximum drawdown as a fraction of peak bankroll.
 *
 *   bankroll(t) = startingBankroll + cumulative_profit(t)
 *   ddPct(t)    = (peak_bankroll − bankroll(t)) / peak_bankroll
 *   maxDDPct    = max ddPct(t)
 *
 * Returns 0 for empty input or a monotonically non-decreasing curve. This is
 * the form most suitable for monitoring rules like "alert if drawdown > 30%".
 *
 * Throws if startingBankroll <= 0.
 */
export function maxDrawdownPct(
  picks: ResolvedPick[],
  startingBankroll: number,
): number {
  if (startingBankroll <= 0) {
    throw new Error('startingBankroll must be positive');
  }
  const curve = cumulativeProfit(picks);
  if (curve.length === 0) return 0;
  let peak = startingBankroll;
  let maxDD = 0;
  for (const point of curve) {
    const bankroll = startingBankroll + point;
    if (bankroll > peak) peak = bankroll;
    const dd = (peak - bankroll) / peak;
    if (dd > maxDD) maxDD = dd;
  }
  return maxDD;
}

// ===================================================================
// Bootstrap Confidence Interval
// ===================================================================

/**
 * Mulberry32 — small, fast PRNG with full 32-bit period.
 * Used for deterministic bootstrap resampling in tests and reproducible
 * confidence intervals.
 */
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Bootstrap confidence interval for the mean of a sample.
 *
 * Resamples the input with replacement `iterations` times (default 1000),
 * computes the mean of each resample, then returns the empirical
 * `confidence` percentile interval (default 95%).
 *
 * Returns:
 *   - mean  : the actual sample mean (deterministic — does NOT depend on seed)
 *   - lower : the (1−confidence)/2 percentile of the bootstrap distribution
 *   - upper : the (1+confidence)/2 percentile of the bootstrap distribution
 *
 * Pass an explicit `seed` to make the result deterministic (used in tests and
 * for stable rule evaluations). When seed is undefined, Math.random() is used.
 *
 * Empty input returns { mean: NaN, lower: NaN, upper: NaN }.
 */
export function bootstrapCI(
  values: number[],
  iterations: number = 1000,
  confidence: number = 0.95,
  seed?: number,
): BootstrapResult {
  if (values.length === 0) return { mean: NaN, lower: NaN, upper: NaN };

  const rng = seed === undefined ? Math.random : mulberry32(seed);
  const n = values.length;
  const resampleMeans: number[] = new Array(iterations);

  for (let i = 0; i < iterations; i++) {
    let total = 0;
    for (let j = 0; j < n; j++) {
      total += values[Math.floor(rng() * n)];
    }
    resampleMeans[i] = total / n;
  }

  resampleMeans.sort((a, b) => a - b);

  const alpha = (1 - confidence) / 2;
  const lowerIdx = Math.max(0, Math.floor(alpha * iterations));
  const upperIdx = Math.min(iterations - 1, Math.floor((1 - alpha) * iterations));

  return {
    mean: meanOf(values),
    lower: resampleMeans[lowerIdx],
    upper: resampleMeans[upperIdx],
  };
}
