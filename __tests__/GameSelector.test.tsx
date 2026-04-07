/** @jest-environment jsdom */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import GameSelector from '../src/components/GameSelector';
import * as oddsApi from '../src/lib/oddsApi';
import type { NBAGame } from '../src/lib/oddsApi';

jest.mock('../src/lib/oddsApi');
const mockFetchGames = oddsApi.fetchGames as jest.MockedFunction<typeof oddsApi.fetchGames>;

// Build sample games dynamically based on "now" so the "Today" header matches.
function todayAt(hour: number): string {
  const d = new Date();
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
}
function tomorrowAt(hour: number): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
}

const sampleGames: NBAGame[] = [
  { id: 'game1', homeTeam: 'Boston Celtics', awayTeam: 'New York Knicks', startTime: todayAt(19) },
  { id: 'game2', homeTeam: 'Los Angeles Lakers', awayTeam: 'Golden State Warriors', startTime: todayAt(22) },
];

describe('GameSelector', () => {
  const onGamesSelected = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('shows loading state initially', () => {
    mockFetchGames.mockReturnValue(new Promise(() => {})); // never resolves
    render(<GameSelector onGamesSelected={onGamesSelected} />);
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it('shows games after loading', async () => {
    mockFetchGames.mockResolvedValue(sampleGames);
    render(<GameSelector onGamesSelected={onGamesSelected} />);

    await waitFor(() => {
      expect(screen.getByText(/New York Knicks/)).toBeInTheDocument();
    });
    expect(screen.getByText(/Golden State Warriors/)).toBeInTheDocument();
    expect(screen.getByText(/Upcoming Games \(2\)/i)).toBeInTheDocument();
  });

  it('groups games by date with a date header', async () => {
    const multiDayGames: NBAGame[] = [
      { id: 'today1', homeTeam: 'Home A', awayTeam: 'Away A', startTime: todayAt(19) },
      { id: 'tom1', homeTeam: 'Home B', awayTeam: 'Away B', startTime: tomorrowAt(19) },
    ];
    mockFetchGames.mockResolvedValue(multiDayGames);
    render(<GameSelector onGamesSelected={onGamesSelected} />);

    await waitFor(() => {
      expect(screen.getByText(/Away A/)).toBeInTheDocument();
    });

    // Both headers should be present
    expect(screen.getByText(/Today —/i)).toBeInTheDocument();
    expect(screen.getByText(/Tomorrow —/i)).toBeInTheDocument();
  });

  it('shows error when fetch fails', async () => {
    mockFetchGames.mockRejectedValue(new Error('Network error'));
    render(<GameSelector onGamesSelected={onGamesSelected} />);

    await waitFor(() => {
      expect(screen.getByText('Network error')).toBeInTheDocument();
    });
    expect(screen.getByText('Retry')).toBeInTheDocument();
  });

  it('shows empty state when no games', async () => {
    mockFetchGames.mockResolvedValue([]);
    render(<GameSelector onGamesSelected={onGamesSelected} />);

    await waitFor(() => {
      expect(screen.getByText(/no nba games/i)).toBeInTheDocument();
    });
  });

  it('toggles game selection on click', async () => {
    mockFetchGames.mockResolvedValue(sampleGames);
    const user = userEvent.setup();
    render(<GameSelector onGamesSelected={onGamesSelected} />);

    await waitFor(() => {
      expect(screen.getByText(/New York Knicks/)).toBeInTheDocument();
    });

    const knicks = screen.getByText(/New York Knicks/).closest('button')!;
    await user.click(knicks);

    // Analyze button should show 1 game selected
    expect(screen.getByText(/Analyze Props \(1 game\)/)).toBeInTheDocument();
  });

  it('select all / deselect all works', async () => {
    mockFetchGames.mockResolvedValue(sampleGames);
    const user = userEvent.setup();
    render(<GameSelector onGamesSelected={onGamesSelected} />);

    await waitFor(() => {
      expect(screen.getByText('Select All')).toBeInTheDocument();
    });

    await user.click(screen.getByText('Select All'));
    expect(screen.getByText(/Analyze Props \(2 games\)/)).toBeInTheDocument();
    expect(screen.getByText('Deselect All')).toBeInTheDocument();

    await user.click(screen.getByText('Deselect All'));
    expect(screen.getByText(/Analyze Props \(0 games\)/)).toBeInTheDocument();
  });

  it('calls onGamesSelected with selected games', async () => {
    mockFetchGames.mockResolvedValue(sampleGames);
    const user = userEvent.setup();
    render(<GameSelector onGamesSelected={onGamesSelected} />);

    await waitFor(() => {
      expect(screen.getByText(/New York Knicks/)).toBeInTheDocument();
    });

    // Select first game
    const knicks = screen.getByText(/New York Knicks/).closest('button')!;
    await user.click(knicks);

    // Click analyze
    await user.click(screen.getByText(/Analyze Props/));
    expect(onGamesSelected).toHaveBeenCalledWith([sampleGames[0]]);
  });

  it('disables analyze button when no games selected', async () => {
    mockFetchGames.mockResolvedValue(sampleGames);
    render(<GameSelector onGamesSelected={onGamesSelected} />);

    await waitFor(() => {
      expect(screen.getByText(/Analyze Props/)).toBeInTheDocument();
    });

    expect(screen.getByText(/Analyze Props/).closest('button')).toBeDisabled();
  });

  it('disables game buttons when disabled prop is true', async () => {
    mockFetchGames.mockResolvedValue(sampleGames);
    render(<GameSelector onGamesSelected={onGamesSelected} disabled />);

    await waitFor(() => {
      expect(screen.getByText(/New York Knicks/)).toBeInTheDocument();
    });

    const knicks = screen.getByText(/New York Knicks/).closest('button')!;
    expect(knicks).toBeDisabled();
  });
});
