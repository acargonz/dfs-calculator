// ============================================================
// DFS Calculator — Math Engine v2.0
// All functions are pure, stateless, and cross-platform.
// See AGENTS.md for architecture and calibration decisions.
// ============================================================

// ---- Normal Distribution ----

/**
 * Standard normal CDF via erfc approximation.
 * Uses Abramowitz & Stegun 7.1.26 on erfc(x/√2).
 * Max error: < 1.5e-7 across the entire domain.
 */
export function normCDF(x: number): number {
  const SQRT2 = Math.SQRT2;
  const a = x / SQRT2;

  const p = 0.3275911;
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;

  const absA = Math.abs(a);
  const t = 1 / (1 + p * absA);
  const erfc =
    ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) *
    t *
    Math.exp(-absA * absA);

  if (a >= 0) {
    return 1 - 0.5 * erfc;
  }
  return 0.5 * erfc;
}

/**
 * Inverse standard normal CDF (percent-point function).
 * Rational approximation by Peter Acklam (relative error < 1.15e-9).
 */
export function normPPF(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  if (p === 0.5) return 0;

  const a = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
    1.383577518672690e2, -3.066479806614716e1, 2.506628277459239e0,
  ];
  const b = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
    6.680131188771972e1, -1.328068155288572e1,
  ];
  const c = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838e0,
    -2.549732539343734e0, 4.374664141464968e0, 2.938163982698783e0,
  ];
  const d = [
    7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996e0,
    3.754408661907416e0,
  ];

  const pLow = 0.02425;
  const pHigh = 1 - pLow;
  let q: number;

  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  } else if (p <= pHigh) {
    q = p - 0.5;
    const r = q * q;
    return (
      ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) *
        q) /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
    );
  } else {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return (
      -(
        ((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q +
        c[5]
      ) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }
}

// ---- Odds Conversion ----

/**
 * Convert American odds to implied probability (includes vig).
 * -110 → 0.5238,  +200 → 0.3333
 */
export function americanToImplied(odds: number): number {
  if (odds < 0) {
    return Math.abs(odds) / (Math.abs(odds) + 100);
  }
  return 100 / (odds + 100);
}

// ---- De-vigging (Probit method) ----

/**
 * Probit de-vig: remove vig from over/under odds to get fair probabilities.
 *
 * 1. Convert both sides to implied probabilities (sum > 1 due to vig).
 * 2. Map to z-scores via normPPF.
 * 3. Centre the z-scores so they sum to 0.
 * 4. Map back to probabilities via normCDF (now sum to 1).
 */
export function devigProbit(
  overOdds: number,
  underOdds: number
): { over: number; under: number } {
  const pOver = americanToImplied(overOdds);
  const pUnder = americanToImplied(underOdds);

  const zOver = normPPF(pOver);
  const zUnder = normPPF(pUnder);

  const zMid = (zOver + zUnder) / 2;

  return {
    over: normCDF(zOver - zMid),
    under: normCDF(zUnder - zMid),
  };
}

// ---- Gamma / Log-Gamma ----

/**
 * Lanczos approximation for ln(Γ(z)), z > 0.
 * Required for negative binomial PMF with non-integer n.
 */
export function lnGamma(z: number): number {
  if (z <= 0) return Infinity;

  const g = 7;
  const coef = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];

  if (z < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * z)) - lnGamma(1 - z);
  }

  z -= 1;
  let x = coef[0];
  for (let i = 1; i < g + 2; i++) {
    x += coef[i] / (z + i);
  }
  const t = z + g + 0.5;
  return (
    0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x)
  );
}

// ---- Negative Binomial Distribution ----

/**
 * Negative Binomial PMF: P(X = k | n, p)
 *
 * scipy convention: n successes, p = success prob, k = # failures.
 * Formula: Γ(k+n) / (Γ(n) · k!) · p^n · (1-p)^k
 * Computed in log-space to avoid overflow.
 */
export function negBinomPMF(k: number, n: number, p: number): number {
  if (k < 0 || !Number.isInteger(k)) return 0;
  if (n <= 0 || p <= 0 || p > 1) return 0;

  const logPMF =
    lnGamma(k + n) -
    lnGamma(n) -
    lnGamma(k + 1) +
    n * Math.log(p) +
    k * Math.log(1 - p);

  return Math.exp(logPMF);
}

/**
 * Negative Binomial CDF: P(X ≤ k | n, p)
 */
export function negBinomCDF(k: number, n: number, p: number): number {
  let sum = 0;
  for (let i = 0; i <= k; i++) {
    sum += negBinomPMF(i, n, p);
  }
  return sum;
}

// ---- Stat Modelling ----

/**
 * Default standard deviation = mean × CV, where CV is looked up
 * by position and stat. See AGENTS.md for the full table and rationale.
 */
function defaultStd(mean: number, position: string, stat: string): number {
  const pos = position.toUpperCase();
  const s = stat.toLowerCase();

  const cvTable: Record<string, Record<string, number>> = {
    PG: {
      points: 0.33, rebounds: 0.38, assists: 0.38,
      steals: 0.65, blocks: 0.70, threes: 0.55,
    },
    SG: {
      points: 0.30, rebounds: 0.36, assists: 0.40,
      steals: 0.65, blocks: 0.70, threes: 0.55,
    },
    SF: {
      points: 0.33, rebounds: 0.33, assists: 0.42,
      steals: 0.65, blocks: 0.65, threes: 0.58,
    },
    PF: {
      points: 0.33, rebounds: 0.30, assists: 0.45,
      steals: 0.65, blocks: 0.60, threes: 0.60,
    },
    C: {
      points: 0.35, rebounds: 0.28, assists: 0.48,
      steals: 0.70, blocks: 0.55, threes: 0.65,
    },
  };

  const posCV = cvTable[pos] || cvTable['SF'];
  const cv = posCV[s] || 0.40;
  return mean * cv;
}

