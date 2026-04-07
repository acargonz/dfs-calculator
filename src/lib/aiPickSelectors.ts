/**
 * Pure helpers for selecting and ranking AI picks for display.
 *
 * These functions answer questions like:
 *   - "Which side (over/under) is the ensemble leaning on for this pick?"
 *   - "Which model gave the strongest call on this pick?"
 *   - "Which 5 picks should we feature in the Best Picks card?"
 *
 * They live in a separate file from the React panel so they can be unit
 * tested without rendering, and so the panel can stay focused on layout.
 *
 * IMPORTANT: the calculator never picks a side — that decision belongs to
 * the AI ensemble. Everything in here reads from MergedPick (which already
 * encodes the AI's votes) and never touches CalculationResult.
 */

import type { MergedPick, ModelVote, ConsensusLabel } from './ensembleConsensus';
import type { AIPick } from './aiAnalysis';

// ============================================================================
// Constants (shared between selectors and the panel)
// ============================================================================

export type AITier = AIPick['confidenceTier']; // 'A' | 'B' | 'C' | 'REJECT'

export const TIER_RANK: Record<AITier, number> = {
  A: 0,
  B: 1,
  C: 2,
  REJECT: 3,
};

/**
 * Sort priority for consensus labels (lower = stronger).
 * Drives both Best Picks ranking and the All Picks table sort.
 */
export const CONSENSUS_PRIORITY: Record<ConsensusLabel, number> = {
  agree_strong: 0,
  agree_weak: 1,
  mixed: 2,
  disagree_dir: 3,
  single_source: 4,
  all_reject: 5,
};

export const TIER_COLOR: Record<AITier, string> = {
  A: '#10b981',
  B: '#f59e0b',
  C: '#fb923c',
  REJECT: '#ef4444',
};

// ============================================================================
// Predicates
// ============================================================================

function isRejected(tier: AITier): boolean {
  return tier === 'REJECT';
}

function isRecommended(tier: AITier): boolean {
  return tier === 'A' || tier === 'B';
}

// ============================================================================
// Direction selectors
// ============================================================================

export type DisplayDirection = 'OVER' | 'UNDER' | 'SPLIT';

/**
 * Decide which side the ensemble is leaning on for display purposes.
 *
 * Algorithm:
 *   1. Count non-rejected votes per direction (rejects don't have a real "side").
 *   2. If one side has more votes → that side wins.
 *   3. On a tie, fall back to the direction held by the single highest-tier
 *      non-rejected vote (deterministic). This guarantees the badge and the
 *      reasoning shown in Best Picks always belong to the same side.
 *   4. If there are no non-rejected votes at all → 'SPLIT' (the All Picks
 *      table renders this as a neutral row; Best Picks filters all_reject out).
 */
export function dominantDirection(pick: MergedPick): DisplayDirection {
  const over = pick.directionCounts.over;
  const under = pick.directionCounts.under;

  if (over > under) return 'OVER';
  if (under > over) return 'UNDER';

  // Tie or both zero — try to break with the strongest vote.
  if (over === 0 && under === 0) return 'SPLIT';

  const top = bestVote(pick);
  if (top && !isRejected(top.pick.confidenceTier)) {
    return top.pick.direction === 'over' ? 'OVER' : 'UNDER';
  }
  return 'SPLIT';
}

/**
 * Highest-confidence vote across the merged pick, regardless of direction.
 * Used when we want "the single strongest opinion" (e.g. picking a tier
 * color for an ensemble row that may not have a single dominant direction).
 *
 * Tie-break: lower TIER_RANK first, then earliest in vote order.
 */
export function bestVote(pick: MergedPick): ModelVote | null {
  if (pick.votes.length === 0) return null;
  return [...pick.votes].sort(
    (a, b) => TIER_RANK[a.pick.confidenceTier] - TIER_RANK[b.pick.confidenceTier],
  )[0];
}

/**
 * Highest-confidence vote that AGREES WITH a specific direction. Used by the
 * Best Picks card so the displayed reasoning always matches the displayed
 * direction badge.
 *
 * Returns null if no model voted that direction (or every vote in that
 * direction was a REJECT).
 */
export function bestVoteForDirection(
  pick: MergedPick,
  direction: 'OVER' | 'UNDER',
): ModelVote | null {
  const dirLower = direction.toLowerCase() as 'over' | 'under';
  const candidates = pick.votes.filter(
    (v) => v.pick.direction === dirLower && !isRejected(v.pick.confidenceTier),
  );
  if (candidates.length === 0) return null;
  return [...candidates].sort(
    (a, b) => TIER_RANK[a.pick.confidenceTier] - TIER_RANK[b.pick.confidenceTier],
  )[0];
}

// ============================================================================
// Best Picks ranking
// ============================================================================

/**
 * Selects the top "best" picks for the highlighted callout card.
 *
 * Filtering:
 *   - Drops `all_reject` rows (no recommend votes by definition).
 *   - Drops rows with zero recommend votes (only weak/reject).
 *
 * Ranking (lower = better, in order):
 *   1. Consensus priority (agree_strong < agree_weak < mixed < disagree_dir
 *      < single_source).
 *   2. More recommend votes wins.
 *   3. Higher individual best-vote tier wins (A > B > C).
 *
 * Then truncates to `limit` (default 5).
 */
export function selectBestPicks(merged: MergedPick[], limit = 5): MergedPick[] {
  const ranked = merged
    .filter((m) => m.consensus !== 'all_reject' && m.tierCounts.recommend > 0)
    .sort((a, b) => {
      const cp = CONSENSUS_PRIORITY[a.consensus] - CONSENSUS_PRIORITY[b.consensus];
      if (cp !== 0) return cp;
      if (a.tierCounts.recommend !== b.tierCounts.recommend) {
        return b.tierCounts.recommend - a.tierCounts.recommend;
      }
      const aBest = bestVote(a)?.pick.confidenceTier ?? 'REJECT';
      const bBest = bestVote(b)?.pick.confidenceTier ?? 'REJECT';
      return TIER_RANK[aBest] - TIER_RANK[bBest];
    });
  return ranked.slice(0, limit);
}

// Re-exported for the panel's "is this a recommendable pick at all?" checks.
export { isRecommended, isRejected };
