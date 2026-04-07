-- ============================================================================
-- Migration 002 — Backfill picks.calculator_prob / picks.calculator_ev
-- ============================================================================
--
-- Fixes the "AI Prob % showing 6000%+" bug in the pick history tab.
--
-- Root cause: `normalizeAIPick` in src/lib/aiAnalysis.ts had a
-- `typeof === 'number'` guard that skipped stringified numbers. When an AI
-- model returned `finalProbability: "60"` (string), the normalizer no-oped,
-- `/api/analyze/route.ts` passed the string into Supabase, and PostgreSQL
-- coerced it to numeric `60`. The history page then rendered `60 * 100 = 6000%`.
--
-- The code fix lives in src/lib/aiAnalysis.ts (normalizeAIPick now handles
-- strings + clamps out-of-range values) and src/app/api/analyze/route.ts
-- (sanitizeProb / sanitizeEV helpers at the DB boundary). This migration
-- retroactively fixes rows that were written by the buggy code.
--
-- Normalization rules (mirrors the TS normalizer):
--   1. calculator_prob should live in [0, 1].
--      - If value is > 1 and <= 100: divide by 100 (percent-encoded).
--      - If value is still outside [0, 1] after that: NULL it out (garbage).
--   2. calculator_ev should live in [-1, 1].
--      - If |value| > 1 and <= 100: divide by 100.
--      - If |value| is still > 1 after that: NULL it out.
--
-- SAFETY:
--   - This is idempotent. Re-running it after a fix is a no-op because all
--     rows are already in range.
--   - We never increase a bad row's magnitude — we only divide or null.
--   - Wrapping in a transaction so a failure rolls everything back cleanly.
--
-- AUDIT TRAIL:
--   We capture the pre-migration stats so you can verify the rewrite.
--   Run the SELECT statements first (review them), then the UPDATE block.
-- ============================================================================

begin;

-- -- PRE-MIGRATION AUDIT -----------------------------------------------------
-- Uncomment to inspect what's about to change before committing.
--
-- select
--   count(*) filter (where calculator_prob > 1)                 as bad_prob_rows,
--   count(*) filter (where calculator_prob > 100)               as garbage_prob_rows,
--   count(*) filter (where abs(calculator_ev) > 1)              as bad_ev_rows,
--   count(*) filter (where abs(calculator_ev) > 100)            as garbage_ev_rows,
--   min(calculator_prob)                                        as min_prob,
--   max(calculator_prob)                                        as max_prob,
--   min(calculator_ev)                                          as min_ev,
--   max(calculator_ev)                                          as max_ev
-- from picks;

-- -- BACKFILL: calculator_prob ----------------------------------------------
-- Step 1: divide percent-encoded rows (1 < value <= 100) by 100.
update picks
set calculator_prob = calculator_prob / 100
where calculator_prob is not null
  and calculator_prob > 1
  and calculator_prob <= 100;

-- Step 2: null out garbage rows that are still out-of-range after step 1.
-- Rows with values > 100 pre-fix (e.g. 5800) become > 1 post-divide, so we
-- catch them here AND any rows that were negative or >100 in the first place.
update picks
set calculator_prob = null
where calculator_prob is not null
  and (calculator_prob < 0 or calculator_prob > 1);

-- -- BACKFILL: calculator_ev ------------------------------------------------
update picks
set calculator_ev = calculator_ev / 100
where calculator_ev is not null
  and (calculator_ev > 1 or calculator_ev < -1)
  and calculator_ev <= 100
  and calculator_ev >= -100;

update picks
set calculator_ev = null
where calculator_ev is not null
  and (calculator_ev < -1 or calculator_ev > 1);

-- -- BACKFILL: raw_calculator_prob -----------------------------------------
-- raw_calculator_prob comes from `rawSide.blendedProb` which is ALWAYS a
-- decimal in [0, 1] in math.ts, so this column should never need backfill.
-- Included as a defensive no-op in case any historical row got polluted.
update picks
set raw_calculator_prob = null
where raw_calculator_prob is not null
  and (raw_calculator_prob < 0 or raw_calculator_prob > 1);

-- -- POST-MIGRATION AUDIT ---------------------------------------------------
-- Uncomment to verify every row is now in range.
--
-- select
--   count(*) filter (where calculator_prob > 1 or calculator_prob < 0) as still_bad_prob,
--   count(*) filter (where abs(calculator_ev) > 1)                    as still_bad_ev
-- from picks;

commit;
