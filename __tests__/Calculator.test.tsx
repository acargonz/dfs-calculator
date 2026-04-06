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
    expect(result.fairOverProb + result.fairUnderProb).toBeCloseTo(1, 2);
  });

  it('returns model probabilities between 0 and 1', () => {
    const result = calculate(sampleInput);
    expect(result.modelOverProb).toBeGreaterThan(0);
    expect(result.modelOverProb).toBeLessThan(1);
    expect(result.modelUnderProb).toBeGreaterThan(0);
    expect(result.modelUnderProb).toBeLessThan(1);
  });

  it('returns blended probability between fair and model', () => {
    const result = calculate(sampleInput);
    const min = Math.min(result.fairOverProb, result.modelOverProb);
    const max = Math.max(result.fairOverProb, result.modelOverProb);
    expect(result.blendedProb).toBeGreaterThanOrEqual(min - 0.001);
    expect(result.blendedProb).toBeLessThanOrEqual(max + 0.001);
  });

  it('returns a valid tier', () => {
    const result = calculate(sampleInput);
    expect(['HIGH', 'MEDIUM', 'LOW', 'REJECT']).toContain(result.tier);
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

  it('kellyStake is 0 when EV is negative', () => {
    const result = calculate({
      ...sampleInput,
      mean: 20,   // well below line of 26.5
      line: 26.5,
    });
    expect(result.kellyStake).toBe(0);
  });

  it('kellyFraction is 0.25 (standard mode)', () => {
    const result = calculate(sampleInput);
    expect(result.kellyFraction).toBe(0.25);
  });

  it('demon mode returns kellyFraction of 0.125', () => {
    const result = calculate({ ...sampleInput, kellyMode: 'demon' });
    expect(result.kellyFraction).toBe(0.125);
  });

  it('larger bankroll increases kelly stake proportionally', () => {
    const small = calculate({ ...sampleInput, bankroll: 100 });
    const large = calculate({ ...sampleInput, bankroll: 1000 });
    if (small.kellyStake > 0) {
      expect(large.kellyStake / small.kellyStake).toBeCloseTo(10, 1);
    }
  });

  it('positive pace modifier increases blended probability', () => {
    const base = calculate(sampleInput);
    const boosted = calculate({ ...sampleInput, paceModifier: 5 });
    expect(boosted.blendedProb).toBeGreaterThan(base.blendedProb);
  });

  it('negative injury modifier decreases blended probability', () => {
    const base = calculate(sampleInput);
    const reduced = calculate({ ...sampleInput, injuryModifier: -5 });
    expect(reduced.blendedProb).toBeLessThan(base.blendedProb);
  });

  it('modifiers of 0 do not change the result', () => {
    const base = calculate(sampleInput);
    const same = calculate({ ...sampleInput, paceModifier: 0, injuryModifier: 0 });
    expect(same.blendedProb).toBe(base.blendedProb);
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
    expect(['HIGH', 'MEDIUM', 'LOW', 'REJECT']).toContain(result.tier);
    expect(result.blendedProb).toBeGreaterThan(0);
    expect(result.blendedProb).toBeLessThan(1);
  });

  it('calculates fantasy points', () => {
    const result = calculate({
      ...sampleInput,
      statType: 'fantasy',
      mean: 48.0,
      line: 47.5,
    });
    expect(result.source).toBe('NegBinomial');
    expect(['HIGH', 'MEDIUM', 'LOW', 'REJECT']).toContain(result.tier);
  });

  it('calculates pts+rebs', () => {
    const result = calculate({
      ...sampleInput,
      statType: 'pts+rebs',
      mean: 33.0,
      line: 32.5,
    });
    expect(result.source).toBe('NegBinomial');
    expect(result.blendedProb).toBeGreaterThan(0);
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

    // Verify results appear
    expect(screen.getByText('LeBron James')).toBeInTheDocument();
    expect(screen.getByTestId('tier-badge')).toBeInTheDocument();
    expect(screen.getByText(/Expected Value/)).toBeInTheDocument();
    expect(screen.getByText(/Kelly Stake/)).toBeInTheDocument();
  });

  it('does not show results before submission in single mode', async () => {
    const user = userEvent.setup();
    render(<Calculator />);
    await user.click(screen.getByText('Single Player'));
    expect(screen.queryByTestId('tier-badge')).not.toBeInTheDocument();
  });
});
