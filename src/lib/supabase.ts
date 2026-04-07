/**
 * Supabase client singleton.
 *
 * Uses the anon key (safe to expose, RLS enforced server-side).
 * If Supabase isn't configured, all helpers return null/empty and the
 * rest of the app still works — database is an enhancement, not a requirement.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient | null {
  if (client) return client;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !key) {
    // Not configured — app works without DB
    return null;
  }

  client = createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  return client;
}

export function isSupabaseConfigured(): boolean {
  return !!(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
}

// ============================================================================
// Typed row shapes
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
