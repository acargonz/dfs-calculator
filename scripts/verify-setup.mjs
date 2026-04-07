// End-to-end verification that Supabase + prompt seeding are complete.
// Run with: node scripts/verify-setup.mjs

import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';

config({ path: '.env.local' });

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!url || !key) {
  console.error('❌ Missing Supabase env vars');
  process.exit(1);
}

const supabase = createClient(url, key);
let pass = 0;
let fail = 0;

function ok(label) { console.log(`✅ ${label}`); pass++; }
function bad(label, err) { console.error(`❌ ${label}:`, err); fail++; }

async function main() {
  console.log('=== DFS Calculator — Setup Verification ===\n');

  // 1. Check each table exists by selecting count
  const tables = ['prompt_versions', 'analyses', 'picks', 'slips', 'daily_summaries'];
  for (const t of tables) {
    const { error, count } = await supabase.from(t).select('*', { count: 'exact', head: true });
    if (error) bad(`Table "${t}" exists`, error.message);
    else ok(`Table "${t}" exists (${count} rows)`);
  }

  // 2. Check Algorithmic Prompt V2 is seeded. V2 is the active prompt —
  // V1 was retired (on-disk file removed) and now only exists as an
  // archived row in legacy Supabase projects for historical FK integrity.
  const { data: prompt, error: promptErr } = await supabase
    .from('prompt_versions')
    .select('version_number, status, content, created_at')
    .eq('version_number', 2)
    .maybeSingle();

  if (promptErr) {
    bad('Prompt V2 query', promptErr.message);
  } else if (!prompt) {
    bad('Prompt V2 seeded', 'No row with version_number=2 found — run `node scripts/seed-prompt.mjs`');
  } else {
    ok(`Prompt V2 seeded (${prompt.content.length} chars, status: ${prompt.status})`);
    if (prompt.content.length < 30000) {
      bad('Prompt V2 length', `suspiciously short: ${prompt.content.length} chars`);
    }
  }

  // 3. Check an active prompt exists
  const { data: active, error: activeErr } = await supabase
    .from('prompt_versions')
    .select('version_number')
    .eq('status', 'active')
    .order('version_number', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (activeErr) bad('Active prompt query', activeErr.message);
  else if (!active) bad('Active prompt', 'No prompt with status=active');
  else ok(`Active prompt: V${active.version_number}`);

  // 4. Check env vars for AI and other APIs
  const envKeys = ['ODDS_API_KEY', 'GEMINI_API_KEY', 'BALLDONTLIE_API_KEY'];
  for (const k of envKeys) {
    if (process.env[k]) ok(`${k} is set`);
    else bad(`${k}`, 'not set in .env.local');
  }

  // 5. Test free ESPN APIs are reachable
  try {
    const res = await fetch('https://site.api.espn.com/apis/site/v2/sports/basketball/nba/injuries');
    if (res.ok) ok('ESPN injuries API reachable');
    else bad('ESPN injuries API', `HTTP ${res.status}`);
  } catch (e) { bad('ESPN injuries API', e.message); }

  // 6. Test PBP Stats API is reachable (needs dynamic season)
  try {
    const year = new Date().getMonth() >= 9 ? new Date().getFullYear() : new Date().getFullYear() - 1;
    const season = `${year}-${String((year + 1) % 100).padStart(2, '0')}`;
    const url = `https://api.pbpstats.com/get-totals/nba?Season=${season}&SeasonType=Regular+Season&Type=Player`;
    const res = await fetch(url);
    if (res.ok) ok(`PBP Stats API reachable (season ${season})`);
    else bad('PBP Stats API', `HTTP ${res.status}`);
  } catch (e) { bad('PBP Stats API', e.message); }

  // 7. Test Odds API is reachable
  if (process.env.ODDS_API_KEY) {
    try {
      const res = await fetch(`https://api.the-odds-api.com/v4/sports/basketball_nba/events?apiKey=${process.env.ODDS_API_KEY}`);
      if (res.ok) ok('Odds API reachable + key valid');
      else bad('Odds API', `HTTP ${res.status}`);
    } catch (e) { bad('Odds API', e.message); }
  }

  // 8. Test Gemini API is reachable (simple ping)
  if (process.env.GEMINI_API_KEY) {
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${process.env.GEMINI_API_KEY}`,
      );
      if (res.ok) ok('Gemini API reachable + key valid');
      else bad('Gemini API', `HTTP ${res.status}`);
    } catch (e) { bad('Gemini API', e.message); }
  }

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
