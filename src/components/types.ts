import type { SideEvaluation, TwoSidedEvaluation } from '../lib/twoSidedCalc';

export type Position = 'PG' | 'SG' | 'SF' | 'PF' | 'C';

export type StatType =
  | 'points'
  | 'rebounds'
  | 'assists'
  | 'steals'
  | 'blocks'
  | 'threes'
  | 'fantasy'
  | 'pra'
  | 'pts+rebs'
  | 'pts+asts'
  | 'rebs+asts';

export interface PlayerFormData {
  playerName: string;
  position: Position;
  statType: StatType;
  mean: number;
  line: number;
  overOdds: number;
  underOdds: number;
  bankroll: number;
  kellyMode: 'standard' | 'demon';
  paceModifier: number;
  injuryModifier: number;
}

/**
 * Two-sided calculation result. The calculator evaluates BOTH the over and the
 * under side of every prop and never picks a direction itself — that decision
 * belongs to the AI ensemble (which has injury data + the Algorithmic Prompt
 * filters — V2 is active in Supabase; V1 is archived). The UI uses
 * `pickBestSide()` only as a display helper.
 *
 * `CalculationResult` is structurally identical to `TwoSidedEvaluation` from
 * `twoSidedCalc.ts`; we re-alias it here so existing component imports keep
 * working.
 */
export type CalculationResult = TwoSidedEvaluation;
export type { SideEvaluation };
