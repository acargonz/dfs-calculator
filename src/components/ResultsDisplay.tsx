import type { CalculationResult, SideEvaluation } from './types';
import TierBadge from './TierBadge';
import { pickBestSide } from '../lib/twoSidedCalc';

interface ResultsDisplayProps {
  result: CalculationResult;
  playerName: string;
}

function pct(value: number): string {
  return (value * 100).toFixed(1) + '%';
}

function SideCard({
  label,
  side,
  highlight,
}: {
  label: 'OVER' | 'UNDER';
  side: SideEvaluation;
  highlight: boolean;
}) {
  const evPositive = side.ev > 0;
  const accent = label === 'OVER' ? '#10b981' : '#fb923c';
  const cardStyle = highlight
    ? { background: `${accent}10`, border: `1px solid ${accent}55` }
    : { background: 'var(--bg-secondary)', border: '1px solid var(--border-subtle)' };

  return (
    <div className="rounded-lg p-3 space-y-2" style={cardStyle}>
      <div className="flex items-center justify-between">
        <span className="text-xs font-bold tracking-wide" style={{ color: accent }}>
          {label} {highlight && '★'}
        </span>
        <TierBadge tier={side.tier} />
      </div>
      <div className="grid grid-cols-3 gap-2 text-center">
        <div>
          <p className="text-[10px] mb-0.5" style={{ color: 'var(--text-muted)' }}>Fair</p>
          <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{pct(side.fairProb)}</p>
        </div>
        <div>
          <p className="text-[10px] mb-0.5" style={{ color: 'var(--text-muted)' }}>Model</p>
          <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{pct(side.modelProb)}</p>
        </div>
        <div>
          <p className="text-[10px] mb-0.5" style={{ color: 'var(--text-muted)' }}>Blended</p>
          <p className="text-sm font-bold" style={{ color: 'var(--accent)' }}>{pct(side.blendedProb)}</p>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div
          className="rounded p-2 text-center"
          style={{ background: 'var(--bg-card)' }}
          title={
            'Per-dollar Kelly EV on this single leg.\n\n' +
            'Formula: EV = p × (decimalOdds − 1) − (1 − p)\n' +
            'where p is the BLENDED probability above (60% model, 40% market devig).\n\n' +
            'A +30% EV does NOT mean a +30% return on a parlay slip — DFS books require\n' +
            '2+ legs to cash, and the slip math compounds variance. The tier filter (HIGH/\n' +
            'MEDIUM/LOW) and the AI overlay both consume this number to decide which legs\n' +
            'survive into a build. High raw EVs here are normal on softer lines.'
          }
        >
          <p className="text-[10px] mb-0.5" style={{ color: 'var(--text-muted)' }}>Expected Value</p>
          <p className={`text-sm font-bold ${evPositive ? 'text-emerald-400' : 'text-red-400'}`}>
            {evPositive ? '+' : ''}{(side.ev * 100).toFixed(1)}%
          </p>
        </div>
        <div className="rounded p-2 text-center" style={{ background: 'var(--bg-card)' }}>
          <p className="text-[10px] mb-0.5" style={{ color: 'var(--text-muted)' }}>
            Kelly ({(side.kellyFraction * 100)}%)
          </p>
          <p className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>
            {side.kellyStake > 0 ? `$${side.kellyStake.toFixed(2)}` : '$0.00'}
          </p>
        </div>
      </div>
    </div>
  );
}

export default function ResultsDisplay({ result, playerName }: ResultsDisplayProps) {
  const best = pickBestSide(result);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold" style={{ color: 'var(--text-primary)' }}>{playerName}</h2>
        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
          Model: {result.source} · ★ stronger side
        </span>
      </div>
      <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
        Both sides are evaluated independently. The calculator does not pick a direction —
        the AI analysis decides over vs under based on the active Algorithmic Prompt filters.
      </p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <SideCard label="OVER" side={result.over} highlight={best === 'over'} />
        <SideCard label="UNDER" side={result.under} highlight={best === 'under'} />
      </div>
    </div>
  );
}
