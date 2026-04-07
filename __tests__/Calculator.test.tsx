/** @jest-environment jsdom */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import Calculator, { calculate } from '../src/components/Calculator';
import type { PlayerFormData } from '../src/components/types';

// Mock oddsApi to prevent GameSelector from making real fetch calls
jest.mock('../src/lib/oddsApi', () => ({
  fetchGames: jest.fn().mockResolvedValue([]),
  fetchProps: jest.fn().mockResolvedValue([]),
}));

// Test the pure calculate function directly (no DOM needed)
describe('calculate()', () => {
  const sampleInput: PlayerFormData = {
    playerName: 'LeBron James',
    position: 'SF',
    statType: 'points',
    mean: 27.5,
    line: 26.5,
    overOdds: -130,
    underOdds: 110,
    bankroll: 100,
    kellyMode: 'standard',
    paceModifier: 0,
    injuryModifier: 0,
  };

  it('returns fair probabilities that sum to ~1', () => {
    const result = calculate(sampleInput);
    expect(result.over.fairProb + result.under.fairProb).toBeCloseTo(1, 2);
  });

  it('returns model probabilities between 0 and 1 for both sides', () => {
    const result = calculate(sampleInput);
    expect(result.over.modelProb).toBeGreaterThan(0);
    expect(result.over.modelProb).toBeLessThan(1);
    expect(result.under.modelProb).toBeGreaterThan(0);
    expect(result.under.modelProb).toBeLessThan(1);
  });

  it('returns blended probability between fair and model on the over side', () => {
    const result = calculate(sampleInput);
    const min = Math.min(result.over.fairProb, result.over.modelProb);
    const max = Math.max(result.over.fairProb, result.over.modelProb);
    expect(result.over.blendedProb).toBeGreaterThanOrEqual(min - 0.001);
    expect(result.over.blendedProb).toBeLessThanOrEqual(max + 0.001);
  });

  it('returns a valid tier on each side', () => {
    const result = calculate(sampleInput);
    expect(['HIGH', 'MEDIUM', 'LOW', 'REJECT']).toContain(result.over.tier);
    expect(['HIGH', 'MEDIUM', 'LOW', 'REJECT']).toContain(result.under.tier);
  });

  it('returns source as Binomial for points', () => {
    const result = calculate(sampleInput);
    expect(result.source).toBe('Binomial');
  });

  it('returns source as NegBinomial for rebounds', () => {
    const result = calculate({
      ...sampleInput,
      statType: 'rebounds',
      mean: 8.5,
      line: 7.5,
    });
    expect(result.source).toBe('NegBinomial');
  });

  it('over kellyStake is 0 when over EV is negative', () => {
    const result = calculate({
      ...sampleInput,
      mean: 20,   // well below line of 26.5 → over has no edge
      line: 26.5,
    });
    expect(result.over.kellyStake).toBe(0);
  });

  it('kellyFraction is 0.25 on both sides (standard mode)', () => {
    const result = calculate(sampleInput);
    expect(result.over.kellyFraction).toBe(0.25);
    expect(result.under.kellyFraction).toBe(0.25);
  });

  it('demon mode returns kellyFraction of 0.125 on both sides', () => {
    const result = calculate({ ...sampleInput, kellyMode: 'demon' });
    expect(result.over.kellyFraction).toBe(0.125);
    expect(result.under.kellyFraction).toBe(0.125);
  });

  it('larger bankroll increases over kelly stake proportionally', () => {
    const small = calculate({ ...sampleInput, bankroll: 100 });
    const large = calculate({ ...sampleInput, bankroll: 1000 });
    if (small.over.kellyStake > 0) {
      expect(large.over.kellyStake / small.over.kellyStake).toBeCloseTo(10, 1);
    }
  });

  it('positive pace modifier increases over blended probability', () => {
    const base = calculate(sampleInput);
    const boosted = calculate({ ...sampleInput, paceModifier: 5 });
    expect(boosted.over.blendedProb).toBeGreaterThan(base.over.blendedProb);
  });

  it('negative injury modifier decreases over blended probability', () => {
    const base = calculate(sampleInput);
    const reduced = calculate({ ...sampleInput, injuryModifier: -5 });
    expect(reduced.over.blendedProb).toBeLessThan(base.over.blendedProb);
  });

  it('modifiers of 0 do not change the over result', () => {
    const base = calculate(sampleInput);
    const same = calculate({ ...sampleInput, paceModifier: 0, injuryModifier: 0 });
    expect(same.over.blendedProb).toBe(base.over.blendedProb);
  });

  it('over and under blended probabilities are mirror images at fair odds', () => {
    const result = calculate({ ...sampleInput, overOdds: -110, underOdds: -110 });
    expect(result.over.blendedProb + result.under.blendedProb).toBeCloseTo(1, 1);
  });

  // Combo + Fantasy stat types
  it('calculates PRA with NegBinomial source', () => {
    const result = calculate({
      ...sampleInput,
      statType: 'pra',
      mean: 39.5,
      line: 38.5,
    });
    expect(result.source).toBe('NegBinomial');
    expect(['HIGH', 'MEDIUM', 'LOW', 'REJECT']).toContain(result.over.tier);
    expect(result.over.blendedProb).toBeGreaterThan(0);
    expect(result.over.blendedProb).toBeLessThan(1);
  });

  it('calculates fantasy points', () => {
    const result = calculate({
      ...sampleInput,
      statType: 'fantasy',
      mean: 48.0,
      line: 47.5,
    });
    expect(result.source).toBe('NegBinomial');
    expect(['HIGH', 'MEDIUM', 'LOW', 'REJECT']).toContain(result.over.tier);
  });

  it('calculates pts+rebs', () => {
    const result = calculate({
      ...sampleInput,
      statType: 'pts+rebs',
      mean: 33.0,
      line: 32.5,
    });
    expect(result.source).toBe('NegBinomial');
    expect(result.over.blendedProb).toBeGreaterThan(0);
  });
});

