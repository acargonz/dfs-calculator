-- =============================================================================
-- Migration 003 — Default-deny RLS + force row level security
-- =============================================================================
--
-- Why this migration exists
-- --------------------------
-- schema.sql ships with these "permissive" policies on every table:
--
--   create policy "allow anon all on picks" on picks
--     for all using (true) with check (true);
--
-- That string "using (true)" is RLS turned inside out: with the anon key,
-- anyone on the internet who knows our project ref can SELECT / INSERT /
-- UPDATE / DELETE every row in every table. The Supabase docs call this out
-- explicitly under "Anonymous access" — the anon key is considered PUBLIC,
-- intended to be embedded in client apps, and RLS is the ONLY thing standing
-- between that public key and the database. A `using (true)` policy removes
-- that wall. This is OWASP API1:2023 Broken Object Level Authorization at
-- the database tier — there is no object-level authorization at all.
--
-- In addition, even after RLS is flipped on, Postgres lets table OWNERS
-- bypass RLS. That's fine for migrations run as the postgres superuser, but
-- it means that if any application role is ever granted ownership (or if a
-- bug grants BYPASSRLS), that role silently bypasses every policy below.
-- `force row level security` closes that escape hatch.
--
-- What this migration does
-- -------------------------
-- 1. Drops the old `allow anon all` policies on every table. They were
--    never safe, and keeping them around while adding a deny policy would
--    result in the permissive policy still granting access (Postgres RLS
--    combines policies with OR, not AND — any single policy that returns
--    true lets the row through).
--
-- 2. Re-asserts `enable row level security` on every table (idempotent —
--    no-op if already enabled, but makes the intent explicit at the top of
--    this file so a reader can verify RLS is on without hunting elsewhere).
--
-- 3. Adds `force row level security` on every table so even the owner role
--    is subject to RLS. The only role that should be making changes going
--    forward is `service_role`, which has the BYPASSRLS attribute and is
--    therefore immune to RLS by design — but it lives only on the server
--    (src/lib/supabaseAdmin.ts, NEVER in a Client Component) and is
--    authenticated by a secret held exclusively in .env.local + Vercel.
--
-- 4. Adds explicit default-deny policies (`using (false) with check (false)`)
--    for the `anon` and `authenticated` roles on every table. Technically
--    the absence of any policy is already default-deny in Postgres RLS, but
--    shipping an explicit deny policy makes the intent visible, survives
--    accidental `drop policy` operations during debugging, and gives us a
--    clean name to drop if we ever need to re-grant read access to a
--    specific slice of the data (e.g. a future public leaderboard).
--
-- After this migration, the ONLY way to read or write these tables is via
-- the service_role key held server-side. The anon key can still *connect*
-- (Supabase needs that for realtime subscriptions and PostgREST handshakes)
-- but every query it makes returns an empty set or a 401.
--
-- Apply with: Supabase Dashboard → SQL Editor → paste file → Run.
-- Idempotent: safe to re-run. Every DROP uses `if exists`, every CREATE
-- uses `if not exists`, every ENABLE is a no-op when already on.
-- =============================================================================

-- ---------- Step 1: drop the dangerously-permissive policies ----------------
drop policy if exists "allow anon all on prompt_versions" on prompt_versions;
drop policy if exists "allow anon all on analyses"        on analyses;
drop policy if exists "allow anon all on picks"           on picks;
drop policy if exists "allow anon all on slips"           on slips;
drop policy if exists "allow anon all on daily_summaries" on daily_summaries;
drop policy if exists "allow anon all on system_alerts"   on system_alerts;

-- ---------- Step 2: ensure RLS is enabled (idempotent) ----------------------
alter table prompt_versions enable row level security;
alter table analyses        enable row level security;
alter table picks           enable row level security;
alter table slips           enable row level security;
alter table daily_summaries enable row level security;
alter table system_alerts   enable row level security;

-- ---------- Step 3: force RLS on table owners too ---------------------------
-- Without `force row level security`, the table OWNER (and any role with
-- BYPASSRLS) silently skips every policy below. service_role has BYPASSRLS
-- by design so it still works; this only affects owner-style roles.
alter table prompt_versions force row level security;
alter table analyses        force row level security;
alter table picks           force row level security;
alter table slips           force row level security;
alter table daily_summaries force row level security;
alter table system_alerts   force row level security;

-- ---------- Step 4: explicit default-deny for anon + authenticated ----------
-- Postgres RLS is already default-deny when no policy matches, but an
-- explicit policy name gives us something to grep for in the dashboard and
-- makes the intent obvious at review time. Both anon and authenticated
-- roles are denied; only service_role (which has BYPASSRLS) can read/write.
create policy "deny anon all on prompt_versions" on prompt_versions
  as restrictive for all to anon, authenticated
  using (false) with check (false);

create policy "deny anon all on analyses" on analyses
  as restrictive for all to anon, authenticated
  using (false) with check (false);

create policy "deny anon all on picks" on picks
  as restrictive for all to anon, authenticated
  using (false) with check (false);

create policy "deny anon all on slips" on slips
  as restrictive for all to anon, authenticated
  using (false) with check (false);

create policy "deny anon all on daily_summaries" on daily_summaries
  as restrictive for all to anon, authenticated
  using (false) with check (false);

create policy "deny anon all on system_alerts" on system_alerts
  as restrictive for all to anon, authenticated
  using (false) with check (false);

-- =============================================================================
-- Post-migration verification (run these in SQL editor after applying):
--
--   select schemaname, tablename, rowsecurity, forcerowsecurity
--   from pg_tables
--   where schemaname = 'public'
--     and tablename in ('prompt_versions','analyses','picks','slips',
--                       'daily_summaries','system_alerts');
--
--   -- Every row should show rowsecurity = true AND forcerowsecurity = true.
--
--   select tablename, policyname, permissive, cmd, qual
--   from pg_policies
--   where schemaname = 'public'
--   order by tablename, policyname;
--
--   -- You should see only `deny anon all on <table>` policies. No
--   -- `allow anon all on <table>` entries should remain.
-- =============================================================================
