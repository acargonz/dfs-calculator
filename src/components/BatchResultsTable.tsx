'use client';

import { useMemo, useState } from 'react';
import TierBadge from './TierBadge';
import type { BatchResult, BatchPlayerResult } from '../lib/batchProcessor';
import { pickBestSide } from '../lib/twoSidedCalc';
import type { CalculationResult, SideEvaluation } from './types';

interface BatchResultsTableProps {
  results: BatchResult;
  onClear: () => void;
}

type SortKey = 'player' | 'stat' | 'line' | 'mean' | 'prob' | 'ev' | 'stake' | 'tier' | 'side';
type SortDir = 'asc' | 'desc';
type TierFilter = 'HIGH' | 'MEDIUM' | 'LOW' | 'REJECT';

const TIER_RANK: Record<string, number> = { HIGH: 0, MEDIUM: 1, LOW: 2, REJECT: 3 };
const ALL_TIERS: TierFilter[] = ['HIGH', 'MEDIUM', 'LOW', 'REJECT'];

/** Returns the side evaluation for the stronger direction (display only). */
function bestSideOf(result: CalculationResult): { side: 'over' | 'under'; eval: SideEvaluation } {
  const side = pickBestSide(result);
  return { side, eval: result[side] };
}

function getSortValue(p: BatchPlayerResult, key: SortKey): number | string {
  if (!p.result) {
    switch (key) {
      case 'player': return p.playerName.toLowerCase();
      case 'stat': return p.statType;
      case 'line': return p.line;
      case 'mean': return p.mean;
      default: return -999;
    }
  }
  const best = bestSideOf(p.result);
  switch (key) {
    case 'player': return p.playerName.toLowerCase();
    case 'stat': return p.statType;
    case 'line': return p.line;
    case 'mean': return p.mean;
    case 'side': return best.side;
    case 'prob': return best.eval.blendedProb;
    case 'ev': return best.eval.ev;
    case 'stake': return best.eval.kellyStake;
    case 'tier': return TIER_RANK[best.eval.tier] ?? 4;
    default: return 0;
  }
}

function pct(value: number): string {
  return (value * 100).toFixed(1) + '%';
}

/** Clean display labels for stat types */
function statLabel(statType: string): string {
  switch (statType) {
    case 'fantasy': return 'FPTS';
    case 'pra': return 'PRA';
    case 'pts+rebs': return 'P+R';
    case 'pts+asts': return 'P+A';
    case 'rebs+asts': return 'R+A';
    default: return statType.charAt(0).toUpperCase() + statType.slice(1);
  }
}

