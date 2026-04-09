/** @jest-environment jsdom */

/**
 * Tests for CalibrationDashboard.
 *
 * The component is mostly a thin presentation layer over a pure view-model
 * builder (buildDashboardViewModel). We test the VM builder directly against
 * canned PickRow fixtures (fast, no mocking) and then hit the component with
 * a small set of integration tests that cover loading / error / empty /
 * populated states via a mocked fetch.
 */

import { render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import CalibrationDashboard, {
  buildDashboardViewModel,
} from '../src/components/CalibrationDashboard';
import type { PickRow } from '../src/lib/supabase';
import type { PickSummary } from '../src/lib/pickHistory';

// ===================================================================
// Fixture factory — builds minimal PickRow objects
// ===================================================================

function makePick(overrides: Partial<PickRow> = {}): PickRow {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    analysis_id: null,
    date: '2026-04-01',
    player_name: 'Test Player',
    team: null,
    opponent: null,
    stat_type: 'points',
    line: 20.5,
    direction: 'over',
    calculator_prob: 0.55,
    calculator_ev: 0.05,
    calculator_tier: 'MEDIUM',
    calculator_stake: 1,
    ai_confidence_tier: 'MEDIUM',
    ai_reasoning: null,
    ai_flags: null,
    ai_modifiers: null,
    actual_value: null,
    won: true,
    pushed: false,
    resolved_at: '2026-04-02T00:00:00Z',
    created_at: '2026-04-01T20:00:00Z',
    bet_odds_over: -110,
    bet_odds_under: -110,
    closing_odds_over: -115,
    closing_odds_under: -105,
    closing_line: 20.5,
    closing_snapshot_at: '2026-04-01T22:30:00Z',
    bookmaker: 'DraftKings',
    home_away: 'home',
    flat_unit_stake: 1,
    raw_calculator_prob: 0.52,
    raw_calculator_tier: 'MEDIUM',
    pace_modifier: 0,
    injury_modifier: 0,
    ...overrides,
  };
}

function makeEmptySummary(): PickSummary {
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
  };
}

// ===================================================================
// Pure-function tests (no React)
// ===================================================================

