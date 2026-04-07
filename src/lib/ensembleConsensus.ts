/**
 * Ensemble consensus logic.
 *
 * When multiple AI models analyze the same slate, they may produce different
 * pick sets. This module merges their outputs into a single unified table,
 * annotating each pick with a consensus badge describing how the models voted.
 *
 * Rules:
 *   - Two picks match if they share the same normalized player + stat + line.
 *     Direction is allowed to differ (that's the most interesting disagreement).
 *   - Tier mapping: A/B = "recommended", C = "weak", REJECT = "rejected".
 *
 * Consensus categories:
 *   agree_strong  — all models recommend (A/B) the same direction
 *   agree_weak    — all models agree direction but one is only C tier
 *   disagree_dir  — models recommend opposite directions (over vs under)
 *   mixed         — some recommend, some reject (still same direction)
 *   all_reject    — all models mark as REJECT
 *   single_source — only one model had an opinion on this pick
 */

import type { AIPick, AIProvider, EnsembleResult } from './aiAnalysis';

export type ConsensusLabel =
  | 'agree_strong'
  | 'agree_weak'
  | 'disagree_dir'
  | 'mixed'
  | 'all_reject'
  | 'single_source';

export interface ModelVote {
  provider: AIProvider;
  model: string;
  pick: AIPick;
}

export interface MergedPick {
  key: string;                      // Canonical matching key
  playerName: string;
  statType: string;
  line: number;
  votes: ModelVote[];               // One entry per model that had a pick on this row
  consensus: ConsensusLabel;
  tierCounts: {
    recommend: number;              // A or B in any direction
    weak: number;                   // C in any direction
    reject: number;                 // REJECT
  };
  directionCounts: {
    over: number;                   // Votes with confidenceTier != REJECT and direction = over
    under: number;
  };
}

export interface ConsensusSummary {
  totalPicks: number;
  agreeStrong: number;
  agreeWeak: number;
  disagreeDir: number;
  mixed: number;
  allReject: number;
  singleSource: number;
}

/**
 * Normalize a player name for cross-model matching. Strips punctuation and
 * diacritics and lowercases. Suffixes like "Jr"/"Sr" are INTENTIONALLY
 * preserved — merging "Jaren Jackson Jr." with "Jaren Jackson Sr." across
 * models would be a silent error, not a fix.
 *
 *   "Nikola Jokić"        → "nikola jokic"
 *   "Nikola Jokic"        → "nikola jokic"     (← merges with the above)
 *   "LeBron James Jr."    → "lebron james jr"
 *   "D'Angelo Russell"    → "dangelo russell"
 *
 * This is distinct from the normalizer in `pickResolver.ts` /
 * `/api/player-stats`, which additionally strips Jr/Sr/II/III/IV suffixes
 * because box-score sources inconsistently include them. See the comment
 * block there for why those call sites need suffix stripping while this
 * one does not.
 */
