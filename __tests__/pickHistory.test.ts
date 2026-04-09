import {
  pickBetOdds,
  pickClosingOdds,
  isResolved,
  pickToPrediction,
  pickToRawPrediction,
  pickToResolved,
  pickToCLV,
  summarizePicks,
} from '../src/lib/pickHistory';
import type { PickRow } from '../src/lib/supabase';

// ============================================================================
// Test fixtures
// ============================================================================

/**
 * Build a PickRow with sensible defaults. Override any fields per test.
 */
function makePick(overrides: Partial<PickRow> = {}): PickRow {
  return {
    id: 'pick-1',
    analysis_id: 'analysis-1',
    date: '2026-04-06',
    player_name: 'LeBron James',
    team: 'LAL',
    opponent: 'BOS',
    stat_type: 'points',
    line: 24.5,
    direction: 'over',
    calculator_prob: 0.6,
    calculator_ev: 0.05,
    calculator_tier: 'MEDIUM',
    calculator_stake: 5,
    ai_confidence_tier: 'MEDIUM',
    ai_reasoning: null,
    ai_flags: null,
    ai_modifiers: null,
    actual_value: null,
    won: null,
    pushed: false,
    resolved_at: null,
    created_at: '2026-04-06T20:00:00Z',

    bet_odds_over: -110,
    bet_odds_under: -110,
    closing_odds_over: -120,
    closing_odds_under: +100,
    closing_line: 24.5,
    closing_snapshot_at: '2026-04-06T23:55:00Z',
    bookmaker: 'draftkings',
    home_away: 'home',
    flat_unit_stake: 1,
    raw_calculator_prob: 0.55,
    raw_calculator_tier: 'LOW',
    pace_modifier: 0,
    injury_modifier: 0,

    ...overrides,
  };
}

// ============================================================================
// pickBetOdds / pickClosingOdds (direction-aware side selection)
// ============================================================================

describe('pickBetOdds', () => {
  test('returns bet_odds_over for an over pick', () => {
    expect(pickBetOdds(makePick({ direction: 'over', bet_odds_over: -130 }))).toBe(-130);
  });

  test('returns bet_odds_under for an under pick', () => {
    expect(pickBetOdds(makePick({ direction: 'under', bet_odds_under: +110 }))).toBe(+110);
  });

  test('returns null when the relevant column is null', () => {
    expect(pickBetOdds(makePick({ direction: 'over', bet_odds_over: null }))).toBeNull();
  });
});

describe('pickClosingOdds', () => {
  test('returns closing_odds_over for an over pick', () => {
    expect(pickClosingOdds(makePick({ direction: 'over', closing_odds_over: -125 }))).toBe(-125);
  });

  test('returns closing_odds_under for an under pick', () => {
    expect(pickClosingOdds(makePick({ direction: 'under', closing_odds_under: +105 }))).toBe(+105);
  });

  test('returns null when the relevant column is null', () => {
    expect(pickClosingOdds(makePick({ direction: 'under', closing_odds_under: null }))).toBeNull();
  });
});

// ============================================================================
// isResolved
// ============================================================================

describe('isResolved', () => {
  test('returns false when won is null', () => {
    expect(isResolved(makePick({ won: null }))).toBe(false);
  });

  test('returns true when won is true', () => {
    expect(isResolved(makePick({ won: true }))).toBe(true);
  });

  test('returns true when won is false (decided loss)', () => {
    expect(isResolved(makePick({ won: false }))).toBe(true);
  });
});

// ============================================================================
// pickToPrediction
// ============================================================================

