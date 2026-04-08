// Server-only — the aiAnalysis module reads provider API keys from
// process.env and must never be imported from a Client Component.
import 'server-only';

import { NextRequest, NextResponse } from 'next/server';
import {
  runEnsembleAnalysis,
  DEFAULT_ENSEMBLE,
  estimateRetryDelayMs,
  type AIProvider,
  type EnsembleProviderConfig,
} from '@/lib/aiAnalysis';
import { mergePicks, matchKey } from '@/lib/ensembleConsensus';
import { getActivePrompt } from '@/lib/promptVersions';
import { getSupabaseAdmin } from '@/lib/supabaseAdmin';
import type { BatchResult, BatchPlayerResult } from '@/lib/batchProcessor';
import { AnalyzeRequestBody, validateProviderKey } from '@/lib/schemas';
import { isAllowedOrigin } from '@/lib/originCheck';
import {
  badRequest,
  forbidden,
  payloadTooLarge,
  internalError,
} from '@/lib/apiErrors';
import { safeErrorMessage } from '@/lib/redact';

/**
 * /api/analyze — the single most sensitive endpoint in this app.
 *
 * Why it deserves all the hardening:
 *   - Fans out to paid LLM providers (Gemini, Claude, OpenRouter). A single
 *     malicious request that slipped past input validation could drain
 *     thousands of tokens across 3 providers in one second. That's OWASP
 *     LLM10:2025 "Denial of Wallet" — exploit lack of input limits and
 *     cost controls to trigger bills that can disrupt cash flow.
 *   - Handles the BYO-key flow where users paste their own Anthropic key.
 *     Anthropic's API key best-practices doc is explicit: never log, never
 *     echo in error responses, never persist. Any lapse here ships the
 *     user's key to our logs / Sentry / error tracker.
 *   - Persists picks to Supabase, so a bad input that evaded the calculator
 *     sanity checks could end up polluting the pick history.
 *
 * Defense-in-depth stack (applied in order):
 *   1. Origin/Referer allowlist (lib/originCheck) — CSRF shield against
 *      browser-based hot-linking from evil.com.
 *   2. Content-Length cap (512KB) — prevents a 20MB JSON bomb from
 *      reaching the Zod parser at all.
 *   3. Zod.safeParse() on the body with strict() — reject any field that's
 *      missing, wrong type, or unknown. OWASP REST Security Cheat Sheet
 *      mandates allowlist validation on every untrusted input field.
 *   4. Provider API-key format validator — block obviously broken keys
 *      (empty, wrong prefix) from burning quota on a guaranteed-failing
 *      upstream call.
 *   5. Redacted error responses — client sees "Internal error", server
 *      logs have the real message with any API keys replaced by
 *      [REDACTED]. Errors are never round-tripped verbatim.
 *
 * External controls that complete the picture (not in this file):
 *   - GCP Cloud Billing hard cap (set via GCP Console — see
 *     SECURITY_DEPLOYMENT_CHECKLIST.md step 1). Bankruptcy protection.
 *   - Vercel Firewall rate-limit rule (dashboard — step 2). Bot shield.
 *   - Supabase RLS default-deny (migration 003 — step 3). DB shield.
 */

/**
 * Local TS interface for the typed access pattern in this route handler.
 * Distinct from the Zod runtime schema (also named AnalyzeRequestBody, but
 * imported as a value) — they live in different namespaces in TypeScript,
 * but to avoid the dual-name confusion this one carries the `Shape` suffix.
 * The `calculatorResults: BatchResult` field is the reason this exists at
 * all: the Zod schema deliberately keeps that field as a loose passthrough
 * object (we produce it ourselves, full validation would duplicate the
 * BatchResult type), and the route still needs typed access to it.
 */
interface AnalyzeRouteBodyShape {
  // Single-provider mode (legacy)
  provider?: AIProvider;
  apiKey?: string;
  model?: string;

