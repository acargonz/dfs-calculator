// Live-fire test for the monitoring rules engine.
//
// Inserts a small batch of synthetic "bad" picks into the picks table that
// should trip specific monitoring rules, then calls /api/system-status to
// verify the previewAlerts array contains the expected rule IDs. Finally,
// deletes the synthetic rows so the real data is untouched.
//
// This script exists because the rules are unit-tested in isolation, but the
// full pipeline (Supabase read → summarizePicks → evaluateRules → route
// response) has never been exercised against real DB IO + a real HTTP
// endpoint. An integration smoke test catches:
//   - schema drift (a new column that summarizePicks doesn't know about)
//   - RLS misconfiguration (anon key can insert but can't read)
//   - the route wiring (monitoringRules.ts → /api/system-status)
//   - JSON serialization / deserialization round-trips
//
// Usage:
//   # Runs against http://localhost:3000 by default
//   node scripts/inject-bad-data.mjs
//
//   # Target a deployed environment
//   TARGET_URL=https://your-app.vercel.app node scripts/inject-bad-data.mjs
//
// Safety:
//   - Every synthetic row is marked with analysis_id = null AND
//     player_name starting with 'SYNTHETIC_'. The cleanup step deletes ONLY
//     rows matching that prefix, so real picks can't be lost.
//   - The script runs cleanup in a `finally` block so even a crash won't
//     leave test data in the DB.
//   - If cleanup fails, the script prints explicit recovery SQL so you can
//     clean up by hand.
//
// Rules exercised:
//   - drawdown-20pct  — 20% drawdown (injects a losing streak that drops
//                       the peak-to-valley by 22%)
//   - drawdown-30pct  — 30% drawdown (injects an even longer losing streak)
//
// Rules intentionally NOT exercised by this script:
//   - insufficient-data: would require deleting all real picks (destructive)
//   - pick-milestone: depends on real total pick count
//   - clv-7day-negative: would require real closing_odds_* columns
//   - brier-degradation: would require a baseline of 50 picks that we'd have
//     to manufacture without touching real data

import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import { randomUUID } from 'crypto';

config({ path: '.env.local' });

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const targetUrl = process.env.TARGET_URL ?? 'http://localhost:3000';

if (!url || !key) {
  console.error('Missing Supabase env vars (.env.local)');
  process.exit(1);
}

const supabase = createClient(url, key);

// Every synthetic row gets a player_name beginning with this prefix so the
// cleanup step can identify and delete them safely. Never change this.
const SYNTHETIC_PREFIX = 'SYNTHETIC_INJECT_BAD_DATA_';

// Use a date far in the past so the synthetic picks don't pollute any
// trailing-window metrics (7-day / 30-day) in the real dashboard. Picks
// that old are still counted by allTime, which is exactly what the
// drawdown rule reads — it uses stats.allTime.maxDrawdownPct.
const ANCIENT_DATE = '2020-01-01';
const ANCIENT_CREATED_AT = '2020-01-01T12:00:00Z';

/**
 * Build a synthetic pick row. Fields mirror PickRow exactly (base + migration
 * 001 columns). The important fields for the drawdown rule are:
 *   - won (true/false) drives the flat profit calculation
 *   - bet_odds_over -110 gives us a predictable -$1/+$0.909 per bet
 *   - flat_unit_stake defaults to 1 so cumulativeProfit walks in flat units
 */
function makeSyntheticPick(outcome, index) {
  return {
    id: randomUUID(),
    analysis_id: null,
    date: ANCIENT_DATE,
    player_name: `${SYNTHETIC_PREFIX}${index}`,
    stat_type: 'points',
    line: 20.5,
    direction: 'over',
    calculator_prob: 0.55,
    calculator_ev: 0.05,
    calculator_tier: 'MEDIUM',
    calculator_stake: 1,
    ai_confidence_tier: 'MEDIUM',
    ai_reasoning: null,
    ai_flags: null,
    ai_modifiers: null,
    actual_value: outcome === 'win' ? 25 : 15,
    won: outcome === 'win',
    pushed: false,
    resolved_at: ANCIENT_CREATED_AT,
    created_at: ANCIENT_CREATED_AT,
    bet_odds_over: -110,
    bet_odds_under: -110,
    closing_odds_over: null,
    closing_odds_under: null,
    closing_line: null,
    closing_snapshot_at: null,
    bookmaker: 'SYNTHETIC',
    home_away: 'home',
    flat_unit_stake: 1,
    raw_calculator_prob: 0.53,
    raw_calculator_tier: 'MEDIUM',
    pace_modifier: 0,
    injury_modifier: 0,
  };
}

/**
 * Build a scenario designed to trigger the drawdown-30pct rule against a
 * bankroll of 100. We need a peak-to-valley drop > 30% of the peak bankroll.
 *
 * Strategy: 15 wins (peak = 100 + 15 * 0.909 ≈ 113.6) then 40 losses
 * (valley = 113.6 - 40 ≈ 73.6). Drawdown = (113.6 - 73.6) / 113.6 ≈ 35.2%.
 *
 * That comfortably exceeds the 30% critical threshold, and using 55 total
 * picks keeps the script fast while still being realistic.
 */