describe('pickToPrediction', () => {
  test('returns null for unresolved pick', () => {
    expect(pickToPrediction(makePick({ won: null }))).toBeNull();
  });

  test('returns null for pushed pick', () => {
    expect(pickToPrediction(makePick({ won: false, pushed: true }))).toBeNull();
  });

  test('returns null when calculator_prob is null', () => {
    expect(pickToPrediction(makePick({ won: true, calculator_prob: null }))).toBeNull();
  });

  test('returns probability + outcome=1 for a win', () => {
    const result = pickToPrediction(makePick({ won: true, calculator_prob: 0.62 }));
    expect(result).toEqual({ probability: 0.62, outcome: 1 });
  });

  test('returns probability + outcome=0 for a loss', () => {
    const result = pickToPrediction(makePick({ won: false, calculator_prob: 0.55 }));
    expect(result).toEqual({ probability: 0.55, outcome: 0 });
  });

  // Regression: legacy picks written before the analyze-route sanitizer
  // landed could store calculator_prob as a percentage (e.g. 65 instead of
  // 0.65). Letting one through poisoned brierScore — the user-visible
  // banner read "Brier: 4198.0281" because (65 − 1)² ≈ 4096 was averaged in
  // with the legitimate sub-1 values. The bounds guard filters them out.
  test('returns null when calculator_prob is stored as a percentage (>1)', () => {
    expect(
      pickToPrediction(makePick({ won: true, calculator_prob: 65 })),
    ).toBeNull();
  });

  test('returns null when calculator_prob is negative', () => {
    expect(
      pickToPrediction(makePick({ won: true, calculator_prob: -0.1 })),
    ).toBeNull();
  });

  test('returns null when calculator_prob is NaN', () => {
    expect(
      pickToPrediction(makePick({ won: true, calculator_prob: Number.NaN })),
    ).toBeNull();
  });

  test('accepts boundary values 0 and 1', () => {
    expect(pickToPrediction(makePick({ won: false, calculator_prob: 0 }))).toEqual({
      probability: 0,
      outcome: 0,
    });
    expect(pickToPrediction(makePick({ won: true, calculator_prob: 1 }))).toEqual({
      probability: 1,
      outcome: 1,
    });
  });
});

// ============================================================================
// pickToRawPrediction
// ============================================================================

describe('pickToRawPrediction', () => {
  test('uses raw_calculator_prob, not calculator_prob', () => {
    const result = pickToRawPrediction(
      makePick({ won: true, calculator_prob: 0.7, raw_calculator_prob: 0.55 }),
    );
    expect(result).toEqual({ probability: 0.55, outcome: 1 });
  });

  test('returns null when raw_calculator_prob is null', () => {
    expect(
      pickToRawPrediction(makePick({ won: true, raw_calculator_prob: null })),
    ).toBeNull();
  });

  test('returns null for unresolved or pushed picks', () => {
    expect(pickToRawPrediction(makePick({ won: null }))).toBeNull();
    expect(
      pickToRawPrediction(makePick({ won: false, pushed: true })),
    ).toBeNull();
  });

  test('returns null when raw_calculator_prob is out of [0,1]', () => {
    expect(
      pickToRawPrediction(makePick({ won: true, raw_calculator_prob: 55 })),
    ).toBeNull();
    expect(
      pickToRawPrediction(makePick({ won: true, raw_calculator_prob: -0.5 })),
    ).toBeNull();
    expect(
      pickToRawPrediction(makePick({ won: true, raw_calculator_prob: Number.NaN })),
    ).toBeNull();
  });
});

// ============================================================================
// pickToResolved
// ============================================================================

describe('pickToResolved', () => {
  test('returns null for unresolved pick', () => {
    expect(pickToResolved(makePick({ won: null }))).toBeNull();
  });

  test('returns null when bet odds are missing for the chosen side', () => {
    expect(
      pickToResolved(makePick({ won: true, direction: 'over', bet_odds_over: null })),
    ).toBeNull();
  });

  test('uses bet_odds_over for an over pick', () => {
    const result = pickToResolved(
      makePick({ won: true, direction: 'over', bet_odds_over: -115, bet_odds_under: 99999 }),
    );
    expect(result?.odds).toBe(-115);
    expect(result?.won).toBe(true);
    expect(result?.pushed).toBe(false);
  });

  test('uses bet_odds_under for an under pick', () => {
    const result = pickToResolved(
      makePick({ won: false, direction: 'under', bet_odds_under: +105, bet_odds_over: 99999 }),
    );
    expect(result?.odds).toBe(+105);
    expect(result?.won).toBe(false);
  });

  test('preserves pushed flag', () => {
    const result = pickToResolved(makePick({ won: false, pushed: true }));
    expect(result?.pushed).toBe(true);
  });

  test('default flat_unit_stake = 1 if missing', () => {
    const result = pickToResolved(makePick({ won: true, flat_unit_stake: null }));
    expect(result?.stake).toBe(1);
  });

  test('uses flat_unit_stake when present', () => {
    const result = pickToResolved(makePick({ won: true, flat_unit_stake: 2.5 }));
    expect(result?.stake).toBe(2.5);
  });
});