/**
 * Convert mean/std to negative binomial (n, p) parameters.
 *
 * NB mean = n·(1-p)/p, variance = n·(1-p)/p²
 * Solving: p = mean/variance, n = mean²/(variance - mean)
 *
 * If variance ≤ mean (underdispersed), use n=200 as Poisson approximation.
 */
function meanStdToNB(mean: number, std: number): { n: number; p: number } {
  const variance = std * std;

  if (variance <= mean) {
    return { n: 200, p: 200 / (200 + mean) };
  }

  return {
    p: mean / variance,
    n: (mean * mean) / (variance - mean),
  };
}

export interface StatModelResult {
  overProb: number;
  underProb: number;
  mean: number;
  std: number;
  source: string;
}

/**
 * Model a counting stat (rebounds, assists, steals, blocks, threes)
 * using the negative binomial distribution.
 * "Over" = P(X > line) = 1 - P(X ≤ floor(line)).
 */
export function modelCountingStat(
  mean: number,
  line: number,
  position: string,
  stat: string,
  userStd?: number
): StatModelResult {
  const std = userStd ?? defaultStd(mean, position, stat);
  const { n, p } = meanStdToNB(mean, std);

  const cutoff = Math.floor(line);
  const cdf = negBinomCDF(cutoff, n, p);
  const overProb = 1 - cdf;

  return {
    overProb: Math.max(0, Math.min(1, overProb)),
    underProb: Math.max(0, Math.min(1, cdf)),
    mean,
    std,
    source: 'NegBinomial',
  };
}

/**
 * Model points scored. Same math as counting stats but labelled "Binomial"
 * for backward compatibility with the V1 prompt output format.
 */
export function modelPoints(
  mean: number,
  line: number,
  position: string,
  userStd?: number
): StatModelResult {
  const std = userStd ?? defaultStd(mean, position, 'points');
  const { n, p } = meanStdToNB(mean, std);

  const cutoff = Math.floor(line);
  const cdf = negBinomCDF(cutoff, n, p);
  const overProb = 1 - cdf;

  return {
    overProb: Math.max(0, Math.min(1, overProb)),
    underProb: Math.max(0, Math.min(1, cdf)),
    mean,
    std,
    source: 'Binomial',
  };
}

// ---- Modifiers ----

export interface Modifier {
  name: string;
  ppDelta: number; // percentage points (+3 = add 0.03)
}

/**
 * Apply additive modifiers to a base probability. Clamps to [0.01, 0.99].
 */
export function applyModifiers(
  baseProb: number,
  modifiers: Modifier[]
): number {
  const totalDelta = modifiers.reduce((sum, m) => sum + m.ppDelta, 0);
  const adjusted = baseProb + totalDelta / 100;
  return Math.max(0.01, Math.min(0.99, adjusted));
}

// ---- Blending ----

/**
 * Weighted blend of model probability and market-implied probability.
 * Default: 60% model / 40% market.
 */
export function blendProbabilities(
  modelProb: number,
  marketProb: number,
  modelWeight: number = 0.6
): number {
  return modelProb * modelWeight + marketProb * (1 - modelWeight);
}

// ---- Kelly Criterion ----

export interface KellyResult {
  fraction: number;
  stake: number;
  ev: number;
}

/**
 * Fractional Kelly staking.
 * Full Kelly: f* = (b·p - q) / b
 * Standard = 1/4 Kelly, Demon = 1/8 Kelly.
 */
export function kellyStake(
  trueProb: number,
  decimalOdds: number,
  bankroll: number = 1,
  mode: 'standard' | 'demon' = 'standard'
): KellyResult {
  const b = decimalOdds - 1;
  const q = 1 - trueProb;
  const ev = trueProb * b - q;
  const fraction = mode === 'standard' ? 0.25 : 0.125;

  if (ev <= 0) {
    return { fraction, stake: 0, ev };
  }

  const fullKelly = (trueProb * b - q) / b;
  const stake = fullKelly * fraction * bankroll;
  return { fraction, stake: Math.max(0, stake), ev };
}

// ---- Tier Assignment ----

export type Tier = 'HIGH' | 'MEDIUM' | 'LOW' | 'REJECT';

export interface TierInput {
  prob: number;
  ev: number;
  majorFlags: number;
  minorFlags: number;
}

/**
 * Assign confidence tier. See AGENTS.md for thresholds table.
 * 1+ major flag → drop one tier. 2+ minor flags → drop one tier.
 */
export function assignTier(input: TierInput): Tier {
  const { prob, ev, majorFlags, minorFlags } = input;

  let tier: Tier;
  if (prob >= 0.58 && ev >= 0.08) tier = 'HIGH';
  else if (prob >= 0.54 && ev >= 0.05) tier = 'MEDIUM';
  else if (prob >= 0.50 && ev >= 0.02) tier = 'LOW';
  else return 'REJECT';

  const tiers: Tier[] = ['HIGH', 'MEDIUM', 'LOW', 'REJECT'];
  let idx = tiers.indexOf(tier);

  if (majorFlags >= 1) idx = Math.min(idx + 1, 3);
  if (minorFlags >= 2) idx = Math.min(idx + 1, 3);

  return tiers[idx];
}
