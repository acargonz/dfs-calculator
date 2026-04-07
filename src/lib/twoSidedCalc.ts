/**
 * Two-sided prop evaluation.
 *
 * The calculator does NOT pick a side. It evaluates BOTH the over and the
 * under side of every prop using the existing pure math primitives in
 * `math.ts`, then returns a {over, under} record. The AI ensemble (which has
 * additional context like injury reports + the active Algorithmic Prompt
 * filters) is the actual decision maker for direction.
 *
 * Why both sides matter:
 *   - A line like "LeBron 24.5 points" can be a great UNDER bet even if the
 *     model thinks the over is mid. The old pipeline only computed the over,
 *     so unders were invisible to both the table and the AI.
 *   - The AI can now see calculator-level edge for each direction and decide
 *     which one to back based on its filters (matchup, recent form, etc.).
 *
 * This file is a thin orchestrator over `math.ts` — no new math lives here.
 */

import {
  applyModifiers,
  assignTier,
  blendProbabilities,
  devigProbit,
  kellyStake,
  modelCountingStat,
  modelPoints,
  type Modifier,
  type Tier,
} from './math';

// ============================================================================
// Types
// ============================================================================

export interface TwoSidedInput {
  statType: string;          // 'points' | 'rebounds' | 'assists' | 'pra' | 'fantasy' | etc.
  position: string;          // 'PG' | 'SG' | 'SF' | 'PF' | 'C'
  mean: number;              // Season-long average for the stat
  line: number;              // Sportsbook prop line
  overOdds: number;          // American odds for over
  underOdds: number;         // American odds for under
  bankroll: number;
  kellyMode: 'standard' | 'demon';
  paceModifier: number;      // ppDelta added to OVER side (under gets the inverse)
  injuryModifier: number;    // ppDelta added to OVER side (under gets the inverse)
}

export interface SideEvaluation {
  fairProb: number;          // Devigged fair probability for this side
  modelProb: number;         // Raw model probability for this side
  blendedProb: number;       // 60/40 model+fair blend (after modifiers applied)
  ev: number;                // Expected value at posted odds
  kellyStake: number;        // Recommended stake at fractional Kelly
  kellyFraction: number;     // Kelly fraction used (0.25 standard, 0.125 demon)
  tier: Tier;                // HIGH | MEDIUM | LOW | REJECT
}

export interface TwoSidedEvaluation {
  over: SideEvaluation;
  under: SideEvaluation;
  source: string;            // 'NegBinomial' | 'Binomial' (from underlying model)
}

// ============================================================================
// Internal helpers
// ============================================================================

/** Convert American odds to decimal odds. */
export function americanToDecimal(odds: number): number {
  if (odds < 0) return 1 + 100 / Math.abs(odds);
  return 1 + odds / 100;
}

/**
 * Build the modifier list for one side. The pace and injury modifiers are
 * defined relative to the OVER side. The under side receives the inverse,
 * preserving the over+under = 1 invariant in fair-probability space.
 */
function modifiersForSide(
  side: 'over' | 'under',
  paceModifier: number,
  injuryModifier: number,
): Modifier[] {
  const sign = side === 'over' ? 1 : -1;
  const out: Modifier[] = [];
  if (paceModifier !== 0) out.push({ name: 'Pace', ppDelta: sign * paceModifier });
  if (injuryModifier !== 0) out.push({ name: 'Injury', ppDelta: sign * injuryModifier });
  return out;
}

/**
 * Evaluate a single side given the model + fair probabilities.
 * Pure: calls into math.ts only.
 */
function evaluateSide(
  modelProb: number,
  fairProb: number,
  americanOdds: number,
  bankroll: number,
  kellyMode: 'standard' | 'demon',
  modifiers: Modifier[],
): SideEvaluation {
  let blended = blendProbabilities(modelProb, fairProb, 0.6);
  if (modifiers.length > 0) blended = applyModifiers(blended, modifiers);

  const decimalOdds = americanToDecimal(americanOdds);
  const kelly = kellyStake(blended, decimalOdds, bankroll, kellyMode);

  const tier = assignTier({
    prob: blended,
    ev: kelly.ev,
    majorFlags: 0,
    minorFlags: 0,
  });

  return {
    fairProb,
    modelProb,
    blendedProb: blended,
    ev: kelly.ev,
    kellyStake: kelly.stake,
    kellyFraction: kelly.fraction,
    tier,
  };
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Evaluate both the over and under side of a prop. Reuses the existing
 * math primitives — no duplication of logic.
 *
 * Steps:
 *   1. Devig once → fair {over, under}
 *   2. Model once → {overProb, underProb}
 *   3. For each side: blend → modifiers → kelly → tier
 *   4. Return both side evaluations + the underlying model source label
 */
export function evaluateBothSides(input: TwoSidedInput): TwoSidedEvaluation {
  const fair = devigProbit(input.overOdds, input.underOdds);

  const model =
    input.statType === 'points'
      ? modelPoints(input.mean, input.line, input.position)
      : modelCountingStat(input.mean, input.line, input.position, input.statType);

  const overModifiers = modifiersForSide('over', input.paceModifier, input.injuryModifier);
  const underModifiers = modifiersForSide('under', input.paceModifier, input.injuryModifier);

  const over = evaluateSide(
    model.overProb,
    fair.over,
    input.overOdds,
    input.bankroll,
    input.kellyMode,
    overModifiers,
  );

  const under = evaluateSide(
    model.underProb,
    fair.under,
    input.underOdds,
    input.bankroll,
    input.kellyMode,
    underModifiers,
  );

  return { over, under, source: model.source };
}

// ============================================================================
// Best-side selector (used by UI rendering — never persisted)
// ============================================================================

export type BestSide = 'over' | 'under';

/**
 * Picks the "stronger" side for display in tables that only have room for
 * one row per prop. The AI ensemble always sees BOTH sides regardless of
 * what this function returns — this is purely a UX helper.
 *
 * Tie-break order:
 *   1. Highest tier wins (HIGH > MEDIUM > LOW > REJECT)
 *   2. Within the same tier, highest EV wins
 *   3. If both sides are REJECT, defaults to over so REJECTs still display
 *      consistently (Option A from the design discussion).
 */
export function pickBestSide(evaluation: TwoSidedEvaluation): BestSide {
  const tierRank: Record<Tier, number> = { HIGH: 0, MEDIUM: 1, LOW: 2, REJECT: 3 };
  const overRank = tierRank[evaluation.over.tier];
  const underRank = tierRank[evaluation.under.tier];

  if (overRank !== underRank) return overRank < underRank ? 'over' : 'under';
  if (evaluation.over.ev !== evaluation.under.ev) {
    return evaluation.over.ev > evaluation.under.ev ? 'over' : 'under';
  }
  return 'over';
}
