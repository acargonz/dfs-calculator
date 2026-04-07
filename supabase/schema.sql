-- DFS Calculator — Supabase schema
-- Run this once in the Supabase SQL editor to bootstrap all tables.
--
-- Free tier limits (500 MB Postgres, 50 k MAU) are far more than this app
-- will ever hit. Indexes are small since all queries are date-scoped.

-- ============================================================================
-- prompt_versions: versioned Algorithmic Prompts for AI analysis
-- ============================================================================
create table if not exists prompt_versions (
  id uuid primary key default gen_random_uuid(),
  version_number integer not null unique,
  content text not null,
  change_summary text,
  parent_version_id uuid references prompt_versions(id),
  status text not null default 'active' check (status in ('active', 'archived', 'draft')),
  created_at timestamptz not null default now(),
  created_by text
);

create index if not exists prompt_versions_status_idx on prompt_versions(status);

-- ============================================================================
-- analyses: one row per AI analysis run
-- ============================================================================
create table if not exists analyses (
  id uuid primary key default gen_random_uuid(),
  date date not null,
  prompt_version_id uuid references prompt_versions(id),
  ai_model text not null,          -- model id from MODEL_CATALOG in src/lib/aiAnalysis.ts
  calculator_results jsonb not null,
  injury_context text,
  lineup_context text,
  ai_response jsonb not null,       -- raw + structured parse
  token_count integer,
  duration_ms integer,
  created_at timestamptz not null default now()
);

create index if not exists analyses_date_idx on analyses(date);
create index if not exists analyses_prompt_version_idx on analyses(prompt_version_id);

-- ============================================================================
-- picks: individual player picks within an analysis
-- ============================================================================
create table if not exists picks (
  id uuid primary key default gen_random_uuid(),
  analysis_id uuid references analyses(id) on delete cascade,
  date date not null,
  player_name text not null,
  team text,
  opponent text,
  stat_type text not null,
  line numeric not null,
  direction text not null check (direction in ('over', 'under')),

  -- Calculator outputs
  calculator_prob numeric,
  calculator_ev numeric,
  calculator_tier text,             -- HIGH / MEDIUM / LOW / REJECT
  calculator_stake numeric,

  -- AI outputs
  ai_confidence_tier text,          -- A / B / C / REJECT
  ai_reasoning text,
  ai_flags jsonb,                   -- array of { type, severity, note }
  ai_modifiers jsonb,               -- { pace, injury, matchup, etc. }

  -- Resolution
  actual_value numeric,
  won boolean,
  pushed boolean default false,
  resolved_at timestamptz,

  -- Bet-time odds (American format) — snapshotted at pick creation
  bet_odds_over integer,
  bet_odds_under integer,

  -- Closing line + odds — snapshotted ~5 min before tip-off by cron.
  -- NULL means the prop was pulled or the snapshot cron failed.
  -- Critical for CLV (Closing Line Value) tracking.
  closing_odds_over integer,
  closing_odds_under integer,
  closing_line numeric,
  closing_snapshot_at timestamptz,

  -- Sportsbook + game context for slicing analyses
  bookmaker text,
  home_away text check (home_away in ('home', 'away')),

  -- Flat 1-unit stake — used for evaluation/calibration only,
  -- not for actual bet sizing (calculator_stake handles that).
  -- Removes bet-sizing noise that would otherwise mask true edge.
  flat_unit_stake numeric default 1.0,

  -- Raw calculator outputs. The existing calculator_* columns hold
  -- AI-adjusted values; these capture the pre-AI math layer separately
  -- so we can evaluate the math layer and the AI layer independently.
  raw_calculator_prob numeric,
  raw_calculator_tier text check (raw_calculator_tier in ('HIGH', 'MEDIUM', 'LOW', 'REJECT')),

  -- Modifier breakdown (extracted from ai_modifiers JSON for query speed)
  pace_modifier numeric default 0,
  injury_modifier numeric default 0,

  created_at timestamptz not null default now()
);

create index if not exists picks_analysis_idx on picks(analysis_id);
create index if not exists picks_date_idx on picks(date);
create index if not exists picks_player_idx on picks(player_name);
create index if not exists picks_unresolved_idx on picks(date) where won is null;
create index if not exists picks_bookmaker_idx on picks(bookmaker);
create index if not exists picks_closing_snapshot_idx
  on picks(closing_snapshot_at)
  where closing_snapshot_at is not null;

-- ============================================================================
-- slips: multi-leg parlay recommendations from AI
-- ============================================================================
create table if not exists slips (
  id uuid primary key default gen_random_uuid(),
  analysis_id uuid references analyses(id) on delete cascade,
  date date not null,
  platform text not null,           -- 'prizepicks' / 'underdog' / 'pick6'
  slip_type text,                   -- 'power' / 'flex' / 'champions' / etc.
  legs_count integer not null,
  stake_amount numeric,
  expected_payout numeric,
  pick_ids uuid[] not null,         -- references picks(id)
  won boolean,
  actual_payout numeric,
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists slips_date_idx on slips(date);
create index if not exists slips_analysis_idx on slips(analysis_id);

-- ============================================================================
-- daily_summaries: rolled-up stats per day per prompt version
-- ============================================================================
create table if not exists daily_summaries (
  id uuid primary key default gen_random_uuid(),
  date date not null,
  prompt_version_id uuid references prompt_versions(id),
  ai_model text not null,
  total_picks integer not null default 0,
  wins integer not null default 0,
  losses integer not null default 0,
  pushes integer not null default 0,
  pending integer not null default 0,
  win_pct numeric,
  roi numeric,                      -- cumulative ROI for the slate
  profit_loss numeric,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(date, prompt_version_id, ai_model)
);

create index if not exists daily_summaries_date_idx on daily_summaries(date);

-- ============================================================================
-- system_alerts: rules engine output (drives the home page status banner)
-- ============================================================================
-- One row per triggered monitoring rule (e.g. "100-Pick CLV Check",
-- "7-Day CLV Decline", "Drawdown 30%"). The home page reads unacknowledged
-- rows and renders them as the system status banner.
--
-- Lifecycle:
--   1. Daily cron evaluates all rules in src/lib/monitoringRules.ts
--      against current stats and inserts a row when a rule triggers.
--   2. User opens app → SystemStatusCard queries unacknowledged rows.
--   3. User clicks ACKNOWLEDGE / DISMISS → update row.
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

create index if not exists system_alerts_unack_idx
  on system_alerts(triggered_at desc)
  where acknowledged_at is null and dismissed = false;
create index if not exists system_alerts_rule_idx on system_alerts(rule_id);

-- ============================================================================
-- Row Level Security — allow anon key full access for single-user app
-- ============================================================================
alter table prompt_versions enable row level security;
alter table analyses enable row level security;
alter table picks enable row level security;
alter table slips enable row level security;
alter table daily_summaries enable row level security;
alter table system_alerts enable row level security;

-- Permissive policies (single-user app, anon key only)
create policy "allow anon all on prompt_versions" on prompt_versions for all using (true) with check (true);
create policy "allow anon all on analyses" on analyses for all using (true) with check (true);
create policy "allow anon all on picks" on picks for all using (true) with check (true);
create policy "allow anon all on slips" on slips for all using (true) with check (true);
create policy "allow anon all on daily_summaries" on daily_summaries for all using (true) with check (true);
create policy "allow anon all on system_alerts" on system_alerts for all using (true) with check (true);
