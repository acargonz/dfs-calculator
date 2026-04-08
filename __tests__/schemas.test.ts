/**
 * schemas.test.ts — unit tests for src/lib/schemas.ts
 *
 * The Zod schemas are the outermost validation layer on every API route.
 * Regressions here would re-open injection / DoW vectors (OWASP API4,
 * OWASP LLM10). Tests cover the provider key format regexes, the
 * AnalyzeRequestBody strict shape, the OddsQuery event-ID allowlist (the
 * SSRF guard for /api/odds), and the LLM response schema that guards
 * /api/analyze output before we show it to the user or persist it.
 */

import {
  AnthropicKey,
  GeminiKey,
  OpenRouterKey,
  validateProviderKey,
  IsoDate,
  PlayerName,
  StatType,
  AnalyzeRequestBody,
  OddsQuery,
  PicksQuery,
  AcknowledgeQuery,
  AIPickSchema,
  AIAnalysisResponseSchema,
} from '../src/lib/schemas';

// ---------------------------------------------------------------------------
// Provider key regex tests
// ---------------------------------------------------------------------------

describe('AnthropicKey', () => {
  it('accepts a valid Anthropic key format', () => {
    const res = AnthropicKey.safeParse(
      'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH',
    );
    expect(res.success).toBe(true);
  });

  it('rejects a missing prefix', () => {
    expect(
      AnthropicKey.safeParse('abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH').success,
    ).toBe(false);
  });

  it('rejects a too-short key', () => {
    expect(AnthropicKey.safeParse('sk-ant-api03-short').success).toBe(false);
  });

  it('rejects an OpenAI key by mistake', () => {
    expect(AnthropicKey.safeParse('sk-proj-abc123').success).toBe(false);
  });

  it('rejects an empty string', () => {
    expect(AnthropicKey.safeParse('').success).toBe(false);
  });
});

describe('GeminiKey', () => {
  it('accepts a valid Gemini key', () => {
    const res = GeminiKey.safeParse('AIzaSyDxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx');
    expect(res.success).toBe(true);
  });

  it('rejects a missing AIza prefix', () => {
    expect(GeminiKey.safeParse('SyDxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx').success).toBe(
      false,
    );
  });

  it('rejects a too-short key', () => {
    expect(GeminiKey.safeParse('AIzaShort').success).toBe(false);
  });
});

describe('OpenRouterKey', () => {
  it('accepts a valid OpenRouter key', () => {
    const res = OpenRouterKey.safeParse(
      'sk-or-v1-abcdefghijklmnopqrstuvwxyz0123456789',
    );
    expect(res.success).toBe(true);
  });

  it('rejects a missing prefix', () => {
    expect(OpenRouterKey.safeParse('v1-abcdefghijklmnop').success).toBe(false);
  });
});

