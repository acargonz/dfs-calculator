import {
  TIER_RANK,
  CONSENSUS_PRIORITY,
  TIER_COLOR,
  dominantDirection,
  bestVote,
  bestVoteForDirection,
  selectBestPicks,
} from '../src/lib/aiPickSelectors';
import type { MergedPick, ModelVote, ConsensusLabel } from '../src/lib/ensembleConsensus';
import type { AIPick, AIProvider } from '../src/lib/aiAnalysis';

// ============================================================================
// Test fixture helpers
// ============================================================================

function makePick(overrides: Partial<AIPick> = {}): AIPick {
  return {
    playerName: 'LeBron James',
    statType: 'points',
    line: 24.5,
    direction: 'over',
    confidenceTier: 'B',
    reasoning: 'baseline',
    flags: [],
    ...overrides,
  };
}

function makeVote(provider: AIProvider, pick: Partial<AIPick> = {}): ModelVote {
  return {
    provider,
    model: `${provider}-test-model`,
    pick: makePick(pick),
  };
}

/**
 * Build a MergedPick from an array of votes. Computes tier and direction
 * counts the same way `mergePicks` does so the helpers see realistic input.
 */
function makeMerged(
  votes: ModelVote[],
  consensus: ConsensusLabel = 'agree_strong',
): MergedPick {
  const tierCounts = { recommend: 0, weak: 0, reject: 0 };
  const directionCounts = { over: 0, under: 0 };
  for (const v of votes) {
    const t = v.pick.confidenceTier;
    if (t === 'A' || t === 'B') tierCounts.recommend++;
    else if (t === 'C') tierCounts.weak++;
    else if (t === 'REJECT') tierCounts.reject++;
    if (t !== 'REJECT') {
      if (v.pick.direction === 'over') directionCounts.over++;
      else if (v.pick.direction === 'under') directionCounts.under++;
    }
  }
  const first = votes[0]?.pick;
  return {
    key: `${first?.playerName ?? 'X'}|${first?.statType ?? 'points'}|${first?.line ?? 0}`,
    playerName: first?.playerName ?? 'X',
    statType: first?.statType ?? 'points',
    line: first?.line ?? 0,
    votes,
    consensus,
    tierCounts,
    directionCounts,
  };
}

// ============================================================================
// Constants
// ============================================================================

describe('TIER_RANK', () => {
  it('orders A < B < C < REJECT', () => {
    expect(TIER_RANK.A).toBeLessThan(TIER_RANK.B);
    expect(TIER_RANK.B).toBeLessThan(TIER_RANK.C);
    expect(TIER_RANK.C).toBeLessThan(TIER_RANK.REJECT);
  });
});

describe('CONSENSUS_PRIORITY', () => {
  it('ranks agree_strong as the strongest signal', () => {
    expect(CONSENSUS_PRIORITY.agree_strong).toBe(0);
  });

  it('ranks all_reject as the weakest signal', () => {
    const others: ConsensusLabel[] = [
      'agree_strong',
      'agree_weak',
      'mixed',
      'disagree_dir',
      'single_source',
    ];
    for (const o of others) {
      expect(CONSENSUS_PRIORITY[o]).toBeLessThan(CONSENSUS_PRIORITY.all_reject);
    }
  });
});

