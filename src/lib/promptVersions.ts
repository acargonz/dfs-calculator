// Server-only — touches Supabase via the service role key.
import 'server-only';

/**
 * Prompt version management.
 *
 * Fetches the currently-active Algorithmic Prompt from Supabase, or falls
 * back to a minimal inline string if Supabase isn't configured (dev / offline).
 * The full production prompts live in `prompts/algorithmic-prompt-v2.txt`
 * on disk and are seeded into Supabase via `scripts/seed-prompt.mjs`.
 */

import { getSupabaseAdmin } from './supabaseAdmin';
import type { PromptVersion } from './supabase';

// Minimal inline fallback used only when Supabase is unreachable. The real
// production content is the file on disk that gets seeded into the
// prompt_versions table on first setup.
const FALLBACK_PROMPT_CONTENT = `You are an NBA prop-betting analyst. The calculator has already computed probabilities and EVs for each player prop. Your job is to review each pick, apply context (injuries, matchups, pace), flag issues, and recommend a final tier (A/B/C/REJECT) with brief reasoning.`;

export async function getActivePrompt(): Promise<PromptVersion> {
  const supabase = getSupabaseAdmin();

  if (supabase) {
    const { data, error } = await supabase
      .from('prompt_versions')
      .select('*')
      .eq('status', 'active')
      .order('version_number', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!error && data) {
      return data as PromptVersion;
    }
  }

  // Fallback if Supabase unavailable or no active prompt
  return {
    id: 'fallback',
    version_number: 0,
    content: FALLBACK_PROMPT_CONTENT,
    change_summary: 'Built-in fallback prompt',
    parent_version_id: null,
    status: 'active',
    created_at: new Date().toISOString(),
    created_by: null,
  };
}

export async function listPromptVersions(): Promise<PromptVersion[]> {
  const supabase = getSupabaseAdmin();
  if (!supabase) return [];

  const { data, error } = await supabase
    .from('prompt_versions')
    .select('*')
    .order('version_number', { ascending: false });

  if (error) return [];
  return (data || []) as PromptVersion[];
}
