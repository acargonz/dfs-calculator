// Probe free NBA box-score data sources to find a balldontlie /v1/stats
// replacement. The current BALLDONTLIE_API_KEY can't access /v1/stats
// (requires paid ALL-STAR tier $9.99/mo), so /api/resolve-picks is broken
// until we either:
//   (a) upgrade the balldontlie tier, or
//   (b) swap to a free alternative (ESPN, pbpstats, NBA.com stats, etc.)
//
// This script tests each candidate and prints which ones return usable
// per-player box-score data for a known past date (2026-04-06).
//
// Usage:
//   node scripts/probe-boxscores.mjs

const DATE_ISO = '2026-04-06'; // yyyy-mm-dd
const DATE_COMPACT = DATE_ISO.replaceAll('-', ''); // yyyymmdd

function ok(label) { console.log(`  ✅ ${label}`); }
function bad(label) { console.log(`  ❌ ${label}`); }
function info(label) { console.log(`  ℹ  ${label}`); }

async function fetchJson(url, headers = {}) {
  const res = await fetch(url, { headers });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}

async function probeEspnScoreboard() {
  console.log('\n=== ESPN Scoreboard (free, no auth) ===');
  const url = `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${DATE_COMPACT}`;
  const { status, json } = await fetchJson(url);
  info(`HTTP ${status}`);
  if (!json) return bad('no JSON');
  const events = json.events ?? [];
  info(`${events.length} events on ${DATE_ISO}`);
  if (events.length > 0) {
    const first = events[0];
    info(`First game: ${first.name} (id ${first.id})`);
    ok('Scoreboard lists games');
    return first.id;
  }
  bad('No events');
  return null;
}

async function probeEspnGameSummary(gameId) {
  if (!gameId) return;
  console.log('\n=== ESPN Game Summary (per-player box) ===');
  const url = `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=${gameId}`;
  const { status, json } = await fetchJson(url);
  info(`HTTP ${status}`);
  if (!json) return bad('no JSON');

  const bx = json.boxscore;
  if (!bx) return bad('no boxscore node');
  const players = bx.players ?? [];
  info(`${players.length} team blocks`);
  if (players.length === 0) return bad('no player data');

  for (const team of players.slice(0, 1)) {
    const stats = team.statistics?.[0];
    const labels = stats?.labels ?? [];
    const athletes = stats?.athletes ?? [];
    info(`Team: ${team.team?.displayName ?? '?'}`);
    info(`Stat labels (${labels.length}): ${labels.join(', ')}`);
    info(`Athletes: ${athletes.length}`);
    if (athletes.length > 0) {
      const sample = athletes[0];
      const name = sample.athlete?.displayName ?? '?';
      info(`First athlete: ${name}`);
      info(`Stats row: ${sample.stats?.join(' | ') ?? '?'}`);
      info(`DNP: ${sample.didNotPlay ?? '?'}, active: ${sample.active ?? '?'}`);
    }
  }
  ok('ESPN summary returns per-player stats');
}

async function probePbpStatsDateRange() {
  console.log('\n=== pbpstats (totals with date range) ===');
  const url = `https://api.pbpstats.com/get-totals/nba?Season=2025-26&SeasonType=Regular+Season&Type=Player&FromDate=${DATE_ISO}&ToDate=${DATE_ISO}`;
  const { status, json } = await fetchJson(url);
  info(`HTTP ${status}`);
  if (!json) return bad('no JSON');
  const rows = json.multi_row_table_data ?? [];
  info(`${rows.length} rows for date range ${DATE_ISO}..${DATE_ISO}`);
  if (rows.length === 0) return bad('empty — pbpstats may not support FromDate/ToDate filters');
  ok('pbpstats date-range works');
  info(`Sample keys: ${Object.keys(rows[0]).slice(0, 10).join(', ')}`);
}

async function probePbpStatsGameLogs() {
  console.log('\n=== pbpstats (game logs) ===');
  const url = `https://api.pbpstats.com/get-game-logs/nba?Season=2025-26&SeasonType=Regular+Season&Type=Player&FromDate=${DATE_ISO}&ToDate=${DATE_ISO}`;
  const { status, json } = await fetchJson(url);
  info(`HTTP ${status}`);
  if (!json) return bad('no JSON');
  const rows = json.multi_row_table_data ?? [];
  info(`${rows.length} rows`);
  if (rows.length > 0) {
    ok('pbpstats game-logs works');
    info(`Sample keys: ${Object.keys(rows[0]).slice(0, 12).join(', ')}`);
    info(`First row: ${JSON.stringify(rows[0]).slice(0, 300)}`);
  } else {
    bad('empty');
  }
}

async function probeNbaStats() {
  console.log('\n=== NBA.com /stats (unofficial but public) ===');
  const url = `https://stats.nba.com/stats/leaguedashplayerstats?College=&Conference=&Country=&DateFrom=${DATE_ISO}&DateTo=${DATE_ISO}&Division=&DraftPick=&DraftYear=&GameScope=&GameSegment=&Height=&LastNGames=0&LeagueID=00&Location=&MeasureType=Base&Month=0&OpponentTeamID=0&Outcome=&PORound=0&PaceAdjust=N&PerMode=Totals&Period=0&PlayerExperience=&PlayerPosition=&PlusMinus=N&Rank=N&Season=2025-26&SeasonSegment=&SeasonType=Regular+Season&ShotClockRange=&StarterBench=&TeamID=0&TwoWay=0&VsConference=&VsDivision=&Weight=`;
  try {
    const { status, json } = await fetchJson(url, {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Referer: 'https://www.nba.com/',
    });
    info(`HTTP ${status}`);
    if (!json) return bad('no JSON (blocked?)');
    const sets = json.resultSets?.[0];
    if (!sets) return bad('no resultSets');
    const rows = sets.rowSet ?? [];
    info(`${rows.length} player rows`);
    info(`Headers: ${sets.headers?.slice(0, 15).join(', ')}`);
    if (rows.length > 0) ok('NBA.com stats works');
  } catch (err) {
    bad(`error: ${err.message}`);
  }
}

async function main() {
  console.log(`Probing free NBA box-score sources for date ${DATE_ISO}...`);
  const gameId = await probeEspnScoreboard();
  await probeEspnGameSummary(gameId);
  await probePbpStatsDateRange();
  await probePbpStatsGameLogs();
  await probeNbaStats();
  console.log('\nDone.');
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