export default function BatchResultsTable({ results, onClear }: BatchResultsTableProps) {
  const [sortKey, setSortKey] = useState<SortKey>('tier');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [collapsed, setCollapsed] = useState(false);
  const [tierFilter, setTierFilter] = useState<Set<TierFilter>>(new Set(ALL_TIERS));

  function handleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDir(key === 'ev' || key === 'prob' || key === 'stake' ? 'desc' : 'asc');
    }
  }

  function toggleTier(tier: TierFilter) {
    setTierFilter((prev) => {
      const next = new Set(prev);
      if (next.has(tier)) next.delete(tier);
      else next.add(tier);
      return next;
    });
  }

  function jumpToAI() {
    const el = document.querySelector('[data-ai-panel]');
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  const sorted = useMemo(() => {
    return [...results.players].sort((a, b) => {
      if (a.status !== 'success' && b.status === 'success') return 1;
      if (a.status === 'success' && b.status !== 'success') return -1;

      const aVal = getSortValue(a, sortKey);
      const bVal = getSortValue(b, sortKey);

      let cmp: number;
      if (typeof aVal === 'string' && typeof bVal === 'string') {
        cmp = aVal.localeCompare(bVal);
      } else {
        cmp = (aVal as number) - (bVal as number);
      }

      return sortDir === 'asc' ? cmp : -cmp;
    });
  }, [results.players, sortKey, sortDir]);

  const filtered = useMemo(() => {
    return sorted.filter((p) => {
      if (p.status !== 'success' || !p.result) return true; // always show error rows
      return tierFilter.has(bestSideOf(p.result).eval.tier as TierFilter);
    });
  }, [sorted, tierFilter]);

  const { summary } = results;
  const headerClass = 'px-2 py-1.5 text-left text-[11px] font-semibold cursor-pointer select-none transition-colors whitespace-nowrap';
  const cellClass = 'px-2 py-1.5 text-xs whitespace-nowrap';

  function arrow(key: SortKey) {
    if (sortKey !== key) return '';
    return sortDir === 'asc' ? ' \u25B2' : ' \u25BC';
  }

  function copyResults() {
    const header = 'Player\tStat\tLine\tMean\tSide\tProb\tEV\tStake\tTier';
    const rows = results.players.map((p) => {
      if (p.status === 'success' && p.result) {
        const { side, eval: e } = bestSideOf(p.result);
        const sideLabel = side === 'over' ? 'OVER' : 'UNDER';
        return `${p.playerName}\t${statLabel(p.statType)}\t${p.line}\t${p.mean.toFixed(1)}\t${sideLabel}\t${pct(e.blendedProb)}\t${(e.ev * 100).toFixed(1)}%\t$${e.kellyStake.toFixed(2)}\t${e.tier}`;
      }
      // Include error rows with status info
      return `${p.playerName}\t${statLabel(p.statType)}\t${p.line}\t-\t-\t-\t-\t-\tERROR: ${p.statusMessage || p.status}`;
    });
    navigator.clipboard.writeText([header, ...rows].join('\n'));
  }

  const filterChipBase = 'rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide cursor-pointer select-none transition-opacity';
  const filterChipActive = { opacity: 1 };
  const filterChipInactive = { opacity: 0.35 };

  return (
    <div className="space-y-3">
      {/* Summary + controls row */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          className="text-xs rounded-md px-2 py-1 transition-opacity hover:opacity-80"
          style={{ border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)' }}
          aria-label={collapsed ? 'Show table' : 'Hide table'}
        >
          {collapsed ? '▶' : '▼'} {collapsed ? 'Show' : 'Hide'} table
        </button>

        {summary.high > 0 && (
          <button
            type="button"
            onClick={() => toggleTier('HIGH')}
            className={filterChipBase}
            style={{
              ...(tierFilter.has('HIGH') ? filterChipActive : filterChipInactive),
              background: 'rgba(16, 185, 129, 0.15)',
              color: '#10b981',
            }}
            title="Toggle HIGH filter"
          >
            {summary.high} HIGH
          </button>
        )}
        {summary.medium > 0 && (
          <button
            type="button"
            onClick={() => toggleTier('MEDIUM')}
            className={filterChipBase}
            style={{
              ...(tierFilter.has('MEDIUM') ? filterChipActive : filterChipInactive),
              background: 'rgba(245, 158, 11, 0.15)',
              color: '#f59e0b',
            }}
            title="Toggle MEDIUM filter"
          >
            {summary.medium} MEDIUM
          </button>
        )}
        {summary.low > 0 && (
          <button
            type="button"
            onClick={() => toggleTier('LOW')}
            className={filterChipBase}
            style={{
              ...(tierFilter.has('LOW') ? filterChipActive : filterChipInactive),
              background: 'rgba(251, 146, 60, 0.15)',
              color: '#fb923c',
            }}
            title="Toggle LOW filter"
          >
            {summary.low} LOW
          </button>
        )}
        {summary.reject > 0 && (
          <button
            type="button"
            onClick={() => toggleTier('REJECT')}
            className={filterChipBase}
            style={{
              ...(tierFilter.has('REJECT') ? filterChipActive : filterChipInactive),
              background: 'rgba(156, 163, 175, 0.1)',
              color: 'var(--text-muted)',
            }}
            title="Toggle REJECT filter"
          >
            {summary.reject} REJECT
          </button>
        )}
        {summary.errors > 0 && (
          <span className="text-xs text-red-400 font-semibold">
            {summary.errors} Error{summary.errors > 1 ? 's' : ''}
          </span>
        )}
        <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
          ({results.players.length} total)
        </span>

        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={jumpToAI}
            className="text-xs rounded-md px-3 py-1 font-semibold transition-opacity hover:opacity-90"
            style={{ background: 'var(--accent)', color: 'white' }}
          >
            Jump to AI ↓
          </button>
        </div>
      </div>

      {/* Table — scrollable container */}
      {!collapsed && (
        <div
          className="rounded-lg overflow-auto"
          style={{
            border: '1px solid var(--border-subtle)',
            maxHeight: '360px',
          }}
        >
          <table className="w-full text-sm">
            <thead
              className="sticky top-0 z-10"
              style={{ background: 'var(--bg-secondary)' }}
            >
              <tr>
                <th className={headerClass} style={{ color: 'var(--text-muted)' }} onClick={() => handleSort('player')}>Player{arrow('player')}</th>
                <th className={headerClass} style={{ color: 'var(--text-muted)' }} onClick={() => handleSort('stat')}>Stat{arrow('stat')}</th>
                <th className={headerClass} style={{ color: 'var(--text-muted)' }} onClick={() => handleSort('line')}>Line{arrow('line')}</th>
                <th className={headerClass} style={{ color: 'var(--text-muted)' }} onClick={() => handleSort('mean')}>Mean{arrow('mean')}</th>
                <th className={headerClass} style={{ color: 'var(--text-muted)' }} onClick={() => handleSort('side')}>Side{arrow('side')}</th>
                <th className={headerClass} style={{ color: 'var(--text-muted)' }} onClick={() => handleSort('prob')}>Prob{arrow('prob')}</th>
                <th className={headerClass} style={{ color: 'var(--text-muted)' }} onClick={() => handleSort('ev')}>EV{arrow('ev')}</th>
                <th className={headerClass} style={{ color: 'var(--text-muted)' }} onClick={() => handleSort('stake')}>Stake{arrow('stake')}</th>
                <th className={headerClass} style={{ color: 'var(--text-muted)' }} onClick={() => handleSort('tier')}>Tier{arrow('tier')}</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr>
                  <td
                    colSpan={9}
                    className="px-3 py-6 text-center text-xs"
                    style={{ color: 'var(--text-muted)' }}
                  >
                    No props match the active tier filters. Click a chip above to re-enable.
                  </td>
                </tr>
              )}
              {filtered.map((p, i) => {
                if (p.status !== 'success' || !p.result) {
                  return (
                    <tr key={i} className="opacity-40" style={{ borderTop: '1px solid var(--border-subtle)' }}>
                      <td className={cellClass} style={{ color: 'var(--text-primary)' }}>{p.playerName}</td>
                      <td className={cellClass} colSpan={8}>
                        <span className="italic text-red-400">{p.statusMessage || p.status}</span>
                      </td>
                    </tr>
                  );
                }

                const { side, eval: e } = bestSideOf(p.result);
                const sideLabel = side === 'over' ? 'OVER' : 'UNDER';
                const sideColor = side === 'over' ? '#10b981' : '#fb923c';
                const isReject = e.tier === 'REJECT';

                return (
                  <tr
                    key={i}
                    className={isReject ? 'opacity-50' : ''}
                    style={{ borderTop: '1px solid var(--border-subtle)' }}
                  >
                    <td className={`${cellClass} font-medium`} style={{ color: 'var(--text-primary)' }}>{p.playerName}</td>
                    <td className={cellClass} style={{ color: 'var(--text-secondary)' }}>{statLabel(p.statType)}</td>
                    <td className={cellClass} style={{ color: 'var(--text-secondary)' }}>{p.line}</td>
                    <td className={cellClass} style={{ color: 'var(--text-secondary)' }}>{p.mean.toFixed(1)}</td>
                    <td className={`${cellClass} font-bold`} style={{ color: sideColor }}>{sideLabel}</td>
                    <td className={`${cellClass} font-medium`} style={{ color: 'var(--accent)' }}>{pct(e.blendedProb)}</td>
                    <td className={`${cellClass} font-medium ${e.ev > 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                      {e.ev > 0 ? '+' : ''}{(e.ev * 100).toFixed(1)}%
                    </td>
                    <td className={cellClass} style={{ color: 'var(--text-primary)' }}>
                      {e.kellyStake > 0 ? `$${e.kellyStake.toFixed(2)}` : '$0'}
                    </td>
                    <td className={cellClass}>
                      <TierBadge tier={e.tier} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Actions */}
      <div className="flex gap-2">
        <button
          onClick={copyResults}
          className="rounded-md px-3 py-1.5 text-xs transition-opacity hover:opacity-80"
          style={{ border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)' }}
        >
          Copy Results
        </button>
        <button
          onClick={onClear}
          className="rounded-md px-3 py-1.5 text-xs transition-opacity hover:opacity-80"
          style={{ border: '1px solid var(--border-subtle)', color: 'var(--text-muted)' }}
        >
          Clear
        </button>
      </div>
    </div>
  );
}
