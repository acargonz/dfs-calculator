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

export interface CalculationResult {
  fairOverProb: number;
  fairUnderProb: number;
  modelOverProb: number;
  modelUnderProb: number;
  blendedProb: number;
  ev: number;
  kellyStake: number;
  kellyFraction: number;
  tier: 'HIGH' | 'MEDIUM' | 'LOW' | 'REJECT';
  source: string;
}
