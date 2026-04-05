import type { CalculationResult } from './types';

const TIER_STYLES: Record<CalculationResult['tier'], string> = {
  HIGH: 'bg-green-600 text-white',
  MEDIUM: 'bg-yellow-500 text-black',
  LOW: 'bg-orange-500 text-white',
  REJECT: 'bg-red-600 text-white',
};

interface TierBadgeProps {
  tier: CalculationResult['tier'];
}

export default function TierBadge({ tier }: TierBadgeProps) {
  return (
    <span
      data-testid="tier-badge"
      className={`inline-block rounded-full px-3 py-1 text-sm font-bold ${TIER_STYLES[tier]}`}
    >
      {tier}
    </span>
  );
}
