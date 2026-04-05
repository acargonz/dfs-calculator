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

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold" style={{ color: 'var(--text-secondary)' }}>
          Today&apos;s Games ({games.length})
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

      <div className="grid gap-2">
        {games.map((game) => {
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
