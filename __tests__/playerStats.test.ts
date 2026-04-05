import { mapPosition } from '../src/lib/playerStats';

describe('mapPosition', () => {
  it('maps G to PG', () => {
    expect(mapPosition('G')).toBe('PG');
  });

  it('maps PG to PG', () => {
    expect(mapPosition('PG')).toBe('PG');
  });

  it('maps SG to SG', () => {
    expect(mapPosition('SG')).toBe('SG');
  });

  it('maps G-F to SG', () => {
    expect(mapPosition('G-F')).toBe('SG');
  });

  it('maps F-G to SG', () => {
    expect(mapPosition('F-G')).toBe('SG');
  });

  it('maps F to PF', () => {
    expect(mapPosition('F')).toBe('PF');
  });

  it('maps PF to PF', () => {
    expect(mapPosition('PF')).toBe('PF');
  });

  it('maps SF to SF', () => {
    expect(mapPosition('SF')).toBe('SF');
  });

  it('maps C to C', () => {
    expect(mapPosition('C')).toBe('C');
  });

  it('maps F-C to C', () => {
    expect(mapPosition('F-C')).toBe('C');
  });

  it('maps C-F to C', () => {
    expect(mapPosition('C-F')).toBe('C');
  });

  it('defaults to SF for unknown position', () => {
    expect(mapPosition('')).toBe('SF');
    expect(mapPosition('XYZ')).toBe('SF');
  });

  it('handles lowercase input', () => {
    expect(mapPosition('g')).toBe('PG');
    expect(mapPosition('f-c')).toBe('C');
  });

  it('handles whitespace', () => {
    expect(mapPosition(' G ')).toBe('PG');
    expect(mapPosition('  C  ')).toBe('C');
  });
});