describe('buildDashboardViewModel', () => {
  test('empty picks returns empty VM with NaN CIs', () => {
    const vm = buildDashboardViewModel([]);
    expect(vm.resolvedCount).toBe(0);
    expect(vm.aiPredictionCount).toBe(0);
    expect(vm.rawPredictionCount).toBe(0);
    expect(vm.profitCurve).toEqual([]);
    expect(Number.isNaN(vm.hitRateCI.mean)).toBe(true);
    expect(Number.isNaN(vm.flatROICI.mean)).toBe(true);
    expect(Number.isNaN(vm.clvCI.mean)).toBe(true);
    expect(vm.byBookmaker).toEqual([]);
  });

  test('always returns 10 reliability bins for default bin count', () => {
    const vm = buildDashboardViewModel([]);
    expect(vm.aiBins).toHaveLength(10);
    expect(vm.rawBins).toHaveLength(10);
  });

  test('separates AI and raw predictions independently', () => {
    const picks = [
      makePick({ calculator_prob: 0.55, raw_calculator_prob: 0.52, won: true }),
      makePick({ calculator_prob: 0.55, raw_calculator_prob: 0.52, won: false }),
    ];
    const vm = buildDashboardViewModel(picks);
    expect(vm.aiPredictionCount).toBe(2);
    expect(vm.rawPredictionCount).toBe(2);
    // Both land in bin 5 (0.5-0.6) for AI and bin 5 (0.5-0.6) for raw
    expect(vm.aiBins[5].count).toBe(2);
    expect(vm.aiBins[5].observedRate).toBe(0.5);
    expect(vm.rawBins[5].count).toBe(2);
    expect(vm.rawBins[5].observedRate).toBe(0.5);
  });

  test('excludes raw predictions when raw_calculator_prob is null', () => {
    const picks = [
      makePick({ calculator_prob: 0.55, raw_calculator_prob: null, won: true }),
      makePick({ calculator_prob: 0.6, raw_calculator_prob: 0.58, won: false }),
    ];
    const vm = buildDashboardViewModel(picks);
    expect(vm.aiPredictionCount).toBe(2);
    expect(vm.rawPredictionCount).toBe(1);
  });

  test('cumulative profit curve is sorted chronologically', () => {
    // Intentionally out-of-order dates to verify sorting
    const picks = [
      makePick({ date: '2026-04-03', bet_odds_over: -110, won: true }),
      makePick({ date: '2026-04-01', bet_odds_over: -110, won: false }),
      makePick({ date: '2026-04-02', bet_odds_over: -110, won: true }),
    ];
    const vm = buildDashboardViewModel(picks);
    expect(vm.profitCurve).toHaveLength(3);
    // Day 1: loss (-1), Day 2: win (~0.909), Day 3: win (~0.909)
    expect(vm.profitCurve[0]).toBeCloseTo(-1, 2);
    expect(vm.profitCurve[1]).toBeCloseTo(-1 + 100 / 110, 2);
    expect(vm.profitCurve[2]).toBeCloseTo(-1 + 2 * (100 / 110), 2);
  });

  test('skips picks with no bet-time odds from resolved/profit', () => {
    const picks = [
      makePick({ bet_odds_over: null, bet_odds_under: null, won: true }),
      makePick({ bet_odds_over: -110, won: true }),
    ];
    const vm = buildDashboardViewModel(picks);
    expect(vm.resolvedCount).toBe(1);
    expect(vm.profitCurve).toHaveLength(1);
  });

  test('hit rate CI is populated even when picks lack bet odds (legacy data)', () => {
    // The "60 resolved, dashboard empty" bug came from deriving the hit rate
    // CI off the `resolved` array — which requires bet odds. Legacy picks
    // pre-migration-001 have no bet_odds_*, so the CI was NaN even though
    // the picks had clear win/loss outcomes. After the fix, the hit rate CI
    // should be computed directly from picks (won != null && !pushed).
    const picks = Array.from({ length: 10 }, (_, i) =>
      makePick({
        id: `pick-${i}`,
        won: i < 6, // 6 wins / 4 losses
        bet_odds_over: null,
        bet_odds_under: null,
      }),
    );
    const vm = buildDashboardViewModel(picks);
    // Resolved-with-odds count is 0 — ROI / CLV / profit math correctly skip
    expect(vm.resolvedCount).toBe(0);
    expect(vm.profitCurve).toHaveLength(0);
    expect(Number.isNaN(vm.flatROICI.mean)).toBe(true);
    expect(Number.isNaN(vm.clvCI.mean)).toBe(true);
    // But the hit rate CI is still populated from the outcomes alone
    expect(vm.hitRateCI.mean).toBeCloseTo(0.6, 5);
    expect(Number.isFinite(vm.hitRateCI.lower)).toBe(true);
    expect(Number.isFinite(vm.hitRateCI.upper)).toBe(true);
  });

  test('hit rate CI excludes pushed picks', () => {
    const picks = [
      makePick({ won: true, pushed: false, bet_odds_over: -110 }),
      makePick({ won: false, pushed: false, bet_odds_over: -110 }),
      makePick({ won: null, pushed: true, bet_odds_over: -110 }),
    ];
    const vm = buildDashboardViewModel(picks);
    // 1 win out of 2 non-pushed = 0.5
    expect(vm.hitRateCI.mean).toBeCloseTo(0.5, 5);
  });

  test('hit rate CI mean equals outcome mean (deterministic with seed)', () => {
    const picks = Array.from({ length: 10 }, (_, i) =>
      makePick({
        id: `pick-${i}`,
        won: i < 6, // 6 wins / 4 losses
        bet_odds_over: -110,
      }),
    );
    const vm = buildDashboardViewModel(picks);
    expect(vm.hitRateCI.mean).toBeCloseTo(0.6, 5);
    expect(vm.hitRateCI.lower).toBeLessThanOrEqual(vm.hitRateCI.mean);
    expect(vm.hitRateCI.upper).toBeGreaterThanOrEqual(vm.hitRateCI.mean);
  });

  test('by-bookmaker groups and sorts by pick count descending', () => {
    const picks = [
      makePick({ bookmaker: 'DraftKings', won: true, bet_odds_over: -110 }),
      makePick({ bookmaker: 'DraftKings', won: false, bet_odds_over: -110 }),
      makePick({ bookmaker: 'DraftKings', won: true, bet_odds_over: -110 }),
      makePick({ bookmaker: 'FanDuel', won: true, bet_odds_over: -110 }),
    ];
    const vm = buildDashboardViewModel(picks);
    expect(vm.byBookmaker).toHaveLength(2);
    expect(vm.byBookmaker[0]).toMatchObject({
      book: 'DraftKings',
      picks: 3,
    });
    expect(vm.byBookmaker[0].hitRate).toBeCloseTo(2 / 3, 3);
    expect(vm.byBookmaker[1]).toMatchObject({
      book: 'FanDuel',
      picks: 1,
      hitRate: 1,
    });
  });

  test('groups unknown bookmaker into (unknown) bucket', () => {
    const picks = [
      makePick({ bookmaker: null, won: true, bet_odds_over: -110 }),
      makePick({ bookmaker: null, won: false, bet_odds_over: -110 }),
    ];
    const vm = buildDashboardViewModel(picks);
    expect(vm.byBookmaker).toHaveLength(1);
    expect(vm.byBookmaker[0].book).toBe('(unknown)');
    expect(vm.byBookmaker[0].picks).toBe(2);
  });

  test('CLV CI is populated when closing odds are present', () => {
    const picks = Array.from({ length: 10 }, (_, i) =>
      makePick({
        id: `pick-${i}`,
        bet_odds_over: -110,
        closing_odds_over: -120, // line moved against us = positive CLV
        direction: 'over',
        won: true,
      }),
    );
    const vm = buildDashboardViewModel(picks);
    expect(Number.isFinite(vm.clvCI.mean)).toBe(true);
    expect(vm.clvCI.mean).toBeGreaterThan(0);
  });

  test('CLV is NaN when no closing odds captured', () => {
    const picks = [
      makePick({
        closing_odds_over: null,
        closing_odds_under: null,
      }),
    ];
    const vm = buildDashboardViewModel(picks);
    expect(Number.isNaN(vm.clvCI.mean)).toBe(true);
  });

  test('respects direction when reading bet/closing odds', () => {
    const overPick = makePick({
      direction: 'over',
      bet_odds_over: -110,
      bet_odds_under: +100,
      closing_odds_over: -120,
      closing_odds_under: +110,
      won: true,
    });
    const underPick = makePick({
      direction: 'under',
      bet_odds_over: -110,
      bet_odds_under: +100,
      closing_odds_over: -120,
      closing_odds_under: +110,
      won: true,
    });
    const vm = buildDashboardViewModel([overPick, underPick]);
    // Both should land in the resolved set
    expect(vm.resolvedCount).toBe(2);
    // Both had closing data → CLV computed for both
    expect(Number.isFinite(vm.clvCI.mean)).toBe(true);
  });
});

