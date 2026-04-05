/** @jest-environment jsdom */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import PlayerForm from '../src/components/PlayerForm';

describe('PlayerForm', () => {
  const mockSubmit = jest.fn();

  beforeEach(() => {
    mockSubmit.mockClear();
  });

  it('renders all input fields', () => {
    render(<PlayerForm onSubmit={mockSubmit} />);
    expect(screen.getByLabelText('Player Name')).toBeInTheDocument();
    expect(screen.getByLabelText('Position')).toBeInTheDocument();
    expect(screen.getByLabelText('Stat Type')).toBeInTheDocument();
    expect(screen.getByLabelText('Player Mean (avg)')).toBeInTheDocument();
    expect(screen.getByLabelText('Betting Line')).toBeInTheDocument();
    expect(screen.getByLabelText('Over Odds (American)')).toBeInTheDocument();
    expect(screen.getByLabelText('Under Odds (American)')).toBeInTheDocument();
  });

  it('renders the submit button', () => {
    render(<PlayerForm onSubmit={mockSubmit} />);
    expect(screen.getByRole('button', { name: 'Calculate Edge' })).toBeInTheDocument();
  });

  it('shows error when player name is empty', async () => {
    const user = userEvent.setup();
    render(<PlayerForm onSubmit={mockSubmit} />);

    await user.click(screen.getByRole('button', { name: 'Calculate Edge' }));

    expect(screen.getByRole('alert')).toHaveTextContent('Player name is required');
    expect(mockSubmit).not.toHaveBeenCalled();
  });

  it('shows error when mean is missing', async () => {
    const user = userEvent.setup();
    render(<PlayerForm onSubmit={mockSubmit} />);

    await user.type(screen.getByLabelText('Player Name'), 'LeBron James');
    await user.click(screen.getByRole('button', { name: 'Calculate Edge' }));

    expect(screen.getByRole('alert')).toHaveTextContent('Mean must be a positive number');
    expect(mockSubmit).not.toHaveBeenCalled();
  });

  it('shows error when line is missing', async () => {
    const user = userEvent.setup();
    render(<PlayerForm onSubmit={mockSubmit} />);

    await user.type(screen.getByLabelText('Player Name'), 'LeBron James');
    await user.type(screen.getByLabelText('Player Mean (avg)'), '27.5');
    await user.click(screen.getByRole('button', { name: 'Calculate Edge' }));

    expect(screen.getByRole('alert')).toHaveTextContent('Line must be a positive number');
    expect(mockSubmit).not.toHaveBeenCalled();
  });

  it('shows error when over odds is missing', async () => {
    const user = userEvent.setup();
    render(<PlayerForm onSubmit={mockSubmit} />);

    await user.type(screen.getByLabelText('Player Name'), 'LeBron James');
    await user.type(screen.getByLabelText('Player Mean (avg)'), '27.5');
    await user.type(screen.getByLabelText('Betting Line'), '26.5');
    await user.click(screen.getByRole('button', { name: 'Calculate Edge' }));

    expect(screen.getByRole('alert')).toHaveTextContent('Over odds must be a non-zero number');
    expect(mockSubmit).not.toHaveBeenCalled();
  });

  it('shows error when under odds is missing', async () => {
    const user = userEvent.setup();
    render(<PlayerForm onSubmit={mockSubmit} />);

    await user.type(screen.getByLabelText('Player Name'), 'LeBron James');
    await user.type(screen.getByLabelText('Player Mean (avg)'), '27.5');
    await user.type(screen.getByLabelText('Betting Line'), '26.5');
    await user.type(screen.getByLabelText('Over Odds (American)'), '-130');
    await user.click(screen.getByRole('button', { name: 'Calculate Edge' }));

    expect(screen.getByRole('alert')).toHaveTextContent('Under odds must be a non-zero number');
    expect(mockSubmit).not.toHaveBeenCalled();
  });

  it('calls onSubmit with correct data when all fields are valid', async () => {
    const user = userEvent.setup();
    render(<PlayerForm onSubmit={mockSubmit} />);

    await user.type(screen.getByLabelText('Player Name'), 'LeBron James');
    await user.selectOptions(screen.getByLabelText('Position'), 'SF');
    await user.selectOptions(screen.getByLabelText('Stat Type'), 'points');
    await user.type(screen.getByLabelText('Player Mean (avg)'), '27.5');
    await user.type(screen.getByLabelText('Betting Line'), '26.5');
    await user.type(screen.getByLabelText('Over Odds (American)'), '-130');
    await user.type(screen.getByLabelText('Under Odds (American)'), '110');
    await user.click(screen.getByRole('button', { name: 'Calculate Edge' }));

    expect(mockSubmit).toHaveBeenCalledTimes(1);
    expect(mockSubmit).toHaveBeenCalledWith({
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
    });
  });

  it('allows changing position and stat type', async () => {
    const user = userEvent.setup();
    render(<PlayerForm onSubmit={mockSubmit} />);

    await user.selectOptions(screen.getByLabelText('Position'), 'C');
    await user.selectOptions(screen.getByLabelText('Stat Type'), 'rebounds');

    expect(screen.getByLabelText('Position')).toHaveValue('C');
    expect(screen.getByLabelText('Stat Type')).toHaveValue('rebounds');
  });

  it('clears error on successful submit after previous error', async () => {
    const user = userEvent.setup();
    render(<PlayerForm onSubmit={mockSubmit} />);

    // First: trigger error
    await user.click(screen.getByRole('button', { name: 'Calculate Edge' }));
    expect(screen.getByRole('alert')).toBeInTheDocument();

    // Then: fill in all fields and submit
    await user.type(screen.getByLabelText('Player Name'), 'Steph Curry');
    await user.type(screen.getByLabelText('Player Mean (avg)'), '30');
    await user.type(screen.getByLabelText('Betting Line'), '29.5');
    await user.type(screen.getByLabelText('Over Odds (American)'), '-110');
    await user.type(screen.getByLabelText('Under Odds (American)'), '-110');
    await user.click(screen.getByRole('button', { name: 'Calculate Edge' }));

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(mockSubmit).toHaveBeenCalledTimes(1);
  });
});
