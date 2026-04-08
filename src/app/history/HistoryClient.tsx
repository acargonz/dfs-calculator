'use client';

/**
 * HistoryClient — interactive pick-history table + filters.
 *
 * Fetches /api/picks with the current filter state, renders a sortable table,
 * and shows aggregated metrics across the filtered slice. Filter changes
 * trigger a re-fetch (the API does the slicing — we don't paginate locally).
 *
 * Three sections, top to bottom:
 *   1. Filter bar (date range, tier, resolved-only)
 *   2. Summary card (PickSummary metrics for the current filter)
 *   3. Pick table (one row per pick, with CLV / outcome / context columns)
 *
 * In dev / unconfigured environments, the page shows the empty state
 * gracefully — no data, no errors.
 */

import { useEffect, useMemo, useState } from 'react';
import type { PickRow } from '@/lib/supabase';
import type { PickSummary } from '@/lib/pickHistory';
import type { Tier } from '@/lib/math';

interface PicksResponse {
  picks: PickRow[];
  summary: PickSummary;
  count: number;
}

const TIER_FILTER_OPTIONS: Array<Tier | 'ALL'> = ['ALL', 'HIGH', 'MEDIUM', 'LOW', 'REJECT'];

function fmtPct(value: number, digits = 1): string {
  if (!Number.isFinite(value)) return '—';
  return `${(value * 100).toFixed(digits)}%`;
}

function fmtPp(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const sign = value >= 0 ? '+' : '';
  return `${sign}${(value * 100).toFixed(2)}pp`;
}

function fmtNum(value: number, digits = 4): string {
  if (!Number.isFinite(value)) return '—';
  return value.toFixed(digits);
}

function fmtOdds(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return value > 0 ? `+${value}` : String(value);
}

function impliedFromAmerican(odds: number | null): number | null {
  if (odds === null || !Number.isFinite(odds)) return null;
  if (odds < 0) return Math.abs(odds) / (Math.abs(odds) + 100);
  return 100 / (odds + 100);
}

function clvForRow(row: PickRow): number | null {
  const betSide = row.direction === 'over' ? row.bet_odds_over : row.bet_odds_under;
  const closeSide = row.direction === 'over' ? row.closing_odds_over : row.closing_odds_under;
  const betImp = impliedFromAmerican(betSide);
  const closeImp = impliedFromAmerican(closeSide);
  if (betImp === null || closeImp === null) return null;
  return closeImp - betImp;
}

function outcomeLabel(row: PickRow): string {
  if (row.pushed) return 'PUSH';
  if (row.won === true) return 'WIN';
  if (row.won === false) return 'LOSS';
  return 'PENDING';
}

function outcomeColor(row: PickRow): string {
  if (row.pushed) return 'text-neutral-400';
  if (row.won === true) return 'text-emerald-400';
  if (row.won === false) return 'text-red-400';
  return 'text-amber-400/70';
}

