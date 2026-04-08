'use client';

/**
 * CalibrationDashboard — deep-dive visualization of model calibration.
 *
 * Complements the compact SystemStatusCard (home) and the row-level table in
 * HistoryClient (/history) with the diagnostics that actually show whether
 * the model is well calibrated:
 *
 *   1. Reliability curve (the money plot) — predicted prob vs observed win
 *      rate in 10 buckets, with y=x reference line. Renders both the AI-
 *      adjusted and the raw pre-AI predictions so you can see if the AI
 *      overlay is helping or hurting.
 *
 *   2. Cumulative profit curve — flat-unit P&L over time. Annotated with
 *      max drawdown depth and final net units.
 *
 *   3. Headline metrics with bootstrap 95% confidence intervals — same
 *      numbers the SummaryCard shows, but with CI widths so you can tell at
 *      a glance whether the sample is large enough to trust the point
 *      estimate.
 *
 *   4. Hit rate by bookmaker — slices CLV by sportsbook so you can spot
 *      which books are softer. Requires migration 001's `bookmaker` column.
 *
 * All visualizations are inline SVG — zero chart-library dependencies. That
 * keeps the bundle size down and tests fast (JSDOM renders SVG natively).
 *
 * Data source: /api/picks?resolvedOnly=true — the same endpoint HistoryClient
 * uses. Filters can be wired in later if we want date-range or tier slicing.
 */

import { useEffect, useMemo, useState } from 'react';
import type { PickRow } from '../lib/supabase';
import type { PickSummary } from '../lib/pickHistory';
import type { Tier } from '../lib/math';
import {
  reliabilityCurve,
  bootstrapCI,
  cumulativeProfit,
  flatROI,
  averageCLV,
  hitRate,
  type Prediction,
  type ResolvedPick,
  type ReliabilityBin,
} from '../lib/calibration';
import {
  pickToPrediction,
  pickToRawPrediction,
  pickToResolved,
  pickToCLV,
  coerceTier,
} from '../lib/pickHistory';

interface PicksResponse {
  picks: PickRow[];
  summary: PickSummary;
  count: number;
}

const BOOTSTRAP_SEED = 42;
const BOOTSTRAP_ITERATIONS = 500;

// ===================================================================
// Formatters
// ===================================================================

function fmtPct(value: number, digits = 1): string {
  if (!Number.isFinite(value)) return '—';
  return `${(value * 100).toFixed(digits)}%`;
}

function fmtPp(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const sign = value >= 0 ? '+' : '';
  return `${sign}${(value * 100).toFixed(2)}pp`;
}

function fmtCI(mean: number, lower: number, upper: number, kind: 'pct' | 'pp'): string {
  const fn = kind === 'pct' ? fmtPct : fmtPp;
  if (!Number.isFinite(mean)) return '—';
  return `${fn(mean)} (${fn(lower)} to ${fn(upper)})`;
}

// ===================================================================
// Pure helpers (exported for unit tests)
// ===================================================================

/**
 * Derive all the chart-ready data from a raw pick list in one pass. Pure
 * function so tests can drive it with canned fixtures without mocking fetch.
 */
export interface DashboardViewModel {
  aiBins: ReliabilityBin[];
  rawBins: ReliabilityBin[];
  aiPredictionCount: number;
  rawPredictionCount: number;
  profitCurve: number[];
  resolvedCount: number;
  /** Headline metric CIs. NaN means insufficient data. */
  hitRateCI: { mean: number; lower: number; upper: number };
  flatROICI: { mean: number; lower: number; upper: number };
  clvCI: { mean: number; lower: number; upper: number };
  /** By-bookmaker slice: list of { book, picks, hitRate, avgCLV }. */
  byBookmaker: Array<{
    book: string;
    picks: number;
    hitRate: number;
    avgCLV: number;
    clvPicks: number;
  }>;
  /**
   * Per-tier breakdown of resolved picks. Each row carries the tier label,
   * the count of decided picks (won + lost, pushes excluded), the win
   * rate, and the calculator's tier definition (the threshold the
   * calculator is "promising"). Lets the user verify that picks tagged
   * HIGH actually win at the rate the threshold implies.
   *
   * Tiers with zero decided picks are still emitted with NaN hitRate so
   * the row renders an empty placeholder rather than disappearing.
   */
  tierBreakdown: Array<{
    tier: Tier;
    decided: number;
    pushed: number;
    hitRate: number;
    /** The calculator's promised win rate for this tier (probability threshold). */
    promisedRate: number;
  }>;
}