// ============================================================================
// pickToCLV
// ============================================================================

describe('pickToCLV', () => {
  test('returns null when bet odds are missing', () => {
    expect(pickToCLV(makePick({ direction: 'over', bet_odds_over: null }))).toBeNull();
  });

  test('returns null when closing odds are missing', () => {
    expect(
      pickToCLV(makePick({ direction: 'over', closing_odds_over: null })),
    ).toBeNull();
  });

  test('returns over odds for an over pick', () => {
    const result = pickToCLV(
      makePick({
        direction: 'over',
        bet_odds_over: -110,
        closing_odds_over: -120,
      }),
    );
    expect(result).toEqual({ betOdds: -110, closingOdds: -120 });
  });

  test('returns under odds for an under pick', () => {
    const result = pickToCLV(
      makePick({
        direction: 'under',
        bet_odds_under: +100,
        closing_odds_under: -105,
      }),
    );
    expect(result).toEqual({ betOdds: +100, closingOdds: -105 });
  });

  test('returns CLV data even for unresolved picks (CLV does not need outcome)', () => {
    const result = pickToCLV(makePick({ won: null }));
    expect(result).not.toBeNull();
  });
});

// ============================================================================
// summarizePicks
// ============================================================================

describe('summarizePicks', () => {
  test('empty input returns zero counts and NaN metrics', () => {
    const summary = summarizePicks([]);
    expect(summary.totalPicks).toBe(0);
    expect(summary.resolvedPicks).toBe(0);
    expect(summary.pendingPicks).toBe(0);
    expect(summary.pushedPicks).toBe(0);
    expect(Number.isNaN(summary.hitRate)).toBe(true);
    expect(Number.isNaN(summary.brierScore)).toBe(true);
    expect(Number.isNaN(summary.logLoss)).toBe(true);
    expect(Number.isNaN(summary.flatROI)).toBe(true);
    expect(Number.isNaN(summary.averageCLV)).toBe(true);
    expect(summary.netUnits).toBe(0);
    expect(summary.maxDrawdown).toBe(0);
    expect(summary.maxDrawdownPct).toBe(0);
    expect(summary.picksWithCLV).toBe(0);
  });

  test('counts pending vs resolved vs pushed correctly', () => {
    const picks = [
      makePick({ id: 'p1', won: true }),
      makePick({ id: 'p2', won: false }),
      makePick({ id: 'p3', won: null }),
      makePick({ id: 'p4', won: false, pushed: true }),
    ];
    const summary = summarizePicks(picks);
    expect(summary.totalPicks).toBe(4);
    expect(summary.resolvedPicks).toBe(3); // wins + losses + pushes (won != null)
    expect(summary.pendingPicks).toBe(1);
    expect(summary.pushedPicks).toBe(1);
  });

  test('hitRate ignores unresolved and pushed picks', () => {
    const picks = [
      makePick({ id: 'p1', won: true }),
      makePick({ id: 'p2', won: false }),
      makePick({ id: 'p3', won: null }), // pending — ignored
      makePick({ id: 'p4', won: false, pushed: true }), // pushed — ignored
    ];
    const summary = summarizePicks(picks);
    expect(summary.hitRate).toBe(0.5); // 1 win / 2 decided
  });

  test('brierScore reflects probability vs outcome quality', () => {
    const picks = [
      makePick({ id: 'p1', won: true, calculator_prob: 0.9 }), // good
      makePick({ id: 'p2', won: false, calculator_prob: 0.1 }), // good
    ];
    const summary = summarizePicks(picks);
    // (0.9-1)^2 + (0.1-0)^2 = 0.01 + 0.01 = 0.02 / 2 = 0.01
    expect(summary.brierScore).toBeCloseTo(0.01, 5);
  });

  test('rawBrierScore differs from brierScore when raw_calculator_prob differs', () => {
    const picks = [
      makePick({
        id: 'p1',
        won: true,
        calculator_prob: 0.9,
        raw_calculator_prob: 0.55,
      }),
      makePick({
        id: 'p2',
        won: false,
        calculator_prob: 0.1,
        raw_calculator_prob: 0.45,
      }),
    ];
    const summary = summarizePicks(picks);
    expect(summary.brierScore).not.toBeCloseTo(summary.rawBrierScore, 3);
    // AI is much better calibrated in this fixture
    expect(summary.brierScore).toBeLessThan(summary.rawBrierScore);
  });

  test('hitRateByTier breaks down correctly', () => {
    const picks = [
      makePick({ id: 'p1', won: true, ai_confidence_tier: 'HIGH' }),
      makePick({ id: 'p2', won: true, ai_confidence_tier: 'HIGH' }),
      makePick({ id: 'p3', won: false, ai_confidence_tier: 'HIGH' }),
      makePick({ id: 'p4', won: true, ai_confidence_tier: 'MEDIUM' }),
      makePick({ id: 'p5', won: false, ai_confidence_tier: 'MEDIUM' }),
    ];
    const summary = summarizePicks(picks);
    expect(summary.hitRateByTier.HIGH).toBeCloseTo(2 / 3, 5);
    expect(summary.hitRateByTier.MEDIUM).toBe(0.5);
    expect(Number.isNaN(summary.hitRateByTier.LOW)).toBe(true);
    expect(Number.isNaN(summary.hitRateByTier.REJECT)).toBe(true);
  });

  test('flatROI uses bet-time odds for the chosen direction', () => {
    const picks = [
      // Over pick won at -110 → +0.909 profit
      makePick({
        id: 'p1',
        won: true,
        direction: 'over',
        bet_odds_over: -110,
        bet_odds_under: 99999,
      }),
      // Under pick lost at -110 → -1 profit
      makePick({
        id: 'p2',
        won: false,
        direction: 'under',
        bet_odds_under: -110,
        bet_odds_over: 99999,
      }),
    ];
    const summary = summarizePicks(picks);
    // (0.909 - 1) / 2 = -0.0455
    expect(summary.flatROI).toBeCloseTo(-0.0455, 3);
    expect(summary.netUnits).toBeCloseTo(-0.0909, 3);
  });

  test('maxDrawdownPct uses startingBankroll parameter', () => {
    const picks = [
      makePick({ id: 'p1', won: false }),
      makePick({ id: 'p2', won: false }),
      makePick({ id: 'p3', won: false }),
    ];
    // 3 losses at -110 each = -3 units, bankroll = 10 → 30% DD
    expect(summarizePicks(picks, 10).maxDrawdownPct).toBeCloseTo(0.3, 5);
    // Same losses, bigger bankroll → smaller DD%
    expect(summarizePicks(picks, 100).maxDrawdownPct).toBeCloseTo(0.03, 5);
  });

  test('picksWithCLV counts only picks with both bet+closing odds', () => {
    const picks = [
      makePick({ id: 'p1' }), // has both → counted
      makePick({ id: 'p2', closing_odds_over: null }), // missing closing → skipped
      makePick({ id: 'p3', bet_odds_over: null }), // missing bet → skipped
      makePick({ id: 'p4' }), // has both → counted
    ];
    const summary = summarizePicks(picks);
    expect(summary.picksWithCLV).toBe(2);
    expect(Number.isNaN(summary.averageCLV)).toBe(false);
  });

  test('averageCLV is positive when lines tightened against picks', () => {
    // Each pick: bet at -110 (52.4%), closed at -130 (56.5%) → +4.1pp CLV
    const picks = [
      makePick({ id: 'p1', bet_odds_over: -110, closing_odds_over: -130 }),
      makePick({ id: 'p2', bet_odds_over: -110, closing_odds_over: -130 }),
      makePick({ id: 'p3', bet_odds_over: -110, closing_odds_over: -130 }),
    ];
    const summary = summarizePicks(picks);
    expect(summary.averageCLV).toBeGreaterThan(0.03);
  });

  test('legacy picks with no captured odds are gracefully skipped', () => {
    const picks = [
      makePick({
        id: 'legacy',
        won: true,
        bet_odds_over: null,
        bet_odds_under: null,
        closing_odds_over: null,
        closing_odds_under: null,
      }),
    ];
    const summary = summarizePicks(picks);
    expect(summary.totalPicks).toBe(1);
    expect(summary.resolvedPicks).toBe(1);
    expect(summary.picksWithCLV).toBe(0);
    // ROI uses ResolvedPick → null because bet_odds null → not counted
    expect(Number.isNaN(summary.flatROI)).toBe(true);
    expect(summary.netUnits).toBe(0);
  });

  test('REJECT tier coercion handles odd tier strings', () => {
    const picks = [
      makePick({ id: 'p1', won: true, ai_confidence_tier: 'NOT_A_REAL_TIER' }),
    ];
    const summary = summarizePicks(picks);
    // Unknown tier strings collapse into REJECT bucket
    expect(summary.hitRateByTier.REJECT).toBe(1);
  });

  test('coerceTier translates AI-native A/B/C to HIGH/MEDIUM/LOW (production data path)', () => {
    // This is the bug we fixed: production /api/analyze writes
    // ai_confidence_tier as 'A'/'B'/'C'/'REJECT' (the AI's native labels per
    // aiAnalysis.ts:193). Pre-fix, all of these silently collapsed into the
    // REJECT bucket because coerceTier only knew about HIGH/MEDIUM/LOW.
    const picks = [
      makePick({ id: 'p1', won: true, ai_confidence_tier: 'A' }),
      makePick({ id: 'p2', won: false, ai_confidence_tier: 'A' }),
      makePick({ id: 'p3', won: true, ai_confidence_tier: 'B' }),
      makePick({ id: 'p4', won: true, ai_confidence_tier: 'C' }),
      makePick({ id: 'p5', won: false, ai_confidence_tier: 'C' }),
    ];
    const summary = summarizePicks(picks);
    expect(summary.hitRateByTier.HIGH).toBe(0.5);
    expect(summary.hitRateByTier.MEDIUM).toBe(1);
    expect(summary.hitRateByTier.LOW).toBe(0.5);
    expect(Number.isNaN(summary.hitRateByTier.REJECT)).toBe(true);
  });

  test('legacy out-of-range probabilities cannot blow up brierScore', () => {
    // Reproduces the production incident: an SystemStatusCard alert showed
    // "Brier: 4198.0281" because some legacy picks stored calculator_prob as
    // a percentage (65) instead of a fraction (0.65). With the read-side
    // bounds guard those legacy rows are filtered out and Brier stays in
    // the mathematically valid [0,1] range — derived from the well-formed
    // picks alone.
    const picks = [
      makePick({ id: 'good1', won: true, calculator_prob: 0.7 }),
      makePick({ id: 'good2', won: false, calculator_prob: 0.3 }),
      makePick({ id: 'legacy', won: true, calculator_prob: 65 }),
    ];
    const summary = summarizePicks(picks);
    expect(summary.brierScore).toBeGreaterThanOrEqual(0);
    expect(summary.brierScore).toBeLessThanOrEqual(1);
    // Sanity: only the two well-formed picks contribute → (0.7-1)² + (0.3-0)² = 0.18 / 2 = 0.09
    expect(summary.brierScore).toBeCloseTo(0.09, 5);
  });

  test('coerceTier accepts both HIGH/MEDIUM/LOW and A/B/C in the same dataset', () => {
    // Dual-format support so legacy fixtures + production data coexist
    // without separate code paths.
    const picks = [
      makePick({ id: 'p1', won: true, ai_confidence_tier: 'HIGH' }),
      makePick({ id: 'p2', won: true, ai_confidence_tier: 'A' }),
      makePick({ id: 'p3', won: false, ai_confidence_tier: 'A' }),
    ];
    const summary = summarizePicks(picks);
    // 3 HIGH-tier picks total, 2 wins → 66.7%
    expect(summary.hitRateByTier.HIGH).toBeCloseTo(2 / 3, 5);
  });
});