export default function HistoryClient() {
  const [picks, setPicks] = useState<PickRow[]>([]);
  const [summary, setSummary] = useState<PickSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [fromDate, setFromDate] = useState<string>('');
  const [toDate, setToDate] = useState<string>('');
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL');
  const [resolvedOnly, setResolvedOnly] = useState<boolean>(false);

  useEffect(() => {
    let cancelled = false;

    const params = new URLSearchParams();
    if (fromDate) params.set('from', fromDate);
    if (toDate) params.set('to', toDate);
    if (tierFilter !== 'ALL') params.set('tier', tierFilter);
    if (resolvedOnly) params.set('resolvedOnly', 'true');

    setLoading(true);
    setError(null);

    fetch(`/api/picks?${params.toString()}`, { cache: 'no-store' })
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
  }, [fromDate, toDate, tierFilter, resolvedOnly]);

  // Sorted by date desc by default (API already does this, but be safe)
  const sortedPicks = useMemo(
    () => [...picks].sort((a, b) => b.date.localeCompare(a.date)),
    [picks],
  );

  const clearFilters = () => {
    setFromDate('');
    setToDate('');
    setTierFilter('ALL');
    setResolvedOnly(false);
  };

  return (
    <div className="space-y-6">
      {/* ---- Filters ---- */}
      <section
        className="rounded-lg border p-4"
        style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-card)' }}
      >
        <div className="flex flex-wrap items-end gap-3">
          <Field label="From">
            <input
              type="date"
              value={fromDate}
              onChange={(e) => setFromDate(e.target.value)}
              className="rounded border bg-transparent px-2 py-1 text-sm"
              style={{
                borderColor: 'var(--border-subtle)',
                color: 'var(--text-primary)',
              }}
            />
          </Field>
          <Field label="To">
            <input
              type="date"
              value={toDate}
              onChange={(e) => setToDate(e.target.value)}
              className="rounded border bg-transparent px-2 py-1 text-sm"
              style={{
                borderColor: 'var(--border-subtle)',
                color: 'var(--text-primary)',
              }}
            />
          </Field>
          <Field label="Tier">
            <select
              value={tierFilter}
              onChange={(e) => setTierFilter(e.target.value as Tier | 'ALL')}
              className="rounded border bg-transparent px-2 py-1 text-sm"
              style={{
                borderColor: 'var(--border-subtle)',
                color: 'var(--text-primary)',
              }}
            >
              {TIER_FILTER_OPTIONS.map((t) => (
                <option key={t} value={t} style={{ background: 'var(--bg-secondary)' }}>
                  {t}
                </option>
              ))}
            </select>
          </Field>
          <label className="flex items-center gap-2 text-sm" style={{ color: 'var(--text-secondary)' }}>
            <input
              type="checkbox"
              checked={resolvedOnly}
              onChange={(e) => setResolvedOnly(e.target.checked)}
            />
            Resolved only
          </label>
          <button
            onClick={clearFilters}
            className="ml-auto rounded border px-3 py-1 text-xs hover:opacity-80"
            style={{
              borderColor: 'var(--border-subtle)',
              color: 'var(--text-secondary)',
            }}
          >
            Clear
          </button>
        </div>
      </section>

      {/* ---- Summary ---- */}
      {summary && <SummaryCard summary={summary} />}

      {/* ---- Loading / error ---- */}
      {loading && (
        <div className="text-sm" style={{ color: 'var(--text-muted)' }}>
          Loading picks…
        </div>
      )}
      {error && (
        <div className="rounded border border-red-700/40 bg-red-900/20 p-3 text-sm text-red-300">
          {error}
        </div>
      )}

      {/* ---- Empty state ---- */}
      {!loading && !error && sortedPicks.length === 0 && (
        <div
          className="rounded-lg border p-8 text-center text-sm"
          style={{
            borderColor: 'var(--border-subtle)',
            color: 'var(--text-muted)',
            background: 'var(--bg-card)',
          }}
        >
          No picks match the current filters.
        </div>
      )}

      {/* ---- Picks table ---- */}
      {!loading && sortedPicks.length > 0 && (
        <section
          className="overflow-x-auto rounded-lg border"
          style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-card)' }}
        >
          <table className="w-full text-xs">
            <thead style={{ background: 'var(--bg-secondary)' }}>
              <tr className="text-left">
                <Th>Date</Th>
                <Th>Player</Th>
                <Th>Stat</Th>
                <Th className="text-right">Line</Th>
                <Th>Side</Th>
                <Th>Tier</Th>
                <Th className="text-right">AI Prob</Th>
                <Th className="text-right">Bet Odds</Th>
                <Th className="text-right">Close Odds</Th>
                <Th className="text-right">CLV</Th>
                <Th>Outcome</Th>
              </tr>
            </thead>
            <tbody>
              {sortedPicks.map((row) => {
                const clv = clvForRow(row);
                const betOdds =
                  row.direction === 'over' ? row.bet_odds_over : row.bet_odds_under;
                const closeOdds =
                  row.direction === 'over'
                    ? row.closing_odds_over
                    : row.closing_odds_under;
                return (
                  <tr
                    key={row.id}
                    className="border-t"
                    style={{ borderColor: 'var(--border-subtle)' }}
                  >
                    <Td>{row.date}</Td>
                    <Td className="font-semibold" style={{ color: 'var(--text-primary)' }}>
                      {row.player_name}
                    </Td>
                    <Td>{row.stat_type}</Td>
                    <Td className="text-right">{row.line}</Td>
                    <Td className="uppercase">{row.direction}</Td>
                    <Td>{row.ai_confidence_tier ?? '—'}</Td>
                    <Td className="text-right">
                      {row.calculator_prob !== null ? fmtPct(row.calculator_prob) : '—'}
                    </Td>
                    <Td className="text-right">{fmtOdds(betOdds)}</Td>
                    <Td className="text-right">{fmtOdds(closeOdds)}</Td>
                    <Td className="text-right">{clv === null ? '—' : fmtPp(clv)}</Td>
                    <Td className={outcomeColor(row)}>{outcomeLabel(row)}</Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Internal subcomponents
// ---------------------------------------------------------------------------

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-xs" style={{ color: 'var(--text-secondary)' }}>
      <span className="uppercase tracking-wider opacity-70">{label}</span>
      {children}
    </label>
  );
}

function Th({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <th
      className={`px-3 py-2 text-[10px] uppercase tracking-wider ${className}`}
      style={{ color: 'var(--text-muted)' }}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  className = '',
  style = {},
}: {
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <td
      className={`px-3 py-2 ${className}`}
      style={{ color: 'var(--text-secondary)', ...style }}
    >
      {children}
    </td>
  );
}

function SummaryCard({ summary }: { summary: PickSummary }) {
  return (
    <section
      className="rounded-lg border p-4"
      style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-card)' }}
    >
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
        <Stat label="Total Picks" value={String(summary.totalPicks)} />
        <Stat label="Resolved" value={String(summary.resolvedPicks)} />
        <Stat label="Hit Rate" value={fmtPct(summary.hitRate)} />
        <Stat label="Flat ROI" value={fmtPct(summary.flatROI)} />
        <Stat label="Net Units" value={fmtNum(summary.netUnits, 2)} />
        <Stat label="Max DD" value={fmtPct(summary.maxDrawdownPct)} />
        <Stat label="Brier (AI)" value={fmtNum(summary.brierScore)} />
        <Stat label="Brier (Raw)" value={fmtNum(summary.rawBrierScore)} />
        <Stat label="Log Loss" value={fmtNum(summary.logLoss)} />
        <Stat label="Picks w/ CLV" value={String(summary.picksWithCLV)} />
        <Stat label="Avg CLV" value={fmtPp(summary.averageCLV)} />
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="HIGH win %" value={fmtPct(summary.hitRateByTier.HIGH)} />
        <Stat label="MEDIUM win %" value={fmtPct(summary.hitRateByTier.MEDIUM)} />
        <Stat label="LOW win %" value={fmtPct(summary.hitRateByTier.LOW)} />
        <Stat label="REJECT win %" value={fmtPct(summary.hitRateByTier.REJECT)} />
      </div>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div
      className="rounded border p-2"
      style={{
        borderColor: 'var(--border-subtle)',
        background: 'var(--bg-secondary)',
      }}
    >
      <div className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
        {label}
      </div>
      <div className="mt-0.5 text-sm font-bold" style={{ color: 'var(--text-primary)' }}>
        {value}
      </div>
    </div>
  );
}