/**
 * Calculator tier thresholds — kept in sync with src/lib/math.ts:assignTier()
 * (lines 411-413). Each value is the minimum *blended* probability that earns
 * the tier, which is also the rate the user has implicitly been promised when
 * they see that tier. Used to compute the "promised vs actual" delta in the
 * tier breakdown table — if HIGH picks systematically win less than 58%, the
 * tier definition is over-promising and the model is mis-calibrated.
 */
const TIER_PROMISED_RATE: Record<Tier, number> = {
  HIGH: 0.58,
  MEDIUM: 0.54,
  LOW: 0.5,
  REJECT: 0,
};

export function buildDashboardViewModel(picks: PickRow[]): DashboardViewModel {
  // --- Reliability curves (AI + raw) --------------------------------------
  const aiPredictions: Prediction[] = picks
    .map(pickToPrediction)
    .filter((p): p is Prediction => p !== null);
  const rawPredictions: Prediction[] = picks
    .map(pickToRawPrediction)
    .filter((p): p is Prediction => p !== null);
  const aiBins = reliabilityCurve(aiPredictions, 10);
  const rawBins = reliabilityCurve(rawPredictions, 10);

  // --- Cumulative profit curve (flat units) -------------------------------
  // Walk picks chronologically ascending so the curve reads left-to-right.
  const resolved: ResolvedPick[] = [...picks]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(pickToResolved)
    .filter((p): p is ResolvedPick => p !== null);
  const profitCurve = cumulativeProfit(resolved);

  // --- Bootstrap CIs on headline metrics ----------------------------------
  // Hit rate: sample from 0/1 outcomes (pushes excluded).
  const outcomes = resolved.filter((r) => !r.pushed).map((r) => (r.won ? 1 : 0));
  const hitRateCI =
    outcomes.length > 0
      ? bootstrapCI(outcomes, BOOTSTRAP_ITERATIONS, 0.95, BOOTSTRAP_SEED)
      : { mean: NaN, lower: NaN, upper: NaN };

  // Flat ROI: sample per-pick profit at $1 stake (push = 0, win = decimal-1, loss = -1)
  const perPickProfits = resolved.map((r) => {
    if (r.pushed) return 0;
    // Use decimal conversion inline to avoid dep cycle with twoSidedCalc
    const decimal = r.odds > 0 ? r.odds / 100 + 1 : 100 / Math.abs(r.odds) + 1;
    return r.won ? decimal - 1 : -1;
  });
  const flatROICI =
    perPickProfits.length > 0
      ? bootstrapCI(perPickProfits, BOOTSTRAP_ITERATIONS, 0.95, BOOTSTRAP_SEED)
      : { mean: NaN, lower: NaN, upper: NaN };

  // CLV: sample per-pick CLV in pp units
  const clvPicks = picks.map(pickToCLV).filter((p) => p !== null);
  const clvValues = clvPicks.map((p) => {
    // implied prob delta = close - bet
    const betImp = p!.betOdds < 0 ? Math.abs(p!.betOdds) / (Math.abs(p!.betOdds) + 100) : 100 / (p!.betOdds + 100);
    const closeImp = p!.closingOdds < 0 ? Math.abs(p!.closingOdds) / (Math.abs(p!.closingOdds) + 100) : 100 / (p!.closingOdds + 100);
    return closeImp - betImp;
  });
  const clvCI =
    clvValues.length > 0
      ? bootstrapCI(clvValues, BOOTSTRAP_ITERATIONS, 0.95, BOOTSTRAP_SEED)
      : { mean: NaN, lower: NaN, upper: NaN };

  // --- Tier breakdown -----------------------------------------------------
  // For each tier, count decided picks (won/lost), pushes, and compute the
  // hit rate. Uses coerceTier from pickHistory.ts so the A/B/C → HIGH/MED/LOW
  // translation matches what the rest of the app does — production stores
  // the AI-native A/B/C labels, legacy fixtures use HIGH/MED/LOW directly.
  const tierOrder: Tier[] = ['HIGH', 'MEDIUM', 'LOW', 'REJECT'];
  const tierBreakdown = tierOrder.map((tier) => {
    let decided = 0;
    let pushed = 0;
    let won = 0;
    for (const p of picks) {
      const mappedTier = coerceTier(p.ai_confidence_tier);
      if (mappedTier !== tier) continue;
      if (p.won === null || p.won === undefined) continue;
      if (p.pushed) {
        pushed += 1;
        continue;
      }
      decided += 1;
      if (p.won === true) won += 1;
    }
    return {
      tier,
      decided,
      pushed,
      hitRate: decided > 0 ? won / decided : NaN,
      promisedRate: TIER_PROMISED_RATE[tier],
    };
  });

  // --- By bookmaker breakdown ---------------------------------------------
  const bookmakerGroups = new Map<string, PickRow[]>();
  for (const p of picks) {
    const key = p.bookmaker ?? '(unknown)';
    if (!bookmakerGroups.has(key)) bookmakerGroups.set(key, []);
    bookmakerGroups.get(key)!.push(p);
  }
  const byBookmaker = Array.from(bookmakerGroups.entries())
    .map(([book, group]) => {
      const groupResolved = group
        .map(pickToResolved)
        .filter((p): p is ResolvedPick => p !== null);
      const groupClv = group.map(pickToCLV).filter((p) => p !== null);
      return {
        book,
        picks: group.length,
        hitRate: hitRate(groupResolved),
        avgCLV: averageCLV(groupClv as NonNullable<ReturnType<typeof pickToCLV>>[]),
        clvPicks: groupClv.length,
      };
    })
    .sort((a, b) => b.picks - a.picks);

  return {
    aiBins,
    rawBins,
    aiPredictionCount: aiPredictions.length,
    rawPredictionCount: rawPredictions.length,
    profitCurve,
    resolvedCount: resolved.length,
    hitRateCI,
    flatROICI,
    clvCI,
    byBookmaker,
    tierBreakdown,
  };
}

