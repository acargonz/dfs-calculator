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
import { getSupabase } from '@/lib/supabase';
import type { BatchResult, BatchPlayerResult } from '@/lib/batchProcessor';
import type { InjuryEntry } from '../injuries/route';

/**
 * Request body supports TWO modes:
 *
 *   1. Legacy single-provider mode (backward compatible):
 *        { provider, apiKey?, model?, ... }
 *
 *   2. New ensemble mode:
 *        { providers: [{ provider, model, apiKey? }, ...], ... }
 *
 * If neither is supplied, falls back to DEFAULT_ENSEMBLE
 * (Gemini 2.5 Flash + GPT-OSS 120B).
 */
interface AnalyzeRequestBody {
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
  injuries?: InjuryEntry[];
  lineupContext?: string;
  bankroll: number;
  platform?: 'prizepicks' | 'underdog' | 'pick6';
  jurisdiction?: string;
  saveToDatabase?: boolean;
}

function getEnvKey(provider: AIProvider): string | undefined {
  if (provider === 'gemini') return process.env.GEMINI_API_KEY;
  if (provider === 'claude') return process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY;
  if (provider === 'openrouter') return process.env.OPENROUTER_API_KEY;
  return undefined;
}

/**
 * Resolve the full list of providers to run. Handles all three input modes:
 * ensemble array, legacy single, or default ensemble.
 */
function resolveProviders(body: AnalyzeRequestBody): EnsembleProviderConfig[] {
  // Ensemble mode
  if (body.providers && body.providers.length > 0) {
    return body.providers.map((p) => {
      const apiKey = p.apiKey || getEnvKey(p.provider);
      if (!apiKey) {
        throw new Error(
          `No API key for ${p.provider}. Provide apiKey in the request or set the corresponding env var.`,
        );
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
    return { provider: d.provider, model: d.model, apiKey };
  });
}

export async function POST(request: NextRequest) {
  try {
    const body: AnalyzeRequestBody = await request.json();

    if (!body.calculatorResults) {
      return NextResponse.json({ error: 'calculatorResults is required' }, { status: 400 });
    }

    // Resolve provider list
    let providers: EnsembleProviderConfig[];
    try {
      providers = resolveProviders(body);
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : 'Provider resolution failed' },
        { status: 400 },
      );
    }

    // Load active prompt
    const promptVersion = await getActivePrompt();

    // Run ensemble in parallel
    const ensemble = await runEnsembleAnalysis(providers, {
      systemPrompt: promptVersion.content,
      calculatorResults: body.calculatorResults,
      injuries: body.injuries,
      lineupContext: body.lineupContext,
      bankroll: body.bankroll,
      platform: body.platform,
      jurisdiction: body.jurisdiction,
    });

    // Compute consensus merge
    const consensus = mergePicks(ensemble);

    // Persist to Supabase
    let analysisId: string | null = null;
    if (body.saveToDatabase !== false) {
      const supabase = getSupabase();
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
              // Closing line / home_away / pace / injury modifiers are
              // populated by other code paths (snapshot cron, batch input
              // plumbing), not by this route.
              bet_odds_over: calc?.overOdds ?? null,
              bet_odds_under: calc?.underOdds ?? null,
              bookmaker: calc?.bookmaker ?? null,
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
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('Analyze error:', message);
    // Even on a total failure we surface a retry hint so the UI countdown
    // can start immediately instead of showing a static "Try again" button.
    return NextResponse.json(
      { error: message, retryAfterMs: estimateRetryDelayMs(message) },
      { status: 500 },
    );
  }
}
