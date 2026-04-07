// Probe ESPN game summary + odds endpoint for probable starters
async function j(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

async function main() {
  // Find a game scheduled in the future (not Final)
  const sb = await j('https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard');
  const games = sb.events || [];
  console.log(`All games: ${games.length}`);
  games.forEach((g) => console.log(`  ${g.id} — ${g.shortName} — ${g.status?.type?.description}`));

  // Try the first game (even if Final, rosters will show who started)
  const targetGame = games[0];
  if (!targetGame) {
    console.log('No games today');
    return;
  }

  console.log(`\n=== Summary for ${targetGame.shortName} (${targetGame.id}) ===`);
  const sum = await j(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=${targetGame.id}`);

  // Check boxscore players (this will only be populated AFTER game starts)
  const players = sum.boxscore?.players || [];
  console.log(`boxscore.players teams: ${players.length}`);
  if (players[0]) {
    const teamStats = players[0].statistics?.[0]?.athletes || [];
    console.log(`  ${players[0].team?.displayName} — ${teamStats.length} players in stats`);
    const starters = teamStats.filter((a) => a.starter === true);
    console.log(`  Starters flagged: ${starters.length}`);
    starters.slice(0, 5).forEach((a) => console.log(`    - ${a.athlete?.displayName}`));
  }

  // Check rosters (pre-game probable)
  const rosters = sum.rosters || [];
  console.log(`\nrosters teams: ${rosters.length}`);
  if (rosters[0]) {
    const roster = rosters[0].roster || [];
    console.log(`  ${rosters[0].team?.displayName} — ${roster.length} players in roster`);
    const withPositions = roster.filter((p) => p.position?.displayName);
    console.log(`  With positions: ${withPositions.length}`);
    if (roster[0]) console.log('  Sample keys:', Object.keys(roster[0]).slice(0, 10));
  }

  // Try probables endpoint (used for DFS sites)
  console.log('\n=== Trying team roster endpoint ===');
  try {
    const team = await j('https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/lal/roster');
    const athletes = team.athletes || [];
    console.log(`Lakers roster: ${athletes.length} players`);
    const samples = athletes.slice(0, 5);
    samples.forEach((a) => {
      const inj = a.injuries?.[0];
      console.log(`  ${a.displayName} | ${a.position?.abbreviation} | ${inj?.status || 'Active'}`);
    });
  } catch (e) { console.error('roster:', e.message); }
}

main().catch((e) => { console.error('fatal:', e); process.exit(1); });
