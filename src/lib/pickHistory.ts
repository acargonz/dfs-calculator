/**
 * Pick history — bridges Supabase PickRow ↔ calibration metric inputs.
 *
 * This module is the only place where we know how PickRow's columns map to
 * calibration's minimal record types. It exposes:
 *
 *   1. Pure transformation helpers (PickRow → Prediction / ResolvedPick / CLVPick)
 *      that handle the direction-aware odds selection (over vs under) and the
 *      "skip if not resolved / no closing data" filtering.
 *
 *   2. A pure summarizer that takes a list of PickRows and returns the full
 *      bundle of metrics consumed by the system status banner, the history
 *      page, and the monitoring rules engine.
 *
 *   3. Thin Supabase query helpers — the only IO in the file. Kept simple
 *      so the bulk of the logic stays pure and unit-testable.
 *
 * Why this layering?
 *   - calibration.ts knows nothing about Supabase or pick row shapes — it just
 *     does math on minimal record types. That keeps it totally pure and reusable.
 *   - pickHistory.ts knows the row shape AND the calibration interface. It is
 *     the translation layer.
 *   - The route handlers (`/api/picks`, `/api/system-status`) know neither math
 *     nor row mapping — they just call summarizePicks() and serialize the result.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { PickRow } from './supabase';
import {
  brierScore,
  logLoss,
  averageCLV,
  flatROI,
  hitRate,
  hitRateByTier,
  cumulativeProfit,
  maxDrawdown,
  maxDrawdownPct,
  type Prediction,
  type ResolvedPick,
  type CLVPick,
} from './calibration';
import type { Tier } from './math';

// ===================================================================
// Types
// ===================================================================

/** A bundled summary of all metrics computed from a slice of pick history. */
export interface PickSummary {
  /** Total picks in the slice (pending + resolved + pushed). */
  totalPicks: number;
  /** Picks with `won` = true or false. */
  resolvedPicks: number;
  /** Picks with `won` = null (game not yet decided). */
  pendingPicks: number;
  /** Picks where `pushed` = true (line landed exactly). */
  pushedPicks: number;

  // ----- Win rates -----
  /** wins / (wins+losses), pushes excluded. NaN if no decided picks. */
  hitRate: number;
  /** Per-tier win rate. NaN per tier with no picks. */
  hitRateByTier: Record<Tier, number>;

  // ----- Calibration -----
  /** Brier score on AI-adjusted probability vs outcome. NaN if 0 picks. */
  brierScore: number;
  /** Log loss on AI-adjusted probability vs outcome. NaN if 0 picks. */
  logLoss: number;
  /** Brier score on raw (pre-AI) calculator probability. NaN if 0 picks. */
  rawBrierScore: number;
  /** Log loss on raw (pre-AI) calculator probability. NaN if 0 picks. */
  rawLogLoss: number;

  // ----- P&L -----
  /** Flat-stake ROI as a decimal (0.05 = +5%). NaN if no decided picks. */
  flatROI: number;
  /** Sum of profit in flat units. */
  netUnits: number;
  /** Worst peak-to-valley drop in flat units. */
  maxDrawdown: number;
  /** Worst peak-to-valley drop as a fraction of bankroll, given startingBankroll. */
  maxDrawdownPct: number;

  // ----- CLV -----
  /** Number of picks with both bet-time and closing odds available. */
  picksWithCLV: number;
  /** Average CLV across picks with closing data. NaN if 0. */
  averageCLV: number;
}

/** Filters for the query helpers. All are optional. */
export interface PickHistoryFilters {
  /** YYYY-MM-DD inclusive lower bound. */
  fromDate?: string;
  /** YYYY-MM-DD inclusive upper bound. */
  toDate?: string;
  /** Restrict to a specific tier. */
  tier?: Tier;
  /** Only resolved picks (won != null). */
  resolvedOnly?: boolean;
  /** Limit number of rows returned. */
  limit?: number;
}

// ===================================================================
// Pure helpers — direction-aware side selection
// ===================================================================

/**
 * Pull the bet-time American odds for the side this pick took.
 * Returns null if the relevant column wasn't captured (legacy picks).
 */
export function pickBetOdds(pick: PickRow): number | null {
  if (pick.direction === 'over') return pick.bet_odds_over;
  return pick.bet_odds_under;
}

