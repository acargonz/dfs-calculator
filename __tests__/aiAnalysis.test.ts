import {
  buildUserMessage,
  computeBackoffMs,
  estimateRetryDelayMs,
  extractJsonFromText,
  formatAmericanOdds,
  getSlateSeasonType,
  healTruncatedJson,
  normalizeAIPick,
  parseAIResponse,
  runAIAnalysis,
  salvagePicksFromMalformed,
  shouldRetryStatus,
  type AIAnalysisRequest,
  type AIPick,
} from '../src/lib/aiAnalysis';
import type { BatchResult } from '../src/lib/batchProcessor';
import type { CalculationResult, SideEvaluation } from '../src/components/types';

/**
 * Build a SideEvaluation. The two-sided refactor moved tier/EV/probabilities
 * onto per-side records. These helpers keep AI-prompt fixtures readable.
 */
function makeSide(overrides: Partial<SideEvaluation> = {}): SideEvaluation {
  return {
    fairProb: 0.5,
    modelProb: 0.5,
    blendedProb: 0.5,
    ev: 0,
    kellyStake: 0,
    kellyFraction: 0.25,
    tier: 'REJECT',
    ...overrides,
  };
}

function makeResult(
  over: Partial<SideEvaluation>,
  under: Partial<SideEvaluation>,
  source = 'NegBinomial',
): CalculationResult {
  return { over: makeSide(over), under: makeSide(under), source };
}

const mockBatchResult: BatchResult = {
  players: [
    {
      playerName: 'LeBron James',
      position: 'SF',
      statType: 'points',
      line: 24.5,
      mean: 25.3,
      overOdds: -115,
      underOdds: -105,
      result: makeResult(
        {
          fairProb: 0.52,
          modelProb: 0.58,
          blendedProb: 0.56,
          ev: 0.06,
          kellyStake: 4.5,
          tier: 'MEDIUM',
        },
        {
          fairProb: 0.48,
          modelProb: 0.42,
          blendedProb: 0.44,
          ev: -0.04,
          kellyStake: 0,
          tier: 'REJECT',
        },
        'NegBinomial',
      ),
      status: 'success',
    },
    {
      playerName: 'Unknown Player',
      position: '',
      statType: 'rebounds',
      line: 8.5,
      mean: 0,
      overOdds: -110,
      underOdds: -110,
      result: null,
      status: 'player_not_found',
      statusMessage: 'Player not found in PBP stats',
    },
  ],
  summary: { high: 0, medium: 1, low: 0, reject: 0, errors: 1 },
};

describe('buildUserMessage', () => {
  const baseReq: AIAnalysisRequest = {
    provider: 'gemini',
    apiKey: 'test',
    systemPrompt: 'system',
    calculatorResults: mockBatchResult,
    bankroll: 200,
    platform: 'prizepicks',
    jurisdiction: 'California',
  };

  it('includes slate metadata', () => {
    const msg = buildUserMessage(baseReq);
    expect(msg).toContain('Bankroll: $200.00');
    expect(msg).toContain('prizepicks');
    expect(msg).toContain('California');
  });

  it('includes calculator summary counts', () => {
    const msg = buildUserMessage(baseReq);
    expect(msg).toContain('0 HIGH, 1 MEDIUM');
  });

  it('includes success rows in the table', () => {
    const msg = buildUserMessage(baseReq);
    expect(msg).toContain('LeBron James');
    expect(msg).toContain('points');
    expect(msg).toContain('24.5');
  });

  it('marks error rows as ERROR in the table', () => {
    const msg = buildUserMessage(baseReq);
    expect(msg).toContain('Unknown Player');
    expect(msg).toContain('ERROR');
  });

  it('includes injury report section when injuries provided', () => {
    const msg = buildUserMessage({
      ...baseReq,
      injuries: [
        {
          playerName: 'Jock Landale',
          team: 'Atlanta Hawks',
          position: 'C',
          status: 'Out',
          comment: 'ankle injury',
          date: '2026-04-06',
        },
      ],
    });
    expect(msg).toContain('Injury Report');
    expect(msg).toContain('Jock Landale');
    expect(msg).toContain('Out');
  });

  it('omits injury section when no injuries', () => {
    const msg = buildUserMessage(baseReq);
    expect(msg).not.toContain('Injury Report');
  });

  it('requests structured JSON response', () => {
    const msg = buildUserMessage(baseReq);
    expect(msg).toContain('"picks"');
    expect(msg).toContain('"slips"');
    expect(msg).toContain('confidenceTier');
  });

  it('explicitly tells the AI that finalEV/finalProbability must be decimals', () => {
    // Guards against AI returning percentage-encoded values that cause the
    // UI to display 1000%+ EVs.
    const msg = buildUserMessage(baseReq);
    expect(msg).toContain('NUMERIC FORMAT');
    expect(msg).toContain('finalProbability');
    expect(msg).toContain('finalEV');
    expect(msg).toContain('DECIMAL');
    expect(msg).toContain('0.07');
  });

  it('defaults jurisdiction to California', () => {
    const { jurisdiction: _j, ...rest } = baseReq;
    void _j;
    const msg = buildUserMessage(rest);
    expect(msg).toContain('California');
  });
});