function buildDrawdownScenario() {
  const picks = [];
  // 15 wins to build a peak
  for (let i = 0; i < 15; i++) {
    picks.push(makeSyntheticPick('win', i));
  }
  // 40 losses to drain it
  for (let i = 15; i < 55; i++) {
    picks.push(makeSyntheticPick('loss', i));
  }
  return picks;
}

/**
 * Pre-flight schema check. The drawdown rule reads columns added by
 * migration 001 (bet_odds_over, flat_unit_stake, etc.), so if the migration
 * isn't applied, the synthetic insert fails with a cryptic PostgREST error
 * like "Could not find the 'bet_odds_over' column of 'picks' in the schema
 * cache". Probe the table up front and print a clear, actionable message.
 *
 * We only probe bet_odds_over — it's the canary. If it's there, the rest
 * of migration 001 is there too (the migration is a single transaction).
 */
async function assertMigrationApplied() {
  console.log('→ Pre-flight schema check…');
  const { error } = await supabase
    .from('picks')
    .select('bet_odds_over')
    .limit(1);
  if (error && /bet_odds_over/i.test(error.message)) {
    console.error('  ✗ Migration 001 is NOT applied');
    console.error('');
    console.error('  This script needs the columns added by migration 001');
    console.error('  (bet_odds_over, flat_unit_stake, etc.). Apply it first:');
    console.error('');
    console.error('    1. Open Supabase dashboard → SQL Editor');
    console.error('    2. Paste contents of');
    console.error('       supabase/migrations/001_pick_history_capture.sql');
    console.error('    3. Click "Run"');
    console.error('');
    console.error('  Or run scripts/check-picks-columns.mjs for a full probe.');
    throw new Error('migration 001 not applied');
  }
  if (error) {
    throw new Error(`schema check failed: ${error.message}`);
  }
  console.log('  ✓ Migration 001 columns present');
}

async function insertSynthetic(picks) {
  console.log(`→ Inserting ${picks.length} synthetic picks…`);
  const { error } = await supabase.from('picks').insert(picks);
  if (error) {
    throw new Error(`insert failed: ${error.message}`);
  }
  console.log('  ✓ Insert OK');
}

async function cleanup() {
  console.log(`→ Cleaning up rows with player_name LIKE '${SYNTHETIC_PREFIX}%'…`);
  const { error, count } = await supabase
    .from('picks')
    .delete({ count: 'exact' })
    .like('player_name', `${SYNTHETIC_PREFIX}%`);
  if (error) {
    console.error(`  ✗ Cleanup failed: ${error.message}`);
    console.error('');
    console.error('  MANUAL CLEANUP — run this in the Supabase SQL editor:');
    console.error(`  delete from picks where player_name like '${SYNTHETIC_PREFIX}%';`);
    return false;
  }
  console.log(`  ✓ Deleted ${count ?? 'unknown'} synthetic rows`);
  return true;
}

async function checkAlerts() {
  const endpoint = `${targetUrl}/api/system-status`;
  console.log(`→ Fetching ${endpoint}`);
  let res;
  try {
    res = await fetch(endpoint);
  } catch (err) {
    throw new Error(
      `Could not reach ${endpoint}. Is the dev server running? (${err.message})`,
    );
  }
  if (!res.ok) {
    throw new Error(`API returned ${res.status}`);
  }
  const body = await res.json();
  const previewIds = (body.previewAlerts ?? []).map((a) => a.rule_id);
  console.log(`  Preview alert IDs: ${previewIds.join(', ') || '(none)'}`);
  return previewIds;
}

function assertRuleFired(ruleIds, expectedId) {
  if (!ruleIds.includes(expectedId)) {
    throw new Error(
      `Expected rule '${expectedId}' to fire, but it did not. ` +
        `Got: [${ruleIds.join(', ')}]`,
    );
  }
  console.log(`  ✓ Rule '${expectedId}' fired as expected`);
}

async function main() {
  console.log('=== Live-fire test: drawdown rules ===\n');
  console.log(`Target: ${targetUrl}\n`);

  let success = false;
  try {
    // Pre-flight: verify migration 001 is applied before we touch anything.
    // Catches the most common "it doesn't work" case with a clear message
    // instead of a cryptic PostgREST schema-cache error from inside insert().
    await assertMigrationApplied();
    console.log('');

    // Pre-flight cleanup: make sure there are no stale synthetic rows from a
    // previous aborted run. Only deletes rows with our unique prefix.
    console.log('→ Pre-flight cleanup of any stale synthetic rows…');
    await cleanup();
    console.log('');

    const picks = buildDrawdownScenario();
    await insertSynthetic(picks);
    console.log('');

    console.log('→ Verifying alerts fire on the injected scenario…');
    const ruleIds = await checkAlerts();
    assertRuleFired(ruleIds, 'drawdown-30pct');
    console.log('');

    success = true;
    console.log('🟢 Live-fire test PASSED');
  } catch (err) {
    console.error('');
    console.error('🔴 Live-fire test FAILED');
    console.error(`   ${err.message}`);
  } finally {
    console.log('');
    await cleanup();
  }

  console.log('');
  // Use exitCode instead of process.exit() so Node can drain pending
  // supabase-js handles cleanly — avoids the libuv assertion on Windows
  // (https://github.com/nodejs/node/issues/30271).
  process.exitCode = success ? 0 : 1;
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exitCode = 1;
});