  // Ensemble mode (new)
  providers?: Array<{
    provider: AIProvider;
    model: string;
    apiKey?: string;
  }>;

  calculatorResults: BatchResult;
  injuries?: unknown[];
  lineupContext?: string;
  bankroll: number;
  platform?: 'prizepicks' | 'underdog' | 'pick6';
  jurisdiction?: string;
  saveToDatabase?: boolean;
}

// 512KB cap — small enough to act as a DoS shield (OWASP API4 — Resource
// Consumption), large enough to fit legitimate full-slate analyses. The AI
// provider will reject anything genuinely absurd long before this cap.
const MAX_BODY_BYTES = 512 * 1024;

function getEnvKey(provider: AIProvider): string | undefined {
  if (provider === 'gemini') return process.env.GEMINI_API_KEY;
  if (provider === 'claude')
    return process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY;
  if (provider === 'openrouter') return process.env.OPENROUTER_API_KEY;
  return undefined;
}

/**
 * Resolve the full list of providers to run. Handles all three input modes:
 * ensemble array, legacy single, or default ensemble. Validates every
 * resolved API key against the provider-specific format regex before
 * returning — this catches typos / truncation / stale keys before we
 * waste a provider request on them.
 */
function resolveProviders(body: AnalyzeRouteBodyShape): EnsembleProviderConfig[] {
  // Ensemble mode
  if (body.providers && body.providers.length > 0) {
    return body.providers.map((p) => {
      const apiKey = p.apiKey || getEnvKey(p.provider);
      if (!apiKey) {
        throw new Error(
          `No API key for ${p.provider}. Provide apiKey in the request or set the corresponding env var.`,
        );
      }
      const fmtCheck = validateProviderKey(p.provider, apiKey);
      if (!fmtCheck.ok) {
        throw new Error(`Invalid ${p.provider} key format: ${fmtCheck.reason}`);
      }
      return { provider: p.provider, model: p.model, apiKey };
    });
  }

  // Legacy single-provider mode
  if (body.provider) {
    const apiKey = body.apiKey || getEnvKey(body.provider);
    if (!apiKey) {
      throw new Error(
        `No ${body.provider} API key available. Provide apiKey in request body or set the env var.`,
      );
    }
    const fmtCheck = validateProviderKey(body.provider, apiKey);
    if (!fmtCheck.ok) {
      throw new Error(`Invalid ${body.provider} key format: ${fmtCheck.reason}`);
    }
    return [
      {
        provider: body.provider,
        model: body.model || '',
        apiKey,
      },
    ];
  }

  // Default ensemble
  return DEFAULT_ENSEMBLE.map((d) => {
    const apiKey = getEnvKey(d.provider);
    if (!apiKey) {
      throw new Error(
        `Default ensemble requires ${d.provider} env key. Configure ${d.provider === 'gemini' ? 'GEMINI_API_KEY' : 'OPENROUTER_API_KEY'} in .env.local.`,
      );
    }
    const fmtCheck = validateProviderKey(d.provider, apiKey);
    if (!fmtCheck.ok) {
      throw new Error(`Invalid ${d.provider} key format: ${fmtCheck.reason}`);
    }
    return { provider: d.provider, model: d.model, apiKey };
  });
}