export function normalizePlayerName(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[.,'`]/g, '')
    .replace(/\s+/g, ' ');
}

/**
 * Canonical key for matching picks across models.
 * Same player + stat + line → same key.
 */
export function matchKey(playerName: string, statType: string, line: number): string {
  return `${normalizePlayerName(playerName)}|${statType.toLowerCase()}|${line.toFixed(1)}`;
}

function isRecommended(tier: AIPick['confidenceTier']): boolean {
  return tier === 'A' || tier === 'B';
}

function isWeak(tier: AIPick['confidenceTier']): boolean {
  return tier === 'C';
}

function isRejected(tier: AIPick['confidenceTier']): boolean {
  return tier === 'REJECT';
}

/**
 * Given a merged pick's votes, compute the consensus label.
 */
export function computeConsensus(votes: ModelVote[]): ConsensusLabel {
  if (votes.length === 0) return 'single_source';
  if (votes.length === 1) return 'single_source';

  const recommended = votes.filter((v) => isRecommended(v.pick.confidenceTier));
  const rejected = votes.filter((v) => isRejected(v.pick.confidenceTier));
  const weak = votes.filter((v) => isWeak(v.pick.confidenceTier));

  // Case: everyone rejects
  if (rejected.length === votes.length) return 'all_reject';

  // Case: at least one recommends, at least one rejects → mixed
  if (recommended.length > 0 && rejected.length > 0) return 'mixed';

  // Case: everyone recommends — check direction
  if (recommended.length + weak.length === votes.length) {
    // Get all non-reject directions
    const directions = new Set(
      votes
        .filter((v) => !isRejected(v.pick.confidenceTier))
        .map((v) => v.pick.direction),
    );

    if (directions.size > 1) return 'disagree_dir';

    // All same direction — are any weak?
    if (weak.length > 0) return 'agree_weak';
    return 'agree_strong';
  }

  // Fallback: weak + reject, but no strong recommendations
  return 'mixed';
}

/**
 * Merge picks from multiple model responses into unified rows with consensus labels.
 */
export function mergePicks(ensemble: EnsembleResult): {
  merged: MergedPick[];
  summary: ConsensusSummary;
} {
  const successful = ensemble.responses.filter(
    (r): r is Extract<typeof r, { status: 'success' }> => r.status === 'success',
  );

  // Key → MergedPick accumulator
  const map = new Map<string, MergedPick>();

  for (const entry of successful) {
    for (const pick of entry.response.picks) {
      const key = matchKey(pick.playerName, pick.statType, pick.line);
      if (!map.has(key)) {
        map.set(key, {
          key,
          playerName: pick.playerName,
          statType: pick.statType,
          line: pick.line,
          votes: [],
          consensus: 'single_source',
          tierCounts: { recommend: 0, weak: 0, reject: 0 },
          directionCounts: { over: 0, under: 0 },
        });
      }

      const merged = map.get(key)!;
      merged.votes.push({
        provider: entry.provider,
        model: entry.model,
        pick,
      });

      // Update tier counts
      if (isRecommended(pick.confidenceTier)) merged.tierCounts.recommend++;
      else if (isWeak(pick.confidenceTier)) merged.tierCounts.weak++;
      else if (isRejected(pick.confidenceTier)) merged.tierCounts.reject++;

      // Update direction counts (only for non-rejected votes)
      if (!isRejected(pick.confidenceTier)) {
        if (pick.direction === 'over') merged.directionCounts.over++;
        else if (pick.direction === 'under') merged.directionCounts.under++;
      }
    }
  }

  // Compute consensus label for each merged pick
  const merged = Array.from(map.values()).map((m) => ({
    ...m,
    consensus: computeConsensus(m.votes),
  }));

  // Build summary
  const summary: ConsensusSummary = {
    totalPicks: merged.length,
    agreeStrong: merged.filter((m) => m.consensus === 'agree_strong').length,
    agreeWeak: merged.filter((m) => m.consensus === 'agree_weak').length,
    disagreeDir: merged.filter((m) => m.consensus === 'disagree_dir').length,
    mixed: merged.filter((m) => m.consensus === 'mixed').length,
    allReject: merged.filter((m) => m.consensus === 'all_reject').length,
    singleSource: merged.filter((m) => m.consensus === 'single_source').length,
  };

  // Sort: agree_strong first, then by vote count desc, then by player name
  const priority: Record<ConsensusLabel, number> = {
    agree_strong: 0,
    agree_weak: 1,
    mixed: 2,
    disagree_dir: 3,
    single_source: 4,
    all_reject: 5,
  };

  merged.sort((a, b) => {
    const pa = priority[a.consensus];
    const pb = priority[b.consensus];
    if (pa !== pb) return pa - pb;
    if (a.votes.length !== b.votes.length) return b.votes.length - a.votes.length;
    return a.playerName.localeCompare(b.playerName);
  });

  return { merged, summary };
}

// ============================================================================
// Badge helpers (for UI rendering)
// ============================================================================

export function consensusLabel(label: ConsensusLabel): string {
  switch (label) {
    case 'agree_strong': return 'Both Agree';
    case 'agree_weak': return 'Weak Agree';
    case 'disagree_dir': return 'Disagree';
    case 'mixed': return 'Mixed';
    case 'all_reject': return 'All Reject';
    case 'single_source': return 'Single Source';
  }
}
