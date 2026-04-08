/**
 * Shared AI analysis types + the model catalog.
 *
 * Why this file exists (separate from aiAnalysis.ts):
 *   `src/lib/aiAnalysis.ts` is marked `import 'server-only'` because it
 *   reads provider API keys from process.env, constructs outbound fetches,
 *   and must never end up in the client bundle. But a few of the types it
 *   exports (AIProvider, AIPick, ModelInfo, MODEL_CATALOG) are legitimately
 *   needed by Client Components — AIAnalysisPanel.tsx renders a dropdown
 *   built from MODEL_CATALOG and consumes AIPick rows from the /api/analyze
 *   response. Keeping those in aiAnalysis.ts would force the whole file
 *   (including API key plumbing) into the client bundle and trip the
 *   server-only guard.
 *
 *   The fix is the standard Next.js App Router split: types + pure constant
 *   data live in a client-safe module (this file), and the server-only
 *   module re-exports them so existing callers don't break.
 *
 * This file has no imports from `node:*` modules, no process.env access,
 * and no side effects — it's safe to import from anywhere.
 */

// ---------------------------------------------------------------------------
// Provider discriminant
// ---------------------------------------------------------------------------
export type AIProvider = 'gemini' | 'claude' | 'openrouter';

// ---------------------------------------------------------------------------
// AI response shapes (match AIAnalysisResponseSchema in schemas.ts)
// ---------------------------------------------------------------------------

export interface AIPick {
  playerName: string;
  statType: string;
  line: number;
  direction: 'over' | 'under';
  confidenceTier: 'A' | 'B' | 'C' | 'REJECT';
  reasoning: string;
  flags: Array<{ type: string; severity: 'minor' | 'major'; note: string }>;
  modifiers?: {
    pace?: number;
    injury?: number;
    matchup?: number;
    rest?: number;
  };
  finalProbability?: number;
  finalEV?: number;
}

/**
 * Shadow evaluation: a prop the model considered but did NOT recommend as
 * a bet. Stored for calibration tracking, never displayed as a betting
 * suggestion. See prompt section 6.1b. Reasoning is only expected on tier
 * "A" entries (rare — A-tier props normally appear in `picks`).
 */
export interface AIShadowEvaluation {
  playerName: string;
  statType: string;
  line: number;
  direction: 'over' | 'under';
  confidenceTier: 'A' | 'B' | 'C' | 'REJECT';
  finalProbability?: number;
  finalEV?: number;
  reasoning?: string;
}

export interface AISlip {
  platform: string;
  slipType: string;
  legsCount: number;
  stakeAmount: number;
  expectedPayout: number;
  pickNames: string[]; // Array of "Player — Stat Over/Under X.X"
  rationale: string;
}

// ---------------------------------------------------------------------------
// Model catalog — displayed by the UI dropdown and used as the default set
// for ensemble mode on the server.
// ---------------------------------------------------------------------------

export interface ModelInfo {
  id: string;
  displayName: string;
  provider: AIProvider;
  notes?: string;
  /** True if BYO-key is mandatory (Claude); false if env key is fine */
  requiresKey?: boolean;
}

export const MODEL_CATALOG: ModelInfo[] = [
  // Gemini (free tier)
  {
    id: 'gemini-2.5-flash',
    displayName: 'Gemini 2.5 Flash',
    provider: 'gemini',
    notes: 'Fastest, strong JSON mode, free tier',
  },
  {
    id: 'gemini-flash-latest',
    displayName: 'Gemini Flash (latest alias)',
    provider: 'gemini',
    notes: 'Always points to newest flash release',
  },
  {
    id: 'gemini-2.5-pro',
    displayName: 'Gemini 2.5 Pro',
    provider: 'gemini',
    notes: 'Strongest reasoning, but free tier heavily rate-limited',
  },

  // OpenRouter free models (verified working)
  {
    id: 'openai/gpt-oss-120b:free',
    displayName: 'GPT-OSS 120B (OpenAI)',
    provider: 'openrouter',
    notes: 'Free, strongest open reasoning model, 131k ctx',
  },
  {
    id: 'openai/gpt-oss-20b:free',
    displayName: 'GPT-OSS 20B (OpenAI)',
    provider: 'openrouter',
    notes: 'Free, smaller + faster GPT-OSS',
  },
  {
    id: 'nvidia/nemotron-3-super-120b-a12b:free',
    displayName: 'Nemotron 3 Super 120B (NVIDIA)',
    provider: 'openrouter',
    notes: 'Free, 120B reasoning model, slower',
  },
  {
    id: 'z-ai/glm-4.5-air:free',
    displayName: 'GLM 4.5 Air (Z.AI)',
    provider: 'openrouter',
    notes: 'Free, alt reasoning model',
  },
  {
    id: 'minimax/minimax-m2.5:free',
    displayName: 'MiniMax M2.5',
    provider: 'openrouter',
    notes: 'Free, different model family',
  },

  // Claude (BYO key)
  {
    id: 'claude-sonnet-4-5',
    displayName: 'Claude Sonnet 4.5',
    provider: 'claude',
    notes: 'Premium, requires Anthropic API key',
    requiresKey: true,
  },
  {
    id: 'claude-opus-4-5',
    displayName: 'Claude Opus 4.5',
    provider: 'claude',
    notes: 'Most capable, requires Anthropic API key',
    requiresKey: true,
  },
];

/**
 * Default ensemble pair (Option I):
 * Gemini 2.5 Flash (Google transformer) + GPT-OSS 120B (OpenAI MoE).
 * Different families → meaningful consensus signal.
 */
export const DEFAULT_ENSEMBLE: Array<{
  provider: AIProvider;
  model: string;
}> = [
  { provider: 'gemini', model: 'gemini-2.5-flash' },
  { provider: 'openrouter', model: 'openai/gpt-oss-120b:free' },
];
