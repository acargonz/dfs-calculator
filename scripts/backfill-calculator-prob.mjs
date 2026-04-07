#!/usr/bin/env node
/**
 * Retroactively fix picks.calculator_prob / picks.calculator_ev rows that
 * were poisoned by the pre-fix `normalizeAIPick` string-handling bug.
 *
 * See: supabase/migrations/002_backfill_calculator_prob.sql
 *
 * This script is the Node equivalent of that SQL migration — it uses the
 * Supabase JS client (same pattern as scripts/seed-prompt.mjs) so you don't
 * need to open the Supabase SQL editor to run it.
 *
 * Usage:
 *   node scripts/backfill-calculator-prob.mjs             # dry run (default)
 *   node scripts/backfill-calculator-prob.mjs --apply     # actually write
 *
 * Idempotent: safe to re-run. Rows already in [0,1] (for prob) and [-1,1]
 * (for ev) are left untouched.
 */

import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';

config({ path: '.env.local' });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error(
    'Missing NEXT_PUBLIC_SUPABASE_URL or a SUPABASE_SERVICE_ROLE_KEY/ANON_KEY in .env.local',
  );
  process.exit(1);
}

const APPLY = process.argv.includes('--apply');

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

/**
 * Mirror of normalizeAIPick from src/lib/aiAnalysis.ts — applied to DB rows
 * that were written by the buggy pre-fix code.
 *
 * Returns `{ prob, ev }` — the corrected values, or `null` to mean "set
 * this column to NULL" (value was unrecoverable garbage).
 */
function normalizeRow(row) {
  const before = { prob: row.calculator_prob, ev: row.calculator_ev };
  const after = { prob: row.calculator_prob, ev: row.calculator_ev };

  // ---- calculator_prob → [0, 1] -----------------------------------------
  if (after.prob !== null && Number.isFinite(after.prob)) {
    if (after.prob > 1) after.prob = after.prob / 100;
    if (after.prob < 0 || after.prob > 1) after.prob = null;
  } else if (after.prob !== null) {
    after.prob = null;
  }

  // ---- calculator_ev → [-1, 1] ------------------------------------------
  if (after.ev !== null && Number.isFinite(after.ev)) {
    if (Math.abs(after.ev) > 1) after.ev = after.ev / 100;
    if (Math.abs(after.ev) > 1) after.ev = null;
  } else if (after.ev !== null) {
    after.ev = null;
  }

  const changed = after.prob !== before.prob || after.ev !== before.ev;
  return { before, after, changed };
}

async function main() {
  console.log(`Backfill mode: ${APPLY ? 'APPLY (will write)' : 'DRY RUN (no writes)'}`);
  console.log('Fetching picks rows...');

  // Fetch all picks — we filter in JS to keep the script simple and because
  // the Supabase JS `or` filter syntax for numeric ranges is clunky.
  const { data: rows, error: fetchErr } = await supabase
    .from('picks')
    .select('id, calculator_prob, calculator_ev')
    .order('date', { ascending: false })
    .limit(5000);

  if (fetchErr) {
    console.error('Fetch failed:', fetchErr);
    process.exit(1);
  }

  console.log(`Loaded ${rows.length} rows.`);

  const plan = rows
    .map((row) => ({ id: row.id, ...normalizeRow(row) }))
    .filter((r) => r.changed);

  console.log(`Rows needing backfill: ${plan.length}`);

  if (plan.length === 0) {
    console.log('Nothing to do. Exiting.');
    return;
  }

  // Summary of the types of fixes we're about to apply.
  let probDivides = 0;
  let probNulls = 0;
  let evDivides = 0;
  let evNulls = 0;

  for (const p of plan) {
    if (p.before.prob !== p.after.prob) {
      if (p.after.prob === null) probNulls++;
      else probDivides++;
    }
    if (p.before.ev !== p.after.ev) {
      if (p.after.ev === null) evNulls++;
      else evDivides++;
    }
  }

  console.log('Plan summary:');
  console.log(`  calculator_prob: ${probDivides} divides, ${probNulls} nulls`);
  console.log(`  calculator_ev:   ${evDivides} divides, ${evNulls} nulls`);

  // Show a few example rows so you can eyeball the rewrite before committing.
  console.log('\nSample rows (first 5):');
  for (const p of plan.slice(0, 5)) {
    console.log(
      `  id=${p.id}  prob: ${p.before.prob} → ${p.after.prob}   ev: ${p.before.ev} → ${p.after.ev}`,
    );
  }

  if (!APPLY) {
    console.log('\nDRY RUN complete. Re-run with --apply to commit changes.');
    return;
  }

  // Write back in small batches to keep any single failure recoverable.
  console.log(`\nApplying ${plan.length} updates...`);
  let ok = 0;
  let fail = 0;
  for (const p of plan) {
    const { error } = await supabase
      .from('picks')
      .update({
        calculator_prob: p.after.prob,
        calculator_ev: p.after.ev,
      })
      .eq('id', p.id);

    if (error) {
      fail++;
      console.error(`  id=${p.id} FAILED: ${error.message}`);
    } else {
      ok++;
    }
  }

  console.log(`\nDone. ${ok} updated, ${fail} failed.`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
