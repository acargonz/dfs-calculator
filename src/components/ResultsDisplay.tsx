import type { CalculationResult } from './types';
import TierBadge from './TierBadge';

interface ResultsDisplayProps {
  result: CalculationResult;
  playerName: string;
}

function pct(value: number): string {
  return (value * 100).toFixed(1) + '%';
}

export default function ResultsDisplay({ result, playerName }: ResultsDisplayProps) {
  const evPositive = result.ev > 0;

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold" style={{ color: 'var(--text-primary)' }}>{playerName}</h2>
        <TierBadge tier={result.tier} />
      </div>

      {/* Probabilities */}
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: 'var(--text-muted)' }}>
          Probabilities (Over)
        </h3>
        <div className="grid grid-cols-3 gap-3">
          <div className="rounded-lg p-3 text-center" style={{ background: 'var(--bg-secondary)' }}>
            <p className="text-xs mb-1" style={{ color: 'var(--text-secondary)' }}>Fair (Market)</p>
            <p className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>{pct(result.fairOverProb)}</p>
          </div>
          <div className="rounded-lg p-3 text-center" style={{ background: 'var(--bg-secondary)' }}>
            <p className="text-xs mb-1" style={{ color: 'var(--text-secondary)' }}>Model ({result.source})</p>
            <p className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>{pct(result.modelOverProb)}</p>
          </div>
          <div className="rounded-lg p-3 text-center" style={{ background: 'rgba(218, 119, 86, 0.1)', border: '1px solid rgba(218, 119, 86, 0.25)' }}>
            <p className="text-xs mb-1" style={{ color: 'var(--accent)' }}>Blended (60/40)</p>
            <p className="text-lg font-bold" style={{ color: 'var(--accent)' }}>{pct(result.blendedProb)}</p>
          </div>
        </div>
      </div>

      {/* EV & Kelly */}
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: 'var(--text-muted)' }}>
          Betting Edge
        </h3>
        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-lg p-3" style={{ background: 'var(--bg-secondary)' }}>
            <p className="text-xs mb-1" style={{ color: 'var(--text-secondary)' }}>Expected Value</p>
            <p className={`text-xl font-bold ${evPositive ? 'text-emerald-400' : 'text-red-400'}`}>
              {evPositive ? '+' : ''}{(result.ev * 100).toFixed(1)}%
            </p>
          </div>
          <div className="rounded-lg p-3" style={{ background: 'var(--bg-secondary)' }}>
            <p className="text-xs mb-1" style={{ color: 'var(--text-secondary)' }}>
              Kelly Stake ({(result.kellyFraction * 100)}% Kelly)
            </p>
            <p className="text-xl font-bold" style={{ color: 'var(--text-primary)' }}>
              {result.kellyStake > 0 ? `$${result.kellyStake.toFixed(2)}` : '$0.00'}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