describe('extractJsonFromText', () => {
  it('returns plain JSON unchanged', () => {
    expect(extractJsonFromText('{"a":1}')).toBe('{"a":1}');
  });

  it('strips markdown code fences', () => {
    const raw = '```json\n{"a":1}\n```';
    expect(extractJsonFromText(raw)).toBe('{"a":1}');
  });

  it('strips plain fences without language tag', () => {
    const raw = '```\n{"a":1}\n```';
    expect(extractJsonFromText(raw)).toBe('{"a":1}');
  });

  it('extracts JSON from prose wrapping', () => {
    const raw = 'Here is the analysis:\n{"a":1,"b":2}\nLet me know if you need more.';
    expect(extractJsonFromText(raw)).toBe('{"a":1,"b":2}');
  });
});

describe('parseAIResponse', () => {
  it('parses a valid response with picks and slips', () => {
    const raw = JSON.stringify({
      picks: [
        {
          playerName: 'LeBron James',
          statType: 'points',
          line: 24.5,
          direction: 'over',
          confidenceTier: 'B',
          reasoning: 'Above average matchup',
          flags: [],
          modifiers: { pace: 0.02 },
          finalProbability: 0.58,
          finalEV: 0.07,
        },
      ],
      slips: [
        {
          platform: 'prizepicks',
          slipType: 'power',
          legsCount: 2,
          stakeAmount: 5,
          expectedPayout: 15,
          pickNames: ['LeBron James — Points Over 24.5'],
          rationale: 'Strong edge',
        },
      ],
      summary: 'One solid pick',
      warnings: [],
    });

    const parsed = parseAIResponse(raw);
    expect(parsed.picks).toHaveLength(1);
    expect(parsed.picks[0].playerName).toBe('LeBron James');
    expect(parsed.picks[0].confidenceTier).toBe('B');
    expect(parsed.slips).toHaveLength(1);
    expect(parsed.summary).toBe('One solid pick');
  });

  it('returns empty arrays for missing fields', () => {
    const raw = JSON.stringify({ summary: 'hello' });
    const parsed = parseAIResponse(raw);
    expect(parsed.picks).toEqual([]);
    expect(parsed.slips).toEqual([]);
    expect(parsed.warnings).toEqual([]);
    expect(parsed.shadowEvaluations).toEqual([]);
    expect(parsed.summary).toBe('hello');
  });

  // Regression guard: shadowEvaluations must survive the schema-validation
  // path. The function previously returned only picks/slips/summary/warnings
  // and silently dropped this field, which broke downstream calibration
  // tracking even though the schema accepted the data. If you add another
  // field to AIAnalysisResponseSchema, add an analogous test here.
  it('propagates shadowEvaluations from a schema-valid response', () => {
    const raw = JSON.stringify({
      picks: [
        {
          playerName: 'LeBron James',
          statType: 'points',
          line: 24.5,
          direction: 'over',
          confidenceTier: 'B',
          reasoning: 'good',
        },
      ],
      summary: 'one pick + one shadow',
      shadowEvaluations: [
        {
          playerName: 'Anthony Davis',
          statType: 'blocks',
          line: 1.5,
          direction: 'under',
          confidenceTier: 'REJECT',
          finalProbability: 0.42,
          finalEV: -0.08,
        },
      ],
    });
    const parsed = parseAIResponse(raw);
    expect(parsed.shadowEvaluations).toHaveLength(1);
    expect(parsed.shadowEvaluations[0].playerName).toBe('Anthony Davis');
    expect(parsed.shadowEvaluations[0].confidenceTier).toBe('REJECT');
  });

  it('handles markdown-wrapped JSON', () => {
    const raw = '```json\n{"picks":[],"slips":[],"summary":"test","warnings":[]}\n```';
    const parsed = parseAIResponse(raw);
    expect(parsed.summary).toBe('test');
  });

  it('throws on invalid JSON', () => {
    expect(() => parseAIResponse('not json at all')).toThrow();
  });

  it('throws on non-object JSON', () => {
    expect(() => parseAIResponse('[1,2,3]')).toThrow('JSON object');
  });

  it('recovers from a response truncated mid-string', () => {
    const raw = '{"picks":[],"slips":[],"summary":"Due to insufficient contextual data for critic';
    const parsed = parseAIResponse(raw);
    expect(parsed.picks).toEqual([]);
    expect(parsed.summary).toContain('Due to insufficient contextual data');
  });

  it('recovers from a response truncated inside an array', () => {
    const raw =
      '{"picks":[{"playerName":"LeBron James","statType":"points","line":24.5,"direction":"over","confidenceTier":"B","reasoning":"short","flags":[]}],"slips":[],"summary":"ok","warnings":["first warning","second warning';
    const parsed = parseAIResponse(raw);
    expect(parsed.picks).toHaveLength(1);
    expect(parsed.picks[0].playerName).toBe('LeBron James');
    expect(parsed.warnings.length).toBeGreaterThanOrEqual(1);
  });

  it('normalizes percentage-encoded finalEV through parseAIResponse', () => {
    // AI returned 7.5 (meaning 7.5%) instead of 0.075. The display layer
    // multiplies by 100, so without normalization the user would see 750%.
    const raw = JSON.stringify({
      picks: [
        {
          playerName: 'LeBron James',
          statType: 'points',
          line: 24.5,
          direction: 'over',
          confidenceTier: 'B',
          reasoning: 'r',
          flags: [],
          finalProbability: 58,
          finalEV: 7.5,
        },
      ],
      slips: [],
      summary: 's',
      warnings: [],
    });
    const parsed = parseAIResponse(raw);
    expect(parsed.picks[0].finalProbability).toBeCloseTo(0.58, 6);
    expect(parsed.picks[0].finalEV).toBeCloseTo(0.075, 6);
  });

  // ---- Mid-response corruption recovery (the GPT-OSS bug) ---------------
  // Simulates the real-world error the user hit:
  //   "Expected ':' after property name in JSON at position 2527
  //    (line 77 column 22). Raw: { \"picks\": [ { \"playerName\": \"Brook Lopez\" ..."
  // Cause: unescaped inner quotes inside a reasoning field ~pick #12.
  // Current healTruncatedJson can't fix mid-response corruption — we need
  // the 4th fallback, salvagePicksFromMalformed, to recover the valid picks
  // that came before the corruption.

  it('recovers valid picks when one pick has mid-response JSON corruption', () => {
    // Pick 1 is clean; pick 2 has an unescaped quote that breaks JSON.parse
    // for the whole response. A well-behaved salvage path should return
    // the valid first pick.
    const raw =
      '{"picks":[' +
      '{"playerName":"Alice","statType":"points","line":20.5,"direction":"over","confidenceTier":"A","reasoning":"clean pick","flags":[],"finalProbability":0.62},' +
      '{"playerName":"Bob","statType":"rebounds","line":8.5,"direction":"over","confidenceTier":"B","reasoning":"he is "due" for rebounds","flags":[],"finalProbability":0.55}' +
      '],"slips":[],"summary":"two picks","warnings":[]}';

    const parsed = parseAIResponse(raw);
    // Alice should be recovered; Bob may or may not depending on whether
    // the walker's forgiving tokenizer accepts the malformed object.
    expect(parsed.picks.length).toBeGreaterThanOrEqual(1);
    const alice = parsed.picks.find((p) => p.playerName === 'Alice');
    expect(alice).toBeDefined();
    expect(alice?.finalProbability).toBeCloseTo(0.62, 6);
  });

  it('recovers multiple valid picks when one middle pick is corrupted', () => {
    // Five picks. Pick #3 has a structural problem (missing colon after
    // property name). Picks 1, 2, 4, 5 should all be salvaged.
    const raw =
      '{"picks":[' +
      '{"playerName":"A","statType":"points","line":20,"direction":"over","confidenceTier":"A","reasoning":"r","flags":[],"finalProbability":0.6},' +
      '{"playerName":"B","statType":"points","line":21,"direction":"over","confidenceTier":"A","reasoning":"r","flags":[],"finalProbability":0.6},' +
      '{"playerName":"C","statType" "points","line":22,"direction":"over","confidenceTier":"A","reasoning":"r","flags":[],"finalProbability":0.6},' +
      '{"playerName":"D","statType":"points","line":23,"direction":"over","confidenceTier":"A","reasoning":"r","flags":[],"finalProbability":0.6},' +
      '{"playerName":"E","statType":"points","line":24,"direction":"over","confidenceTier":"A","reasoning":"r","flags":[],"finalProbability":0.6}' +
      '],"slips":[],"summary":"s","warnings":[]}';

    const parsed = parseAIResponse(raw);
    const names = parsed.picks.map((p) => p.playerName).sort();
    // A, B, D, E must survive; C is the corrupt one
    expect(names).toContain('A');
    expect(names).toContain('B');
    expect(names).toContain('D');
    expect(names).toContain('E');
    expect(names).not.toContain('C');
  });

  it('throws when the entire response is total garbage', () => {
    expect(() => parseAIResponse('<html>500 Internal Server Error</html>')).toThrow();
  });
});

