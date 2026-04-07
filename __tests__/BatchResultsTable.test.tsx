/** @jest-environment jsdom */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import BatchResultsTable from '../src/components/BatchResultsTable';
import type { BatchResult, BatchPlayerResult } from '../src/lib/batchProcessor';
import { bestTier } from '../src/lib/batchProcessor';
import type { CalculationResult, SideEvaluation } from '../src/components/types';

/**
 * Build a synthetic SideEvaluation for tests. The two-sided refactor moved
 * tier/EV/blended/etc into per-side records — these helpers keep test setup
 * compact and let each test override only the fields it cares about.
 */
function makeSide(overrides: Partial<SideEvaluation> = {}): SideEvaluation {
  return {
    fairProb: 0.5,
    modelProb: 0.5,
    blendedProb: 0.5,
    ev: 0,
    kellyStake: 0,
    kellyFraction: 0.25,
    tier: 'REJECT',
    ...overrides,
  };
}

/**
 * Build a CalculationResult where the OVER side carries the meaningful
 * numbers by default. The under side is a non-competitive REJECT so
 * `pickBestSide` always returns 'over' and existing test expectations
 * (which only care about one row) keep working.
 */
function makeResult(
  overSide: Partial<SideEvaluation>,
  underSide: Partial<SideEvaluation> = { tier: 'REJECT', ev: -0.05 },
  source = 'Binomial',
): CalculationResult {
  return { over: makeSide(overSide), under: makeSide(underSide), source };
}

const DEFAULT_OVER: Partial<SideEvaluation> = {
  fairProb: 0.52,
  modelProb: 0.62,
  blendedProb: 0.62,
  ev: 0.12,
  kellyStake: 8.5,
  kellyFraction: 0.25,
  tier: 'HIGH',
};

function makePlayer(overrides: Partial<BatchPlayerResult> = {}): BatchPlayerResult {
  return {
    playerName: 'Test Player',
    position: 'SF',
    statType: 'points',
    line: 24.5,
    mean: 25.0,
    overOdds: -110,
    underOdds: -110,
    result: makeResult(DEFAULT_OVER),
    status: 'success',
    ...overrides,
  };
}

function makeResults(players: BatchPlayerResult[]): BatchResult {
  const summary = { high: 0, medium: 0, low: 0, reject: 0, errors: 0 };
  for (const p of players) {
    if (p.status !== 'success' || !p.result) {
      summary.errors++;
    } else {
      switch (bestTier(p.result)) {
        case 'HIGH': summary.high++; break;
        case 'MEDIUM': summary.medium++; break;
        case 'LOW': summary.low++; break;
        case 'REJECT': summary.reject++; break;
      }
    }
  }
  return { players, summary };
}