// Integration test: render the full Calculator and interact with it
describe('Calculator component', () => {
  it('defaults to batch mode with tab toggle', () => {
    render(<Calculator />);
    expect(screen.getByText('Batch')).toBeInTheDocument();
    expect(screen.getByText('Single Player')).toBeInTheDocument();
  });

  it('shows results after submitting valid data in single mode', async () => {
    const user = userEvent.setup();
    render(<Calculator />);

    // Switch to Single Player mode
    await user.click(screen.getByText('Single Player'));

    // Fill the form
    await user.type(screen.getByLabelText('Player Name'), 'LeBron James');
    await user.selectOptions(screen.getByLabelText('Position'), 'SF');
    await user.selectOptions(screen.getByLabelText('Stat Type'), 'points');
    await user.type(screen.getByLabelText('Player Mean (avg)'), '27.5');
    await user.type(screen.getByLabelText('Betting Line'), '26.5');
    await user.type(screen.getByLabelText('Over Odds (American)'), '-130');
    await user.type(screen.getByLabelText('Under Odds (American)'), '110');
    await user.click(screen.getByRole('button', { name: 'Calculate Edge' }));

    // Verify results appear — both sides now render
    expect(screen.getByText('LeBron James')).toBeInTheDocument();
    // Two tier badges (one per side)
    expect(screen.getAllByTestId('tier-badge').length).toBe(2);
    // Both sides have an Expected Value label
    expect(screen.getAllByText(/Expected Value/).length).toBeGreaterThan(0);
    // Both sides have a Kelly label
    expect(screen.getAllByText(/Kelly/).length).toBeGreaterThan(0);
    // Both side labels appear
    expect(screen.getByText(/^OVER/)).toBeInTheDocument();
    expect(screen.getByText(/^UNDER/)).toBeInTheDocument();
  });

  it('does not show results before submission in single mode', async () => {
    const user = userEvent.setup();
    render(<Calculator />);
    await user.click(screen.getByText('Single Player'));
    expect(screen.queryByTestId('tier-badge')).not.toBeInTheDocument();
  });
});