describe('TIER_COLOR', () => {
  it('returns a hex color string for every tier', () => {
    for (const t of ['A', 'B', 'C', 'REJECT'] as const) {
      expect(TIER_COLOR[t]).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });
});

// ============================================================================
// dominantDirection
// ============================================================================

describe('dominantDirection', () => {
  it('returns OVER when more non-rejected votes are over', () => {
    const merged = makeMerged([
      makeVote('gemini', { confidenceTier: 'A', direction: 'over' }),
      makeVote('openrouter', { confidenceTier: 'B', direction: 'over' }),
      makeVote('claude', { confidenceTier: 'B', direction: 'under' }),
    ]);
    expect(dominantDirection(merged)).toBe('OVER');
  });

  it('returns UNDER when more non-rejected votes are under', () => {
    const merged = makeMerged([
      makeVote('gemini', { confidenceTier: 'B', direction: 'under' }),
      makeVote('openrouter', { confidenceTier: 'A', direction: 'under' }),
    ]);
    expect(dominantDirection(merged)).toBe('UNDER');
  });

  it('breaks 1v1 ties using the highest-tier vote (over wins)', () => {
    const merged = makeMerged([
      makeVote('gemini', { confidenceTier: 'A', direction: 'over' }),   // strongest
      makeVote('openrouter', { confidenceTier: 'B', direction: 'under' }),
    ]);
    expect(dominantDirection(merged)).toBe('OVER');
  });

  it('breaks 1v1 ties using the highest-tier vote (under wins)', () => {
    const merged = makeMerged([
      makeVote('gemini', { confidenceTier: 'B', direction: 'over' }),
      makeVote('openrouter', { confidenceTier: 'A', direction: 'under' }), // strongest
    ]);
    expect(dominantDirection(merged)).toBe('UNDER');
  });

  it('returns SPLIT when every vote was REJECT (no real direction)', () => {
    const merged = makeMerged([
      makeVote('gemini', { confidenceTier: 'REJECT', direction: 'over' }),
      makeVote('openrouter', { confidenceTier: 'REJECT', direction: 'under' }),
    ]);
    expect(dominantDirection(merged)).toBe('SPLIT');
  });

  it('ignores rejected votes when counting directions', () => {
    const merged = makeMerged([
      makeVote('gemini', { confidenceTier: 'REJECT', direction: 'over' }),
      makeVote('openrouter', { confidenceTier: 'B', direction: 'under' }),
    ]);
    expect(dominantDirection(merged)).toBe('UNDER');
  });
});

// ============================================================================
// bestVote
// ============================================================================

describe('bestVote', () => {
  it('returns null for an empty merged pick', () => {
    const merged = makeMerged([]);
    expect(bestVote(merged)).toBeNull();
  });

  it('returns the only vote when there is just one', () => {
    const vote = makeVote('gemini', { confidenceTier: 'B' });
    const merged = makeMerged([vote]);
    expect(bestVote(merged)?.pick.confidenceTier).toBe('B');
  });

  it('returns the highest-tier vote across multiple', () => {
    const merged = makeMerged([
      makeVote('gemini', { confidenceTier: 'C' }),
      makeVote('openrouter', { confidenceTier: 'A' }),
      makeVote('claude', { confidenceTier: 'B' }),
    ]);
    expect(bestVote(merged)?.provider).toBe('openrouter');
  });

  it('breaks ties by vote order (sort is stable)', () => {
    const merged = makeMerged([
      makeVote('gemini', { confidenceTier: 'A' }),
      makeVote('openrouter', { confidenceTier: 'A' }),
    ]);
    expect(bestVote(merged)?.provider).toBe('gemini');
  });
});

// ============================================================================
// bestVoteForDirection
// ============================================================================

describe('bestVoteForDirection', () => {
  it('returns null when no vote matches the direction', () => {
    const merged = makeMerged([
      makeVote('gemini', { confidenceTier: 'A', direction: 'over' }),
    ]);
    expect(bestVoteForDirection(merged, 'UNDER')).toBeNull();
  });

  it('returns null when the only matching vote is a REJECT', () => {
    const merged = makeMerged([
      makeVote('gemini', { confidenceTier: 'REJECT', direction: 'under' }),
      makeVote('openrouter', { confidenceTier: 'A', direction: 'over' }),
    ]);
    expect(bestVoteForDirection(merged, 'UNDER')).toBeNull();
  });

  it('returns the strongest non-reject vote in the requested direction', () => {
    const merged = makeMerged([
      makeVote('gemini', { confidenceTier: 'B', direction: 'over' }),
      makeVote('openrouter', { confidenceTier: 'A', direction: 'over' }),
      makeVote('claude', { confidenceTier: 'A', direction: 'under' }),
    ]);
    expect(bestVoteForDirection(merged, 'OVER')?.provider).toBe('openrouter');
    expect(bestVoteForDirection(merged, 'UNDER')?.provider).toBe('claude');
  });

  it('reasoning of the returned vote always belongs to the requested side', () => {
    const merged = makeMerged([
      makeVote('gemini', {
        confidenceTier: 'A',
        direction: 'over',
        reasoning: 'OVER is great',
      }),
      makeVote('openrouter', {
        confidenceTier: 'A',
        direction: 'under',
        reasoning: 'UNDER is great',
      }),
    ]);
    expect(bestVoteForDirection(merged, 'OVER')?.pick.reasoning).toBe('OVER is great');
    expect(bestVoteForDirection(merged, 'UNDER')?.pick.reasoning).toBe('UNDER is great');
  });
});

// ============================================================================
// selectBestPicks
// ============================================================================

describe('selectBestPicks', () => {
  it('returns an empty array when there are no merged picks', () => {
    expect(selectBestPicks([])).toEqual([]);
  });

  it('drops all_reject picks even when limit allows them', () => {
    const merged = [
      makeMerged(
        [makeVote('gemini', { confidenceTier: 'REJECT' })],
        'all_reject',
      ),
    ];
    expect(selectBestPicks(merged)).toEqual([]);
  });

  it('drops picks with zero recommend votes', () => {
    const merged = [
      makeMerged(
        [
          makeVote('gemini', { confidenceTier: 'C', direction: 'over' }),
          makeVote('openrouter', { confidenceTier: 'C', direction: 'over' }),
        ],
        'agree_weak',
      ),
    ];
    expect(selectBestPicks(merged)).toEqual([]);
  });

  it('orders by consensus priority first', () => {
    const strong = makeMerged(
      [
        makeVote('gemini', { playerName: 'Strong', confidenceTier: 'B', direction: 'over' }),
        makeVote('openrouter', { playerName: 'Strong', confidenceTier: 'B', direction: 'over' }),
      ],
      'agree_strong',
    );
    const weak = makeMerged(
      [
        makeVote('gemini', { playerName: 'Weak', confidenceTier: 'A', direction: 'over' }),
        makeVote('openrouter', { playerName: 'Weak', confidenceTier: 'C', direction: 'over' }),
      ],
      'agree_weak',
    );
    const sorted = selectBestPicks([weak, strong]);
    expect(sorted[0].playerName).toBe('Strong');
    expect(sorted[1].playerName).toBe('Weak');
  });

  it('within same consensus, more recommend votes wins', () => {
    const two = makeMerged(
      [
        makeVote('gemini', { playerName: 'TwoRecs', confidenceTier: 'B', direction: 'over' }),
        makeVote('openrouter', { playerName: 'TwoRecs', confidenceTier: 'B', direction: 'over' }),
      ],
      'agree_strong',
    );
    const oneStrong = makeMerged(
      [
        makeVote('gemini', { playerName: 'OneRec', confidenceTier: 'A', direction: 'over' }),
      ],
      'agree_strong',
    );
    const sorted = selectBestPicks([oneStrong, two]);
    expect(sorted[0].playerName).toBe('TwoRecs');
    expect(sorted[1].playerName).toBe('OneRec');
  });

  it('within same consensus and recommend count, higher best-tier wins', () => {
    const aRow = makeMerged(
      [
        makeVote('gemini', { playerName: 'A-pick', confidenceTier: 'A', direction: 'over' }),
        makeVote('openrouter', { playerName: 'A-pick', confidenceTier: 'B', direction: 'over' }),
      ],
      'agree_strong',
    );
    const bRow = makeMerged(
      [
        makeVote('gemini', { playerName: 'B-pick', confidenceTier: 'B', direction: 'over' }),
        makeVote('openrouter', { playerName: 'B-pick', confidenceTier: 'B', direction: 'over' }),
      ],
      'agree_strong',
    );
    const sorted = selectBestPicks([bRow, aRow]);
    expect(sorted[0].playerName).toBe('A-pick');
    expect(sorted[1].playerName).toBe('B-pick');
  });

  it('respects the limit parameter', () => {
    const merged: MergedPick[] = [];
    for (let i = 0; i < 8; i++) {
      merged.push(
        makeMerged(
          [
            makeVote('gemini', { playerName: `P${i}`, confidenceTier: 'A', direction: 'over' }),
            makeVote('openrouter', { playerName: `P${i}`, confidenceTier: 'B', direction: 'over' }),
          ],
          'agree_strong',
        ),
      );
    }
    expect(selectBestPicks(merged, 5)).toHaveLength(5);
    expect(selectBestPicks(merged, 3)).toHaveLength(3);
  });

  it('defaults limit to 5', () => {
    const merged: MergedPick[] = [];
    for (let i = 0; i < 10; i++) {
      merged.push(
        makeMerged(
          [
            makeVote('gemini', { playerName: `P${i}`, confidenceTier: 'B', direction: 'over' }),
            makeVote('openrouter', { playerName: `P${i}`, confidenceTier: 'B', direction: 'over' }),
          ],
          'agree_strong',
        ),
      );
    }
    expect(selectBestPicks(merged)).toHaveLength(5);
  });

  it('keeps disagree_dir picks when at least one side is recommended', () => {
    const merged = [
      makeMerged(
        [
          makeVote('gemini', { confidenceTier: 'A', direction: 'over' }),
          makeVote('openrouter', { confidenceTier: 'B', direction: 'under' }),
        ],
        'disagree_dir',
      ),
    ];
    expect(selectBestPicks(merged)).toHaveLength(1);
  });
});