// Exposed so tests can assert on the pure function without mocking fetch
export { flatROI };

// ===================================================================
// Component
// ===================================================================

export default function CalibrationDashboard() {
  const [picks, setPicks] = useState<PickRow[] | null>(null);
  const [summary, setSummary] = useState<PickSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    fetch('/api/picks?resolvedOnly=true&limit=5000', { cache: 'no-store' })
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || `HTTP ${res.status}`);
        }
        return res.json() as Promise<PicksResponse>;
      })
      .then((data) => {
        if (cancelled) return;
        setPicks(data.picks);
        setSummary(data.summary);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Unknown error');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const vm = useMemo(() => (picks ? buildDashboardViewModel(picks) : null), [picks]);

  if (loading) {
    return (
      <div className="text-sm" style={{ color: 'var(--text-muted)' }}>
        Loading calibration data…
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded border border-red-700/40 bg-red-900/20 p-3 text-sm text-red-300">
        Failed to load: {error}
      </div>
    );
  }

  if (!vm || !summary || vm.resolvedCount === 0) {
    return (
      <div
        className="rounded-lg border p-8 text-center text-sm"
        data-testid="calibration-empty"
        style={{
          borderColor: 'var(--border-subtle)',
          color: 'var(--text-muted)',
          background: 'var(--bg-card)',
        }}
      >
        No resolved picks yet. The dashboard activates once at least one pick
        has been resolved by the nightly cron.
      </div>
    );
  }

  return (
    <div className="space-y-6" data-testid="calibration-dashboard">
      {/* ---- Headline metrics with CIs ---- */}
      <section
        className="rounded-lg border p-4"
        style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-card)' }}
      >
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="text-sm font-bold uppercase tracking-wider" style={{ color: 'var(--text-primary)' }}>
            Headline Metrics (95% Bootstrap CI)
          </h2>
          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
            {vm.resolvedCount} resolved picks
          </span>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <CIStat
            label="Hit Rate"
            value={fmtCI(vm.hitRateCI.mean, vm.hitRateCI.lower, vm.hitRateCI.upper, 'pct')}
            hint="Break-even at −110 is 52.4%"
          />
          <CIStat
            label="Flat ROI"
            value={fmtCI(vm.flatROICI.mean, vm.flatROICI.lower, vm.flatROICI.upper, 'pct')}
            hint="Per-unit return at 1u flat stake"
          />
          <CIStat
            label="Avg CLV"
            value={fmtCI(vm.clvCI.mean, vm.clvCI.lower, vm.clvCI.upper, 'pp')}
            hint="Positive = beating the closing line"
          />
        </div>
      </section>

      {/* ---- Hit rate by tier ---- */}
      <section
        className="rounded-lg border p-4"
        data-testid="tier-breakdown"
        style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-card)' }}
      >
        <h2 className="mb-2 text-sm font-bold uppercase tracking-wider" style={{ color: 'var(--text-primary)' }}>
          Hit Rate by Tier
        </h2>
        <p className="mb-4 text-xs" style={{ color: 'var(--text-muted)' }}>
          Each tier carries an implicit promise — HIGH says &ldquo;the model
          believes this hits at least 58% of the time.&rdquo; If the actual rate
          systematically undershoots the promise, the tier definitions are
          over-promising and the model is mis-calibrated.
        </p>
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left" style={{ color: 'var(--text-muted)' }}>
              <th className="py-1">Tier</th>
              <th className="py-1 text-right">Decided</th>
              <th className="py-1 text-right">Pushed</th>
              <th className="py-1 text-right">Actual</th>
              <th className="py-1 text-right">Promised</th>
              <th className="py-1 text-right">Δ</th>
            </tr>
          </thead>
          <tbody>
            {vm.tierBreakdown.map((row) => {
              const delta = Number.isFinite(row.hitRate)
                ? row.hitRate - row.promisedRate
                : NaN;
              const deltaColor = !Number.isFinite(delta)
                ? 'var(--text-muted)'
                : delta >= 0
                  ? '#10b981'
                  : delta >= -0.03
                    ? '#f59e0b'
                    : '#ef4444';
              return (
                <tr
                  key={row.tier}
                  className="border-t"
                  data-testid={`tier-row-${row.tier}`}
                  style={{ borderColor: 'var(--border-subtle)' }}
                >
                  <td className="py-1 font-semibold" style={{ color: 'var(--text-primary)' }}>
                    {row.tier}
                  </td>
                  <td className="py-1 text-right" style={{ color: 'var(--text-secondary)' }}>
                    {row.decided}
                  </td>
                  <td className="py-1 text-right" style={{ color: 'var(--text-muted)' }}>
                    {row.pushed}
                  </td>
                  <td className="py-1 text-right" style={{ color: 'var(--text-secondary)' }}>
                    {fmtPct(row.hitRate)}
                  </td>
                  <td className="py-1 text-right" style={{ color: 'var(--text-muted)' }}>
                    {row.tier === 'REJECT' ? '—' : fmtPct(row.promisedRate)}
                  </td>
                  <td className="py-1 text-right font-semibold" style={{ color: deltaColor }}>
                    {!Number.isFinite(delta) || row.tier === 'REJECT'
                      ? '—'
                      : `${delta >= 0 ? '+' : ''}${(delta * 100).toFixed(1)}pp`}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      {/* ---- Reliability curve ---- */}
      <section
        className="rounded-lg border p-4"
        style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-card)' }}
      >
        <h2 className="mb-2 text-sm font-bold uppercase tracking-wider" style={{ color: 'var(--text-primary)' }}>
          Reliability Curve
        </h2>
        <p className="mb-4 text-xs" style={{ color: 'var(--text-muted)' }}>
          When the model says X%, does the bet win X% of the time? Points on
          the y=x diagonal = perfectly calibrated. Above = underconfident. Below
          = overconfident.
        </p>
        <ReliabilityCurveSVG
          aiBins={vm.aiBins}
          rawBins={vm.rawBins}
          aiCount={vm.aiPredictionCount}
          rawCount={vm.rawPredictionCount}
        />
        <div className="mt-3 flex flex-wrap gap-4 text-xs" style={{ color: 'var(--text-muted)' }}>
          <LegendSwatch color="#da7756" label={`AI-adjusted (${vm.aiPredictionCount})`} />
          <LegendSwatch color="#64b5f6" label={`Raw calculator (${vm.rawPredictionCount})`} />
          <LegendSwatch color="rgba(255,255,255,0.3)" label="Perfect calibration (y=x)" />
        </div>
      </section>

      {/* ---- Cumulative profit curve ---- */}
      <section
        className="rounded-lg border p-4"
        style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-card)' }}
      >
        <h2 className="mb-2 text-sm font-bold uppercase tracking-wider" style={{ color: 'var(--text-primary)' }}>
          Cumulative Profit (Flat Units)
        </h2>
        <p className="mb-4 text-xs" style={{ color: 'var(--text-muted)' }}>
          Running sum of profit at 1-unit flat stake per pick. Pushes add 0,
          losses subtract 1, wins add the decimal payout minus 1.
        </p>
        <ProfitCurveSVG curve={vm.profitCurve} />
        <div className="mt-3 grid grid-cols-3 gap-3 text-xs">
          <MiniStat label="Final Net" value={vm.profitCurve.length > 0 ? vm.profitCurve[vm.profitCurve.length - 1].toFixed(2) : '0.00'} />
          <MiniStat label="Max DD" value={summary.maxDrawdown.toFixed(2)} />
          <MiniStat label="Max DD %" value={fmtPct(summary.maxDrawdownPct)} />
        </div>
      </section>

      {/* ---- By bookmaker ---- */}
      <section
        className="rounded-lg border p-4"
        style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-card)' }}
      >
        <h2 className="mb-2 text-sm font-bold uppercase tracking-wider" style={{ color: 'var(--text-primary)' }}>
          By Bookmaker
        </h2>
        <p className="mb-4 text-xs" style={{ color: 'var(--text-muted)' }}>
          Performance split by sportsbook. Softer books should show higher hit
          rate and CLV. Requires migration 001&apos;s <code>bookmaker</code> column.
        </p>
        {vm.byBookmaker.length === 0 ? (
          <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
            No bookmaker data captured.
          </div>
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left" style={{ color: 'var(--text-muted)' }}>
                <th className="py-1">Book</th>
                <th className="py-1 text-right">Picks</th>
                <th className="py-1 text-right">Hit Rate</th>
                <th className="py-1 text-right">CLV (n)</th>
                <th className="py-1 text-right">Avg CLV</th>
              </tr>
            </thead>
            <tbody>
              {vm.byBookmaker.map((row) => (
                <tr
                  key={row.book}
                  className="border-t"
                  style={{ borderColor: 'var(--border-subtle)' }}
                >
                  <td className="py-1 font-semibold" style={{ color: 'var(--text-primary)' }}>
                    {row.book}
                  </td>
                  <td className="py-1 text-right" style={{ color: 'var(--text-secondary)' }}>
                    {row.picks}
                  </td>
                  <td className="py-1 text-right" style={{ color: 'var(--text-secondary)' }}>
                    {fmtPct(row.hitRate)}
                  </td>
                  <td className="py-1 text-right" style={{ color: 'var(--text-muted)' }}>
                    {row.clvPicks}
                  </td>
                  <td className="py-1 text-right" style={{ color: 'var(--text-secondary)' }}>
                    {fmtPp(row.avgCLV)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

// ===================================================================
// SVG subcomponents
// ===================================================================

/**
 * Reliability curve rendered as inline SVG. Overlays two lines: AI-adjusted
 * (orange) and raw calculator (blue), plus the y=x diagonal as a reference.
 *
 * Bins with count === 0 are skipped (no dots drawn) so empty buckets appear as
 * gaps rather than distorting the line.
 */
function ReliabilityCurveSVG({
  aiBins,
  rawBins,
  aiCount,
  rawCount,
}: {
  aiBins: ReliabilityBin[];
  rawBins: ReliabilityBin[];
  aiCount: number;
  rawCount: number;
}) {
  const width = 400;
  const height = 260;
  const padding = { top: 20, right: 20, bottom: 30, left: 40 };
  const plotW = width - padding.left - padding.right;
  const plotH = height - padding.top - padding.bottom;

  const xScale = (v: number) => padding.left + v * plotW;
  const yScale = (v: number) => padding.top + (1 - v) * plotH;

  // Build poly-lines skipping empty bins
  const buildPoints = (bins: ReliabilityBin[]): string =>
    bins
      .filter((b) => b.count > 0)
      .map((b) => `${xScale(b.predictedMean)},${yScale(b.observedRate)}`)
      .join(' ');

  const aiPoints = buildPoints(aiBins);
  const rawPoints = buildPoints(rawBins);

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="w-full"
      role="img"
      aria-label="Reliability curve"
      data-testid="reliability-curve"
    >
      {/* Background grid */}
      {[0.25, 0.5, 0.75].map((v) => (
        <g key={`h-${v}`}>
          <line
            x1={padding.left}
            y1={yScale(v)}
            x2={padding.left + plotW}
            y2={yScale(v)}
            stroke="rgba(255,255,255,0.08)"
            strokeWidth={1}
          />
          <line
            x1={xScale(v)}
            y1={padding.top}
            x2={xScale(v)}
            y2={padding.top + plotH}
            stroke="rgba(255,255,255,0.08)"
            strokeWidth={1}
          />
        </g>
      ))}

      {/* y=x reference */}
      <line
        x1={xScale(0)}
        y1={yScale(0)}
        x2={xScale(1)}
        y2={yScale(1)}
        stroke="rgba(255,255,255,0.3)"
        strokeWidth={1}
        strokeDasharray="4 4"
      />

      {/* Raw calculator line (drawn first so AI overlays on top) */}
      {rawCount > 0 && (
        <polyline
          points={rawPoints}
          fill="none"
          stroke="#64b5f6"
          strokeWidth={2}
          strokeLinejoin="round"
        />
      )}
      {rawBins
        .filter((b) => b.count > 0)
        .map((b, i) => (
          <circle
            key={`raw-${i}`}
            cx={xScale(b.predictedMean)}
            cy={yScale(b.observedRate)}
            r={3}
            fill="#64b5f6"
          />
        ))}

      {/* AI line */}
      {aiCount > 0 && (
        <polyline
          points={aiPoints}
          fill="none"
          stroke="#da7756"
          strokeWidth={2}
          strokeLinejoin="round"
        />
      )}
      {aiBins
        .filter((b) => b.count > 0)
        .map((b, i) => (
          <circle
            key={`ai-${i}`}
            cx={xScale(b.predictedMean)}
            cy={yScale(b.observedRate)}
            r={3}
            fill="#da7756"
          />
        ))}

      {/* Axes labels */}
      <text
        x={padding.left + plotW / 2}
        y={height - 5}
        textAnchor="middle"
        fill="rgba(255,255,255,0.5)"
        fontSize="10"
      >
        Predicted Probability
      </text>
      <text
        x={10}
        y={padding.top + plotH / 2}
        textAnchor="middle"
        fill="rgba(255,255,255,0.5)"
        fontSize="10"
        transform={`rotate(-90, 10, ${padding.top + plotH / 2})`}
      >
        Observed Win Rate
      </text>

      {/* Axis tick labels */}
      {[0, 0.5, 1].map((v) => (
        <text
          key={`xt-${v}`}
          x={xScale(v)}
          y={padding.top + plotH + 15}
          textAnchor="middle"
          fill="rgba(255,255,255,0.4)"
          fontSize="9"
        >
          {v.toFixed(1)}
        </text>
      ))}
      {[0, 0.5, 1].map((v) => (
        <text
          key={`yt-${v}`}
          x={padding.left - 5}
          y={yScale(v) + 3}
          textAnchor="end"
          fill="rgba(255,255,255,0.4)"
          fontSize="9"
        >
          {v.toFixed(1)}
        </text>
      ))}
    </svg>
  );
}

/**
 * Cumulative profit curve as inline SVG. X-axis is pick index (chronological),
 * Y-axis is running profit in flat units.
 */
function ProfitCurveSVG({ curve }: { curve: number[] }) {
  const width = 400;
  const height = 200;
  const padding = { top: 20, right: 20, bottom: 30, left: 40 };
  const plotW = width - padding.left - padding.right;
  const plotH = height - padding.top - padding.bottom;

  if (curve.length === 0) {
    return (
      <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
        No resolved picks to plot.
      </div>
    );
  }

  const minY = Math.min(0, ...curve);
  const maxY = Math.max(0, ...curve);
  const range = maxY - minY || 1;

  const xScale = (i: number) =>
    padding.left + (i / Math.max(curve.length - 1, 1)) * plotW;
  const yScale = (v: number) =>
    padding.top + (1 - (v - minY) / range) * plotH;

  const points = curve.map((v, i) => `${xScale(i)},${yScale(v)}`).join(' ');

  // Area under curve (closed back to y=0 baseline)
  const zeroY = yScale(0);
  const areaPoints =
    `${xScale(0)},${zeroY} ` +
    points +
    ` ${xScale(curve.length - 1)},${zeroY}`;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="w-full"
      role="img"
      aria-label="Cumulative profit curve"
      data-testid="profit-curve"
    >
      {/* Zero line */}
      <line
        x1={padding.left}
        y1={zeroY}
        x2={padding.left + plotW}
        y2={zeroY}
        stroke="rgba(255,255,255,0.2)"
        strokeWidth={1}
        strokeDasharray="2 2"
      />

      {/* Area fill */}
      <polygon points={areaPoints} fill="rgba(218,119,86,0.15)" />

      {/* Curve line */}
      <polyline
        points={points}
        fill="none"
        stroke="#da7756"
        strokeWidth={2}
        strokeLinejoin="round"
      />

      {/* Axes */}
      <text
        x={padding.left + plotW / 2}
        y={height - 5}
        textAnchor="middle"
        fill="rgba(255,255,255,0.5)"
        fontSize="10"
      >
        Pick # (chronological)
      </text>

      {/* Y-axis tick labels (min/zero/max) */}
      {[minY, 0, maxY]
        .filter((v, i, arr) => arr.indexOf(v) === i)
        .map((v) => (
          <text
            key={`py-${v}`}
            x={padding.left - 5}
            y={yScale(v) + 3}
            textAnchor="end"
            fill="rgba(255,255,255,0.4)"
            fontSize="9"
          >
            {v.toFixed(0)}
          </text>
        ))}
    </svg>
  );
}

// ===================================================================
// Tiny subcomponents
// ===================================================================

function CIStat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div
      className="rounded border p-3"
      style={{
        borderColor: 'var(--border-subtle)',
        background: 'var(--bg-secondary)',
      }}
    >
      <div
        className="text-[10px] uppercase tracking-wider"
        style={{ color: 'var(--text-muted)' }}
      >
        {label}
      </div>
      <div className="mt-1 text-sm font-bold" style={{ color: 'var(--text-primary)' }}>
        {value}
      </div>
      {hint && (
        <div className="mt-1 text-[10px]" style={{ color: 'var(--text-muted)' }}>
          {hint}
        </div>
      )}
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div
      className="rounded border p-2"
      style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-secondary)' }}
    >
      <div
        className="text-[10px] uppercase tracking-wider"
        style={{ color: 'var(--text-muted)' }}
      >
        {label}
      </div>
      <div className="mt-0.5 text-xs font-bold" style={{ color: 'var(--text-primary)' }}>
        {value}
      </div>
    </div>
  );
}

function LegendSwatch({ color, label }: { color: string; label: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <span
        className="inline-block h-2 w-4 rounded-sm"
        style={{ background: color }}
      />
      <span>{label}</span>
    </div>
  );
}