/**
 * Pull the closing-time American odds for the side this pick took.
 * Returns null if the snapshot job didn't run / prop was pulled / etc.
 */
export function pickClosingOdds(pick: PickRow): number | null {
  if (pick.direction === 'over') return pick.closing_odds_over;
  return pick.closing_odds_under;
}

/** Returns true iff `won` has been decided (not null). */
export function isResolved(pick: PickRow): boolean {
  return pick.won !== null;
}

// ===================================================================
// Pure transformations — PickRow → calibration inputs
// ===================================================================

/**
 * Convert a PickRow to a Prediction using the AI-adjusted probability.
 * Returns null when:
 *   - The pick isn't resolved (no outcome)
 *   - The pick was pushed (excluded from calibration)
 *   - calculator_prob is null (no probability captured)
 */
export function pickToPrediction(pick: PickRow): Prediction | null {
  if (!isResolved(pick) || pick.pushed) return null;
  if (pick.calculator_prob === null) return null;
  return {
    probability: pick.calculator_prob,
    outcome: pick.won ? 1 : 0,
  };
}

/**
 * Convert a PickRow to a Prediction using the RAW (pre-AI) calculator
 * probability. Returns null under the same conditions as pickToPrediction()
 * except this looks at `raw_calculator_prob` instead.
 *
 * Used to evaluate the math layer in isolation from the AI overlay — comparing
 * brierScore() of raw vs AI predictions tells us whether the AI is helping or
 * hurting calibration.
 */
export function pickToRawPrediction(pick: PickRow): Prediction | null {
  if (!isResolved(pick) || pick.pushed) return null;
  if (pick.raw_calculator_prob === null) return null;
  return {
    probability: pick.raw_calculator_prob,
    outcome: pick.won ? 1 : 0,
  };
}

/**
 * Convert a PickRow to a ResolvedPick (used by ROI / drawdown / hit-rate).
 * Returns null when the pick isn't resolved or no bet-time odds were captured.
 *
 * Pushed picks ARE returned (with pushed: true) because the calibration ROI
 * helpers need to know about them to correctly handle the denominator.
 */
export function pickToResolved(pick: PickRow): ResolvedPick | null {
  if (!isResolved(pick)) return null;
  const odds = pickBetOdds(pick);
  if (odds === null) return null;
  return {
    won: pick.won === true,
    pushed: pick.pushed,
    odds,
    stake: pick.flat_unit_stake ?? 1,
  };
}

/**
 * Convert a PickRow to a CLVPick. Returns null unless BOTH the bet-time and
 * closing odds for the chosen side are present.
 *
 * Resolution status is irrelevant for CLV — a pick can be unresolved but still
 * have a closing line. The CLV signal converges much faster than P&L, which
 * is the whole point of tracking it.
 */
export function pickToCLV(pick: PickRow): CLVPick | null {
  const betOdds = pickBetOdds(pick);
  const closingOdds = pickClosingOdds(pick);
  if (betOdds === null || closingOdds === null) return null;
  return { betOdds, closingOdds };
}

/**
 * Map a raw `ai_confidence_tier` column value to a calculator Tier.
 *
 * The AI ensemble emits `A` / `B` / `C` / `REJECT` (see aiAnalysis.ts line
 * 193 — the prompt explicitly translates HIGH→A, MEDIUM→B, LOW→C). Older
 * test fixtures and the calibration dashboard's tier-rank logic use the
 * calculator-native HIGH / MEDIUM / LOW labels. This function accepts both
 * conventions so production data and tests behave identically — without it,
 * production picks all bucket into REJECT and `hitRateByTier` looks empty.
 */
export function coerceTier(value: string | null | undefined): Tier {
  if (value == null) return 'REJECT';
  // AI-native (current production)
  if (value === 'A') return 'HIGH';
  if (value === 'B') return 'MEDIUM';
  if (value === 'C') return 'LOW';
  // Calculator-native (legacy fixtures + manual writes)
  if (value === 'HIGH' || value === 'MEDIUM' || value === 'LOW') return value;
  return 'REJECT';
}

// ===================================================================
// Pure summarizer — the main entry point
// ===================================================================