// ============================================================================
// salvagePicksFromMalformed — direct unit tests
// ============================================================================

describe('salvagePicksFromMalformed', () => {
  it('returns null when the text does not contain a picks array', () => {
    expect(salvagePicksFromMalformed('not even json')).toBeNull();
    expect(salvagePicksFromMalformed('{"summary":"no picks field here"}')).toBeNull();
  });

  it('returns empty array when picks field exists but array is empty', () => {
    const raw = '{"picks":[]}';
    expect(salvagePicksFromMalformed(raw)).toEqual([]);
  });

  it('extracts all picks from a clean JSON array', () => {
    const raw =
      '{"picks":[' +
      '{"playerName":"Alice","statType":"points","line":20,"direction":"over","confidenceTier":"A","reasoning":"r","flags":[]},' +
      '{"playerName":"Bob","statType":"assists","line":5,"direction":"under","confidenceTier":"B","reasoning":"r","flags":[]}' +
      ']}';
    const out = salvagePicksFromMalformed(raw);
    expect(out).not.toBeNull();
    expect(out).toHaveLength(2);
    expect(out?.[0].playerName).toBe('Alice');
    expect(out?.[1].playerName).toBe('Bob');
  });

  it('skips picks without a playerName (drops incomplete fragments)', () => {
    const raw =
      '{"picks":[' +
      '{"playerName":"Alice","statType":"points","line":20,"direction":"over","confidenceTier":"A","reasoning":"r","flags":[]},' +
      '{"statType":"assists","line":5,"direction":"under","confidenceTier":"B","reasoning":"r","flags":[]}' +
      ']}';
    const out = salvagePicksFromMalformed(raw);
    expect(out).toHaveLength(1);
    expect(out?.[0].playerName).toBe('Alice');
  });

  it('stops at the closing ] of the picks array', () => {
    // Anything after the picks array (slips, summary, etc.) must NOT be
    // scooped up as a stray pick.
    const raw =
      '{"picks":[' +
      '{"playerName":"Alice","statType":"points","line":20,"direction":"over","confidenceTier":"A","reasoning":"r","flags":[]}' +
      '],"summary":"hello","warnings":[]}';
    const out = salvagePicksFromMalformed(raw);
    expect(out).toHaveLength(1);
    expect(out?.[0].playerName).toBe('Alice');
  });

  it('tolerates whitespace between "picks" and the array opener', () => {
    const raw =
      '{ "picks" : [ {"playerName":"Alice","statType":"points","line":20,"direction":"over","confidenceTier":"A","reasoning":"r","flags":[]} ] }';
    const out = salvagePicksFromMalformed(raw);
    expect(out).toHaveLength(1);
  });
});

