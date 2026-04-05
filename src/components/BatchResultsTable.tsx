'use client';

import { useState } from 'react';
import TierBadge from './TierBadge';
import type { BatchResult, BatchPlayerResult } from '../lib/batchProcessor';

interface BatchResultsTableProps {
  results: BatchResult;
  onClear: () => void;
}

type SortKey = 'player' | 'stat' | 'line' | 'mean' | 'prob' | 'ev' | 'stake' | 'tier';
type SortDir = 'asc' | 'desc';

const TIER_RANK: Record<string, number> = { HIGH: 0, MEDIUM: 1, LOW: 2, REJECT: 3 };

function getSortValue(p: BatchPlayerResult, key: SortKey): number | string {
  switch (key) {
    case 'player': return p.playerName.toLowerCase();
    case 'stat': return p.statType;
    case 'line': return p.line;
    case 'mean': return p.mean;
    case 'prob': return p.result?.blendedProb ?? -1;
    case 'ev': return p.result?.ev ?? -999;
    case 'stake': return p.result?.kellyStake ?? -1;
    case 'tier': return TIER_RANK[p.result?.tier ?? 'REJECT'] ?? 4;
    default: return 0;
  }
}

function pct(value: number): string {
  return (value * 100).toFixed(1) + '%';
}

export default function BatchResultsTable({ results, onClear }: BatchResultsTableProps) {
  const [sortKey, setSortKey] = useState<SortKey>('tier');
  const [sortDir, setSortDir] = useState<SortDir>('asc');

  function handleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDir(key === 'ev' || key === 'prob' || key === 'stake' ? 'desc' : 'asc');
    }
  }

  const sorted = [...results.players].sort((a, b) => {
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

  const { summary } = results;
  const headerClass = 'px-3 py-2 text-left text-xs font-semibold cursor-pointer select-none transition-colors';

  function arrow(key: SortKey) {
    if (sortKey !== key) return '';
    return sortDir === 'asc' ? ' \u25B2' : ' \u25BC';
  }

  function copyResults() {
    const header = 'Player\tStat\tLine\tMean\tProb\tEV\tStake\tTier';
    const rows = results.players.map((p) => {
      if (p.status === 'success' && p.result) {
        const r = p.result;
        return `${p.playerName}\t${p.statType}\t${p.line}\t${p.mean.toFixed(1)}\t${pct(r.blendedProb)}\t${(r.ev * 100).toFixed(1)}%\t$${r.kellyStake.toFixed(2)}\t${r.tier}`;
      }
      // Include error rows with status info
      return `${p.playerName}\t${p.statType}\t${p.line}\t-\t-\t-\t-\tERROR: ${p.statusMessage || p.status}`;
    });
    navigator.clipboard.writeText([header, ...rows].join('\n'));
  }

  return (
    <div className="space-y-4">
      {/* Summary */}
      <div className="flex flex-wrap items-center gap-3">
        {summary.high > 0 && <span className="text-sm font-semibold text-emerald-400">{summary.high} HIGH</span>}
        {summary.medium > 0 && <span className="text-sm font-semibold text-amber-400">{summary.medium} MEDIUM</span>}
        {summary.low > 0 && <span className="text-sm font-semibold text-orange-400">{summary.low} LOW</span>}
        {summary.reject > 0 && <span className="text-sm" style={{ color: 'var(--text-muted)' }}>{summary.reject} REJECT</span>}
        {summary.errors > 0 && <span className="text-sm text-red-400">{summary.errors} Error{summary.errors > 1 ? 's' : ''}</span>}
        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>({results.players.length} total)</span>
      </div>

      {/* Table */}
      <div className="overflow-x-auto rounded-lg" style={{ border: '1px solid var(--border-subtle)' }}>
        <table className="w-full text-sm">
          <thead style={{ background: 'var(--bg-secondary)' }}>
            <tr>
              <th className={headerClass} style={{ color: 'var(--text-muted)' }} onClick={() => handleSort('player')}>Player{arrow('player')}</th>
              <th className={headerClass} style={{ color: 'var(--text-muted)' }} onClick={() => handleSort('stat')}>Stat{arrow('stat')}</th>
              <th className={headerClass} style={{ color: 'var(--text-muted)' }} onClick={() => handleSort('line')}>Line{arrow('line')}</th>
              <th className={headerClass} style={{ color: 'var(--text-muted)' }} onClick={() => handleSort('mean')}>Mean{arrow('mean')}</th>
              <th className={headerClass} style={{ color: 'var(--text-muted)' }} onClick={() => handleSort('prob')}>Prob{arrow('prob')}</th>
              <th className={headerClass} style={{ color: 'var(--text-muted)' }} onClick={() => handleSort('ev')}>EV{arrow('ev')}</th>
              <th className={headerClass} style={{ color: 'var(--text-muted)' }} onClick={() => handleSort('stake')}>Stake{arrow('stake')}</th>
              <th className={headerClass} style={{ color: 'var(--text-muted)' }} onClick={() => handleSort('tier')}>Tier{arrow('tier')}</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((p, i) => {
              if (p.status !== 'success' || !p.result) {
                return (
                  <tr key={i} className="opacity-40" style={{ borderTop: '1px solid var(--border-subtle)' }}>
                    <td className="px-3 py-2" style={{ color: 'var(--text-primary)' }}>{p.playerName}</td>
                    <td className="px-3 py-2" colSpan={7}>
                      <span className="italic text-red-400">{p.statusMessage || p.status}</span>
                    </td>
                  </tr>
                );
              }

              const r = p.result;
              const isReject = r.tier === 'REJECT';

              return (
                <tr
                  key={i}
                  className={isReject ? 'opacity-50' : ''}
                  style={{ borderTop: '1px solid var(--border-subtle)' }}
                >
                  <td className="px-3 py-2 font-medium" style={{ color: 'var(--text-primary)' }}>{p.playerName}</td>
                  <td className="px-3 py-2 capitalize" style={{ color: 'var(--text-secondary)' }}>{p.statType}</td>
                  <td className="px-3 py-2" style={{ color: 'var(--text-secondary)' }}>{p.line}</td>
                  <td className="px-3 py-2" style={{ color: 'var(--text-secondary)' }}>{p.mean.toFixed(1)}</td>
                  <td className="px-3 py-2 font-medium" style={{ color: 'var(--accent)' }}>{pct(r.blendedProb)}</td>
                  <td className={`px-3 py-2 font-medium ${r.ev > 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                    {r.ev > 0 ? '+' : ''}{(r.ev * 100).toFixed(1)}%
                  </td>
                  <td className="px-3 py-2" style={{ color: 'var(--text-primary)' }}>
                    {r.kellyStake > 0 ? `$${r.kellyStake.toFixed(2)}` : '$0'}
                  </td>
                  <td className="px-3 py-2">
                    <TierBadge tier={r.tier} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Actions */}
      <div className="flex gap-3">
        <button
          onClick={copyResults}
          className="rounded-lg px-4 py-2 text-sm transition-colors hover:opacity-80"
          style={{ border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)' }}
        >
          Copy Results
        </button>
        <button
          onClick={onClear}
          className="rounded-lg px-4 py-2 text-sm transition-colors hover:opacity-80"
          style={{ border: '1px solid var(--border-subtle)', color: 'var(--text-muted)' }}
        >
          Clear
        </button>
      </div>
    </div>
  );
}