// ===================================================================
// Component integration tests (with mocked fetch)
// ===================================================================

interface MockResponse {
  picks: PickRow[];
  summary: PickSummary;
  count: number;
}

function mockFetchOnce(body: MockResponse, ok: boolean = true) {
  const fetchMock = jest.fn().mockResolvedValueOnce({
    ok,
    json: async () => body,
  });
  (global as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function mockFetchError(message: string) {
  const fetchMock = jest.fn().mockRejectedValueOnce(new Error(message));
  (global as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch;
  return fetchMock;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('CalibrationDashboard', () => {
  it('shows loading state initially', () => {
    (global as unknown as { fetch: typeof fetch }).fetch = jest
      .fn()
      .mockReturnValue(new Promise(() => {})) as unknown as typeof fetch;
    render(<CalibrationDashboard />);
    expect(screen.getByText(/loading calibration data/i)).toBeInTheDocument();
  });

  it('shows empty state when no picks', async () => {
    mockFetchOnce({ picks: [], summary: makeEmptySummary(), count: 0 });
    render(<CalibrationDashboard />);
    await waitFor(() => {
      expect(screen.getByTestId('calibration-empty')).toBeInTheDocument();
    });
  });

  it('shows empty state when picks exist but none are resolved yet', async () => {
    // Regression guard for the empty-state trigger. The fix for the
    // "missing odds" bug swapped the guard from `vm.resolvedCount === 0`
    // (which required bet odds) to `summary.resolvedPicks === 0`. This
    // test locks in that the all-pending case still hits the empty state —
    // otherwise a brand-new user with only pending picks would see a
    // half-rendered dashboard full of NaN metrics.
    const picks = [
      makePick({ won: null, pushed: false, resolved_at: null }),
      makePick({ won: null, pushed: false, resolved_at: null }),
    ];
    mockFetchOnce({
      picks,
      summary: {
        ...makeEmptySummary(),
        totalPicks: 2,
        resolvedPicks: 0,
        pendingPicks: 2,
      },
      count: 2,
    });
    render(<CalibrationDashboard />);
    await waitFor(() => {
      expect(screen.getByTestId('calibration-empty')).toBeInTheDocument();
    });
    // And critically NOT the populated dashboard
    expect(
      screen.queryByTestId('calibration-dashboard'),
    ).not.toBeInTheDocument();
  });

  it('shows error state when fetch fails', async () => {
    mockFetchError('Network down');
    render(<CalibrationDashboard />);
    await waitFor(() => {
      expect(screen.getByText(/network down/i)).toBeInTheDocument();
    });
  });

  it('shows dashboard when resolved picks are available', async () => {
    const picks = [
      makePick({ won: true, bet_odds_over: -110 }),
      makePick({ won: false, bet_odds_over: -110 }),
      makePick({ won: true, bet_odds_over: -110 }),
    ];
    mockFetchOnce({
      picks,
      summary: {
        ...makeEmptySummary(),
        totalPicks: 3,
        resolvedPicks: 3,
        hitRate: 2 / 3,
      },
      count: 3,
    });
    render(<CalibrationDashboard />);
    await waitFor(() => {
      expect(screen.getByTestId('calibration-dashboard')).toBeInTheDocument();
    });
    // Reliability curve SVG renders
    expect(screen.getByTestId('reliability-curve')).toBeInTheDocument();
    // Profit curve SVG renders
    expect(screen.getByTestId('profit-curve')).toBeInTheDocument();
    // Headline metrics section shows the pick count
    expect(screen.getByText(/3 resolved picks/i)).toBeInTheDocument();
  });

  it('renders dashboard for resolved picks even when bet odds are missing', async () => {
    // Reproduces the user-facing bug: 60 resolved picks in the DB, all
    // pre-migration-001 (no bet_odds_*), calibration tab showed empty state.
    const picks = [
      makePick({ won: true, bet_odds_over: null, bet_odds_under: null }),
      makePick({ won: false, bet_odds_over: null, bet_odds_under: null }),
      makePick({ won: true, bet_odds_over: null, bet_odds_under: null }),
    ];
    mockFetchOnce({
      picks,
      summary: {
        ...makeEmptySummary(),
        totalPicks: 3,
        resolvedPicks: 3,
        hitRate: 2 / 3,
      },
      count: 3,
    });
    render(<CalibrationDashboard />);
    await waitFor(() => {
      expect(screen.getByTestId('calibration-dashboard')).toBeInTheDocument();
    });
    // Empty state is NOT rendered
    expect(screen.queryByTestId('calibration-empty')).not.toBeInTheDocument();
    // Missing-odds notice IS rendered
    expect(
      screen.getByTestId('calibration-missing-odds-notice'),
    ).toBeInTheDocument();
    // Heading shows the true resolved count, not the with-odds count
    expect(screen.getByText(/3 resolved picks/i)).toBeInTheDocument();
    // Reliability curve still renders (uses pickToPrediction, not bet odds)
    expect(screen.getByTestId('reliability-curve')).toBeInTheDocument();
    // Tier breakdown still renders
    expect(screen.getByTestId('tier-breakdown')).toBeInTheDocument();
  });

  it('does NOT show the missing-odds notice when bet odds ARE present', async () => {
    const picks = [
      makePick({ won: true, bet_odds_over: -110 }),
      makePick({ won: false, bet_odds_over: -110 }),
    ];
    mockFetchOnce({
      picks,
      summary: {
        ...makeEmptySummary(),
        totalPicks: 2,
        resolvedPicks: 2,
      },
      count: 2,
    });
    render(<CalibrationDashboard />);
    await waitFor(() => {
      expect(screen.getByTestId('calibration-dashboard')).toBeInTheDocument();
    });
    expect(
      screen.queryByTestId('calibration-missing-odds-notice'),
    ).not.toBeInTheDocument();
  });

  it('shows by-bookmaker table with grouped counts', async () => {
    const picks = [
      makePick({
        bookmaker: 'DraftKings',
        won: true,
        bet_odds_over: -110,
      }),
      makePick({
        bookmaker: 'FanDuel',
        won: true,
        bet_odds_over: -110,
      }),
    ];
    mockFetchOnce({
      picks,
      summary: {
        ...makeEmptySummary(),
        totalPicks: 2,
        resolvedPicks: 2,
      },
      count: 2,
    });
    render(<CalibrationDashboard />);
    await waitFor(() => {
      expect(screen.getByText('DraftKings')).toBeInTheDocument();
    });
    expect(screen.getByText('FanDuel')).toBeInTheDocument();
  });

  it('requests resolvedOnly from the API', async () => {
    const fetchMock = mockFetchOnce({
      picks: [],
      summary: makeEmptySummary(),
      count: 0,
    });
    render(<CalibrationDashboard />);
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('resolvedOnly=true');
  });
});