describe('normalizeAIPick', () => {
  function makePick(overrides: Partial<AIPick> = {}): AIPick {
    return {
      playerName: 'Test Player',
      statType: 'points',
      line: 20,
      direction: 'over',
      confidenceTier: 'B',
      reasoning: 'baseline',
      flags: [],
      ...overrides,
    };
  }

  it('passes a decimal finalEV through unchanged', () => {
    const out = normalizeAIPick(makePick({ finalEV: 0.07 }));
    expect(out.finalEV).toBeCloseTo(0.07, 6);
  });

  it('passes a decimal finalProbability through unchanged', () => {
    const out = normalizeAIPick(makePick({ finalProbability: 0.58 }));
    expect(out.finalProbability).toBeCloseTo(0.58, 6);
  });

  it('converts a percentage-encoded finalEV to decimal', () => {
    const out = normalizeAIPick(makePick({ finalEV: 7.5 }));
    expect(out.finalEV).toBeCloseTo(0.075, 6);
  });

  it('converts a percentage-encoded finalProbability to decimal', () => {
    const out = normalizeAIPick(makePick({ finalProbability: 58 }));
    expect(out.finalProbability).toBeCloseTo(0.58, 6);
  });

  it('converts a negative percentage-encoded finalEV to decimal', () => {
    const out = normalizeAIPick(makePick({ finalEV: -12.5 }));
    expect(out.finalEV).toBeCloseTo(-0.125, 6);
  });

  it('handles the dangerous 1000% case (finalEV = 10.8)', () => {
    // The exact bug the user reported: AI outputs 10.8 instead of 0.108,
    // UI multiplies by 100 → shows 1080%.
    const out = normalizeAIPick(makePick({ finalEV: 10.8 }));
    expect(out.finalEV).toBeCloseTo(0.108, 6);
  });

  it('leaves finalEV at the boundary (exactly 1.0) untouched', () => {
    // 1.0 EV is theoretically possible at +Infinity payout, treat as decimal.
    const out = normalizeAIPick(makePick({ finalEV: 1.0 }));
    expect(out.finalEV).toBeCloseTo(1.0, 6);
  });

  it('leaves a negative decimal finalEV unchanged', () => {
    const out = normalizeAIPick(makePick({ finalEV: -0.04 }));
    expect(out.finalEV).toBeCloseTo(-0.04, 6);
  });

  it('passes undefined fields through', () => {
    const out = normalizeAIPick(makePick({}));
    expect(out.finalEV).toBeUndefined();
    expect(out.finalProbability).toBeUndefined();
  });

  it('drops NaN fields to undefined so the DB column ends up NULL', () => {
    // NaN in a probability field is always a bug in the AI output; we do not
    // want to propagate NaN through downstream math or into the database.
    const out = normalizeAIPick(makePick({ finalEV: NaN, finalProbability: NaN }));
    expect(out.finalEV).toBeUndefined();
    expect(out.finalProbability).toBeUndefined();
  });

  it('returns a fresh copy (does not mutate input)', () => {
    const input = makePick({ finalEV: 7.5, finalProbability: 58 });
    const out = normalizeAIPick(input);
    expect(input.finalEV).toBe(7.5);
    expect(input.finalProbability).toBe(58);
    expect(out.finalEV).toBeCloseTo(0.075, 6);
    expect(out.finalProbability).toBeCloseTo(0.58, 6);
  });

  // ---- String-input bug (the "AI Prob % = 6000" bug) ---------------------
  // Some models emit stringified numbers for JSON safety. The pre-fix
  // normalizer's `typeof === 'number'` guard skipped these entirely, so a
  // response like `{"finalProbability": "60"}` was coerced to numeric 60 by
  // Supabase on insert and displayed as 6000.0% in the pick history.

  it('parses a stringified decimal finalProbability', () => {
    const out = normalizeAIPick(
      makePick({ finalProbability: '0.58' as unknown as number }),
    );
    expect(out.finalProbability).toBeCloseTo(0.58, 6);
  });

  it('parses a stringified percent-encoded finalProbability', () => {
    const out = normalizeAIPick(
      makePick({ finalProbability: '60' as unknown as number }),
    );
    expect(out.finalProbability).toBeCloseTo(0.6, 6);
  });

  it('parses a stringified finalProbability with a trailing % sign', () => {
    const out = normalizeAIPick(
      makePick({ finalProbability: '58%' as unknown as number }),
    );
    expect(out.finalProbability).toBeCloseTo(0.58, 6);
  });

  it('parses a stringified finalProbability with whitespace and % sign', () => {
    const out = normalizeAIPick(
      makePick({ finalProbability: ' 72.5 % ' as unknown as number }),
    );
    expect(out.finalProbability).toBeCloseTo(0.725, 6);
  });

  it('parses a stringified decimal finalEV', () => {
    const out = normalizeAIPick(makePick({ finalEV: '0.075' as unknown as number }));
    expect(out.finalEV).toBeCloseTo(0.075, 6);
  });

  it('parses a stringified percent-encoded negative finalEV', () => {
    const out = normalizeAIPick(makePick({ finalEV: '-12.5' as unknown as number }));
    expect(out.finalEV).toBeCloseTo(-0.125, 6);
  });

  // ---- Out-of-range garbage values get dropped --------------------------
  // A value like 5800 is garbage — after dividing by 100, it's still 58,
  // way outside [0,1]. Rather than store it, we drop the field so the
  // DB column is NULL (display: "—") instead of 5800%.

  it('drops a finalProbability that stays > 1 even after dividing', () => {
    const out = normalizeAIPick(makePick({ finalProbability: 5800 }));
    expect(out.finalProbability).toBeUndefined();
  });

  it('drops a negative finalProbability', () => {
    const out = normalizeAIPick(makePick({ finalProbability: -0.2 }));
    expect(out.finalProbability).toBeUndefined();
  });

  it('drops a finalEV that stays > 1 even after dividing', () => {
    const out = normalizeAIPick(makePick({ finalEV: 1500 }));
    expect(out.finalEV).toBeUndefined();
  });

  it('drops a finalProbability from an empty string', () => {
    const out = normalizeAIPick(
      makePick({ finalProbability: '' as unknown as number }),
    );
    expect(out.finalProbability).toBeUndefined();
  });

  it('drops a non-numeric string finalProbability', () => {
    const out = normalizeAIPick(
      makePick({ finalProbability: 'high' as unknown as number }),
    );
    expect(out.finalProbability).toBeUndefined();
  });

  it('preserves a legitimate finalProbability of exactly 0', () => {
    const out = normalizeAIPick(makePick({ finalProbability: 0 }));
    expect(out.finalProbability).toBe(0);
  });

  it('preserves a legitimate finalProbability of exactly 1', () => {
    const out = normalizeAIPick(makePick({ finalProbability: 1 }));
    expect(out.finalProbability).toBe(1);
  });
});