describe('validateProviderKey', () => {
  it('routes gemini provider to GeminiKey', () => {
    expect(
      validateProviderKey('gemini', 'AIzaSyDxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx').ok,
    ).toBe(true);
    expect(validateProviderKey('gemini', 'sk-ant-api03-xxxxx').ok).toBe(false);
  });

  it('routes claude provider to AnthropicKey', () => {
    expect(
      validateProviderKey(
        'claude',
        'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH',
      ).ok,
    ).toBe(true);
    expect(validateProviderKey('claude', 'AIzaShort').ok).toBe(false);
  });

  it('routes openrouter provider to OpenRouterKey', () => {
    expect(
      validateProviderKey(
        'openrouter',
        'sk-or-v1-abcdefghijklmnopqrstuvwxyz0123456789',
      ).ok,
    ).toBe(true);
  });

  it('returns a reason string on failure', () => {
    const res = validateProviderKey('claude', 'garbage');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(typeof res.reason).toBe('string');
      expect(res.reason.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Generic reusable field validators
// ---------------------------------------------------------------------------

describe('IsoDate', () => {
  it('accepts YYYY-MM-DD', () => {
    expect(IsoDate.safeParse('2026-04-07').success).toBe(true);
  });

  it('rejects datetime strings', () => {
    expect(IsoDate.safeParse('2026-04-07T12:00:00Z').success).toBe(false);
  });

  it('rejects slashes', () => {
    expect(IsoDate.safeParse('2026/04/07').success).toBe(false);
  });
});

describe('PlayerName', () => {
  it('accepts names with diacritics and apostrophes', () => {
    expect(PlayerName.safeParse('Nikola Jokić').success).toBe(true);
    expect(PlayerName.safeParse("D'Angelo Russell").success).toBe(true);
    expect(PlayerName.safeParse('Karl-Anthony Towns').success).toBe(true);
  });

  it('rejects angle brackets', () => {
    expect(PlayerName.safeParse('<script>').success).toBe(false);
  });

  it('rejects backticks', () => {
    expect(PlayerName.safeParse('LeBron`James').success).toBe(false);
  });

  it('rejects empty string', () => {
    expect(PlayerName.safeParse('').success).toBe(false);
  });

  it('rejects names longer than 64 chars', () => {
    expect(PlayerName.safeParse('A'.repeat(65)).success).toBe(false);
  });
});

describe('StatType', () => {
  it('accepts known stat types', () => {
    for (const stat of [
      'points',
      'rebounds',
      'assists',
      'threes',
      'steals',
      'blocks',
      'pra',
      'pr',
      'pa',
      'ra',
      'fantasy',
    ] as const) {
      expect(StatType.safeParse(stat).success).toBe(true);
    }
  });

  it('rejects unknown stat types', () => {
    expect(StatType.safeParse('turnovers').success).toBe(false);
    expect(StatType.safeParse('POINTS').success).toBe(false); // case-sensitive
  });
});

// ---------------------------------------------------------------------------
// AnalyzeRequestBody — the big one
// ---------------------------------------------------------------------------

describe('AnalyzeRequestBody', () => {
  const minimalValidBody = {
    providers: [{ provider: 'gemini' as const, model: 'gemini-2.5-pro' }],
    calculatorResults: { players: [] },
    bankroll: 100,
  };

  it('accepts a minimal valid ensemble body', () => {
    const res = AnalyzeRequestBody.safeParse(minimalValidBody);
    expect(res.success).toBe(true);
  });

  it('accepts a legacy single-provider body', () => {
    const res = AnalyzeRequestBody.safeParse({
      provider: 'claude',
      model: 'claude-sonnet-4-5',
      calculatorResults: { players: [] },
      bankroll: 100,
    });
    expect(res.success).toBe(true);
  });

  it('rejects unknown top-level fields (strict)', () => {
    const res = AnalyzeRequestBody.safeParse({
      ...minimalValidBody,
      unknownField: 'should not be allowed',
    });
    expect(res.success).toBe(false);
  });

  it('rejects > 200 players in a single batch', () => {
    const tooMany = Array.from({ length: 201 }, () => ({}));
    const res = AnalyzeRequestBody.safeParse({
      ...minimalValidBody,
      calculatorResults: { players: tooMany },
    });
    expect(res.success).toBe(false);
  });

  it('rejects a bankroll <= 0', () => {
    const res = AnalyzeRequestBody.safeParse({ ...minimalValidBody, bankroll: 0 });
    expect(res.success).toBe(false);
  });

  it('rejects a bankroll > 1M', () => {
    const res = AnalyzeRequestBody.safeParse({
      ...minimalValidBody,
      bankroll: 2_000_000,
    });
    expect(res.success).toBe(false);
  });

  it('rejects a non-finite bankroll (NaN/Infinity)', () => {
    const resNaN = AnalyzeRequestBody.safeParse({
      ...minimalValidBody,
      bankroll: Number.NaN,
    });
    expect(resNaN.success).toBe(false);

    const resInf = AnalyzeRequestBody.safeParse({
      ...minimalValidBody,
      bankroll: Number.POSITIVE_INFINITY,
    });
    expect(resInf.success).toBe(false);
  });

  it('rejects > 5 providers in the ensemble', () => {
    const sixProviders = Array.from({ length: 6 }, () => ({
      provider: 'gemini' as const,
      model: 'gemini-2.5-pro',
    }));
    const res = AnalyzeRequestBody.safeParse({
      ...minimalValidBody,
      providers: sixProviders,
    });
    expect(res.success).toBe(false);
  });

  it('rejects lineupContext longer than 10k chars', () => {
    const res = AnalyzeRequestBody.safeParse({
      ...minimalValidBody,
      lineupContext: 'x'.repeat(10_001),
    });
    expect(res.success).toBe(false);
  });

  it('rejects invalid platform values', () => {
    const res = AnalyzeRequestBody.safeParse({
      ...minimalValidBody,
      platform: 'draftkings', // not in the enum
    });
    expect(res.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// OddsQuery — the SSRF guard
// ---------------------------------------------------------------------------

describe('OddsQuery', () => {
  it('accepts games type without eventId', () => {
    expect(OddsQuery.safeParse({ type: 'games' }).success).toBe(true);
  });

  it('accepts props type with a valid hex eventId', () => {
    expect(
      OddsQuery.safeParse({
        type: 'props',
        eventId: 'a1b2c3d4e5f6a7b8',
      }).success,
    ).toBe(true);
  });

  it('rejects props type without eventId', () => {
    expect(OddsQuery.safeParse({ type: 'props' }).success).toBe(false);
  });

  it('rejects path-traversal attempts in eventId', () => {
    expect(
      OddsQuery.safeParse({
        type: 'props',
        eventId: '../../../etc/passwd',
      }).success,
    ).toBe(false);
  });

  it('rejects URL components in eventId (SSRF attempt)', () => {
    expect(
      OddsQuery.safeParse({
        type: 'props',
        eventId: 'evil.com/path?a=b',
      }).success,
    ).toBe(false);
  });

  it('rejects uppercase hex (the upstream emits lowercase)', () => {
    expect(
      OddsQuery.safeParse({
        type: 'props',
        eventId: 'A1B2C3D4E5F6A7B8',
      }).success,
    ).toBe(false);
  });

  it('rejects an empty eventId', () => {
    expect(
      OddsQuery.safeParse({
        type: 'props',
        eventId: '',
      }).success,
    ).toBe(false);
  });

  it('rejects an eventId shorter than 16 chars', () => {
    expect(
      OddsQuery.safeParse({
        type: 'props',
        eventId: 'a1b2c3',
      }).success,
    ).toBe(false);
  });

  it('rejects invalid type values', () => {
    expect(OddsQuery.safeParse({ type: 'unknown' }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PicksQuery + AcknowledgeQuery
// ---------------------------------------------------------------------------

describe('PicksQuery', () => {
  it('accepts an empty query', () => {
    expect(PicksQuery.safeParse({}).success).toBe(true);
  });

  it('accepts a fully-populated valid query', () => {
    expect(
      PicksQuery.safeParse({
        from: '2026-04-01',
        to: '2026-04-07',
        tier: 'HIGH',
        resolvedOnly: 'true',
        limit: '100',
        bankroll: '250',
      }).success,
    ).toBe(true);
  });

  it('rejects an unknown tier value', () => {
    expect(PicksQuery.safeParse({ tier: 'INSANE' }).success).toBe(false);
  });

  it('rejects a non-numeric limit', () => {
    expect(PicksQuery.safeParse({ limit: '100; drop table' }).success).toBe(false);
  });
});

describe('AcknowledgeQuery', () => {
  it('accepts a valid uuid', () => {
    expect(
      AcknowledgeQuery.safeParse({
        id: '123e4567-e89b-12d3-a456-426614174000',
      }).success,
    ).toBe(true);
  });

  it('rejects a non-uuid id', () => {
    expect(AcknowledgeQuery.safeParse({ id: 'not-a-uuid' }).success).toBe(false);
  });

  it('rejects unknown fields (strict)', () => {
    expect(
      AcknowledgeQuery.safeParse({
        id: '123e4567-e89b-12d3-a456-426614174000',
        extra: 'field',
      }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// LLM response schemas — protect downstream consumers
// ---------------------------------------------------------------------------

describe('AIPickSchema', () => {
  const minimalValidPick = {
    playerName: 'LeBron James',
    statType: 'points',
    line: 24.5,
    direction: 'over' as const,
    confidenceTier: 'A' as const,
    reasoning: 'Strong matchup vs weak perimeter defense',
  };

  it('accepts a minimal valid pick', () => {
    expect(AIPickSchema.safeParse(minimalValidPick).success).toBe(true);
  });

  it('defaults flags to an empty array', () => {
    const res = AIPickSchema.safeParse(minimalValidPick);
    if (res.success) {
      expect(res.data.flags).toEqual([]);
    }
  });

  it('rejects an invalid direction', () => {
    expect(
      AIPickSchema.safeParse({ ...minimalValidPick, direction: 'sideways' }).success,
    ).toBe(false);
  });

  it('rejects an invalid confidenceTier', () => {
    expect(
      AIPickSchema.safeParse({ ...minimalValidPick, confidenceTier: 'S' }).success,
    ).toBe(false);
  });

  it('rejects a finalProbability outside [0, 1]', () => {
    expect(
      AIPickSchema.safeParse({ ...minimalValidPick, finalProbability: 58 }).success,
    ).toBe(false);
  });

  it('rejects a finalEV outside [-1, 1]', () => {
    expect(
      AIPickSchema.safeParse({ ...minimalValidPick, finalEV: 12 }).success,
    ).toBe(false);
  });

  it('rejects reasoning longer than 2000 chars', () => {
    expect(
      AIPickSchema.safeParse({
        ...minimalValidPick,
        reasoning: 'x'.repeat(2001),
      }).success,
    ).toBe(false);
  });
});

describe('AIAnalysisResponseSchema', () => {
  it('accepts a valid response with defaults', () => {
    const res = AIAnalysisResponseSchema.safeParse({
      picks: [
        {
          playerName: 'LeBron James',
          statType: 'points',
          line: 24.5,
          direction: 'over',
          confidenceTier: 'A',
          reasoning: 'good',
        },
      ],
    });
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.slips).toEqual([]);
      expect(res.data.warnings).toEqual([]);
      expect(res.data.summary).toBe('');
    }
  });

  it('rejects > 200 picks', () => {
    const picks = Array.from({ length: 201 }, () => ({
      playerName: 'A',
      statType: 'points',
      line: 1,
      direction: 'over' as const,
      confidenceTier: 'A' as const,
      reasoning: '',
    }));
    expect(AIAnalysisResponseSchema.safeParse({ picks }).success).toBe(false);
  });
});
