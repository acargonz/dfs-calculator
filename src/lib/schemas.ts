// Shared Zod runtime validators for every API route body / query param.
//
// Runtime validation is non-negotiable for a public, unauthenticated API
// (OWASP API4:2023 — Unrestricted Resource Consumption, OWASP API8:2023 —
// Security Misconfiguration, OWASP Top 10 2021 A03 — Injection). The
// TypeScript compiler only checks source — a malicious caller can send
// any JSON body and the route handler will happily cast it.
//
// All schemas here are SERVER-SIDE only. The return type of .safeParse()
// is the discriminated union { success: true, data } | { success: false,
// error } — routes should always use safeParse (not .parse()) so a bad
// payload yields 400, not 500.

import 'server-only';

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Provider API-key format validators (BYO-key flow).
// These are *format* checks, not authenticity checks — the only way to know
// a key is valid is to try it with the provider. These block obviously
// broken input (empty string, wrong format) from ever reaching the upstream
// call, which has two benefits:
//   1. Burns no provider quota on guaranteed-failing calls.
//   2. Prevents an attacker from smuggling weird characters into our fetch()
//      URL / header construction.
// ---------------------------------------------------------------------------

/** Anthropic keys look like `sk-ant-api03-<40+ base64url chars>`. */
export const AnthropicKey = z
  .string()
  .regex(/^sk-ant-api\d{2}-[A-Za-z0-9_-]{40,}$/, 'invalid Anthropic API key format');

/** Google Gemini keys start with `AIza` followed by 30+ base64url chars. */
export const GeminiKey = z
  .string()
  .regex(/^AIza[A-Za-z0-9_-]{30,}$/, 'invalid Google API key format');

/** OpenRouter keys look like `sk-or-v1-<64 hex>` historically. */
export const OpenRouterKey = z
  .string()
  .regex(/^sk-or-[A-Za-z0-9_-]{20,}$/, 'invalid OpenRouter API key format');

/** Discriminated union — pick the right validator for the provider. */
export function validateProviderKey(
  provider: 'gemini' | 'claude' | 'openrouter',
  key: string,
): { ok: true } | { ok: false; reason: string } {
  const schema =
    provider === 'gemini'
      ? GeminiKey
      : provider === 'claude'
        ? AnthropicKey
        : OpenRouterKey;
  const res = schema.safeParse(key);
  if (res.success) return { ok: true };
  return { ok: false, reason: res.error.issues[0]?.message ?? 'invalid key format' };
}

// ---------------------------------------------------------------------------
// Generic reusable field validators
// ---------------------------------------------------------------------------

/** ISO date in YYYY-MM-DD format (no time component). */
export const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

/** UUID v4 / v5 / v6 / v7 — any flavor Supabase might generate. */
export const Uuid = z.string().uuid('expected uuid');

/** American odds must be a finite integer in a realistic sportsbook range. */
export const AmericanOdds = z
  .number()
  .int()
  .min(-10000)
  .max(10000)
  .finite();

/** Prop line (e.g. 25.5 points). Finite number, reasonable NBA range. */
export const PropLine = z.number().finite().min(0).max(200);