// ============================================================================
// formatAmericanOdds
// ============================================================================

describe('formatAmericanOdds', () => {
  it('prefixes positive odds with +', () => {
    expect(formatAmericanOdds(150)).toBe('+150');
  });

  it('preserves negative odds unchanged', () => {
    expect(formatAmericanOdds(-110)).toBe('-110');
  });

  it('returns N/A for zero', () => {
    expect(formatAmericanOdds(0)).toBe('N/A');
  });

  it('returns N/A for null/undefined', () => {
    expect(formatAmericanOdds(null)).toBe('N/A');
    expect(formatAmericanOdds(undefined)).toBe('N/A');
  });

  it('returns N/A for non-finite values', () => {
    expect(formatAmericanOdds(Number.NaN)).toBe('N/A');
    expect(formatAmericanOdds(Number.POSITIVE_INFINITY)).toBe('N/A');
  });
});

// ============================================================================
// Transient-error retry layer (shouldRetryStatus, computeBackoffMs,
// estimateRetryDelayMs)
// ============================================================================

describe('shouldRetryStatus', () => {
  it('does not retry 2xx responses', () => {
    expect(shouldRetryStatus(200)).toBe(false);
    expect(shouldRetryStatus(201)).toBe(false);
    expect(shouldRetryStatus(204)).toBe(false);
  });

  it('does not retry unambiguous client errors', () => {
    expect(shouldRetryStatus(400)).toBe(false);
    expect(shouldRetryStatus(401)).toBe(false);
    expect(shouldRetryStatus(403)).toBe(false);
    expect(shouldRetryStatus(404)).toBe(false);
    expect(shouldRetryStatus(422)).toBe(false);
  });

  it('retries 408 Request Timeout', () => {
    expect(shouldRetryStatus(408)).toBe(true);
  });

  it('retries 429 Too Many Requests (rate limit)', () => {
    expect(shouldRetryStatus(429)).toBe(true);
  });

  it('retries all 5xx server errors', () => {
    expect(shouldRetryStatus(500)).toBe(true);
    expect(shouldRetryStatus(502)).toBe(true);
    expect(shouldRetryStatus(503)).toBe(true); // the Gemini "high demand" case
    expect(shouldRetryStatus(504)).toBe(true);
    expect(shouldRetryStatus(599)).toBe(true);
  });

  it('does not retry 6xx (no such range exists in HTTP)', () => {
    expect(shouldRetryStatus(600)).toBe(false);
  });
});

