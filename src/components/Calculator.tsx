'use client';

import { useState } from 'react';
import PlayerForm from './PlayerForm';
import ResultsDisplay from './ResultsDisplay';
import GameSelector from './GameSelector';
import BatchResultsTable from './BatchResultsTable';
import PasteInput from './PasteInput';
import AIAnalysisPanel from './AIAnalysisPanel';
import type { PlayerFormData, CalculationResult } from './types';
import type { NBAGame, PlayerProp } from '../lib/oddsApi';
import type { BatchResult } from '../lib/batchProcessor';
import type { ParsedPlayer } from '../lib/parsers';
import { fetchGames, fetchProps, crossReferenceOdds } from '../lib/oddsApi';
import { fetchPlayerStats } from '../lib/playerStats';
import { processBatch } from '../lib/batchProcessor';
import { evaluateBothSides } from '../lib/twoSidedCalc';

type Mode = 'single' | 'batch';
type BatchPhase = 'select' | 'processing' | 'results';

/**
 * Evaluate both sides of a prop. The calculator NEVER picks a direction —
 * the AI ensemble decides over vs under based on the active Algorithmic
 * Prompt filters (matchups, recent form, postseason context, etc.). This
 * wrapper exists for backward compatibility with the test suite.
 */
function calculate(data: PlayerFormData): CalculationResult {
  return evaluateBothSides({
    statType: data.statType,
    position: data.position,
    mean: data.mean,
    line: data.line,
    overOdds: data.overOdds,
    underOdds: data.underOdds,
    bankroll: data.bankroll,
    kellyMode: data.kellyMode,
    paceModifier: data.paceModifier,
    injuryModifier: data.injuryModifier,
  });
}

