-- DFS Calculator — Migration 001: Pick history capture
--
-- Adds columns to `picks` for CLV tracking, calibration analysis, and
-- per-pick context. Adds the `system_alerts` table for the rules engine.
--
-- All changes are additive and backward-compatible. Safe to run multiple
-- times (every statement uses `if not exists`).
--
-- Run this in the Supabase SQL editor after `schema.sql`.
--
-- Why this migration exists:
--   The original `picks` table captured the bare minimum: player, stat, line,
--   direction, AI tier, and resolution columns. To support calibration
--   analysis (Brier score, Log Loss), CLV tracking, hierarchical analysis by
--   bookmaker / matchup / context, and the rules-engine status banner on the
--   home page, we need a richer per-pick capture.
--
--   Closing-line columns are nullable because the snapshot cron may fail or
--   the prop may have been pulled before T-5min. NULL is correctly handled by
--   downstream CLV calculations (excluded from averages).

-- ============================================================================
-- PICKS — bet-time odds (American format)
-- ============================================================================
-- Snapshot the over/under odds we observed at pick creation time. Lets us
-- recompute true bet-time EV later even if the line moves.
alter table picks add column if not exists bet_odds_over integer;
alter table picks add column if not exists bet_odds_under integer;

-- ============================================================================
-- PICKS — closing line + odds (snapshotted ~5 min before tip-off)
-- ============================================================================
-- The single most important data for CLV tracking. NULL means the prop was
-- pulled before snapshot or the cron job failed for that pick. Downstream
-- analysis treats NULL as "no CLV data available" and excludes it.
alter table picks add column if not exists closing_odds_over integer;
alter table picks add column if not exists closing_odds_under integer;
alter table picks add column if not exists closing_line numeric;
alter table picks add column if not exists closing_snapshot_at timestamptz;

-- ============================================================================
-- PICKS — sportsbook + game context
-- ============================================================================
-- `bookmaker` lets us slice CLV/ROI by sportsbook (some books are softer).
-- `home_away` is needed for home/away calibration analysis.
alter table picks add column if not exists bookmaker text;
alter table picks add column if not exists home_away text check (home_away in ('home', 'away'));

-- ============================================================================
-- PICKS — flat unit stake (used for evaluation, not for actual betting)
-- ============================================================================
-- Real bets still use `calculator_stake` (Kelly-derived). `flat_unit_stake`
-- is the normalized 1-unit stake used for unbiased ROI evaluation, removing
-- bet-sizing noise that would otherwise mask the underlying edge.
alter table picks add column if not exists flat_unit_stake numeric default 1.0;

-- ============================================================================
-- PICKS — raw calculator outputs (separated from AI-adjusted values)
-- ============================================================================
-- The existing `calculator_prob` / `calculator_ev` columns currently hold
-- AI-adjusted values (the persistence code reads from
-- `topVote.pick.finalProbability` in /api/analyze/route.ts). To evaluate the
-- math layer and the AI layer separately for calibration, we need the raw
-- pre-AI values stored alongside.
alter table picks add column if not exists raw_calculator_prob numeric;
alter table picks add column if not exists raw_calculator_tier text
  check (raw_calculator_tier in ('HIGH', 'MEDIUM', 'LOW', 'REJECT'));

-- ============================================================================
-- PICKS — modifier breakdown (extracted from ai_modifiers JSON for queries)
-- ============================================================================
-- These already exist inside the `ai_modifiers` JSON column, but extracting
-- them into typed numeric columns makes slicing/filtering analyses much
-- faster and avoids the need for jsonb operators in every query.
alter table picks add column if not exists pace_modifier numeric default 0;
alter table picks add column if not exists injury_modifier numeric default 0;

-- ============================================================================
-- PICKS — indexes for new query patterns
-- ============================================================================
create index if not exists picks_bookmaker_idx on picks(bookmaker);
create index if not exists picks_closing_snapshot_idx
  on picks(closing_snapshot_at)
  where closing_snapshot_at is not null;

-- ============================================================================
-- SYSTEM_ALERTS — rules engine output
-- ============================================================================
-- One row per triggered monitoring rule (e.g. "100-Pick CLV Check",
-- "7-Day CLV Decline", "Drawdown 30%"). The home page reads unacknowledged
-- rows and renders them as the system status banner.
--
-- Lifecycle:
--   1. Daily cron runs `alertEvaluator.ts`, evaluates each rule against
--      current stats, inserts a row when a rule triggers.
--   2. User opens app → SystemStatusCard queries unacknowledged rows.
--   3. User clicks ACKNOWLEDGE / DISMISS → update sets `acknowledged_at` or
--      `dismissed = true`.
--   4. Acknowledged rows are kept forever as an audit trail.
create table if not exists system_alerts (
  id uuid primary key default gen_random_uuid(),
  rule_id text not null,                 -- e.g. 'milestone-100-picks'
  rule_name text not null,               -- human-readable name
  severity text not null check (severity in ('info', 'warning', 'critical')),
  message text not null,                 -- pre-rendered English message
  metadata jsonb,                        -- captured stats at trigger time
  triggered_at timestamptz not null default now(),
  acknowledged_at timestamptz,
  acknowledged_by text,
  dismissed boolean not null default false,
  auto_action_taken text                 -- description of any auto-action run
);

-- Most common query: "show me unacknowledged alerts ordered newest first"
create index if not exists system_alerts_unack_idx
  on system_alerts(triggered_at desc)
  where acknowledged_at is null and dismissed = false;

-- For deduplication: "has this rule fired before?"
create index if not exists system_alerts_rule_idx on system_alerts(rule_id);

-- Enable RLS to match existing tables (single-user app, anon key full access)
alter table system_alerts enable row level security;
create policy "allow anon all on system_alerts"
  on system_alerts for all using (true) with check (true);