/**
 * Compute the full bundle of metrics for a list of pick rows.
 *
 * `startingBankroll` is used for the drawdown-percentage calculation. Defaults
 * to 100 (so a "1 unit per bet" sizing produces drawdown as a fraction of a
 * 100-unit bankroll). Pass the user's actual bankroll for accurate alerts.
 *
 * Pure: no IO, no Date.now(). Caller controls the input slice and the
 * bankroll. Easily unit-testable.
 *
 * The function never throws on missing fields — anything not captured (legacy
 * picks, snapshot failures, unresolved picks) is silently filtered out by the
 * per-helper null guards. Each metric reports the count of contributing rows
 * via the `picksWithCLV` / `resolvedPicks` / etc. fields so the UI can show
 * a denominator alongside the value.
 */
export function summarizePicks(
  picks: PickRow[],
  startingBankroll: number = 100,
): PickSummary {
  // Counts — these don't need any null guards
  const totalPicks = picks.length;
  const resolvedPicks = picks.filter((p) => isResolved(p)).length;
  const pendingPicks = picks.filter((p) => !isResolved(p)).length;
  const pushedPicks = picks.filter((p) => p.pushed).length;

  // Calibration: AI-adjusted predictions
  const aiPredictions: Prediction[] = picks
    .map(pickToPrediction)
    .filter((p): p is Prediction => p !== null);

  // Calibration: raw calculator predictions
  const rawPredictions: Prediction[] = picks
    .map(pickToRawPrediction)
    .filter((p): p is Prediction => p !== null);

  // ROI / hit rate / drawdown — all driven by ResolvedPick
  const resolved: ResolvedPick[] = picks
    .map(pickToResolved)
    .filter((p): p is ResolvedPick => p !== null);

  // CLV — driven by CLVPick (uses any pick with both odds present)
  const clvPicks: CLVPick[] = picks
    .map(pickToCLV)
    .filter((p): p is CLVPick => p !== null);

  // Hit rate by tier needs the (tier, won, pushed) shape — and the tier
  // here means the AI-confidence-tier the pick was placed at, not the raw
  // calculator tier (which we evaluate separately via rawPredictions).
  const hitRateByTierInput = picks
    .filter((p) => isResolved(p))
    .map((p) => ({
      tier: coerceTier(p.ai_confidence_tier),
      won: p.won === true,
      pushed: p.pushed,
    }));

  // Net units (sum of cumulative profit curve's final value)
  const profitCurve = cumulativeProfit(resolved);
  const netUnits = profitCurve.length === 0 ? 0 : profitCurve[profitCurve.length - 1];

  return {
    totalPicks,
    resolvedPicks,
    pendingPicks,
    pushedPicks,

    hitRate: hitRate(resolved),
    hitRateByTier: hitRateByTier(hitRateByTierInput),

    brierScore: brierScore(aiPredictions),
    logLoss: logLoss(aiPredictions),
    rawBrierScore: brierScore(rawPredictions),
    rawLogLoss: logLoss(rawPredictions),

    flatROI: flatROI(resolved),
    netUnits,
    maxDrawdown: maxDrawdown(resolved),
    maxDrawdownPct: maxDrawdownPct(resolved, startingBankroll),

    picksWithCLV: clvPicks.length,
    averageCLV: averageCLV(clvPicks),
  };
}

// ===================================================================
// Supabase query helpers (the only IO in this file)
// ===================================================================

/**
 * Fetch picks from Supabase with optional filters.
 *
 * Returns an empty array on error (logged to console). Callers should treat
 * an empty array as "no data" rather than "error" — the rest of the app
 * already gracefully handles empty pick lists.
 *
 * The function intentionally returns the full PickRow shape so callers can
 * pass the result directly to summarizePicks() or render rows in a table
 * without re-querying.
 */
export async function fetchPicks(
  supabase: SupabaseClient,
  filters: PickHistoryFilters = {},
): Promise<PickRow[]> {
  let query = supabase.from('picks').select('*');

  if (filters.fromDate) query = query.gte('date', filters.fromDate);
  if (filters.toDate) query = query.lte('date', filters.toDate);
  if (filters.tier) query = query.eq('ai_confidence_tier', filters.tier);
  if (filters.resolvedOnly) query = query.not('won', 'is', null);
  if (filters.limit) query = query.limit(filters.limit);

  query = query.order('date', { ascending: false });

  const { data, error } = await query;
  if (error) {
    console.error('fetchPicks error:', error.message);
    return [];
  }
  return (data ?? []) as PickRow[];
}

