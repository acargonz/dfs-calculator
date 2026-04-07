// Quick script to verify free injury/lineup sources are available.
// Run with: node scripts/test-espn.mjs

async function j(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

async function main() {
  console.log('=== ESPN NBA Injuries ===');
  try {
    const inj = await j('https://site.api.espn.com/apis/site/v2/sports/basketball/nba/injuries');
    const teams = inj.injuries || [];
    console.log(`Teams with injuries: ${teams.length}`);
    const sample = teams[0];
    if (sample) {
      console.log(`Sample team: ${sample.displayName} — ${sample.injuries?.length || 0} injured players`);
      const p = sample.injuries?.[0];
      if (p) {
        console.log(`  - ${p.athlete?.displayName} (${p.status}) — ${p.shortComment || p.longComment || 'n/a'}`);
      }
    }
  } catch (e) { console.error('injuries:', e.message); }

  console.log('\n=== ESPN NBA Scoreboard ===');
  try {
    const sb = await j('https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard');
    const games = sb.events || [];
    console.log(`Games today: ${games.length}`);
    games.slice(0, 3).forEach((g) => console.log(`  ${g.id}: ${g.name} — ${g.status?.type?.description}`));

    // Try fetching summary for first game → see if starters present
    if (games[0]) {
      console.log('\n=== ESPN Game Summary (first game) ===');
      try {
        const sum = await j(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=${games[0].id}`);
        const rosters = sum.rosters || sum.boxscore?.players || [];
        console.log(`Rosters found: ${rosters.length}`);
        const first = rosters[0];
        if (first) {
          const players = first.roster || first.statistics?.[0]?.athletes || [];
          console.log(`  Team ${first.team?.displayName}: ${players.length} players`);
          const starters = players.filter((p) => p.starter === true || p.position?.displayName);
          console.log(`  Starter flags: ${starters.length}`);
          if (players[0]) console.log('  Sample player keys:', Object.keys(players[0]).slice(0, 8));
        }
      } catch (e) { console.error('summary:', e.message); }
    }
  } catch (e) { console.error('scoreboard:', e.message); }

  console.log('\n=== NBA.com Scoreboard (fallback) ===');
  try {
    const nba = await j('https://cdn.nba.com/static/json/liveData/scoreboard/todaysScoreboard_00.json');
    const games = nba.scoreboard?.games || [];
    console.log(`Games: ${games.length}`);
    games.slice(0, 3).forEach((g) => console.log(`  ${g.gameId}: ${g.awayTeam?.teamTricode} @ ${g.homeTeam?.teamTricode} — ${g.gameStatusText}`));
  } catch (e) { console.error('nba scoreboard:', e.message); }
}

main().catch((e) => { console.error('fatal:', e); process.exit(1); });
