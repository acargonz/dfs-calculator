import type { CalculationResult } from './types';

const TIER_STYLES: Record<CalculationResult['tier'], string> = {
  HIGH: 'bg-emerald-600/20 text-emerald-400 border border-emerald-600/30',
  MEDIUM: 'bg-amber-500/15 text-amber-400 border border-amber-500/25',
  LOW: 'bg-orange-500/15 text-orange-400 border border-orange-500/25',
  REJECT: 'bg-red-500/10 text-red-400/70 border border-red-500/20',
};

interface TierBadgeProps {
  tier: CalculationResult['tier'];
}

export default function TierBadge({ tier }: TierBadgeProps) {
  return (
    <span
      data-testid="tier-badge"
      className={`inline-block rounded-full px-3 py-1 text-xs font-bold tracking-wide ${TIER_STYLES[tier]}`}
    >
      {tier}
    </span>
  );
}