describe('computeBackoffMs', () => {
  const OPTS = { initialBackoffMs: 1000, maxBackoffMs: 8000 };

  it('uses exponential backoff when no Retry-After header is present', () => {
    expect(computeBackoffMs(0, null, OPTS)).toBe(1000);
    expect(computeBackoffMs(1, null, OPTS)).toBe(2000);
    expect(computeBackoffMs(2, null, OPTS)).toBe(4000);
  });

  it('clamps the exponential backoff at maxBackoffMs', () => {
    expect(computeBackoffMs(3, null, OPTS)).toBe(8000);
    expect(computeBackoffMs(10, null, OPTS)).toBe(8000);
  });

  it('honors a numeric Retry-After header (seconds)', () => {
    expect(computeBackoffMs(0, '5', OPTS)).toBe(5000);
    expect(computeBackoffMs(0, '2.5', OPTS)).toBe(2500);
  });

  it('clamps a large Retry-After header at maxBackoffMs', () => {
    expect(computeBackoffMs(0, '120', OPTS)).toBe(8000);
  });

  it('falls back to exponential backoff on a non-numeric Retry-After', () => {
    // HTTP-date format — we don't parse it, so we should fall through.
    expect(computeBackoffMs(1, 'Wed, 21 Oct 2015 07:28:00 GMT', OPTS)).toBe(2000);
  });

  it('rejects a negative Retry-After and falls back', () => {
    expect(computeBackoffMs(0, '-5', OPTS)).toBe(1000);
  });
});

describe('estimateRetryDelayMs', () => {
  it('returns 30s for the exact Gemini 503 high-demand message', () => {
    const msg =
      'Gemini API error (503): { "error": { "code": 503, "message": "This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later." } }';
    // "high demand" outranks "503" — it's more specific.
    expect(estimateRetryDelayMs(msg)).toBe(45_000);
  });

  it('returns 60s for quota / 429 errors', () => {
    expect(estimateRetryDelayMs('429 Too Many Requests')).toBe(60_000);
    expect(estimateRetryDelayMs('You have exceeded your quota')).toBe(60_000);
  });

  it('returns 30s for generic 503 responses', () => {
    expect(estimateRetryDelayMs('503 Service Unavailable')).toBe(30_000);
  });

  it('returns 20s for 502 / 504 gateway errors', () => {
    expect(estimateRetryDelayMs('502 Bad Gateway')).toBe(20_000);
    expect(estimateRetryDelayMs('504 Gateway Timeout')).toBe(20_000);
  });

  it('returns 30s default for unknown error messages', () => {
    expect(estimateRetryDelayMs('some weird thing happened')).toBe(30_000);
    expect(estimateRetryDelayMs('')).toBe(30_000);
  });

  it('is case insensitive', () => {
    expect(estimateRetryDelayMs('HIGH DEMAND')).toBe(45_000);
    expect(estimateRetryDelayMs('QUOTA EXCEEDED')).toBe(60_000);
  });
});

// ============================================================================
// healTruncatedJson
// ============================================================================

describe('healTruncatedJson', () => {
  it('returns input unchanged when already valid', () => {
    expect(healTruncatedJson('{"a":1,"b":[1,2]}')).toBe('{"a":1,"b":[1,2]}');
  });

  it('closes an unterminated string', () => {
    const healed = healTruncatedJson('{"summary":"Due to insuff');
    expect(() => JSON.parse(healed)).not.toThrow();
  });

  it('closes an unclosed array', () => {
    const healed = healTruncatedJson('{"picks":[1,2,3');
    expect(() => JSON.parse(healed)).not.toThrow();
  });

  it('closes nested unclosed structures in LIFO order', () => {
    const healed = healTruncatedJson('{"picks":[{"a":1},{"b":"hello wor');
    expect(() => JSON.parse(healed)).not.toThrow();
  });

  it('strips trailing comma before closing', () => {
    const healed = healTruncatedJson('{"picks":[1,2,');
    expect(() => JSON.parse(healed)).not.toThrow();
    const parsed = JSON.parse(healed);
    expect(parsed.picks).toEqual([1, 2]);
  });

  it('handles escaped quotes inside strings correctly', () => {
    const healed = healTruncatedJson('{"reasoning":"he said \\"hi');
    expect(() => JSON.parse(healed)).not.toThrow();
  });

  it('drops a trailing backslash that would be a hanging escape', () => {
    const healed = healTruncatedJson('{"reasoning":"test\\');
    expect(() => JSON.parse(healed)).not.toThrow();
  });
});

// ============================================================================
// buildUserMessage odds integration
// ============================================================================

