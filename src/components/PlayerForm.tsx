'use client';

import { useState } from 'react';
import type { PlayerFormData, Position, StatType } from './types';

const POSITIONS: Position[] = ['PG', 'SG', 'SF', 'PF', 'C'];
const STAT_TYPES: { value: StatType; label: string }[] = [
  { value: 'points', label: 'Points' },
  { value: 'rebounds', label: 'Rebounds' },
  { value: 'assists', label: 'Assists' },
  { value: 'steals', label: 'Steals' },
  { value: 'blocks', label: 'Blocks' },
  { value: 'threes', label: 'Threes' },
  { value: 'fantasy', label: 'Fantasy Points (DK)' },
  { value: 'pra', label: 'Pts+Rebs+Asts' },
  { value: 'pts+rebs', label: 'Pts+Rebs' },
  { value: 'pts+asts', label: 'Pts+Asts' },
  { value: 'rebs+asts', label: 'Rebs+Asts' },
];

interface PlayerFormProps {
  onSubmit: (data: PlayerFormData) => void;
}

export default function PlayerForm({ onSubmit }: PlayerFormProps) {
  const [playerName, setPlayerName] = useState('');
  const [position, setPosition] = useState<Position>('SF');
  const [statType, setStatType] = useState<StatType>('points');
  const [mean, setMean] = useState('');
  const [line, setLine] = useState('');
  const [overOdds, setOverOdds] = useState('');
  const [underOdds, setUnderOdds] = useState('');
  const [bankroll, setBankroll] = useState('100');
  const [kellyMode, setKellyMode] = useState<'standard' | 'demon'>('standard');
  const [paceModifier, setPaceModifier] = useState('0');
  const [injuryModifier, setInjuryModifier] = useState('0');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [error, setError] = useState('');

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');

    const meanNum = parseFloat(mean);
    const lineNum = parseFloat(line);
    const overNum = parseFloat(overOdds);
    const underNum = parseFloat(underOdds);

    if (!playerName.trim()) {
      setError('Player name is required.');
      return;
    }
    if (isNaN(meanNum) || meanNum <= 0) {
      setError('Mean must be a positive number.');
      return;
    }
    if (isNaN(lineNum) || lineNum <= 0) {
      setError('Line must be a positive number.');
      return;
    }
    if (isNaN(overNum) || overNum === 0) {
      setError('Over odds must be a non-zero number (e.g., -110 or +150).');
      return;
    }
    if (isNaN(underNum) || underNum === 0) {
      setError('Under odds must be a non-zero number (e.g., -110 or +150).');
      return;
    }

    onSubmit({
      playerName: playerName.trim(),
      position,
      statType,
      mean: meanNum,
      line: lineNum,
      overOdds: overNum,
      underOdds: underNum,
      bankroll: parseFloat(bankroll) || 100,
      kellyMode,
      paceModifier: parseFloat(paceModifier) || 0,
      injuryModifier: parseFloat(injuryModifier) || 0,
    });
  }

  const inputClass =
    'w-full rounded-lg px-3 py-2 focus:outline-none transition-colors';
  const inputStyle = {
    background: 'var(--bg-secondary)',
    border: '1px solid var(--border-subtle)',
    color: 'var(--text-primary)',
  };
  const labelClass = 'block text-sm font-medium mb-1';
  const labelStyle = { color: 'var(--text-secondary)' };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {/* Player Name */}
      <div>
        <label htmlFor="playerName" className={labelClass} style={labelStyle}>
          Player Name
        </label>
        <input
          id="playerName"
          type="text"
          value={playerName}
          onChange={(e) => setPlayerName(e.target.value)}
          placeholder="e.g., LeBron James"
          className={inputClass}
          style={inputStyle}
        />
      </div>

      {/* Position & Stat Type row */}
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label htmlFor="position" className={labelClass} style={labelStyle}>
            Position
          </label>
          <select
            id="position"
            value={position}
            onChange={(e) => setPosition(e.target.value as Position)}
            className={inputClass}
            style={inputStyle}
          >
            {POSITIONS.map((pos) => (
              <option key={pos} value={pos}>
                {pos}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="statType" className={labelClass} style={labelStyle}>
            Stat Type
          </label>
          <select
            id="statType"
            value={statType}
            onChange={(e) => setStatType(e.target.value as StatType)}
            className={inputClass}
            style={inputStyle}
          >
            {STAT_TYPES.map((st) => (
              <option key={st.value} value={st.value}>
                {st.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Mean & Line row */}
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label htmlFor="mean" className={labelClass} style={labelStyle}>
            Player Mean (avg)
          </label>
          <input
            id="mean"
            type="number"
            step="0.1"
            value={mean}
            onChange={(e) => setMean(e.target.value)}
            placeholder="e.g., 27.5"
            className={inputClass}
            style={inputStyle}
          />
        </div>
        <div>
          <label htmlFor="line" className={labelClass} style={labelStyle}>
            Betting Line
          </label>
          <input
            id="line"
            type="number"
            step="0.5"
            value={line}
            onChange={(e) => setLine(e.target.value)}
            placeholder="e.g., 26.5"
            className={inputClass}
            style={inputStyle}
          />
        </div>
      </div>

      {/* Over & Under Odds row */}
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label htmlFor="overOdds" className={labelClass} style={labelStyle}>
            Over Odds (American)
          </label>
          <input
            id="overOdds"
            type="number"
            value={overOdds}
            onChange={(e) => setOverOdds(e.target.value)}
            placeholder="e.g., -130"
            className={inputClass}
            style={inputStyle}
          />
        </div>
        <div>
          <label htmlFor="underOdds" className={labelClass} style={labelStyle}>
            Under Odds (American)
          </label>
          <input
            id="underOdds"
            type="number"
            value={underOdds}
            onChange={(e) => setUnderOdds(e.target.value)}
            placeholder="e.g., +110"
            className={inputClass}
            style={inputStyle}
          />
        </div>
      </div>

      {/* Advanced Options */}
      <div>
        <button
          type="button"
          onClick={() => setShowAdvanced(!showAdvanced)}
          className="text-sm transition-colors"
          style={{ color: 'var(--accent)' }}
        >
          {showAdvanced ? 'Hide' : 'Show'} Advanced Options
        </button>

        {showAdvanced && (
          <div className="mt-3 space-y-4 rounded-lg p-4" style={{ border: '1px solid var(--border-subtle)' }}>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label htmlFor="bankroll" className={labelClass} style={labelStyle}>
                  Bankroll ($)
                </label>
                <input
                  id="bankroll"
                  type="number"
                  step="1"
                  value={bankroll}
                  onChange={(e) => setBankroll(e.target.value)}
                  placeholder="100"
                  className={inputClass}
                  style={inputStyle}
                />
              </div>
              <div>
                <label htmlFor="kellyMode" className={labelClass} style={labelStyle}>
                  Kelly Mode
                </label>
                <select
                  id="kellyMode"
                  value={kellyMode}
                  onChange={(e) => setKellyMode(e.target.value as 'standard' | 'demon')}
                  className={inputClass}
                  style={inputStyle}
                >
                  <option value="standard">Standard (1/4 Kelly)</option>
                  <option value="demon">Demon (1/8 Kelly)</option>
                </select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label htmlFor="paceModifier" className={labelClass} style={labelStyle}>
                  Pace Adj. (pp)
                </label>
                <input
                  id="paceModifier"
                  type="number"
                  step="0.5"
                  value={paceModifier}
                  onChange={(e) => setPaceModifier(e.target.value)}
                  placeholder="0"
                  className={inputClass}
                  style={inputStyle}
                />
              </div>
              <div>
                <label htmlFor="injuryModifier" className={labelClass} style={labelStyle}>
                  Injury Adj. (pp)
                </label>
                <input
                  id="injuryModifier"
                  type="number"
                  step="0.5"
                  value={injuryModifier}
                  onChange={(e) => setInjuryModifier(e.target.value)}
                  placeholder="0"
                  className={inputClass}
                  style={inputStyle}
                />
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Error message */}
      {error && (
        <p role="alert" className="text-red-400 text-sm">
          {error}
        </p>
      )}

      {/* Submit */}
      <button
        type="submit"
        className="w-full rounded-lg py-2.5 font-semibold text-white transition-colors hover:opacity-90"
        style={{ background: 'var(--accent)' }}
      >
        Calculate Edge
      </button>
    </form>
  );
}
