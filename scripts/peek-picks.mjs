// One-off reconnaissance script. Dumps a summary of the picks table so we
// can understand what's already in there before running E2E smoke tests.
// Safe to run any time — read-only.
//
// Usage:
//   node scripts/peek-picks.mjs
//
// This script intentionally only queries base-schema columns (pre-migration-001)
// so it works even before migration 001 is applied. Once migration 001 is live,
// we can extend it to include CLV/bookmaker/home_away columns.

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

async function main() {
  console.log('=== Picks table reconnaissance ===\n');

  // Grab every row using only base-schema columns (no migration 001 deps)
  const { data: allPicks, error } = await supabase
    .from('picks')
    .select(
      'id, analysis_id, date, player_name, stat_type, line, direction, ' +
        'calculator_tier, ai_confidence_tier, won, pushed, actual_value, ' +
        'created_at, resolved_at',
    )
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Query failed:', error);
    process.exit(1);
  }

  console.log(`Total picks: ${allPicks.length}`);

  // Count resolution states manually
  const wins = allPicks.filter((p) => p.won === true && !p.pushed);
  const losses = allPicks.filter((p) => p.won === false && !p.pushed);
  const pending = allPicks.filter((p) => p.won === null && !p.pushed);
  const pushed = allPicks.filter((p) => p.pushed === true);

  console.log(`Wins:    ${wins.length}`);
  console.log(`Losses:  ${losses.length}`);
  console.log(`Pushes:  ${pushed.length}`);
  console.log(`Pending: ${pending.length}`);
  if (wins.length + losses.length > 0) {
    const hitRate = wins.length / (wins.length + losses.length);
    console.log(`Hit rate: ${(hitRate * 100).toFixed(1)}% (on ${wins.length + losses.length} decided picks)`);
  }

  // Analyses
  const analysisIds = new Set(allPicks.map((p) => p.analysis_id).filter(Boolean));
  console.log(`\nDistinct analyses: ${analysisIds.size}`);

  // Date breakdown
  const byDate = new Map();
  for (const p of allPicks) {
    byDate.set(p.date, (byDate.get(p.date) ?? 0) + 1);
  }
  console.log(`\nPicks per date:`);
  for (const [date, count] of [...byDate.entries()].sort()) {
    console.log(`  ${date}: ${count}`);
  }

  // Peek at latest 10 resolved rows to sanity-check the outcomes
  const resolved = allPicks.filter(
    (p) => p.won !== null || p.pushed,
  );
  console.log(`\nLatest 10 resolved picks:`);
  console.log(
    '  Date        Player                   Stat       Line   Dir    Actual  Outcome',
  );
  console.log(
    '  ──────────  ───────────────────────  ─────────  ─────  ─────  ──────  ───────',
  );
  for (const p of resolved.slice(0, 10)) {
    const outcome = p.pushed
      ? 'PUSH'
      : p.won === true
      ? 'WIN'
      : p.won === false
      ? 'LOSS'
      : 'PENDING';
    console.log(
      `  ${p.date}  ${p.player_name.slice(0, 23).padEnd(23)}  ${p.stat_type
        .slice(0, 9)
        .padEnd(9)}  ${String(p.line).padStart(5)}  ${p.direction.padEnd(5)}  ${String(
        p.actual_value ?? '—',
      ).padStart(6)}  ${outcome}`,
    );
  }

  // Breakdown by AI confidence tier
  if (wins.length + losses.length > 0) {
    console.log(`\nHit rate by AI confidence tier:`);
    const tiers = ['A', 'B', 'C', 'HIGH', 'MEDIUM', 'LOW', 'REJECT'];
    for (const t of tiers) {
      const tierPicks = [...wins, ...losses].filter(
        (p) => p.ai_confidence_tier === t,
      );
      if (tierPicks.length === 0) continue;
      const tierWins = tierPicks.filter((p) => p.won === true).length;
      const rate = tierWins / tierPicks.length;
      console.log(
        `  ${t.padEnd(6)}: ${tierWins}/${tierPicks.length} = ${(rate * 100).toFixed(1)}%`,
      );
    }
  }
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
