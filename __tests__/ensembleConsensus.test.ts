import {
  normalizePlayerName,
  matchKey,
  computeConsensus,
  mergePicks,
  consensusLabel,
  type ModelVote,
} from '../src/lib/ensembleConsensus';
import type { AIPick, EnsembleResult, AIAnalysisResponse } from '../src/lib/aiAnalysis';

// ============================================================================
// Helpers
// ============================================================================

function makePick(overrides: Partial<AIPick> = {}): AIPick {
  return {
    playerName: 'LeBron James',
    statType: 'points',
    line: 24.5,
    direction: 'over',
    confidenceTier: 'B',
    reasoning: 'test reasoning',
    flags: [],
    ...overrides,
  };
}

function makeVote(provider: 'gemini' | 'openrouter' | 'claude', pick: Partial<AIPick> = {}): ModelVote {
  return {
    provider,
    model: provider === 'gemini' ? 'gemini-2.5-flash' : 'openai/gpt-oss-120b:free',
    pick: makePick(pick),
  };
}

function makeResponse(picks: AIPick[]): AIAnalysisResponse {
  return {
    picks,
    slips: [],
    summary: 'test',
    warnings: [],
    rawText: '{}',
    durationMs: 100,
    model: 'test-model',
    provider: 'gemini',
  };
}

// ============================================================================
// normalizePlayerName
// ============================================================================

describe('normalizePlayerName', () => {
  it('lowercases names', () => {
    expect(normalizePlayerName('LeBron James')).toBe('lebron james');
  });

  it('strips trailing/leading whitespace', () => {
    expect(normalizePlayerName('  LeBron James  ')).toBe('lebron james');
  });

  it('removes periods and apostrophes', () => {
    expect(normalizePlayerName("D'Angelo Russell")).toBe('dangelo russell');
    expect(normalizePlayerName('LeBron James Jr.')).toBe('lebron james jr');
  });

  it('removes commas and backticks', () => {
    expect(normalizePlayerName('Smith, John')).toBe('smith john');
    expect(normalizePlayerName('Dev`on Booker')).toBe('devon booker');
  });

  it('collapses multiple spaces into one', () => {
    expect(normalizePlayerName('LeBron   James')).toBe('lebron james');
  });

  it('handles unicode names', () => {
    expect(normalizePlayerName('Giannis Antetokounmpo')).toBe('giannis antetokounmpo');
  });

  it('treats variant inputs as identical', () => {
    expect(normalizePlayerName('LeBron James Jr.')).toBe(normalizePlayerName('lebron james jr'));
  });

  // Regression: two models emitting the same player with and without a
  // diacritic must produce the same key so consensus merging works.
  it('strips diacritics so "Jokić" and "Jokic" merge', () => {
    expect(normalizePlayerName('Nikola Jokić')).toBe('nikola jokic');
    expect(normalizePlayerName('Nikola Jokić')).toBe(normalizePlayerName('Nikola Jokic'));
  });

  it('strips diacritics on multiple accented characters', () => {
    expect(normalizePlayerName('Luka Dončić')).toBe('luka doncic');
    expect(normalizePlayerName('Luka Dončić')).toBe(normalizePlayerName('Luka Doncic'));
  });

  // Intentional contrast with the pickResolver normalizer: suffixes are
  // preserved here so Jr and Sr don't collide across models.
  it('preserves Jr/Sr so generations do not collide', () => {
    expect(normalizePlayerName('Jaren Jackson Jr')).toBe('jaren jackson jr');
    expect(normalizePlayerName('Jaren Jackson Jr')).not.toBe(normalizePlayerName('Jaren Jackson Sr'));
  });
});

// ============================================================================
// matchKey
// ============================================================================

