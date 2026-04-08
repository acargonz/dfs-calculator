// Server-only Supabase client using the SERVICE ROLE key.
// IMPORTANT — the service role key bypasses Row Level Security by design.
// Never import this file from a Client Component, hook, or anywhere
// rendered in the browser. The `server-only` import at the top of this
// file causes a Next.js build error if a Client Component tries to import
// it, giving us a belt-and-suspenders guard on top of "don't import it".
import 'server-only';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * Lazy singleton for the server-side admin client.
 *
 * Why service role (and not the anon key)?
 *   The anon key is meant to be public and paired with Row Level Security
 *   policies in the database. This project writes to picks / analyses /
 *   system_alerts from cron routes and /api/analyze — operations that used
 *   to work via wide-open RLS ("using(true) with check(true)"), which is
 *   functionally the same as no RLS at all. Migration 003 locks those
 *   tables down with a default-deny policy, so anon writes stop working.
 *   Server routes that legitimately need to write bypass RLS by using the
 *   service role key. Clients (browsers) never get this key.
 *
 * Invariants:
 *   - SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY must both be set.
 *   - persistSession / autoRefreshToken are both off — this client is
 *     stateless between requests (no cookie / localStorage).
 *   - All callers must be inside a Route Handler, Server Component, or
 *     cron route. Never pass rows read via this client to the browser
 *     without re-filtering them for user-safe columns.
 *
 * Returns null instead of throwing when env vars are missing so local dev
 * without Supabase still boots — each caller decides how to handle the
 * null (most fall back to "Supabase not configured" 500).
 */
let adminClient: SupabaseClient | null = null;

export function getSupabaseAdmin(): SupabaseClient | null {
  if (adminClient) return adminClient;

  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceKey) return null;

  adminClient = createClient(url, serviceKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
    global: {
      // Tag every outbound request so it's easy to distinguish server-side
      // writes from anything an attacker tried to replay with a stolen key.
      headers: { 'x-dfs-client': 'server-admin' },
    },
  });

  return adminClient;
}

export function isSupabaseAdminConfigured(): boolean {
  return !!(
    (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL) &&
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
}
