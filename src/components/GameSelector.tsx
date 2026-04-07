'use client';

import { useState, useEffect } from 'react';
import type { NBAGame } from '../lib/oddsApi';
import { fetchGames } from '../lib/oddsApi';

interface GameSelectorProps {
  onGamesSelected: (games: NBAGame[]) => void;
  disabled?: boolean;
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  return date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

/** Returns "Mon, Apr 6" / "Today" / "Tomorrow" relative to user's local time. */
function formatDateHeader(iso: string): string {
  const date = new Date(iso);
  const now = new Date();

  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const gameDay = startOfDay(date);
  const today = startOfDay(now);
  const diffDays = Math.round((gameDay.getTime() - today.getTime()) / (24 * 60 * 60 * 1000));

  const weekday = date.toLocaleDateString('en-US', { weekday: 'long' });
  const monthDay = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

  if (diffDays === 0) return `Today — ${weekday}, ${monthDay}`;
  if (diffDays === 1) return `Tomorrow — ${weekday}, ${monthDay}`;
  if (diffDays === -1) return `Yesterday — ${weekday}, ${monthDay}`;
  return `${weekday}, ${monthDay}`;
}

/** Stable key for grouping games by local calendar day. */
function dateKey(iso: string): string {
  const date = new Date(iso);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

interface DateGroup {
  key: string;
  header: string;
  games: NBAGame[];
}

/** Group games by local calendar day, sorted chronologically by day then tip-off. */
function groupGamesByDate(games: NBAGame[]): DateGroup[] {
  const sorted = [...games].sort(
    (a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime(),
  );

  const groups = new Map<string, DateGroup>();
  for (const game of sorted) {
    const key = dateKey(game.startTime);
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        header: formatDateHeader(game.startTime),
        games: [],
      });
    }
    groups.get(key)!.games.push(game);
  }

  return Array.from(groups.values());
}

export default function GameSelector({ onGamesSelected, disabled }: GameSelectorProps) {
  const [games, setGames] = useState<NBAGame[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');

    fetchGames()
      .then((data) => {
        if (!cancelled) {
          setGames(data);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err.message || 'Failed to load games');
          setLoading(false);
        }
      });

    return () => { cancelled = true; };
  }, []);

  function toggleGame(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    if (selected.size === games.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(games.map((g) => g.id)));
    }
  }

  function handleAnalyze() {
    const selectedGames = games.filter((g) => selected.has(g.id));
    onGamesSelected(selectedGames);
  }

  if (loading) {
    return (
      <div className="text-center py-8" style={{ color: 'var(--text-secondary)' }}>
        Loading today&apos;s NBA games...
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-center py-8">
        <p className="text-red-400 mb-2">{error}</p>
        <button
          onClick={() => window.location.reload()}
          className="text-sm transition-colors hover:opacity-80"
          style={{ color: 'var(--accent)' }}
        >
          Retry
        </button>
      </div>
    );
  }

  if (games.length === 0) {
    return (
      <div className="text-center py-8" style={{ color: 'var(--text-secondary)' }}>
        No NBA games scheduled today.
      </div>
    );
  }

  const allSelected = selected.size === games.length;
  const dateGroups = groupGamesByDate(games);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold" style={{ color: 'var(--text-secondary)' }}>
          Upcoming Games ({games.length})
        </h3>
        <button
          type="button"
          onClick={toggleAll}
          className="text-xs transition-colors hover:opacity-80"
          style={{ color: 'var(--accent)' }}
        >
          {allSelected ? 'Deselect All' : 'Select All'}
        </button>
      </div>

      <div className="space-y-4">
        {dateGroups.map((group) => (
          <div key={group.key} className="space-y-2">
            <div
              className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide"
              style={{ color: 'var(--text-muted)' }}
            >
              <span>{group.header}</span>
              <span
                className="rounded-full px-2 py-0.5 text-[10px]"
                style={{ background: 'var(--bg-secondary)', color: 'var(--text-secondary)' }}
              >
                {group.games.length}
              </span>
              <div className="flex-1 h-px" style={{ background: 'var(--border-subtle)' }} />
            </div>

            <div className="grid gap-2">
              {group.games.map((game) => {
                const isSelected = selected.has(game.id);
                return (
                  <button
                    key={game.id}
                    type="button"
                    onClick={() => toggleGame(game.id)}
                    disabled={disabled}
                    className={`flex items-center justify-between rounded-lg p-3 text-left transition-colors ${
                      disabled ? 'opacity-50 cursor-not-allowed' : ''
                    }`}
                    style={{
                      background: isSelected ? 'rgba(218, 119, 86, 0.1)' : 'var(--bg-secondary)',
                      border: isSelected ? '1px solid rgba(218, 119, 86, 0.4)' : '1px solid var(--border-subtle)',
                      color: isSelected ? 'var(--text-primary)' : 'var(--text-secondary)',
                    }}
                  >
                    <span className="font-medium">
                      {game.awayTeam} @ {game.homeTeam}
                    </span>
                    <span className="text-sm" style={{ color: 'var(--text-muted)' }}>
                      {formatTime(game.startTime)}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      <button
        type="button"
        onClick={handleAnalyze}
        disabled={selected.size === 0 || disabled}
        className="w-full rounded-lg py-2.5 font-semibold text-white transition-colors hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
        style={{ background: 'var(--accent)' }}
      >
        Analyze Props ({selected.size} game{selected.size !== 1 ? 's' : ''})
      </button>
    </div>
  );
}