describe('matchKey', () => {
  it('produces same key for identical inputs', () => {
    expect(matchKey('LeBron James', 'points', 24.5)).toBe(
      matchKey('LeBron James', 'points', 24.5),
    );
  });

  it('produces same key across name variants', () => {
    expect(matchKey('LeBron James', 'points', 24.5)).toBe(
      matchKey('  LeBron James  ', 'points', 24.5),
    );
  });

  it('produces different key for different lines', () => {
    expect(matchKey('LeBron James', 'points', 24.5)).not.toBe(
      matchKey('LeBron James', 'points', 25.5),
    );
  });

  it('produces different key for different stats', () => {
    expect(matchKey('LeBron James', 'points', 24.5)).not.toBe(
      matchKey('LeBron James', 'rebounds', 24.5),
    );
  });

  it('normalizes line to one decimal place', () => {
    expect(matchKey('LeBron James', 'points', 24.5)).toBe('lebron james|points|24.5');
    expect(matchKey('LeBron James', 'points', 24.50)).toBe('lebron james|points|24.5');
  });

  it('lowercases stat type', () => {
    expect(matchKey('LeBron James', 'POINTS', 24.5)).toBe(
      matchKey('LeBron James', 'points', 24.5),
    );
  });

  it('uses pipe as separator', () => {
    expect(matchKey('LeBron James', 'points', 24.5)).toBe('lebron james|points|24.5');
  });
});

// ============================================================================
// computeConsensus
// ============================================================================

describe('computeConsensus', () => {
  it('returns single_source for empty votes', () => {
    expect(computeConsensus([])).toBe('single_source');
  });

  it('returns single_source for one vote only', () => {
    expect(computeConsensus([makeVote('gemini', { confidenceTier: 'A' })])).toBe('single_source');
  });

  it('returns agree_strong when all models recommend (A/B) same direction', () => {
    const votes = [
      makeVote('gemini', { confidenceTier: 'A', direction: 'over' }),
      makeVote('openrouter', { confidenceTier: 'B', direction: 'over' }),
    ];
    expect(computeConsensus(votes)).toBe('agree_strong');
  });

  it('returns agree_weak when one is C tier but direction matches', () => {
    const votes = [
      makeVote('gemini', { confidenceTier: 'A', direction: 'over' }),
      makeVote('openrouter', { confidenceTier: 'C', direction: 'over' }),
    ];
    expect(computeConsensus(votes)).toBe('agree_weak');
  });

  it('returns disagree_dir when models recommend opposite directions', () => {
    const votes = [
      makeVote('gemini', { confidenceTier: 'A', direction: 'over' }),
      makeVote('openrouter', { confidenceTier: 'B', direction: 'under' }),
    ];
    expect(computeConsensus(votes)).toBe('disagree_dir');
  });

  it('returns mixed when one recommends and another rejects', () => {
    const votes = [
      makeVote('gemini', { confidenceTier: 'A', direction: 'over' }),
      makeVote('openrouter', { confidenceTier: 'REJECT', direction: 'over' }),
    ];
    expect(computeConsensus(votes)).toBe('mixed');
  });

  it('returns all_reject when every vote is REJECT', () => {
    const votes = [
      makeVote('gemini', { confidenceTier: 'REJECT' }),
      makeVote('openrouter', { confidenceTier: 'REJECT' }),
    ];
    expect(computeConsensus(votes)).toBe('all_reject');
  });

  it('returns mixed for weak + reject (no recommendations)', () => {
    const votes = [
      makeVote('gemini', { confidenceTier: 'C', direction: 'over' }),
      makeVote('openrouter', { confidenceTier: 'REJECT' }),
    ];
    expect(computeConsensus(votes)).toBe('mixed');
  });

  it('handles three-model agreement', () => {
    const votes = [
      makeVote('gemini', { confidenceTier: 'A', direction: 'over' }),
      makeVote('openrouter', { confidenceTier: 'B', direction: 'over' }),
      makeVote('claude', { confidenceTier: 'A', direction: 'over' }),
    ];
    expect(computeConsensus(votes)).toBe('agree_strong');
  });

  it('handles three-model disagreement (one reject + two recommend)', () => {
    const votes = [
      makeVote('gemini', { confidenceTier: 'A', direction: 'over' }),
      makeVote('openrouter', { confidenceTier: 'B', direction: 'over' }),
      makeVote('claude', { confidenceTier: 'REJECT', direction: 'over' }),
    ];
    expect(computeConsensus(votes)).toBe('mixed');
  });
});

// ============================================================================
// mergePicks
// ============================================================================