/** Player name — must be safe to print inline in an LLM prompt. */
export const PlayerName = z
  .string()
  .min(1)
  .max(64)
  // Allow any Unicode letter (\p{L}) or combining mark (\p{M}) plus digits,
  // spaces, hyphens, apostrophes, and periods. No angle brackets, backticks,
  // pipes, backslashes, or newlines — all prompt-injection vectors. The
  // previous version used [A-Za-zÀ-ÿ] which covered only Latin-1 and
  // rejected real NBA names like Jokić (ć is U+0107, Latin Extended-A) and
  // Dončić (č is U+010D). \p{L} is the correct Unicode-aware alternative.
  .regex(
    /^[\p{L}\p{M}0-9 .'\-]+$/u,
    'player name contains disallowed characters',
  );

/** Stat type enum — keep in sync with batchProcessor canonical values. */
export const StatType = z.enum([
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
]);

// ---------------------------------------------------------------------------
// Request body schemas — one per route that accepts a body.
// ---------------------------------------------------------------------------

/**
 * /api/analyze POST body. Accepts both legacy single-provider mode and new
 * ensemble mode. The calculatorResults shape is NOT fully validated here
 * (it's produced by our own calculator and can contain many optional
 * fields) — instead we cap the total body size at the route level and
 * check the critical fields.
 */
export const AnalyzeRequestBody = z
  .object({
    provider: z.enum(['gemini', 'claude', 'openrouter']).optional(),
    apiKey: z.string().min(1).max(512).optional(),
    model: z.string().min(1).max(128).optional(),

    providers: z
      .array(
        z.object({
          provider: z.enum(['gemini', 'claude', 'openrouter']),
          model: z.string().min(1).max(128),
          apiKey: z.string().min(1).max(512).optional(),
        }),
      )
      .min(1)
      .max(5)
      .optional(),

    // calculatorResults is a big BatchResult blob from our own code — we
    // only check that it's an object with a players array that's not
    // unreasonably huge. Full shape validation would duplicate BatchResult
    // type and we produce it ourselves server-side, so the risk is
    // resource-exhaustion (big arrays) not malicious content.
    calculatorResults: z
      .object({
        players: z
          .array(z.object({}).passthrough())
          .max(200, 'too many players in a single analysis batch'),
        summary: z.object({}).passthrough().optional(),
      })
      .passthrough(),

    injuries: z.array(z.object({}).passthrough()).max(500).optional(),
    lineupContext: z.string().max(10_000).optional(),
    bankroll: z.number().finite().min(1).max(1_000_000),
    platform: z.enum(['prizepicks', 'underdog', 'pick6']).optional(),
    jurisdiction: z.string().max(64).optional(),
    saveToDatabase: z.boolean().optional(),
  })
  .strict();
export type AnalyzeRequestBodyT = z.infer<typeof AnalyzeRequestBody>;

/** /api/odds GET query params. */
export const OddsQuery = z
  .object({
    type: z.enum(['games', 'props']),
    // Odds API event IDs are lower-case hex strings. Strict allowlist
    // prevents SSRF-style abuse where an attacker tries to make us fetch
    // `../../something` or a different hostname.
    eventId: z
      .string()
      .regex(/^[a-f0-9]{16,64}$/, 'invalid eventId format')
      .optional(),
  })
  .refine((v) => v.type !== 'props' || !!v.eventId, {
    message: 'eventId required when type=props',
    path: ['eventId'],
  });

/** /api/picks GET query params. */
export const PicksQuery = z
  .object({
    from: IsoDate.optional(),
    to: IsoDate.optional(),
    tier: z.enum(['HIGH', 'MEDIUM', 'LOW', 'REJECT']).optional(),
    resolvedOnly: z.enum(['true', 'false']).optional(),
    limit: z
      .string()
      .regex(/^\d{1,5}$/)
      .optional(),
    bankroll: z
      .string()
      .regex(/^\d+(\.\d+)?$/)
      .optional(),
  })
  .strict();

/** /api/system-status/acknowledge query params. */
export const AcknowledgeQuery = z
  .object({
    id: Uuid,
  })
  .strict();

// ---------------------------------------------------------------------------
// LLM response schema — used with Zod safeParse after every AI call.
// The upstream JSON is fully validated before we show anything to the user
// or persist anything to Supabase (OWASP LLM05 — Improper Output Handling).
// ---------------------------------------------------------------------------

export const AIPickSchema = z
  .object({
    playerName: z.string().min(1).max(128),
    statType: z.string().min(1).max(32),
    line: z.number().finite(),
    direction: z.enum(['over', 'under']),
    confidenceTier: z.enum(['A', 'B', 'C', 'REJECT']),
    reasoning: z.string().max(2000),
    flags: z
      .array(
        z.object({
          type: z.string().max(64),
          severity: z.enum(['minor', 'major']),
          note: z.string().max(512),
        }),
      )
      .max(20)
      .optional()
      .default([]),
    modifiers: z
      .object({
        pace: z.number().optional(),
        injury: z.number().optional(),
        matchup: z.number().optional(),
        rest: z.number().optional(),
      })
      .optional(),
    finalProbability: z.number().min(0).max(1).optional(),
    finalEV: z.number().min(-1).max(1).optional(),
  })
  .passthrough();

// Shadow evaluations: every prop the model considered but did NOT recommend
// as a bet. Used for calibration tracking — proves the tier filter is doing
// useful work and surfaces drift. See prompt section 6.1b. Lean by design:
// no flags, no modifiers, reasoning is optional and only expected on tier "A"
// shadow entries (which should be rare since A-tier props normally appear in
// picks).
export const AIShadowEvaluationSchema = z
  .object({
    playerName: z.string().min(1).max(128),
    statType: z.string().min(1).max(32),
    line: z.number().finite(),
    direction: z.enum(['over', 'under']),
    confidenceTier: z.enum(['A', 'B', 'C', 'REJECT']),
    finalProbability: z.number().min(0).max(1).optional(),
    finalEV: z.number().min(-1).max(1).optional(),
    reasoning: z.string().max(150).optional(),
  })
  .passthrough();

export const AIAnalysisResponseSchema = z
  .object({
    picks: z.array(AIPickSchema).max(200),
    slips: z
      .array(
        z
          .object({
            platform: z.string().max(64),
            slipType: z.string().max(64),
            legsCount: z.number().int().min(1).max(20),
            stakeAmount: z.number().finite().min(0),
            expectedPayout: z.number().finite(),
            pickNames: z.array(z.string().max(256)).max(20),
            rationale: z.string().max(2000),
          })
          .passthrough(),
      )
      .max(20)
      .optional()
      .default([]),
    summary: z.string().max(4000).optional().default(''),
    warnings: z.array(z.string().max(1000)).max(50).optional().default([]),
    shadowEvaluations: z
      .array(AIShadowEvaluationSchema)
      .max(16)
      .optional()
      .default([]),
  })
  .passthrough();
