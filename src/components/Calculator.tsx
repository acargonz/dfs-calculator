'use client';

import { useState } from 'react';
import PlayerForm from './PlayerForm';
import ResultsDisplay from './ResultsDisplay';
import GameSelector from './GameSelector';
import BatchResultsTable from './BatchResultsTable';
import PasteInput from './PasteInput';
import type { PlayerFormData, CalculationResult } from './types';
import type { NBAGame, PlayerProp } from '../lib/oddsApi';
import type { BatchResult } from '../lib/batchProcessor';
import type { ParsedPlayer } from '../lib/parsers';
import { fetchProps } from '../lib/oddsApi';
import { fetchPlayerStats } from '../lib/playerStats';
import { processBatch } from '../lib/batchProcessor';
import {
  devigProbit,
  modelCountingStat,
  modelPoints,
  blendProbabilities,
  applyModifiers,
  kellyStake,
  assignTier,
} from '../lib/math';
import type { Modifier } from '../lib/math';

type Mode = 'single' | 'batch';
type BatchPhase = 'select' | 'processing' | 'results';

function americanToDecimal(odds: number): number {
  if (odds < 0) return 1 + 100 / Math.abs(odds);
  return 1 + odds / 100;
}

function calculate(data: PlayerFormData): CalculationResult {
  const fair = devigProbit(data.overOdds, data.underOdds);

  const model =
    data.statType === 'points'
      ? modelPoints(data.mean, data.line, data.position)
      : modelCountingStat(data.mean, data.line, data.position, data.statType);

  let blended = blendProbabilities(model.overProb, fair.over, 0.6);

  const modifiers: Modifier[] = [];
  if (data.paceModifier !== 0) {
    modifiers.push({ name: 'Pace', ppDelta: data.paceModifier });
  }
  if (data.injuryModifier !== 0) {
    modifiers.push({ name: 'Injury', ppDelta: data.injuryModifier });
  }
  if (modifiers.length > 0) {
    blended = applyModifiers(blended, modifiers);
  }

  const decimalOdds = americanToDecimal(data.overOdds);
  const kelly = kellyStake(blended, decimalOdds, data.bankroll, data.kellyMode);

  const tier = assignTier({
    prob: blended,
    ev: kelly.ev,
    majorFlags: 0,
    minorFlags: 0,
  });

  return {
    fairOverProb: fair.over,
    fairUnderProb: fair.under,
    modelOverProb: model.overProb,
    modelUnderProb: model.underProb,
    blendedProb: blended,
    ev: kelly.ev,
    kellyStake: kelly.stake,
    kellyFraction: kelly.fraction,
    tier,
    source: model.source,
  };
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
          bankroll: 100,
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
    setProgress({ current: 0, total: players.length, playerName: 'Starting calculations...' });

    try {
      // Convert parsed players to PlayerProp format (default odds -110/-110 for paste)
      const props: PlayerProp[] = players.map((p) => ({
        playerName: p.playerName,
        statType: p.statType as PlayerProp['statType'],
        line: p.line,
        overOdds: -110,
        underOdds: -110,
        bookmaker: 'paste',
      }));

      const result = await processBatch(
        {
          props,
          bankroll: 100,
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
            <div className="rounded-xl p-6" style={cardStyle}>
              <BatchResultsTable results={batchResult} onClear={clearBatch} />
            </div>
          )}
        </>
      )}
    </div>
  );
}

export { calculate };