describe('mergePicks', () => {
  it('returns empty merged when no responses succeeded', () => {
    const ensemble: EnsembleResult = {
      responses: [
        { status: 'error', provider: 'gemini', model: 'g', error: 'fail' },
      ],
      durationMs: 50,
    };

    const result = mergePicks(ensemble);
    expect(result.merged).toEqual([]);
    expect(result.summary.totalPicks).toBe(0);
  });

  it('merges identical picks from two providers', () => {
    const pick = makePick({ confidenceTier: 'A', direction: 'over' });
    const ensemble: EnsembleResult = {
      responses: [
        { status: 'success', provider: 'gemini', model: 'g', response: makeResponse([pick]) },
        { status: 'success', provider: 'openrouter', model: 'o', response: makeResponse([pick]) },
      ],
      durationMs: 100,
    };

    const result = mergePicks(ensemble);
    expect(result.merged).toHaveLength(1);
    expect(result.merged[0].votes).toHaveLength(2);
    expect(result.merged[0].consensus).toBe('agree_strong');
  });

  it('keeps two picks separate when player differs', () => {
    const ensemble: EnsembleResult = {
      responses: [
        {
          status: 'success',
          provider: 'gemini',
          model: 'g',
          response: makeResponse([makePick({ playerName: 'LeBron James' })]),
        },
        {
          status: 'success',
          provider: 'openrouter',
          model: 'o',
          response: makeResponse([makePick({ playerName: 'Stephen Curry' })]),
        },
      ],
      durationMs: 100,
    };

    const result = mergePicks(ensemble);
    expect(result.merged).toHaveLength(2);
    expect(result.merged.every((m) => m.votes.length === 1)).toBe(true);
    expect(result.merged.every((m) => m.consensus === 'single_source')).toBe(true);
  });

  it('keeps two picks separate when stat differs', () => {
    const ensemble: EnsembleResult = {
      responses: [
        {
          status: 'success',
          provider: 'gemini',
          model: 'g',
          response: makeResponse([makePick({ statType: 'points' })]),
        },
        {
          status: 'success',
          provider: 'openrouter',
          model: 'o',
          response: makeResponse([makePick({ statType: 'rebounds' })]),
        },
      ],
      durationMs: 100,
    };

    const result = mergePicks(ensemble);
    expect(result.merged).toHaveLength(2);
  });

  it('keeps two picks separate when line differs', () => {
    const ensemble: EnsembleResult = {
      responses: [
        {
          status: 'success',
          provider: 'gemini',
          model: 'g',
          response: makeResponse([makePick({ line: 24.5 })]),
        },
        {
          status: 'success',
          provider: 'openrouter',
          model: 'o',
          response: makeResponse([makePick({ line: 25.5 })]),
        },
      ],
      durationMs: 100,
    };

    const result = mergePicks(ensemble);
    expect(result.merged).toHaveLength(2);
  });

  it('matches picks across name variants', () => {
    const ensemble: EnsembleResult = {
      responses: [
        {
          status: 'success',
          provider: 'gemini',
          model: 'g',
          response: makeResponse([makePick({ playerName: 'LeBron James' })]),
        },
        {
          status: 'success',
          provider: 'openrouter',
          model: 'o',
          response: makeResponse([makePick({ playerName: '  lebron james  ' })]),
        },
      ],
      durationMs: 100,
    };

    const result = mergePicks(ensemble);
    expect(result.merged).toHaveLength(1);
    expect(result.merged[0].votes).toHaveLength(2);
  });

  it('detects disagreement when directions differ', () => {
    const ensemble: EnsembleResult = {
      responses: [
        {
          status: 'success',
          provider: 'gemini',
          model: 'g',
          response: makeResponse([makePick({ direction: 'over', confidenceTier: 'A' })]),
        },
        {
          status: 'success',
          provider: 'openrouter',
          model: 'o',
          response: makeResponse([makePick({ direction: 'under', confidenceTier: 'B' })]),
        },
      ],
      durationMs: 100,
    };

    const result = mergePicks(ensemble);
    expect(result.merged).toHaveLength(1);
    expect(result.merged[0].consensus).toBe('disagree_dir');
    expect(result.merged[0].directionCounts.over).toBe(1);
    expect(result.merged[0].directionCounts.under).toBe(1);
  });

  it('counts tiers per merged pick', () => {
    const ensemble: EnsembleResult = {
      responses: [
        {
          status: 'success',
          provider: 'gemini',
          model: 'g',
          response: makeResponse([makePick({ confidenceTier: 'A' })]),
        },
        {
          status: 'success',
          provider: 'openrouter',
          model: 'o',
          response: makeResponse([makePick({ confidenceTier: 'C' })]),
        },
      ],
      durationMs: 100,
    };

    const result = mergePicks(ensemble);
    expect(result.merged[0].tierCounts.recommend).toBe(1);
    expect(result.merged[0].tierCounts.weak).toBe(1);
    expect(result.merged[0].tierCounts.reject).toBe(0);
  });

  it('builds an accurate summary', () => {
    const ensemble: EnsembleResult = {
      responses: [
        {
          status: 'success',
          provider: 'gemini',
          model: 'g',
          response: makeResponse([
            makePick({ playerName: 'A', confidenceTier: 'A', direction: 'over' }),
            makePick({ playerName: 'B', confidenceTier: 'C', direction: 'over' }),
            makePick({ playerName: 'C', confidenceTier: 'REJECT' }),
            makePick({ playerName: 'SoloPick' }),
          ]),
        },
        {
          status: 'success',
          provider: 'openrouter',
          model: 'o',
          response: makeResponse([
            makePick({ playerName: 'A', confidenceTier: 'B', direction: 'over' }),
            makePick({ playerName: 'B', confidenceTier: 'A', direction: 'over' }),
            makePick({ playerName: 'C', confidenceTier: 'REJECT' }),
          ]),
        },
      ],
      durationMs: 100,
    };

    const result = mergePicks(ensemble);
    // 4 unique picks: A (agree_strong), B (agree_weak — one A one C), C (all_reject), SoloPick (single_source)
    expect(result.summary.totalPicks).toBe(4);
    expect(result.summary.agreeStrong).toBe(1);
    expect(result.summary.agreeWeak).toBe(1);
    expect(result.summary.allReject).toBe(1);
    expect(result.summary.singleSource).toBe(1);
  });

  it('sorts picks: agree_strong first, then by vote count, then by name', () => {
    const ensemble: EnsembleResult = {
      responses: [
        {
          status: 'success',
          provider: 'gemini',
          model: 'g',
          response: makeResponse([
            makePick({ playerName: 'Zach', confidenceTier: 'REJECT' }),
            makePick({ playerName: 'Anthony', confidenceTier: 'A', direction: 'over' }),
            makePick({ playerName: 'Bob', confidenceTier: 'A', direction: 'over' }),
          ]),
        },
        {
          status: 'success',
          provider: 'openrouter',
          model: 'o',
          response: makeResponse([
            makePick({ playerName: 'Zach', confidenceTier: 'REJECT' }),
            makePick({ playerName: 'Anthony', confidenceTier: 'A', direction: 'over' }),
            makePick({ playerName: 'Bob', confidenceTier: 'A', direction: 'over' }),
          ]),
        },
      ],
      durationMs: 100,
    };

    const result = mergePicks(ensemble);
    // First: agree_strong picks alphabetical (Anthony, Bob)
    expect(result.merged[0].playerName).toBe('Anthony');
    expect(result.merged[1].playerName).toBe('Bob');
    // Last: all_reject (Zach)
    expect(result.merged[result.merged.length - 1].playerName).toBe('Zach');
  });

  it('skips error responses entirely', () => {
    const ensemble: EnsembleResult = {
      responses: [
        {
          status: 'success',
          provider: 'gemini',
          model: 'g',
          response: makeResponse([makePick({ confidenceTier: 'A' })]),
        },
        { status: 'error', provider: 'openrouter', model: 'o', error: 'rate limited' },
      ],
      durationMs: 50,
    };

    const result = mergePicks(ensemble);
    expect(result.merged).toHaveLength(1);
    expect(result.merged[0].consensus).toBe('single_source');
    expect(result.merged[0].votes).toHaveLength(1);
  });
});

// ============================================================================
// Badge helpers
// ============================================================================

describe('consensusLabel', () => {
  it('returns human-readable strings for every label', () => {
    expect(consensusLabel('agree_strong')).toBe('Both Agree');
    expect(consensusLabel('agree_weak')).toBe('Weak Agree');
    expect(consensusLabel('disagree_dir')).toBe('Disagree');
    expect(consensusLabel('mixed')).toBe('Mixed');
    expect(consensusLabel('all_reject')).toBe('All Reject');
    expect(consensusLabel('single_source')).toBe('Single Source');
  });
});
