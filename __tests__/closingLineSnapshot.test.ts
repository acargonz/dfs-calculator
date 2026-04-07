import {
  buildSnapshotPlan,
  buildPropLookup,
  type PendingPick,
  type PropSnapshot,
} from '../src/lib/closingLineSnapshot';
import { matchKey } from '../src/lib/ensembleConsensus';

// ============================================================================
// buildPropLookup
// ============================================================================

describe('buildPropLookup', () => {
  it('returns an empty map for an empty input', () => {
    expect(buildPropLookup([]).size).toBe(0);
  });

  it('keys a single prop by canonical matchKey', () => {
    const lookup = buildPropLookup([
      [
        {
          playerName: 'LeBron James',
          statType: 'points',
          line: 24.5,
          overOdds: -110,
          underOdds: -120,
        },
      ],
    ]);
    const key = matchKey('LeBron James', 'points', 24.5);
    expect(lookup.get(key)).toEqual({
      overOdds: -110,
      underOdds: -120,
      line: 24.5,
    });
  });

  it('flattens props from multiple games into one lookup', () => {
    const lookup = buildPropLookup([
      [
        {
          playerName: 'LeBron James',
          statType: 'points',
          line: 24.5,
          overOdds: -110,
          underOdds: -120,
        },
      ],
      [
        {
          playerName: 'Stephen Curry',
          statType: 'threes',
          line: 4.5,
          overOdds: -105,
          underOdds: -115,
        },
      ],
    ]);
    expect(lookup.size).toBe(2);
    expect(lookup.has(matchKey('LeBron James', 'points', 24.5))).toBe(true);
    expect(lookup.has(matchKey('Stephen Curry', 'threes', 4.5))).toBe(true);
  });

  it('matches keys across casing/whitespace differences', () => {
    const lookup = buildPropLookup([
      [
        {
          playerName: '  LeBron James  ',
          statType: 'POINTS',
          line: 24.5,
          overOdds: -110,
          underOdds: -120,
        },
      ],
    ]);
    // Same canonical key when normalized
    expect(lookup.get(matchKey('lebron james', 'points', 24.5))).toBeDefined();
  });

  it('overwrites duplicate keys with last-write-wins', () => {
    const lookup = buildPropLookup([
      [
        {
          playerName: 'LeBron James',
          statType: 'points',
          line: 24.5,
          overOdds: -110,
          underOdds: -120,
        },
      ],
      [
        {
          playerName: 'LeBron James',
          statType: 'points',
          line: 24.5,
          overOdds: +100,
          underOdds: -130,
        },
      ],
    ]);
    expect(lookup.get(matchKey('LeBron James', 'points', 24.5))).toEqual({
      overOdds: +100,
      underOdds: -130,
      line: 24.5,
    });
  });
});

// ============================================================================
// buildSnapshotPlan
// ============================================================================

const SNAP_TIME = '2026-04-06T23:55:00.000Z';

function makePick(overrides: Partial<PendingPick> = {}): PendingPick {
  return {
    id: 'pick-1',
    player_name: 'LeBron James',
    stat_type: 'points',
    line: 24.5,
    ...overrides,
  };
}

function lookupOf(
  entries: Array<{ pick: { playerName: string; statType: string; line: number }; snap: PropSnapshot }>,
): Map<string, PropSnapshot> {
  const m = new Map<string, PropSnapshot>();
  for (const e of entries) {
    m.set(matchKey(e.pick.playerName, e.pick.statType, e.pick.line), e.snap);
  }
  return m;
}