describe('buildUserMessage odds integration', () => {
  const mockWithOdds: BatchResult = {
    players: [
      {
        playerName: 'Stephen Curry',
        position: 'PG',
        statType: 'threes',
        line: 4.5,
        mean: 4.8,
        overOdds: -140,
        underOdds: 110,
        result: makeResult(
          {
            fairProb: 0.58,
            modelProb: 0.64,
            blendedProb: 0.62,
            ev: 0.09,
            kellyStake: 7.5,
            tier: 'HIGH',
          },
          {
            fairProb: 0.42,
            modelProb: 0.36,
            blendedProb: 0.38,
            ev: -0.07,
            kellyStake: 0,
            tier: 'REJECT',
          },
          'NegBinomial',
        ),
        status: 'success',
      },
    ],
    summary: { high: 1, medium: 0, low: 0, reject: 0, errors: 0 },
  };

  const req: AIAnalysisRequest = {
    provider: 'gemini',
    apiKey: 'test',
    systemPrompt: 'system',
    calculatorResults: mockWithOdds,
    bankroll: 200,
  };

  it('includes sharp over and under odds in the table', () => {
    const msg = buildUserMessage(req);
    expect(msg).toContain('-140');
    expect(msg).toContain('+110');
  });

  it('includes fair probabilities from the calculator', () => {
    const msg = buildUserMessage(req);
    // fairOverProb 0.58 → 58.0%
    expect(msg).toContain('58.0%');
    expect(msg).toContain('42.0%');
  });

  it('includes column headers for sharp odds', () => {
    const msg = buildUserMessage(req);
    expect(msg).toContain('O Odds');
    expect(msg).toContain('U Odds');
  });

  it('includes tight output limits in the response format instructions', () => {
    const msg = buildUserMessage(req);
    expect(msg).toContain('<= 250 characters');
    expect(msg).toContain('<= 400 characters');
  });

  it('includes a data availability block', () => {
    const msg = buildUserMessage(req);
    expect(msg).toContain('## Data Availability');
    expect(msg).toContain('AVAILABLE:');
    expect(msg).toContain('UNAVAILABLE');
  });

  it('tells the model not to declare NO-BET DAY for absent data', () => {
    const msg = buildUserMessage(req);
    expect(msg).toContain('NO-BET DAY');
    expect(msg).toContain('do NOT demand');
  });

  it('maps calculator tiers to confidence tiers explicitly', () => {
    const msg = buildUserMessage(req);
    expect(msg).toContain('HIGH');
    expect(msg).toContain('"A"');
    expect(msg).toContain('REJECT');
  });

  it('reports zero injuries when none supplied and frames empty list as complete data', () => {
    const msg = buildUserMessage(req);
    // Must communicate that empty = no injuries reported (not missing data)
    expect(msg).toContain('zero injuries currently reported');
    // Must explicitly frame the list as COMPLETE so weaker models don't
    // rationalize "injury data is incomplete" as a reason to return empty picks.
    expect(msg).toContain('COMPLETE list');
    // Must explicitly tell the model "absence from the list = healthy" so it
    // doesn't read "most players have no status tagged" as missing data.
    expect(msg).toContain('absence from the list IS the "no injury" signal');
  });

  it('reports injury count when supplied and frames the list as authoritative', () => {
    const msg = buildUserMessage({
      ...req,
      injuries: [
        { playerName: 'X', team: 'LAL', position: 'PG', status: 'Out', comment: 'ankle', date: '2026-04-06' },
      ],
    });
    expect(msg).toContain('1 entries');
    expect(msg).toContain('COMPLETE list');
  });

  it('explicitly overrides legacy HALT-on-missing-injury rules from the system prompt', () => {
    // Regression guard for the openai/gpt-oss-120b:free empty-picks bug: the
    // legacy prompt has absolute-language "MUST HALT" / "STOP" rules written
    // for the old manual-paste workflow. The user message must contain an
    // explicit override so weaker models don't latch onto those rules.
    const msg = buildUserMessage(req);
    expect(msg).toContain('OVERRIDES');
    expect(msg).toContain('HALT');
    expect(msg).toMatch(/injury data is incomplete.*NOT acceptable/);
  });

  it('scopes shadowEvaluations to the working set, not the full candidate table', () => {
    // Regression guard: weaker models saw 770-row candidate tables and
    // concluded they had to emit 770 shadow evaluations, blowing the output
    // token budget. The user message must make it unambiguous that shadow
    // evals cover the ≤8-prop working set only.
    const msg = buildUserMessage(req);
    expect(msg).toContain('WORKING SET');
    expect(msg).toContain('NOT the entire candidate table');
  });
});

// =============================================================================
// getSlateSeasonType — promote BatchResult player season types to slate label
// =============================================================================

describe('getSlateSeasonType', () => {
  function build(seasonTypes: Array<'regular' | 'playoffs' | 'finals' | undefined>): BatchResult {
    return {
      players: seasonTypes.map((st, i) => ({
        playerName: `P${i}`,
        position: 'SF',
        statType: 'points',
        line: 20,
        mean: 22,
        overOdds: -110,
        underOdds: -110,
        result: makeResult({ tier: 'MEDIUM', ev: 0.05 }, { tier: 'REJECT', ev: -0.05 }),
        status: 'success' as const,
        seasonType: st,
      })),
      summary: { high: 0, medium: seasonTypes.length, low: 0, reject: 0, errors: 0 },
    };
  }

  it('returns regular when all players are regular', () => {
    expect(getSlateSeasonType(build(['regular', 'regular']))).toBe('regular');
  });

  it('returns regular when no player has a seasonType field', () => {
    expect(getSlateSeasonType(build([undefined, undefined]))).toBe('regular');
  });

  it('returns playoffs when any player is in playoffs', () => {
    expect(getSlateSeasonType(build(['regular', 'playoffs']))).toBe('playoffs');
  });

  it('returns finals when any player is in finals', () => {
    expect(getSlateSeasonType(build(['playoffs', 'finals', 'regular']))).toBe('finals');
  });

  it('returns finals beats playoffs in promotion', () => {
    expect(getSlateSeasonType(build(['playoffs', 'playoffs', 'finals']))).toBe('finals');
  });

  it('returns regular for empty player list', () => {
    expect(getSlateSeasonType({ players: [], summary: { high: 0, medium: 0, low: 0, reject: 0, errors: 0 } })).toBe('regular');
  });
});