export async function POST(request: NextRequest) {
  try {
    // ───── Gate 1: origin allowlist (CSRF shield) ─────
    if (!isAllowedOrigin(request)) {
      return forbidden('Cross-origin request blocked');
    }

    // ───── Gate 2: content-length cap ─────
    // Reject oversized bodies before we even try to parse them. The
    // Content-Length header is trusted here because Vercel/Next.js
    // validates it against the actual received body length server-side.
    const contentLength = Number(request.headers.get('content-length') ?? '0');
    if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
      return payloadTooLarge(MAX_BODY_BYTES);
    }

    // ───── Gate 3: JSON parse (wrapped so a bad body doesn't bubble) ─────
    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      return badRequest('Invalid JSON body');
    }

    // ───── Gate 4: Zod schema validation ─────
    const parsed = AnalyzeRequestBody.safeParse(rawBody);
    if (!parsed.success) {
      return badRequest(
        parsed.error.issues[0]?.message ?? 'Invalid request body',
        { issues: parsed.error.issues.slice(0, 5).map((i) => i.path.join('.')) },
      );
    }
    const body = parsed.data as unknown as AnalyzeRouteBodyShape;

    if (!body.calculatorResults) {
      return badRequest('calculatorResults is required');
    }

    // ───── Gate 5: resolve + validate provider keys ─────
    let providers: EnsembleProviderConfig[];
    try {
      providers = resolveProviders(body);
    } catch (e) {
      return badRequest(safeErrorMessage(e, 'Provider resolution failed'));
    }

    // Load active prompt (reads from Supabase via admin client)
    const promptVersion = await getActivePrompt();

    // Run ensemble in parallel
    const ensemble = await runEnsembleAnalysis(providers, {
      systemPrompt: promptVersion.content,
      calculatorResults: body.calculatorResults,
      injuries: body.injuries as never,
      lineupContext: body.lineupContext,
      bankroll: body.bankroll,
      platform: body.platform,
      jurisdiction: body.jurisdiction,
    });

    // Compute consensus merge
    const consensus = mergePicks(ensemble);

    // Persist to Supabase via admin client (bypasses RLS default-deny)
    let analysisId: string | null = null;
    if (body.saveToDatabase !== false) {
      const supabase = getSupabaseAdmin();
      if (supabase && promptVersion.id !== 'fallback') {
        const today = new Date().toISOString().split('T')[0];
        const successful = ensemble.responses.filter((r) => r.status === 'success');
        const models = successful.map((r) => r.model).join(' + ');

        const { data: analysisRow, error: insertErr } = await supabase
          .from('analyses')
          .insert({
            date: today,
            prompt_version_id: promptVersion.id,
            ai_model: models || 'none',
            calculator_results: body.calculatorResults,
            injury_context: body.injuries ? JSON.stringify(body.injuries) : null,
            lineup_context: body.lineupContext || null,
            ai_response: {
              ensemble: ensemble.responses,
              consensus,
            },
            token_count: successful.reduce(
              (acc, r) => (r.status === 'success' ? acc + (r.response.tokensUsed || 0) : acc),
              0,
            ),
            duration_ms: ensemble.durationMs,
          })
          .select()
          .single();

        if (!insertErr && analysisRow) {
          analysisId = analysisRow.id;

          // Build a lookup from matchKey → BatchPlayerResult so we can pull
          // bet-time odds, bookmaker, and raw calculator outputs into each
          // pick row. Uses the same canonical key as ensembleConsensus.mergePicks
          // so the lookup hits even when AI normalizes player names slightly.
          const calcLookup = new Map<string, BatchPlayerResult>();
          for (const player of body.calculatorResults.players) {
            calcLookup.set(
              matchKey(player.playerName, player.statType, player.line),
              player,
            );
          }

          // Belt-and-suspenders: even after normalizeAIPick, any value that
          // slipped through as non-finite / out-of-range gets nulled at the
          // DB boundary so we never poison the picks.calculator_prob column.
          const sanitizeProb = (v: unknown): number | null => {
            if (typeof v !== 'number' || !Number.isFinite(v)) return null;
            return v >= 0 && v <= 1 ? v : null;
          };
          const sanitizeEV = (v: unknown): number | null => {
            if (typeof v !== 'number' || !Number.isFinite(v)) return null;
            return Math.abs(v) <= 1 ? v : null;
          };

          // Insert one row per merged pick (agreement-weighted)
          const pickRows = consensus.merged.map((m) => {
            // Prefer recommended votes for the reasoning/tier display
            const recommendVote = m.votes.find(
              (v) => v.pick.confidenceTier === 'A' || v.pick.confidenceTier === 'B',
            );
            const topVote = recommendVote || m.votes[0];

            // Look up the original BatchPlayerResult for bet-time context.
            // The chosen side (over/under) determines which raw calculator
            // values get persisted alongside the AI-adjusted ones.
            const calc = calcLookup.get(m.key);
            const chosenDir: 'over' | 'under' =
              topVote.pick.direction === 'over' ? 'over' : 'under';
            const rawSide = calc?.result?.[chosenDir];

            return {
              analysis_id: analysisRow.id,
              date: today,
              player_name: m.playerName,
              stat_type: m.statType,
              line: m.line,
              direction: topVote.pick.direction,
              ai_confidence_tier: topVote.pick.confidenceTier,
              ai_reasoning: topVote.pick.reasoning,
              ai_flags: [{ consensus: m.consensus, votes: m.votes.map((v) => ({ provider: v.provider, model: v.model, tier: v.pick.confidenceTier, direction: v.pick.direction })) }],
              ai_modifiers: topVote.pick.modifiers || null,
              // Use ?? not || — a legit 0.0 probability should stay 0, not
              // flip to null. sanitize* also guards against non-finite /
              // out-of-range values that somehow slipped through the
              // normalizer (stringified numbers, hallucinated 5800%, etc.).
              calculator_prob: sanitizeProb(topVote.pick.finalProbability),
              calculator_ev: sanitizeEV(topVote.pick.finalEV),
              calculator_tier: m.consensus,

              // Bet-time capture columns (added by migration 001).
              // Closing line is populated separately by the snapshot cron;
              // home_away + pace/injury modifiers come from the batch
              // result + the AI's per-pick modifier object so calibration
              // analysis can slice by venue and context. Falls back to
              // null / 0 when the upstream data didn't carry it (legacy
              // fixtures, crossReferenceOdds path, or AIs that omit the
              // modifiers field).
              bet_odds_over: calc?.overOdds ?? null,
              bet_odds_under: calc?.underOdds ?? null,
              bookmaker: calc?.bookmaker ?? null,
              home_away: calc?.homeAway ?? null,
              pace_modifier: topVote.pick.modifiers?.pace ?? 0,
              injury_modifier: topVote.pick.modifiers?.injury ?? 0,
              raw_calculator_prob: rawSide?.blendedProb ?? null,
              raw_calculator_tier: rawSide?.tier ?? null,
            };
          });

          if (pickRows.length > 0) {
            await supabase.from('picks').insert(pickRows);
          }
        }
      }
    }

    // Compute a retry hint for the UI countdown. If ANY provider in the
    // ensemble failed with a transient error, surface the longest estimated
    // delay so the user can wait out the worst offender before retrying.
    // Successful-only ensembles return `undefined` (no banner / no timer).
    const failedResponses = ensemble.responses.filter((r) => r.status === 'error');
    const retryAfterMs =
      failedResponses.length > 0
        ? Math.max(
            ...failedResponses.map((r) =>
              estimateRetryDelayMs(r.status === 'error' ? r.error : ''),
            ),
          )
        : undefined;

    // Return full response
    return NextResponse.json({
      ensemble: ensemble.responses,
      consensus,
      durationMs: ensemble.durationMs,
      analysisId,
      promptVersion: promptVersion.version_number,
      retryAfterMs,
    });
  } catch (err) {
    // Log the full (redacted) error server-side, but return a generic
    // message to the client. We still surface the retry hint so the UI
    // countdown can start, but without leaking any underlying detail.
    const message = safeErrorMessage(err);
    // eslint-disable-next-line no-console
    console.error('[analyze] fatal:', message);
    return NextResponse.json(
      {
        error: 'Internal error',
        code: 'internal',
        retryAfterMs: estimateRetryDelayMs(message),
      },
      { status: 500 },
    );
  }
}