describe('buildSnapshotPlan', () => {
  it('returns an empty plan when there are no pending picks', () => {
    const plan = buildSnapshotPlan([], new Map(), SNAP_TIME);
    expect(plan.updates).toEqual([]);
    expect(plan.unmatchedCount).toBe(0);
    expect(plan.unmatchedPickIds).toEqual([]);
  });

  it('returns one update when a pending pick matches a live prop', () => {
    const lookup = lookupOf([
      {
        pick: { playerName: 'LeBron James', statType: 'points', line: 24.5 },
        snap: { overOdds: -120, underOdds: -100, line: 24.5 },
      },
    ]);
    const plan = buildSnapshotPlan([makePick()], lookup, SNAP_TIME);
    expect(plan.updates).toHaveLength(1);
    expect(plan.unmatchedCount).toBe(0);
    expect(plan.updates[0]).toEqual({
      pickId: 'pick-1',
      closing_odds_over: -120,
      closing_odds_under: -100,
      closing_line: 24.5,
      closing_snapshot_at: SNAP_TIME,
    });
  });

  it('marks a pick unmatched when no live prop is found', () => {
    const plan = buildSnapshotPlan([makePick()], new Map(), SNAP_TIME);
    expect(plan.updates).toEqual([]);
    expect(plan.unmatchedCount).toBe(1);
    expect(plan.unmatchedPickIds).toEqual(['pick-1']);
  });

  it('uses the passed snapshotTime for closing_snapshot_at (deterministic)', () => {
    const lookup = lookupOf([
      {
        pick: { playerName: 'LeBron James', statType: 'points', line: 24.5 },
        snap: { overOdds: -110, underOdds: -110, line: 24.5 },
      },
    ]);
    const plan = buildSnapshotPlan([makePick()], lookup, '2026-01-01T00:00:00.000Z');
    expect(plan.updates[0].closing_snapshot_at).toBe('2026-01-01T00:00:00.000Z');
  });

  it('handles a mix of matched and unmatched picks', () => {
    const lookup = lookupOf([
      {
        pick: { playerName: 'LeBron James', statType: 'points', line: 24.5 },
        snap: { overOdds: -110, underOdds: -110, line: 24.5 },
      },
    ]);
    const picks: PendingPick[] = [
      makePick({ id: 'p1' }),
      makePick({ id: 'p2', player_name: 'Nobody Here', line: 99.5 }),
      makePick({ id: 'p3', player_name: 'Also Missing' }),
    ];
    const plan = buildSnapshotPlan(picks, lookup, SNAP_TIME);
    expect(plan.updates).toHaveLength(1);
    expect(plan.updates[0].pickId).toBe('p1');
    expect(plan.unmatchedCount).toBe(2);
    expect(plan.unmatchedPickIds).toEqual(['p2', 'p3']);
  });

  it('matches across player-name casing differences', () => {
    const lookup = lookupOf([
      {
        pick: { playerName: 'lebron james', statType: 'points', line: 24.5 },
        snap: { overOdds: -120, underOdds: -100, line: 24.5 },
      },
    ]);
    const plan = buildSnapshotPlan(
      [makePick({ player_name: 'LeBron James' })],
      lookup,
      SNAP_TIME,
    );
    expect(plan.updates).toHaveLength(1);
  });

  it('matches across stat-type casing differences', () => {
    const lookup = lookupOf([
      {
        pick: { playerName: 'LeBron James', statType: 'POINTS', line: 24.5 },
        snap: { overOdds: -120, underOdds: -100, line: 24.5 },
      },
    ]);
    const plan = buildSnapshotPlan(
      [makePick({ stat_type: 'points' })],
      lookup,
      SNAP_TIME,
    );
    expect(plan.updates).toHaveLength(1);
  });

  it('captures the LIVE line from the lookup, even if the bet-time line differs', () => {
    // Pick was made at 24.5, but the book has since moved the line to 25.5.
    // The closing snapshot should record 25.5 (the actual closing line).
    // Note: matching is by the bet-time line (24.5), so we set the lookup
    // key to 24.5 but the snap.line to 25.5 to simulate that the book
    // returned a different line under the same player+stat key.
    const m = new Map<string, PropSnapshot>();
    m.set(matchKey('LeBron James', 'points', 24.5), {
      overOdds: -130,
      underOdds: +110,
      line: 25.5,
    });
    const plan = buildSnapshotPlan([makePick()], m, SNAP_TIME);
    expect(plan.updates[0].closing_line).toBe(25.5);
  });

  it('preserves pick order in updates and unmatchedPickIds', () => {
    const lookup = lookupOf([
      {
        pick: { playerName: 'A Player', statType: 'points', line: 10 },
        snap: { overOdds: -110, underOdds: -110, line: 10 },
      },
      {
        pick: { playerName: 'C Player', statType: 'points', line: 30 },
        snap: { overOdds: -110, underOdds: -110, line: 30 },
      },
    ]);
    const picks: PendingPick[] = [
      makePick({ id: 'pa', player_name: 'A Player', line: 10 }),
      makePick({ id: 'pb', player_name: 'B Player', line: 20 }),
      makePick({ id: 'pc', player_name: 'C Player', line: 30 }),
    ];
    const plan = buildSnapshotPlan(picks, lookup, SNAP_TIME);
    expect(plan.updates.map((u) => u.pickId)).toEqual(['pa', 'pc']);
    expect(plan.unmatchedPickIds).toEqual(['pb']);
  });

  it('returns numeric line correctly when pick.line is a string-coerced numeric', () => {
    // Defensive: Supabase numeric columns sometimes round-trip as strings
    // depending on the client. The pure helper should still match if the
    // caller has already coerced via Number().
    const lookup = lookupOf([
      {
        pick: { playerName: 'LeBron James', statType: 'points', line: 24.5 },
        snap: { overOdds: -110, underOdds: -110, line: 24.5 },
      },
    ]);
    const pick: PendingPick = {
      id: 'p1',
      player_name: 'LeBron James',
      stat_type: 'points',
      line: Number('24.5'),
    };
    const plan = buildSnapshotPlan([pick], lookup, SNAP_TIME);
    expect(plan.updates).toHaveLength(1);
  });
});
