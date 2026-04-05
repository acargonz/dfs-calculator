'use client';

import { useState } from 'react';
import PlayerForm from './PlayerForm';
import ResultsDisplay from './ResultsDisplay';
import type { PlayerFormData, CalculationResult } from './types';
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

function americanToDecimal(odds: number): number {
  if (odds < 0) return 1 + 100 / Math.abs(odds);
  return 1 + odds / 100;
}

function calculate(data: PlayerFormData): CalculationResult {
  // Step 1: De-vig market odds to get fair probabilities
  const fair = devigProbit(data.overOdds, data.underOdds);

  // Step 2: Model probability from player mean vs line
  const model =
    data.statType === 'points'
      ? modelPoints(data.mean, data.line, data.position)
      : modelCountingStat(data.mean, data.line, data.position, data.statType);

  // Step 3: Blend model (60%) and market (40%)
  let blended = blendProbabilities(model.overProb, fair.over, 0.6);

  // Step 3.5: Apply modifiers (pace, injury)
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

  // Step 4: Kelly staking
  const decimalOdds = americanToDecimal(data.overOdds);
  const kelly = kellyStake(blended, decimalOdds, data.bankroll, data.kellyMode);

  // Step 5: Assign confidence tier
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
  const [result, setResult] = useState<CalculationResult | null>(null);
  const [playerName, setPlayerName] = useState('');

  function handleSubmit(data: PlayerFormData) {
    setPlayerName(data.playerName);
    setResult(calculate(data));
  }

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-slate-700 bg-slate-800/50 p-6">
        <PlayerForm onSubmit={handleSubmit} />
      </div>

      {result && (
        <div className="rounded-xl border border-slate-700 bg-slate-800/50 p-6">
          <ResultsDisplay result={result} playerName={playerName} />
          <button
            type="button"
            onClick={() => setResult(null)}
            className="mt-4 w-full rounded-lg border border-slate-600 py-2 text-sm text-slate-400 hover:bg-slate-700 hover:text-white transition-colors"
          >
            Clear Results
          </button>
        </div>
      )}
    </div>
  );
}

export { calculate };