export default function Calculator() {
  // Mode
  const [mode, setMode] = useState<Mode>('batch');

  // Single Player state
  const [result, setResult] = useState<CalculationResult | null>(null);
  const [playerName, setPlayerName] = useState('');

  // Batch state
  const [batchPhase, setBatchPhase] = useState<BatchPhase>('select');
  const [batchResult, setBatchResult] = useState<BatchResult | null>(null);
  const [progress, setProgress] = useState({ current: 0, total: 0, playerName: '' });
  const [batchError, setBatchError] = useState('');
  const [oddsWarning, setOddsWarning] = useState('');
  const [bankroll, setBankroll] = useState('100');

  function handleSubmit(data: PlayerFormData) {
    setPlayerName(data.playerName);
    setResult(calculate(data));
  }

  async function handleGamesSelected(games: NBAGame[]) {
    setBatchPhase('processing');
    setBatchError('');
    setProgress({ current: 0, total: 0, playerName: 'Fetching props...' });

    try {
      // Fetch props for all selected games
      const allProps: PlayerProp[] = [];
      for (let i = 0; i < games.length; i++) {
        setProgress({ current: i + 1, total: games.length, playerName: `Fetching props for ${games[i].awayTeam} @ ${games[i].homeTeam}...` });
        const props = await fetchProps(games[i].id);
        allProps.push(...props);
      }

      if (allProps.length === 0) {
        setBatchError('No player props found for the selected games. Props may not be available yet.');
        setBatchPhase('select');
        return;
      }

      setProgress({ current: 0, total: allProps.length, playerName: 'Starting calculations...' });

      const result = await processBatch(
        {
          props: allProps,
          bankroll: parseFloat(bankroll) || 100,
          kellyMode: 'standard',
          paceModifier: 0,
          injuryModifier: 0,
        },
        fetchPlayerStats,
        (current, total, name) => {
          setProgress({ current, total, playerName: name });
        }
      );

      setBatchResult(result);
      setBatchPhase('results');
    } catch (err) {
      setBatchError(err instanceof Error ? err.message : 'Batch processing failed');
      setBatchPhase('select');
    }
  }

  async function handlePastedPlayers(players: ParsedPlayer[]) {
    setBatchPhase('processing');
    setBatchError('');
    setOddsWarning('');
    setProgress({ current: 0, total: 0, playerName: 'Fetching real odds for cross-reference...' });

    try {
      // Step 1: Fetch all today's games and their props for cross-referencing
      let allRealProps: PlayerProp[] = [];
      try {
        const games = await fetchGames();
        for (let i = 0; i < games.length; i++) {
          setProgress({
            current: i + 1,
            total: games.length,
            playerName: `Fetching odds: ${games[i].awayTeam} @ ${games[i].homeTeam}...`,
          });
          const props = await fetchProps(games[i].id);
          allRealProps.push(...props);
        }
      } catch {
        // If odds fetch fails, continue with no real odds (all will fall back to -110/-110)
        allRealProps = [];
      }

      // Step 2: Cross-reference parsed players against real sportsbook odds
      setProgress({ current: 0, total: players.length, playerName: 'Matching odds...' });
      const matches = crossReferenceOdds(players, allRealProps);

      const matchedCount = matches.filter((m) => m.matched).length;
      const unmatchedCount = matches.length - matchedCount;

      if (allRealProps.length === 0) {
        setOddsWarning(
          `Could not fetch sportsbook odds. All ${matches.length} players use estimated -110/-110 odds — results are model-only estimates.`
        );
      } else if (unmatchedCount > 0 && matchedCount > 0) {
        setOddsWarning(
          `${matchedCount} of ${matches.length} players matched to real sportsbook odds. ${unmatchedCount} use estimated -110/-110 — those results are less accurate.`
        );
      } else if (unmatchedCount === matches.length) {
        setOddsWarning(
          `No pasted players matched today's sportsbook odds. All ${matches.length} use estimated -110/-110 — results are model-only estimates.`
        );
      }

      // Step 3: Run batch with cross-referenced props
      const props = matches.map((m) => m.prop);

      const result = await processBatch(
        {
          props,
          bankroll: parseFloat(bankroll) || 100,
          kellyMode: 'standard',
          paceModifier: 0,
          injuryModifier: 0,
        },
        fetchPlayerStats,
        (current, total, name) => {
          setProgress({ current, total, playerName: name });
        }
      );

      setBatchResult(result);
      setBatchPhase('results');
    } catch (err) {
      setBatchError(err instanceof Error ? err.message : 'Batch processing failed');
      setBatchPhase('select');
    }
  }

  function clearBatch() {
    setBatchResult(null);
    setBatchPhase('select');
    setBatchError('');
    setOddsWarning('');
  }

  const tabClass = (active: boolean) =>
    `px-5 py-2.5 text-sm font-semibold rounded-t-lg transition-colors ${
      active
        ? 'text-white'
        : 'hover:bg-[var(--bg-card-hover)]'
    }`;
  const tabStyle = (active: boolean) => ({
    background: active ? 'var(--bg-card)' : 'transparent',
    color: active ? 'var(--accent)' : 'var(--text-secondary)',
    borderBottom: active ? '2px solid var(--accent)' : '2px solid transparent',
  });

  const cardStyle = {
    background: 'var(--bg-card)',
    border: '1px solid var(--border-subtle)',
  };

  return (
    <div className="space-y-6">
      {/* Mode Toggle */}
      <div className="flex gap-1" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
        <button type="button" className={tabClass(mode === 'batch')} style={tabStyle(mode === 'batch')} onClick={() => setMode('batch')}>
          Batch
        </button>
        <button type="button" className={tabClass(mode === 'single')} style={tabStyle(mode === 'single')} onClick={() => setMode('single')}>
          Single Player
        </button>
      </div>

      {/* Single Player Mode */}
      {mode === 'single' && (
        <>
          <div className="rounded-xl p-6" style={cardStyle}>
            <PlayerForm onSubmit={handleSubmit} />
          </div>

          {result && (
            <div className="rounded-xl p-6" style={cardStyle}>
              <ResultsDisplay result={result} playerName={playerName} />
              <button
                type="button"
                onClick={() => setResult(null)}
                className="mt-4 w-full rounded-lg py-2 text-sm transition-colors hover:opacity-80"
                style={{ border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)' }}
              >
                Clear Results
              </button>
            </div>
          )}
        </>
      )}

      {/* Batch Mode */}
      {mode === 'batch' && (
        <>
          {batchPhase === 'select' && (
            <>
              {batchError && (
                <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-400">
                  {batchError}
                </div>
              )}

              {/* Bankroll */}
              <div className="rounded-xl p-4" style={cardStyle}>
                <div className="flex items-center gap-3">
                  <label htmlFor="batchBankroll" className="text-sm font-medium whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>
                    Bankroll
                  </label>
                  <div className="relative flex-1 max-w-[160px]">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm" style={{ color: 'var(--text-muted)' }}>$</span>
                    <input
                      id="batchBankroll"
                      type="number"
                      min="1"
                      step="1"
                      value={bankroll}
                      onChange={(e) => setBankroll(e.target.value)}
                      className="w-full rounded-lg pl-7 pr-3 py-2 text-sm focus:outline-none"
                      style={{
                        background: 'var(--bg-secondary)',
                        border: '1px solid var(--border-subtle)',
                        color: 'var(--text-primary)',
                      }}
                    />
                  </div>
                  <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                    Kelly stakes sized to this amount
                  </span>
                </div>
              </div>

              <div className="rounded-xl p-6" style={cardStyle}>
                <GameSelector
                  onGamesSelected={handleGamesSelected}
                />
              </div>

              <div className="flex items-center gap-3">
                <div className="h-px flex-1" style={{ background: 'var(--border-subtle)' }} />
                <span className="text-xs" style={{ color: 'var(--text-muted)' }}>or paste lines manually</span>
                <div className="h-px flex-1" style={{ background: 'var(--border-subtle)' }} />
              </div>

              <div className="rounded-xl p-6" style={cardStyle}>
                <PasteInput onParsed={handlePastedPlayers} />
              </div>
            </>
          )}

          {batchPhase === 'processing' && (
            <div className="rounded-xl p-6" style={cardStyle}>
              <div className="text-center space-y-3">
                <div
                  className="inline-block h-8 w-8 animate-spin rounded-full border-4"
                  style={{ borderColor: 'var(--border-subtle)', borderTopColor: 'var(--accent)' }}
                />
                <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                  {progress.total > 0 && (
                    <span className="font-medium" style={{ color: 'var(--text-primary)' }}>{progress.current}/{progress.total} </span>
                  )}
                  {progress.playerName}
                </p>
                {progress.total > 0 && (
                  <div className="mx-auto w-64 h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--bg-secondary)' }}>
                    <div
                      className="h-full rounded-full transition-all duration-300"
                      style={{ width: `${(progress.current / progress.total) * 100}%`, background: 'var(--accent)' }}
                    />
                  </div>
                )}
              </div>
            </div>
          )}

          {batchPhase === 'results' && batchResult && (
            <>
              {oddsWarning && (
                <div
                  className="rounded-lg p-3 text-sm"
                  style={{ background: 'rgba(218, 119, 86, 0.1)', border: '1px solid rgba(218, 119, 86, 0.3)', color: 'var(--accent)' }}
                >
                  {oddsWarning}
                </div>
              )}
              <div className="rounded-xl p-6" style={cardStyle}>
                <BatchResultsTable results={batchResult} onClear={clearBatch} />
              </div>
              <AIAnalysisPanel
                batchResult={batchResult}
                bankroll={parseFloat(bankroll) || 100}
              />
            </>
          )}
        </>
      )}
    </div>
  );
}

export { calculate };
