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
        <h2 className="text-xl font-bold text-white">{playerName}</h2>
        <TierBadge tier={result.tier} />
      </div>

      {/* Probabilities */}
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-2">
          Probabilities (Over)
        </h3>
        <div className="grid grid-cols-3 gap-3">
          <div className="rounded-lg bg-slate-700/50 p-3 text-center">
            <p className="text-xs text-slate-400 mb-1">Fair (Market)</p>
            <p className="text-lg font-semibold text-white">{pct(result.fairOverProb)}</p>
          </div>
          <div className="rounded-lg bg-slate-700/50 p-3 text-center">
            <p className="text-xs text-slate-400 mb-1">Model ({result.source})</p>
            <p className="text-lg font-semibold text-white">{pct(result.modelOverProb)}</p>
          </div>
          <div className="rounded-lg bg-blue-900/30 border border-blue-800/50 p-3 text-center">
            <p className="text-xs text-blue-300 mb-1">Blended (60/40)</p>
            <p className="text-lg font-bold text-blue-400">{pct(result.blendedProb)}</p>
          </div>
        </div>
      </div>

      {/* EV & Kelly */}
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-2">
          Betting Edge
        </h3>
        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-lg bg-slate-700/50 p-3">
            <p className="text-xs text-slate-400 mb-1">Expected Value</p>
            <p className={`text-xl font-bold ${evPositive ? 'text-green-400' : 'text-red-400'}`}>
              {evPositive ? '+' : ''}{(result.ev * 100).toFixed(1)}%
            </p>
          </div>
          <div className="rounded-lg bg-slate-700/50 p-3">
            <p className="text-xs text-slate-400 mb-1">
              Kelly Stake ({(result.kellyFraction * 100)}% Kelly)
            </p>
            <p className="text-xl font-bold text-white">
              {result.kellyStake > 0 ? `$${result.kellyStake.toFixed(2)}` : '$0.00'}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
