// Probe the picks table one column at a time to learn exactly which
// migration-001 columns are present and which are missing. Read-only.
//
// Usage:
//   node scripts/check-picks-columns.mjs

import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';

config({ path: '.env.local' });

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!url || !key) {
  console.error('Missing Supabase env vars');
  process.exit(1);
}

const supabase = createClient(url, key);

// Columns added by migration 001
const MIGRATION_001_COLUMNS = [
  'bet_odds_over',
  'bet_odds_under',
  'closing_odds_over',
  'closing_odds_under',
  'closing_line',
  'closing_snapshot_at',
  'bookmaker',
  'home_away',
  'flat_unit_stake',
  'raw_calculator_prob',
  'raw_calculator_tier',
  'pace_modifier',
  'injury_modifier',
];

async function columnExists(col) {
  const { error } = await supabase.from('picks').select(col).limit(1);
  return !error || !error.message.includes('does not exist');
}

async function main() {
  console.log('=== Probing picks table columns ===\n');

  let present = 0;
  let missing = 0;

  for (const col of MIGRATION_001_COLUMNS) {
    const exists = await columnExists(col);
    console.log(`${exists ? '✅' : '❌'} ${col}`);
    if (exists) present++;
    else missing++;
  }

  console.log(`\nSummary: ${present} present, ${missing} missing.`);

  // Also check system_alerts table
  const { error: alertErr } = await supabase
    .from('system_alerts')
    .select('id')
    .limit(1);
  console.log(
    `\nsystem_alerts table: ${alertErr ? '❌ missing' : '✅ present'}`,
  );
  if (alertErr) console.log(`  error: ${alertErr.message}`);

  if (missing > 0 || alertErr) {
    console.log('\n→ Migration 001 needs to be applied:');
    console.log('  1. Open Supabase dashboard → SQL Editor');
    console.log('  2. Paste contents of supabase/migrations/001_pick_history_capture.sql');
    console.log('  3. Click "Run"');
    process.exit(1);
  }

  console.log('\n✅ Schema is up to date.');
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