describe('BatchResultsTable', () => {
  const onClear = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders summary counts', () => {
    const players = [
      makePlayer({ playerName: 'A', result: makeResult({ ...DEFAULT_OVER, tier: 'HIGH' }) }),
      makePlayer({ playerName: 'B', result: makeResult({ ...DEFAULT_OVER, tier: 'MEDIUM' }) }),
      makePlayer({ playerName: 'C', result: makeResult({ ...DEFAULT_OVER, tier: 'REJECT', ev: -0.05, kellyStake: 0 }) }),
    ];
    render(<BatchResultsTable results={makeResults(players)} onClear={onClear} />);

    expect(screen.getByText('1 HIGH')).toBeInTheDocument();
    expect(screen.getByText('1 MEDIUM')).toBeInTheDocument();
    expect(screen.getByText('1 REJECT')).toBeInTheDocument();
    expect(screen.getByText('(3 total)')).toBeInTheDocument();
  });

  it('renders player rows with correct data', () => {
    const players = [makePlayer({ playerName: 'LeBron James', mean: 27.5, line: 26.5 })];
    render(<BatchResultsTable results={makeResults(players)} onClear={onClear} />);

    expect(screen.getByText('LeBron James')).toBeInTheDocument();
    expect(screen.getByText('26.5')).toBeInTheDocument();
    expect(screen.getByText('27.5')).toBeInTheDocument();
    expect(screen.getByText('62.0%')).toBeInTheDocument(); // blendedProb
  });

  it('renders error rows with status message', () => {
    const players = [
      makePlayer({
        playerName: 'Unknown',
        result: null,
        status: 'player_not_found',
        statusMessage: 'Player not found',
      }),
    ];
    render(<BatchResultsTable results={makeResults(players)} onClear={onClear} />);

    expect(screen.getByText('Unknown')).toBeInTheDocument();
    expect(screen.getByText('Player not found')).toBeInTheDocument();
  });

  it('sorts by column when header clicked', async () => {
    const user = userEvent.setup();
    const players = [
      makePlayer({ playerName: 'Zach', result: makeResult({ ...DEFAULT_OVER, ev: 0.05 }) }),
      makePlayer({ playerName: 'Aaron', result: makeResult({ ...DEFAULT_OVER, ev: 0.15 }) }),
    ];
    render(<BatchResultsTable results={makeResults(players)} onClear={onClear} />);

    // Click Player header to sort alphabetically
    await user.click(screen.getByText(/^Player/));

    const rows = screen.getAllByRole('row');
    // rows[0] is header, rows[1] and rows[2] are data
    expect(rows[1]).toHaveTextContent('Aaron');
    expect(rows[2]).toHaveTextContent('Zach');
  });

  it('toggles sort direction on repeated header click', async () => {
    const user = userEvent.setup();
    const players = [
      makePlayer({ playerName: 'Aaron' }),
      makePlayer({ playerName: 'Zach' }),
    ];
    render(<BatchResultsTable results={makeResults(players)} onClear={onClear} />);

    // Click Player twice for descending
    await user.click(screen.getByText(/^Player/));
    await user.click(screen.getByText(/^Player/));

    const rows = screen.getAllByRole('row');
    expect(rows[1]).toHaveTextContent('Zach');
    expect(rows[2]).toHaveTextContent('Aaron');
  });

  it('calls onClear when Clear button clicked', async () => {
    const user = userEvent.setup();
    const players = [makePlayer()];
    render(<BatchResultsTable results={makeResults(players)} onClear={onClear} />);

    await user.click(screen.getByText('Clear'));
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it('copies results to clipboard', async () => {
    const user = userEvent.setup();
    const players = [makePlayer({ playerName: 'Test' })];
    render(<BatchResultsTable results={makeResults(players)} onClear={onClear} />);

    // jsdom navigator.clipboard is getter-only — override via defineProperty
    const writeText = jest.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });

    await user.click(screen.getByText('Copy Results'));
    expect(writeText).toHaveBeenCalledTimes(1);

    const clipboardText = writeText.mock.calls[0][0];
    expect(clipboardText).toContain('Player\tStat\tLine');
    expect(clipboardText).toContain('Test');
  });

  it('includes error rows in clipboard copy', async () => {
    const user = userEvent.setup();
    const players = [
      makePlayer({
        playerName: 'Broken Player',
        result: null,
        status: 'player_not_found',
        statusMessage: 'Player not found',
      }),
    ];
    render(<BatchResultsTable results={makeResults(players)} onClear={onClear} />);

    const writeText = jest.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });

    await user.click(screen.getByText('Copy Results'));
    expect(writeText).toHaveBeenCalledTimes(1);

    const clipboardText = writeText.mock.calls[0][0];
    expect(clipboardText).toContain('Player\tStat\tLine');
    expect(clipboardText).toContain('Broken Player');
    expect(clipboardText).toContain('ERROR: Player not found');
  });

  it('copies both success and error rows', async () => {
    const user = userEvent.setup();
    const players = [
      makePlayer({ playerName: 'Good Player' }),
      makePlayer({
        playerName: 'Bad Player',
        result: null,
        status: 'api_error',
        statusMessage: 'API timeout',
      }),
    ];
    render(<BatchResultsTable results={makeResults(players)} onClear={onClear} />);

    const writeText = jest.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });

    await user.click(screen.getByText('Copy Results'));
    const clipboardText = writeText.mock.calls[0][0];
    expect(clipboardText).toContain('Good Player');
    expect(clipboardText).toContain('Bad Player');
    expect(clipboardText).toContain('ERROR: API timeout');
  });

  it('shows EV with correct sign and formatting', () => {
    const players = [
      makePlayer({ playerName: 'Positive', result: makeResult({ ...DEFAULT_OVER, ev: 0.12 }) }),
      makePlayer({
        playerName: 'Negative',
        result: makeResult({ ...DEFAULT_OVER, ev: -0.05, tier: 'REJECT', kellyStake: 0 }),
      }),
    ];
    render(<BatchResultsTable results={makeResults(players)} onClear={onClear} />);

    expect(screen.getByText('+12.0%')).toBeInTheDocument();
    expect(screen.getByText('-5.0%')).toBeInTheDocument();
  });

  it('shows $0 for zero kelly stake', () => {
    const players = [
      makePlayer({
        result: makeResult({ ...DEFAULT_OVER, kellyStake: 0, tier: 'REJECT', ev: -0.05 }),
      }),
    ];
    render(<BatchResultsTable results={makeResults(players)} onClear={onClear} />);

    expect(screen.getByText('$0')).toBeInTheDocument();
  });

  it('collapses and expands the table body', async () => {
    const user = userEvent.setup();
    const players = [makePlayer({ playerName: 'CollapseMe' })];
    render(<BatchResultsTable results={makeResults(players)} onClear={onClear} />);

    // Row visible by default
    expect(screen.getByText('CollapseMe')).toBeInTheDocument();

    // Click collapse toggle
    await user.click(screen.getByRole('button', { name: /hide table/i }));
    expect(screen.queryByText('CollapseMe')).not.toBeInTheDocument();

    // Click again to expand
    await user.click(screen.getByRole('button', { name: /show table/i }));
    expect(screen.getByText('CollapseMe')).toBeInTheDocument();
  });

  it('hides rows of a tier when its filter chip is clicked off', async () => {
    const user = userEvent.setup();
    const players = [
      makePlayer({
        playerName: 'RejectPlayer',
        result: makeResult({ ...DEFAULT_OVER, tier: 'REJECT', ev: -0.05, kellyStake: 0 }),
      }),
      makePlayer({ playerName: 'HighPlayer', result: makeResult({ ...DEFAULT_OVER, tier: 'HIGH' }) }),
    ];
    render(<BatchResultsTable results={makeResults(players)} onClear={onClear} />);

    // Both visible by default
    expect(screen.getByText('RejectPlayer')).toBeInTheDocument();
    expect(screen.getByText('HighPlayer')).toBeInTheDocument();

    // Click the REJECT filter chip to disable it
    await user.click(screen.getByRole('button', { name: /1 REJECT/i }));

    // REJECT row hidden, HIGH row still visible
    expect(screen.queryByText('RejectPlayer')).not.toBeInTheDocument();
    expect(screen.getByText('HighPlayer')).toBeInTheDocument();
  });

  it('renders a Jump to AI button', () => {
    const players = [makePlayer()];
    render(<BatchResultsTable results={makeResults(players)} onClear={onClear} />);
    expect(screen.getByRole('button', { name: /jump to ai/i })).toBeInTheDocument();
  });

  it('shows an empty-state row when every tier filter is toggled off', async () => {
    const user = userEvent.setup();
    const players = [
      makePlayer({ playerName: 'Only', result: makeResult({ ...DEFAULT_OVER, tier: 'HIGH' }) }),
    ];
    render(<BatchResultsTable results={makeResults(players)} onClear={onClear} />);

    // Click HIGH chip off (only one tier present)
    await user.click(screen.getByRole('button', { name: /1 HIGH/i }));

    expect(screen.queryByText('Only')).not.toBeInTheDocument();
    expect(screen.getByText(/No props match/i)).toBeInTheDocument();
  });
});