// =============================================================================
// buildUserMessage — Season Phase line + Postseason Context Banner
// =============================================================================

describe('buildUserMessage season phase rendering', () => {
  function build(seasonTypes: Array<'regular' | 'playoffs' | 'finals' | undefined>): BatchResult {
    return {
      players: seasonTypes.map((st, i) => ({
        playerName: `P${i}`,
        position: 'SF',
        statType: 'points',
        line: 20,
        mean: 22,
        overOdds: -110,
        underOdds: -110,
        result: makeResult(
          { tier: 'MEDIUM', ev: 0.05, blendedProb: 0.55 },
          { tier: 'REJECT', ev: -0.05, blendedProb: 0.45 },
        ),
        status: 'success' as const,
        seasonType: st,
      })),
      summary: { high: 0, medium: seasonTypes.length, low: 0, reject: 0, errors: 0 },
    };
  }

  function reqFor(batch: BatchResult): AIAnalysisRequest {
    return {
      provider: 'gemini',
      apiKey: 'test',
      systemPrompt: 'system',
      calculatorResults: batch,
      bankroll: 200,
      jurisdiction: 'California',
    };
  }

  it('renders "Season Phase: regular" when no postseason data is present', () => {
    const msg = buildUserMessage(reqFor(build([undefined, 'regular'])));
    expect(msg).toContain('Season Phase: regular');
  });

  it('does NOT render the Postseason Context banner during regular season', () => {
    const msg = buildUserMessage(reqFor(build([undefined, 'regular'])));
    expect(msg).not.toContain('## Postseason Context');
    expect(msg).not.toContain('Postseason Context Protocol');
  });

  it('renders "Season Phase: playoffs" when any player is in playoffs', () => {
    const msg = buildUserMessage(reqFor(build(['regular', 'playoffs'])));
    expect(msg).toContain('Season Phase: playoffs');
  });

  it('renders the Postseason Context banner during the playoffs', () => {
    const msg = buildUserMessage(reqFor(build(['regular', 'playoffs'])));
    expect(msg).toContain('## Postseason Context');
    expect(msg).toContain('Postseason Context Protocol');
    expect(msg).toContain('Playoffs subsection');
    expect(msg).toContain('rounds 1');
  });

  it('renders "Season Phase: finals" when any player is in the Finals', () => {
    const msg = buildUserMessage(reqFor(build(['playoffs', 'finals'])));
    expect(msg).toContain('Season Phase: finals');
  });

  it('renders the Finals-specific banner copy when any player is in the Finals', () => {
    const msg = buildUserMessage(reqFor(build(['playoffs', 'finals'])));
    expect(msg).toContain('## Postseason Context');
    expect(msg).toContain('Finals subsection');
    expect(msg).toContain('FINALS');
  });

  it('warns the model that the 0.75x Kelly multiplier is already applied', () => {
    const msg = buildUserMessage(reqFor(build(['playoffs'])));
    expect(msg).toContain('0.75');
    // The model should not be told to "add" further variance discounts.
    expect(msg).toMatch(/already applied|already in the stake/i);
  });
});

describe('callOpenRouter HTTP request shape (regression)', () => {
  // See callOpenRouter in src/lib/aiAnalysis.ts for why response_format
  // must not be set on OpenRouter requests.
  it('does NOT set response_format on the OpenRouter request body', async () => {
    let capturedBody: Record<string, unknown> | null = null;
    const originalFetch = global.fetch;
    global.fetch = jest.fn(async (_url: unknown, init: RequestInit) => {
      capturedBody = JSON.parse(init.body as string);
      return new Response(
        JSON.stringify({
          choices: [
            { message: { content: '{"picks":[],"slips":[],"summary":"x","warnings":[]}' } },
          ],
          usage: { total_tokens: 100 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as unknown as typeof global.fetch;

    try {
      await runAIAnalysis({
        provider: 'openrouter',
        apiKey: 'test-key',
        model: 'openai/gpt-oss-120b:free',
        systemPrompt: 'sys',
        calculatorResults: mockBatchResult,
        bankroll: 200,
        platform: 'prizepicks',
        jurisdiction: 'California',
      });
    } finally {
      global.fetch = originalFetch;
    }

    // Guard against the mock never running — `null.toHaveProperty(...)` would
    // also pass and produce a false green.
    expect(capturedBody).not.toBeNull();
    expect(capturedBody).not.toHaveProperty('response_format');
  });
});
