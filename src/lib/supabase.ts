/**
 * Supabase TYPE definitions (no runtime).
 *
 * This module used to export a `getSupabase()` singleton that built a
 * Supabase client from `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY`.
 * That approach had two problems:
 *
 *   1. The anon key was shipped into the browser bundle (it has the
 *      `NEXT_PUBLIC_` prefix), making it retrievable by any attacker who
 *      opened DevTools. Our RLS policies were wide-open (`using(true)
 *      with check(true)`), so the anon key + RLS-as-advertised provided
 *      zero access control — a clean path to delete every pick in the
 *      database from the browser console.
 *
 *   2. Every single caller of `getSupabase()` is actually a server-side
 *      Route Handler or a server-only library function. No Client
 *      Component ever needs a Supabase client at runtime — the client
 *      just fetches our own /api/* endpoints and gets JSON back.
 *
 * Resolution (security findings C1, C2, H2, H7):
 *   - Move the client construction into `supabaseAdmin.ts`, which uses the
 *     SERVICE ROLE key and is gated behind `import 'server-only'`.
 *   - Enable real Row Level Security via migration 003 with a default-deny
 *     policy. The service role client bypasses RLS by design (BYPASSRLS).
 *   - Keep this file for the TYPE exports only, because both server code
 *     and client components legitimately need to type function parameters
 *     and React state as `PickRow` / `SystemAlertRow` / etc.
 *   - Type-only imports are erased at compile time, so importing from this
 *     file from a Client Component does NOT pull any runtime into the
 *     browser bundle.
 *
 * All API routes that previously called `getSupabase()` now call
 * `getSupabaseAdmin()` from `./supabaseAdmin`.
 */

// ============================================================================
// Typed row shapes — safe to import from anywhere (client + server).
// ============================================================================

export interface PromptVersion {
  id: string;
  version_number: number;
  content: string;
  change_summary: string | null;
  parent_version_id: string | null;
  status: 'active' | 'archived' | 'draft';
  created_at: string;
  created_by: string | null;
}

export interface AnalysisRow {
  id: string;
  date: string;
  prompt_version_id: string | null;
  ai_model: string;
  calculator_results: unknown;
  injury_context: string | null;
  lineup_context: string | null;
  ai_response: unknown;
  token_count: number | null;
  duration_ms: number | null;
  created_at: string;
}

export interface PickRow {
  id: string;
  analysis_id: string | null;
  date: string;
  player_name: string;
  team: string | null;
  opponent: string | null;
  stat_type: string;
  line: number;
  direction: 'over' | 'under';
  calculator_prob: number | null;
  calculator_ev: number | null;
  calculator_tier: string | null;
  calculator_stake: number | null;
  ai_confidence_tier: string | null;
  ai_reasoning: string | null;
  ai_flags: unknown;
  ai_modifiers: unknown;
  actual_value: number | null;
  won: boolean | null;
  pushed: boolean;
  resolved_at: string | null;
  created_at: string;

  // Bet-time capture columns (migration 001) — all nullable for backward compat
  bet_odds_over: number | null;
  bet_odds_under: number | null;
  closing_odds_over: number | null;
  closing_odds_under: number | null;
  closing_line: number | null;
  closing_snapshot_at: string | null;
  bookmaker: string | null;
  home_away: 'home' | 'away' | null;
  flat_unit_stake: number | null;
  raw_calculator_prob: number | null;
  raw_calculator_tier: string | null;
  pace_modifier: number | null;
  injury_modifier: number | null;
}

/** A row in the system_alerts table (migration 001). */
export interface SystemAlertRow {
  id: string;
  rule_id: string;
  rule_name: string;
  severity: 'info' | 'warning' | 'critical';
  message: string;
  metadata: unknown;
  triggered_at: string;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
  dismissed: boolean;
  auto_action_taken: string | null;
}

// ============================================================================
// Legacy runtime exports — kept as thin shims that point at supabaseAdmin so
// any code we forgot to migrate still compiles. Both are deprecated; new code
// should import from `./supabaseAdmin` directly.
// ============================================================================

/**
 * @deprecated Use `getSupabaseAdmin()` from `./supabaseAdmin` instead.
 * This shim is kept purely to avoid breaking any in-flight refactors during
 * the security migration. It will be removed in a follow-up commit.
 */
export function getSupabase() {
  // Import lazily so tree-shaking can drop this on the client side and the
  // `server-only` import in supabaseAdmin.ts doesn't fire at module load.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getSupabaseAdmin } = require('./supabaseAdmin') as typeof import('./supabaseAdmin');
  return getSupabaseAdmin();
}

/** @deprecated Use `isSupabaseAdminConfigured()` from `./supabaseAdmin`. */
export function isSupabaseConfigured(): boolean {
  return !!(
    (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL) &&
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
}
