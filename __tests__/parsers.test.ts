import {
  normalizeStatType,
  parseDirection,
  parseDFSText,
} from '../src/lib/parsers';

describe('normalizeStatType', () => {
  it('normalizes "pts" to "points"', () => {
    expect(normalizeStatType('pts')).toBe('points');
    expect(normalizeStatType('Points')).toBe('points');
  });

  it('normalizes "rebs" to "rebounds"', () => {
    expect(normalizeStatType('rebs')).toBe('rebounds');
    expect(normalizeStatType('Rebounds')).toBe('rebounds');
    expect(normalizeStatType('reb')).toBe('rebounds');
  });

  it('normalizes "asts" to "assists"', () => {
    expect(normalizeStatType('asts')).toBe('assists');
    expect(normalizeStatType('Assists')).toBe('assists');
    expect(normalizeStatType('ast')).toBe('assists');
  });

  it('normalizes steals variants', () => {
    expect(normalizeStatType('stl')).toBe('steals');
    expect(normalizeStatType('stls')).toBe('steals');
    expect(normalizeStatType('Steals')).toBe('steals');
  });

  it('normalizes blocks variants', () => {
    expect(normalizeStatType('blk')).toBe('blocks');
    expect(normalizeStatType('blks')).toBe('blocks');
    expect(normalizeStatType('Blocks')).toBe('blocks');
  });

  it('normalizes three-pointer variants', () => {
    expect(normalizeStatType('3-pointers')).toBe('threes');
    expect(normalizeStatType('3-Pt')).toBe('threes');
    expect(normalizeStatType('3pm')).toBe('threes');
    expect(normalizeStatType('Three Pointers')).toBe('threes');
    expect(normalizeStatType('threes made')).toBe('threes');
  });

  it('normalizes combo stats', () => {
    expect(normalizeStatType('PRA')).toBe('pra');
    expect(normalizeStatType('Pts+Rebs+Asts')).toBe('pra');
  });

  it('returns unknown stat types as-is', () => {
    expect(normalizeStatType('turnovers')).toBe('turnovers');
  });
});

describe('parseDirection', () => {
  it('returns "over" for over/more/higher', () => {
    expect(parseDirection('Over')).toBe('over');
    expect(parseDirection('more')).toBe('over');
    expect(parseDirection('Higher')).toBe('over');
  });

  it('returns "under" for under/less/lower/fewer', () => {
    expect(parseDirection('Under')).toBe('under');
    expect(parseDirection('less')).toBe('under');
    expect(parseDirection('Lower')).toBe('under');
    expect(parseDirection('fewer')).toBe('under');
  });

  it('defaults to "over" for unknown', () => {
    expect(parseDirection('whatever')).toBe('over');
  });
});

describe('parseDFSText', () => {
  it('returns empty array for empty text', () => {
    expect(parseDFSText('')).toEqual([]);
    expect(parseDFSText('   ')).toEqual([]);
  });

  it('parses PrizePicks format (name, direction, stat, line)', () => {
    const text = `LeBron James
More
Points
26.5`;
    const result = parseDFSText(text);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      playerName: 'LeBron James',
      line: 26.5,
      statType: 'points',
      direction: 'over',
    });
  });

  it('parses Underdog format (name, direction, line + stat)', () => {
    const text = `Stephen Curry
Higher
24.5 Points`;
    const result = parseDFSText(text);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      playerName: 'Stephen Curry',
      line: 24.5,
      statType: 'points',
      direction: 'over',
    });
  });

  it('parses "less" as under direction', () => {
    const text = `Anthony Davis
Less
Rebounds
8.5`;
    const result = parseDFSText(text);
    expect(result).toHaveLength(1);
    expect(result[0].direction).toBe('under');
    expect(result[0].statType).toBe('rebounds');
  });

  it('parses multiple players', () => {
    const text = `LeBron James
More
Points
26.5
Steph Curry
More
3-Pointers
4.5`;
    const result = parseDFSText(text);
    expect(result).toHaveLength(2);
    expect(result[0].playerName).toBe('LeBron James');
    expect(result[0].statType).toBe('points');
    expect(result[0].line).toBe(26.5);
    expect(result[1].playerName).toBe('Steph Curry');
    expect(result[1].statType).toBe('threes');
    expect(result[1].line).toBe(4.5);
  });

  it('handles stat + line on same line', () => {
    const text = `Jayson Tatum
More
Assists 6.5`;
    const result = parseDFSText(text);
    expect(result).toHaveLength(1);
    expect(result[0].statType).toBe('assists');
    expect(result[0].line).toBe(6.5);
  });

  it('handles whole number lines', () => {
    const text = `Joel Embiid
More
Rebounds
10`;
    const result = parseDFSText(text);
    expect(result).toHaveLength(1);
    expect(result[0].line).toBe(10);
  });

  it('handles abbreviated stat types', () => {
    const text = `Nikola Jokic
More
Asts
8.5`;
    const result = parseDFSText(text);
    expect(result).toHaveLength(1);
    expect(result[0].statType).toBe('assists');
  });

  it('parses 3-pt variants', () => {
    const text = `Klay Thompson
More
3pm
3.5`;
    const result = parseDFSText(text);
    expect(result).toHaveLength(1);
    expect(result[0].statType).toBe('threes');
  });

  it('ignores lines with no parseable content', () => {
    const text = `


`;
    expect(parseDFSText(text)).toEqual([]);
  });

  it('handles mixed directions in a batch', () => {
    const text = `Player One
More
Points
20.5
Player Two
Less
Rebounds
7.5`;
    const result = parseDFSText(text);
    expect(result).toHaveLength(2);
    expect(result[0].direction).toBe('over');
    expect(result[1].direction).toBe('under');
  });
});
