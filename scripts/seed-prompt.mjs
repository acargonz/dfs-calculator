// Seed the active Algorithmic Prompt into Supabase.
//
// Default (insert-only, idempotent):
//   node scripts/seed-prompt.mjs
//
// Force-update the existing row if the on-disk prompt content has changed:
//   node scripts/seed-prompt.mjs --force-update
//
// History
// -------
// V1 was the initial Algorithmic Prompt. It has been retired — the on-disk
// file was removed, and this script no longer seeds it. Any Supabase project
// bootstrapped before April 2026 will still have V1 in the `prompt_versions`
// table with status='archived' (its row is preserved so historical analyses
// with prompt_version_id pointing at V1 still FK-resolve). New environments
// start directly at V2.
//
// V2 is the active prompt and is seeded from `prompts/algorithmic-prompt-v2.txt`.
// It adds the Postseason Context Protocol (Section 0.3a), the Postseason Kelly
// Note (1.5a), and the Postseason Confidence Tier Modifiers (6.1a) on top of
// V1, plus the PrizePicks/Underdog fantasy scoring switch.
//
// --force-update is the supported way to push in-place edits (e.g. scoring
// formula tweaks, new rules) into the already-seeded V2 row. Without the flag,
// the script logs a warning and leaves existing rows untouched, which is the
// safe default.

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { config } from 'dotenv';

config({ path: '.env.local' });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY in .env.local');
  process.exit(1);
}

const FORCE_UPDATE = process.argv.includes('--force-update');

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

/**
 * Idempotently insert one prompt version. Returns the row that exists in
 * the table afterward (either the existing one or the newly inserted one).
 *
 * When --force-update is passed, existing rows whose on-disk content has
 * drifted from the DB copy are updated in place. This is the supported
 * path for pushing prompt edits without creating a throwaway new version.
 */
async function seedVersion({ versionNumber, filePath, summary, parentVersionId }) {
  const content = readFileSync(filePath, 'utf8');
  console.log(`V${versionNumber}: ${content.length} chars, ${content.split('\n').length} lines`);

  const { data: existing, error: checkErr } = await supabase
    .from('prompt_versions')
    .select('id, version_number, status, content')
    .eq('version_number', versionNumber)
    .maybeSingle();

  if (checkErr) {
    console.error(`V${versionNumber} check failed:`, checkErr);
    process.exit(1);
  }

  if (existing) {
    // Detect drift between disk + DB so the user gets a clear signal when
    // an update is pending but --force-update wasn't passed.
    const drifted = existing.content !== content;

    if (drifted && FORCE_UPDATE) {
      const { error: updateErr } = await supabase
        .from('prompt_versions')
        .update({ content, change_summary: summary })
        .eq('id', existing.id);
      if (updateErr) {
        console.error(`V${versionNumber} update failed:`, updateErr);
        process.exit(1);
      }
      console.log(`  V${versionNumber} CONTENT UPDATED in place (id: ${existing.id}).`);
      return { ...existing, content };
    }

    if (drifted && !FORCE_UPDATE) {
      console.log(
        `  V${versionNumber} exists (id: ${existing.id}) but CONTENT DIFFERS from disk.`,
      );
      console.log(
        `  Re-run with --force-update to push the on-disk content into Supabase.`,
      );
      return existing;
    }

    console.log(
      `  V${versionNumber} already exists and matches disk (id: ${existing.id}, status: ${existing.status}).`,
    );
    return existing;
  }

  const { data, error } = await supabase
    .from('prompt_versions')
    .insert({
      version_number: versionNumber,
      content,
      change_summary: summary,
      parent_version_id: parentVersionId ?? null,
      status: 'active',
      created_by: 'seed-script',
    })
    .select()
    .single();

  if (error) {
    console.error(`V${versionNumber} insert failed:`, error);
    process.exit(1);
  }

  console.log(`  V${versionNumber} inserted (id: ${data.id}).`);
  return data;
}

/**
 * Archive any non-V2 prompt versions so V2 is the unique 'active' row.
 * Safe to re-run. This preserves legacy V1 rows (for FK integrity on
 * historical analyses) while guaranteeing the app sees V2 as the
 * currently-active prompt.
 */
async function activateV2(v2) {
  if (!v2) return;

  // Promote V2 → active
  const { error: activateErr } = await supabase
    .from('prompt_versions')
    .update({ status: 'active' })
    .eq('id', v2.id);
  if (activateErr) {
    console.error('Failed to activate V2:', activateErr);
    process.exit(1);
  }
  console.log(`  V2 status: active`);

  // Archive any other prompt rows (e.g., legacy V1) so V2 is the unique
  // active version. Uses a not-equal filter so this stays idempotent.
  const { error: archiveErr } = await supabase
    .from('prompt_versions')
    .update({ status: 'archived' })
    .neq('id', v2.id)
    .eq('status', 'active');
  if (archiveErr) {
    console.error('Failed to archive non-V2 prompts:', archiveErr);
    process.exit(1);
  }
}

async function main() {
  console.log('Seeding Algorithmic Prompt V2...');

  const v2 = await seedVersion({
    versionNumber: 2,
    filePath: 'prompts/algorithmic-prompt-v2.txt',
    summary:
      'V2 — Adds Postseason Context Protocol (Section 0.3a), Postseason Kelly Note (1.5a), ' +
      'and Postseason Confidence Tier Modifiers (6.1a) for NBA Playoffs and Finals. ' +
      'Module C uses the PrizePicks/Underdog fantasy-scoring formula (DK Pick6 has no fantasy props).',
    parentVersionId: null,
  });

  await activateV2(v2);

  console.log('Done.');
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
