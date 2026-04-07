/**
 * AI analysis orchestrator.
 *
 * Accepts calculator batch results + context data (injuries, lineups),
 * builds a structured user message, sends to the chosen AI provider
 * (Gemini, Claude, or OpenRouter), and parses the structured JSON response.
 *
 * Supports ensemble mode: multiple providers run in parallel, responses merged
 * via ensembleConsensus.ts to flag agreements/disagreements/rejections.
 *
 * The system prompt is the currently-active Algorithmic Prompt from Supabase
 * (V2 as of seed; V1 retained as archived for history). The user message
 * contains the actual slate data.
 */

import type { BatchResult } from './batchProcessor';
import type { InjuryEntry } from '../app/api/injuries/route';
import { determineSlateSeasonType, type SeasonType } from './playerStatsBlend';

export type AIProvider = 'gemini' | 'claude' | 'openrouter';

export interface AIAnalysisRequest {
  provider: AIProvider;
  apiKey: string;                 // Server-side env key OR user-supplied BYO key
  model?: string;                 // Override default model
  systemPrompt: string;           // Active Algorithmic Prompt content (V2 by default)
  calculatorResults: BatchResult;
  injuries?: InjuryEntry[];
  lineupContext?: string;         // Optional pre-formatted lineup text
  bankroll: number;
  platform?: 'prizepicks' | 'underdog' | 'pick6';
  jurisdiction?: string;          // Default 'California'
}

export interface AIPick {
  playerName: string;
  statType: string;
  line: number;
  direction: 'over' | 'under';
  confidenceTier: 'A' | 'B' | 'C' | 'REJECT';
  reasoning: string;
  flags: Array<{ type: string; severity: 'minor' | 'major'; note: string }>;
  modifiers?: {
    pace?: number;
    injury?: number;
    matchup?: number;
    rest?: number;
  };
  finalProbability?: number;
  finalEV?: number;
}

export interface AISlip {
  platform: string;
  slipType: string;
  legsCount: number;
  stakeAmount: number;
  expectedPayout: number;
  pickNames: string[];           // Array of "Player — Stat Over/Under X.X"
  rationale: string;
}

export interface AIAnalysisResponse {
  picks: AIPick[];
  slips: AISlip[];
  summary: string;
  warnings: string[];
  rawText: string;
  tokensUsed?: number;
  durationMs: number;
  model: string;
  provider: AIProvider;
}

// ============================================================================
// Message builders
// ============================================================================

/**
 * Format American odds for the prompt table. Handles positive/negative
 * and falls back to "N/A" when the odds are zero or missing.
 */
export function formatAmericanOdds(odds: number | null | undefined): string {
  if (odds === null || odds === undefined || odds === 0 || !Number.isFinite(odds)) {
    return 'N/A';
  }
  return odds > 0 ? `+${odds}` : `${odds}`;
}

/**
 * Promote per-player season types in a BatchResult up to a single slate-level
 * label. Used to drive the "Season Phase" line in the user message and
 * activates the Postseason Context Protocol section in Algorithmic Prompt V2.
 *
 * Rules (delegated to determineSlateSeasonType):
 *   - Any player with Finals data → 'finals'
 *   - Else any player with playoffs data → 'playoffs'
 *   - Else → 'regular'
 *
 * Players whose stats fetch failed (status !== 'success') are skipped — their
 * undefined seasonType collapses to 'regular' in the helper anyway, so the
 * slate label is driven entirely by successfully-fetched players.
 */
export function getSlateSeasonType(batchResult: BatchResult): SeasonType {
  const types: SeasonType[] = batchResult.players
    .map((p) => p.seasonType)
    .filter((t): t is SeasonType => t !== undefined);
  return determineSlateSeasonType(types);
}

export function buildUserMessage(req: AIAnalysisRequest): string {
  const lines: string[] = [];
  const slateSeasonType = getSlateSeasonType(req.calculatorResults);

  lines.push(`## Slate Analysis Request`);
  lines.push(`Date: ${new Date().toISOString().split('T')[0]}`);
  lines.push(`Season Phase: ${slateSeasonType}`);
  lines.push(`Jurisdiction: ${req.jurisdiction || 'California'}`);
  if (req.platform) lines.push(`Platform: ${req.platform}`);
  lines.push(`Bankroll: $${req.bankroll.toFixed(2)}`);
  lines.push('');

  // ------------------------------------------------------------------
  // Postseason Context Banner — only emitted when at least one player's
  // stats blend includes playoff or Finals data. Tells the model that:
  //   1. The "Mean" column is no longer pure regular-season — it's a
  //      weighted blend (regular + playoffs (+ finals)).
  //   2. The Postseason Context Protocol from the system prompt
  //      (Algorithmic Prompt V2 Section 0.3a) applies for THIS slate.
  //   3. Calculator stakes have already been quarter-Kelly-scaled by
  //      0.75x for postseason discipline; the model should not double-
  //      apply the reduction.
  // ------------------------------------------------------------------
  if (slateSeasonType !== 'regular') {
    lines.push(`## Postseason Context`);
    if (slateSeasonType === 'finals') {
      lines.push(`This slate contains NBA FINALS games. Activate the Postseason Context Protocol (Section 0.3a) — Finals subsection. The "Mean" column for each player is a blend of regular season + playoffs + Finals games (weights shown in the gamesPlayed counts row). Defensive intensity, rotation tightening, and home/road splits matter MORE than in any earlier round. Star usage is at peak — secondary players are more vulnerable to UNDER outcomes on volume props.`);
    } else {
      lines.push(`This slate contains NBA PLAYOFF games (rounds 1–3, no Finals yet). Activate the Postseason Context Protocol (Section 0.3a) — Playoffs subsection. The "Mean" column for each player is a blend of regular season + playoffs games. Rotations are tightening, pace is slower, defensive scheming is more aggressive than the regular season.`);
    }
    lines.push(`The calculator has already applied a 0.75x Kelly multiplier on top of the standard quarter-Kelly stake — DO NOT downgrade tiers further "for postseason variance" since that adjustment is already in the stake column.`);
    lines.push('');
  }

  // ------------------------------------------------------------------
  // Data Availability (CRITICAL — keeps models from downgrading on absent data)
  // ------------------------------------------------------------------
  const hasInjuries = !!(req.injuries && req.injuries.length > 0);
  const hasLineups = !!req.lineupContext && req.lineupContext.length > 0;

  lines.push(`## Data Availability`);
  lines.push(`You are working with a constrained free-data stack. Treat this block as authoritative — do NOT demand or assume additional data beyond what is listed here. Do NOT downgrade picks or declare "NO-BET DAY" simply because a data source below is marked UNAVAILABLE. Use what IS available and proceed with best-effort analysis.`);
  lines.push('');
  lines.push(`AVAILABLE:`);
  lines.push(`- Sharp consensus odds (over/under American) from The Odds API — per-row in the table below.`);
  lines.push(`- Season-long player averages (PBP Stats) — the "Mean" column below.`);
  lines.push(`- Calculator-computed fair probabilities (devigged), model probabilities (negative binomial / normal), 60/40 blended probability, EV vs posted price, quarter-Kelly stake, and tier.`);
  lines.push(`- Player position (when matched in balldontlie).`);
  lines.push(`- ESPN injury report (${hasInjuries ? `${req.injuries!.length} entries` : 'empty — zero reported injuries at fetch time'}).`);
  if (hasLineups) lines.push(`- Team roster / lineup context (ESPN).`);
  lines.push('');
  lines.push(`UNAVAILABLE (do not ask for, do not penalize for absence):`);
  if (!hasLineups) lines.push(`- Pre-game confirmed starting lineups (not free).`);
  lines.push(`- Team affiliation for every prop player (only injured players have team tagged).`);
  lines.push(`- Rolling last-N game logs / recent form.`);
  lines.push(`- Pace, matchup DVP, altitude, rest/B2B context.`);
  lines.push(`- Minute projections, usage rate, field ownership.`);
  lines.push(`- Vegas totals/spreads.`);
  lines.push('');
  lines.push(`ANALYSIS RULES FOR THIS DATA SET:`);
  lines.push(`1. The calculator's "Tier" (HIGH / MEDIUM / LOW / REJECT) is your primary signal. It already blends sharp odds with a negative-binomial model calibrated on season means.`);
  lines.push(`2. HIGH tier → map to confidenceTier "A". MEDIUM → "B". LOW → "C". REJECT → "REJECT".`);
  lines.push(`3. Only override the calculator tier when the injury report gives clear, direct evidence (e.g. starter listed OUT → teammates' usage picks upgraded; target player listed OUT → REJECT the pick).`);
  lines.push(`4. Do NOT invent modifiers for missing pace/matchup data. Leave those fields at 0 in the "modifiers" block.`);
  lines.push(`5. A valid analysis can produce picks even with zero injury adjustments. "Insufficient context" is NOT an acceptable excuse to return an empty picks array when the calculator has produced HIGH or MEDIUM tiers.`);
  lines.push(`6. If the calculator returned HIGH/MEDIUM tiers, you MUST return those as picks (with appropriate A/B confidence) unless the injury report contains a direct contradiction.`);
  lines.push('');

  // Calculator results — BOTH sides exposed so the AI can pick a direction
  lines.push(`## Calculator Results (${req.calculatorResults.players.length} props)`);
  lines.push(`Summary (counts use the stronger side per row): ${req.calculatorResults.summary.high} HIGH, ${req.calculatorResults.summary.medium} MEDIUM, ${req.calculatorResults.summary.low} LOW, ${req.calculatorResults.summary.reject} REJECT`);
  lines.push('');
  lines.push('IMPORTANT: Each row shows the calculator output for BOTH the over and under side. The calculator never picks a direction — that is YOUR job. Compare OverEV vs UnderEV (and OverTier vs UnderTier) and back the side with the stronger edge for each player you choose to recommend.');
  lines.push('');
  lines.push('Columns: player, position, stat, line, sharp over odds, sharp under odds, season mean, fair over %, fair under %, model over %, model under %, blended over %, blended under %, over EV, under EV, over Kelly stake, under Kelly stake, over tier, under tier.');
  lines.push('');
  lines.push('| Player | Pos | Stat | Line | O Odds | U Odds | Mean | FairOver | FairUnder | ModelOver | ModelUnder | BlendOver | BlendUnder | OverEV | UnderEV | OverStake | UnderStake | OverTier | UnderTier |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const p of req.calculatorResults.players) {
    if (p.status !== 'success' || !p.result) {
      lines.push(
        `| ${p.playerName} | ${p.position || '—'} | ${p.statType} | ${p.line} | ${formatAmericanOdds(p.overOdds)} | ${formatAmericanOdds(p.underOdds)} | — | — | — | — | — | — | — | — | — | — | — | — | ERROR: ${p.statusMessage || 'unknown'} |`,
      );
      continue;
    }
    const r = p.result;
    const o = r.over;
    const u = r.under;
    lines.push(
      `| ${p.playerName} | ${p.position || '—'} | ${p.statType} | ${p.line} | ${formatAmericanOdds(p.overOdds)} | ${formatAmericanOdds(p.underOdds)} | ${p.mean.toFixed(1)} | ${(o.fairProb * 100).toFixed(1)}% | ${(u.fairProb * 100).toFixed(1)}% | ${(o.modelProb * 100).toFixed(1)}% | ${(u.modelProb * 100).toFixed(1)}% | ${(o.blendedProb * 100).toFixed(1)}% | ${(u.blendedProb * 100).toFixed(1)}% | ${(o.ev * 100).toFixed(1)}% | ${(u.ev * 100).toFixed(1)}% | $${o.kellyStake.toFixed(2)} | $${u.kellyStake.toFixed(2)} | ${o.tier} | ${u.tier} |`,
    );
  }
  lines.push('');

  // Injuries
  if (req.injuries && req.injuries.length > 0) {
    lines.push(`## Injury Report (${req.injuries.length} players)`);
    for (const inj of req.injuries) {
      lines.push(`- ${inj.playerName} (${inj.team}, ${inj.position}) — ${inj.status}. ${inj.comment}`);
    }
    lines.push('');
  }

  // Lineups
  if (req.lineupContext) {
    lines.push(`## Lineup Context`);
    lines.push(req.lineupContext);
    lines.push('');
  }

  // Output instruction
  lines.push(`## Response Format`);
  lines.push(`Return a SINGLE compact JSON object matching the exact shape below. Hard limits:`);
  lines.push(`- "reasoning" per pick MUST be <= 250 characters.`);
  lines.push(`- "summary" MUST be <= 400 characters (2–4 sentences max).`);
  lines.push(`- "warnings" array MUST contain at most 4 items, each <= 150 characters.`);
  lines.push(`- NO markdown fences, NO commentary outside the JSON, NO trailing text.`);
  lines.push(`- If you decide no picks are actionable, return picks: [] with a one-sentence summary explaining why.`);
  lines.push(``);
  lines.push(`NUMERIC FORMAT — READ CAREFULLY:`);
  lines.push(`- "finalProbability" MUST be a DECIMAL between 0 and 1. Example: 58% → write 0.58 (NOT 58, NOT "58%").`);
  lines.push(`- "finalEV" MUST be a DECIMAL, typically between -1 and 1. Example: +7% EV → write 0.07 (NOT 7, NOT 7.0, NOT "7%"). A -4% EV → write -0.04.`);
  lines.push(`- The table above shows EV/probability columns formatted as percentage strings ("10.8%") for human readability ONLY. In your JSON output, use the decimal form (0.108).`);
  lines.push(``);
  lines.push('```');
  lines.push(`{`);
  lines.push(`  "picks": [`);
  lines.push(`    {`);
  lines.push(`      "playerName": "string",`);
  lines.push(`      "statType": "string",`);
  lines.push(`      "line": number,`);
  lines.push(`      "direction": "over"|"under",`);
  lines.push(`      "confidenceTier": "A"|"B"|"C"|"REJECT",`);
  lines.push(`      "reasoning": "1-3 sentences",`);
  lines.push(`      "flags": [{"type":"string","severity":"minor"|"major","note":"string"}],`);
  lines.push(`      "modifiers": {"pace":0,"injury":0,"matchup":0,"rest":0},`);
  lines.push(`      "finalProbability": 0.58,`);
  lines.push(`      "finalEV": 0.07`);
  lines.push(`    }`);
  lines.push(`  ],`);
  lines.push(`  "slips": [`);
  lines.push(`    {`);
  lines.push(`      "platform": "prizepicks|underdog|pick6",`);
  lines.push(`      "slipType": "power|flex|champions|2-pick|3-pick",`);
  lines.push(`      "legsCount": number,`);
  lines.push(`      "stakeAmount": number,`);
  lines.push(`      "expectedPayout": number,`);
  lines.push(`      "pickNames": ["Player — Stat Over/Under X.X"],`);
  lines.push(`      "rationale": "why these legs together"`);
  lines.push(`    }`);
  lines.push(`  ],`);
  lines.push(`  "summary": "2-4 sentence slate overview",`);
  lines.push(`  "warnings": ["any concerns about data, variance, etc."]`);
  lines.push(`}`);
  lines.push('```');

  return lines.join('\n');
}

// ============================================================================
// Response parsing
// ============================================================================

export function extractJsonFromText(raw: string): string {
  // Strip code fences if present
  let text = raw.trim();

  // Remove leading/trailing markdown fences
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');

  // Find the first top-level object and walk forward tracking brace/bracket
  // balance + string state. If we find the matching close, return just the
  // object (prose after the JSON is discarded). If the input is truncated
  // and no match is found, return everything from firstBrace to end so the
  // caller can heal the truncation.
  const firstBrace = text.indexOf('{');
  if (firstBrace < 0) return text.trim();

  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  let end = -1;

  for (let i = firstBrace; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === '{' || ch === '[') {
      stack.push(ch);
    } else if (ch === '}' || ch === ']') {
      stack.pop();
      if (stack.length === 0) {
        end = i;
        break;
      }
    }
  }

  if (end >= 0) {
    return text.substring(firstBrace, end + 1).trim();
  }

  // Truncated: return everything from the first brace onward.
  return text.substring(firstBrace).trim();
}

/**
 * Attempt to heal a truncated JSON string (response hit token limit mid-output).
 * Walks the text once, tracking string/object/array nesting, then closes any
 * unterminated string + any unclosed arrays/objects in LIFO order.
 * Returns the original text unchanged if the structure is already valid.
 */
export function healTruncatedJson(text: string): string {
  const stack: Array<'{' | '[' | '"'> = [];
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const top = stack[stack.length - 1];

    if (top === '"') {
      // Inside a string: watch for escape sequences and closing quote
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === '"') stack.pop();
      continue;
    }

    // Outside a string
    if (ch === '"') stack.push('"');
    else if (ch === '{') stack.push('{');
    else if (ch === '[') stack.push('[');
    else if (ch === '}') {
      if (top === '{') stack.pop();
    } else if (ch === ']') {
      if (top === '[') stack.pop();
    }
  }

  if (stack.length === 0) return text;

  // Repair: close in reverse order
  let healed = text;

  // If we ended mid-escape, drop the trailing backslash
  if (escaped) healed = healed.slice(0, -1);

  // If we ended inside a string, close it and drop the trailing partial value
  if (stack[stack.length - 1] === '"') {
    healed += '"';
    stack.pop();
  }

  // Close remaining containers in LIFO order.
  // Remove any trailing comma that would now be a syntax error.
  healed = healed.replace(/,\s*$/, '');
  while (stack.length > 0) {
    const open = stack.pop();
    healed += open === '{' ? '}' : ']';
  }

  return healed;
}

/**
 * Best-effort coerce an unknown value to a finite JS number.
 *
 * Handles the two common AI output oddities:
 *   1. Numbers wrapped as strings: `"0.58"`, `"60"`, `"-0.07"`.
 *   2. Percent-suffixed strings:  `"58%"`, `"7.5 %"`.
 *
 * Returns `undefined` for everything we can't safely convert — callers should
 * treat `undefined` as "drop this field, don't persist garbage."
 */
function toFiniteNumber(v: unknown): number | undefined {
  if (typeof v === 'number') {
    return Number.isFinite(v) ? v : undefined;
  }
  if (typeof v === 'string') {
    const cleaned = v.trim().replace(/%/g, '').replace(/\s+/g, '');
    if (cleaned === '') return undefined;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/**
 * AI providers frequently return `finalEV` and `finalProbability` in the
 * wrong shape:
 *
 *   1. Percent-encoded number:   `58`  → means 58%  → want 0.58.
 *   2. Stringified decimal:      `"0.58"` → want 0.58.
 *   3. Stringified percent:      `"60"` or `"58%"` → want 0.58.
 *   4. Non-finite garbage:       `NaN`, `undefined`, arbitrary object.
 *
 * The display layer multiplies by 100, so a value that slips through
 * unnormalized shows up at e.g. 5800% — which is exactly the "AI Prob %"
 * bug that prompted this rewrite.
 *
 * Normalization rules:
 *   - `finalProbability` is bounded `[0, 1]` by definition. If the coerced
 *     value is > 1, divide by 100 once. If it's STILL outside `[0, 1]` after
 *     that single divide, the value is garbage → drop to `undefined`.
 *   - `finalEV` for sports props at realistic prices is bounded `|EV| < 1`.
 *     If the coerced |value| is > 1, divide by 100 once. If it's STILL > 1,
 *     drop to `undefined`.
 *
 * Returns a fresh copy — does not mutate the input.
 */
export function normalizeAIPick(pick: AIPick): AIPick {
  const out = { ...pick };

  // ---- finalProbability → [0, 1] ------------------------------------------
  let fp = toFiniteNumber(out.finalProbability as unknown);
  if (fp === undefined) {
    out.finalProbability = undefined;
  } else {
    if (fp > 1) fp = fp / 100;
    // After the single divide, the value MUST live in [0, 1] for a probability.
    // Anything else is garbage (e.g. AI hallucinated `5800`) — drop it so the
    // DB column is left NULL instead of a bad value.
    out.finalProbability = fp >= 0 && fp <= 1 ? fp : undefined;
  }

  // ---- finalEV → roughly [-1, 1] ------------------------------------------
  let ev = toFiniteNumber(out.finalEV as unknown);
  if (ev === undefined) {
    out.finalEV = undefined;
  } else {
    if (Math.abs(ev) > 1) ev = ev / 100;
    // Clamp band: |ev| <= 1 is the realistic range. Beyond that, drop it.
    out.finalEV = Math.abs(ev) <= 1 ? ev : undefined;
  }

  return out;
}

/**
 * Salvage individually-parseable pick objects from a malformed JSON response.
 *
 * Where `healTruncatedJson` handles END-of-response truncation (unclosed
 * strings/brackets), this function handles MID-response corruption — e.g.
 * when an open-source model emits an unescaped quote inside a `reasoning`
 * field halfway through the picks array, invalidating every byte after it
 * for the top-level parser.
 *
 * Strategy:
 *   1. Locate `"picks": [` in the raw text.
 *   2. Walk forward from there tracking brace depth + string state. Every
 *      time we close a top-level object (depth returns to 0), slice it out
 *      and attempt `JSON.parse` on that single object.
 *   3. Keep the picks that parse; silently skip the ones that don't.
 *
 * Returns `null` if we can't even find the picks array. Returns an array
 * (possibly empty) otherwise. The caller treats `null` as "give up and
 * throw" and an empty array as "response had no valid picks at all".
 *
 * Note: the walker's string tracking is somewhat forgiving. An unescaped
 * quote inside `reasoning` will confuse the `inString` toggle locally, but
 * as long as the AI's quotes are BALANCED (which they usually are — the
 * issue is quoting style, not missing close-quotes), the outer `{...}`
 * boundary still lines up correctly. Individual objects that truly can't
 * be parsed just get skipped.
 */
export function salvagePicksFromMalformed(text: string): AIPick[] | null {
  // Find the "picks": [  opener (tolerate whitespace variations).
  const picksMatch = text.match(/"picks"\s*:\s*\[/);
  if (!picksMatch || picksMatch.index === undefined) return null;

  const arrayStart = picksMatch.index + picksMatch[0].length;

  const salvaged: AIPick[] = [];
  let depth = 0;
  let inString = false;
  let escaped = false;
  let objStart = -1;

  for (let i = arrayStart; i < text.length; i++) {
    const ch = text[i];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }

    if (inString) {
      if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === '{') {
      if (depth === 0) objStart = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && objStart >= 0) {
        const objText = text.substring(objStart, i + 1);
        // Try strict parse first, then try healing the object in case it
        // was partially truncated.
        let parsedObj: unknown = null;
        try {
          parsedObj = JSON.parse(objText);
        } catch {
          try {
            parsedObj = JSON.parse(healTruncatedJson(objText));
          } catch {
            // Skip this pick — it's unparseable
          }
        }
        if (parsedObj && typeof parsedObj === 'object' && !Array.isArray(parsedObj)) {
          const asPick = parsedObj as AIPick;
          // Basic sanity: must have a playerName to be worth keeping
          if (typeof asPick.playerName === 'string' && asPick.playerName.length > 0) {
            salvaged.push(asPick);
          }
        }
        objStart = -1;
      }
      // depth may dip negative if the outer array was never opened cleanly
      // (e.g. the "picks" key was missing brackets). Stop gracefully.
      if (depth < 0) break;
    } else if (ch === ']' && depth === 0) {
      // End of the picks array
      break;
    }
  }

  return salvaged;
}

export function parseAIResponse(rawText: string): {
  picks: AIPick[];
  slips: AISlip[];
  summary: string;
  warnings: string[];
} {
  // Build a "from-first-brace" version of the raw text to preserve the tail
  // for truncation recovery. extractJsonFromText can chop the tail at
  // lastIndexOf('}'), which strips fields after the first closed pick object
  // in a truncated response.
  let fromFirstBrace = rawText.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const firstBrace = fromFirstBrace.indexOf('{');
  if (firstBrace > 0) fromFirstBrace = fromFirstBrace.substring(firstBrace);

  const extracted = extractJsonFromText(rawText);

  let parsed: unknown;
  let firstErr: unknown = null;

  // 1. Try the strict extract (handles happy-path + prose-wrapped JSON)
  try {
    parsed = JSON.parse(extracted);
  } catch (e) {
    firstErr = e;

    // 2. Try healing the strict extract
    try {
      parsed = JSON.parse(healTruncatedJson(extracted));
    } catch {
      // 3. Heal from first brace to end of raw text (keeps the truncated tail
      //    so we can recover fields beyond the first closed object).
      try {
        parsed = JSON.parse(healTruncatedJson(fromFirstBrace));
      } catch {
        // 4. Mid-response corruption fallback: salvage individually-parseable
        //    pick objects. This is the LAST resort because it drops the
        //    summary/slips/warnings fields (we only get picks). Better than
        //    losing the entire analysis to a single bad pick object.
        const salvagedPicks = salvagePicksFromMalformed(fromFirstBrace);
        if (salvagedPicks && salvagedPicks.length > 0) {
          return {
            picks: salvagedPicks.map(normalizeAIPick),
            slips: [],
            summary: `Partial recovery: salvaged ${salvagedPicks.length} pick(s) from malformed JSON. Slips/summary lost to mid-response corruption.`,
            warnings: [
              'AI response had mid-response JSON corruption; partial recovery via salvagePicksFromMalformed.',
            ],
          };
        }
        throw new Error(
          `Failed to parse AI response as JSON: ${firstErr instanceof Error ? firstErr.message : 'unknown'}. Raw: ${rawText.slice(0, 200)}`,
        );
      }
    }
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('AI response is not a JSON object');
  }

  const obj = parsed as Record<string, unknown>;

  return {
    picks: Array.isArray(obj.picks)
      ? (obj.picks as AIPick[]).map(normalizeAIPick)
      : [],
    slips: Array.isArray(obj.slips) ? (obj.slips as AISlip[]) : [],
    summary: typeof obj.summary === 'string' ? obj.summary : '',
    warnings: Array.isArray(obj.warnings) ? (obj.warnings as string[]) : [],
  };
}

// ============================================================================
// Transient-error retry layer (shared by all providers)
// ============================================================================

/**
 * HTTP status codes we treat as transient / retryable:
 *   - 408 Request Timeout
 *   - 425 Too Early
 *   - 429 Too Many Requests (provider rate limit — usually respects Retry-After)
 *   - 500, 502, 503, 504 — standard "something on their end" errors.
 *     Gemini 2.5 Flash returns 503 with "currently experiencing high demand"
 *     during brief Google capacity spikes, which is the primary target of
 *     this retry path.
 */
export function shouldRetryStatus(status: number): boolean {
  if (status === 408 || status === 425 || status === 429) return true;
  if (status >= 500 && status < 600) return true;
  return false;
}

/**
 * Compute the delay (ms) before the next retry attempt.
 *
 * Priority:
 *   1. If the provider sent a `Retry-After` header, honor it (clamped to
 *      `maxBackoffMs` so a misconfigured API can't stall us for hours).
 *   2. Otherwise, exponential backoff: initialBackoffMs * 2^attempt,
 *      clamped to maxBackoffMs.
 *
 * `attempt` is zero-indexed: pass `0` for the delay before the FIRST retry
 * (second total attempt), `1` for the second retry, etc.
 */
export function computeBackoffMs(
  attempt: number,
  retryAfterHeader: string | null,
  opts: { initialBackoffMs: number; maxBackoffMs: number },
): number {
  if (retryAfterHeader) {
    // `Retry-After` can be a number of seconds OR an HTTP-date. We only
    // handle the numeric form (the vast majority of API responses). For an
    // HTTP-date, parseFloat returns NaN and we fall through to exponential.
    const parsed = parseFloat(retryAfterHeader);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return Math.min(parsed * 1000, opts.maxBackoffMs);
    }
  }
  const exp = opts.initialBackoffMs * Math.pow(2, attempt);
  return Math.min(exp, opts.maxBackoffMs);
}

/**
 * Best-effort suggestion for how long the CLIENT should wait before letting
 * the user retry manually, based on the error message string. Used by the
 * /api/analyze route to emit a `retryAfterMs` hint in its error response so
 * the UI countdown timer can show something useful.
 *
 * Values are intentionally conservative — we'd rather nudge the user to
 * wait a little too long than spam a throttled endpoint.
 */
export function estimateRetryDelayMs(errorMessage: string): number {
  const lower = (errorMessage || '').toLowerCase();

  // Rate limit / quota errors: usually need longer to clear.
  if (lower.includes('quota') || lower.includes('429')) return 60_000;

  // Gemini "high demand" and similar overload messages.
  if (lower.includes('high demand') || lower.includes('overloaded')) return 45_000;

  // 503 Service Unavailable — transient, typically clears in ~15s.
  if (lower.includes('503') || lower.includes('service unavailable')) return 30_000;

  // 502 Bad Gateway or 504 Gateway Timeout — also transient.
  if (lower.includes('502') || lower.includes('504') || lower.includes('gateway')) return 20_000;

  // Generic fallback.
  return 30_000;
}

interface FetchWithRetryOptions {
  maxRetries?: number;        // Default: 2 → up to 3 total attempts
  initialBackoffMs?: number;  // Default: 1000
  maxBackoffMs?: number;      // Default: 8000
}

/**
 * A thin wrapper around `fetch` that retries transient failures with
 * exponential backoff. Non-retryable responses (200, 400, 401, etc.) are
 * returned as-is on the first attempt — this is NOT a "keep trying until
 * it works" helper, it's specifically for the Gemini 503 / rate limit case.
 *
 * Network errors (thrown by fetch itself) are retried the same way.
 *
 * Returns the final Response — which may still be an error response if
 * every retry attempt failed. The caller is responsible for turning that
 * into an exception via `res.ok` checks.
 */
async function fetchWithRetry(
  url: string,
  init: RequestInit,
  opts: FetchWithRetryOptions = {},
): Promise<Response> {
  const maxRetries = opts.maxRetries ?? 2;
  const initialBackoffMs = opts.initialBackoffMs ?? 1000;
  const maxBackoffMs = opts.maxBackoffMs ?? 8000;

  let lastRes: Response | null = null;
  let lastErr: unknown = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, init);

      // Success or unambiguous client error — no point retrying.
      if (res.ok || !shouldRetryStatus(res.status)) return res;

      lastRes = res;

      // Out of retries? Return the last (failed) response so the caller
      // can surface a real error message from the body.
      if (attempt === maxRetries) return res;

      const backoffMs = computeBackoffMs(attempt, res.headers.get('retry-after'), {
        initialBackoffMs,
        maxBackoffMs,
      });
      await new Promise((r) => setTimeout(r, backoffMs));
    } catch (err) {
      lastErr = err;
      if (attempt === maxRetries) throw err;
      const backoffMs = computeBackoffMs(attempt, null, { initialBackoffMs, maxBackoffMs });
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  }

  // Loop only falls off the end if the last iteration retried rather than
  // returning. Guard against it anyway.
  if (lastRes) return lastRes;
  throw lastErr ?? new Error('fetchWithRetry exhausted retries without a response');
}

// ============================================================================
// Provider: Gemini (Google)
// ============================================================================

async function callGemini(
  apiKey: string,
  model: string,
  systemPrompt: string,
  userMessage: string,
): Promise<{ rawText: string; tokensUsed?: number }> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const body = {
    contents: [
      {
        role: 'user',
        parts: [{ text: userMessage }],
      },
    ],
    systemInstruction: {
      parts: [{ text: systemPrompt }],
    },
    generationConfig: {
      temperature: 0.3,
      maxOutputTokens: 16384,
      responseMimeType: 'application/json',
    },
  };

  const res = await fetchWithRetry(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini API error (${res.status}): ${errText}`);
  }

  const data = await res.json();
  const rawText: string =
    data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  const tokensUsed = data.usageMetadata?.totalTokenCount;

  if (!rawText) {
    throw new Error('Gemini returned empty response');
  }

  return { rawText, tokensUsed };
}

// ============================================================================
// Provider: Claude (Anthropic)
// ============================================================================

async function callClaude(
  apiKey: string,
  model: string,
  systemPrompt: string,
  userMessage: string,
): Promise<{ rawText: string; tokensUsed?: number }> {
  const url = 'https://api.anthropic.com/v1/messages';

  const body = {
    model,
    max_tokens: 8192,
    temperature: 0.3,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
  };

  const res = await fetchWithRetry(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Claude API error (${res.status}): ${errText}`);
  }

  const data = await res.json();
  const rawText: string =
    (Array.isArray(data.content) && data.content[0]?.text) || '';
  const tokensUsed =
    (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0);

  if (!rawText) {
    throw new Error('Claude returned empty response');
  }

  return { rawText, tokensUsed };
}

// ============================================================================
// Provider: OpenRouter (aggregator for free + paid models)
// ============================================================================

async function callOpenRouter(
  apiKey: string,
  model: string,
  systemPrompt: string,
  userMessage: string,
): Promise<{ rawText: string; tokensUsed?: number }> {
  const url = 'https://openrouter.ai/api/v1/chat/completions';

  const body = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ],
    temperature: 0.3,
    max_tokens: 8192,
    // Ask the model to return JSON only if the provider supports it
    response_format: { type: 'json_object' },
  };

  const res = await fetchWithRetry(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://github.com/dfs-calculator',
      'X-Title': 'DFS Calculator',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`OpenRouter API error (${res.status}): ${errText}`);
  }

  const data = await res.json();
  const rawText: string = data.choices?.[0]?.message?.content || '';
  const tokensUsed = data.usage?.total_tokens;

  if (!rawText) {
    throw new Error('OpenRouter returned empty response');
  }

  return { rawText, tokensUsed };
}

// ============================================================================
// Model catalog
// ============================================================================

/**
 * List of models known to work on free tiers (verified via scripts/test-candidates.mjs).
 * Used by the UI dropdowns and as the default set for ensemble mode.
 */
export interface ModelInfo {
  id: string;
  displayName: string;
  provider: AIProvider;
  notes?: string;
  requiresKey?: boolean;  // True if BYO-key is mandatory (Claude); false if env key is fine
}

export const MODEL_CATALOG: ModelInfo[] = [
  // Gemini (free tier)
  { id: 'gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', provider: 'gemini', notes: 'Fastest, strong JSON mode, free tier' },
  { id: 'gemini-flash-latest', displayName: 'Gemini Flash (latest alias)', provider: 'gemini', notes: 'Always points to newest flash release' },
  { id: 'gemini-2.5-pro', displayName: 'Gemini 2.5 Pro', provider: 'gemini', notes: 'Strongest reasoning, but free tier heavily rate-limited' },

  // OpenRouter free models (verified working)
  { id: 'openai/gpt-oss-120b:free', displayName: 'GPT-OSS 120B (OpenAI)', provider: 'openrouter', notes: 'Free, strongest open reasoning model, 131k ctx' },
  { id: 'openai/gpt-oss-20b:free', displayName: 'GPT-OSS 20B (OpenAI)', provider: 'openrouter', notes: 'Free, smaller + faster GPT-OSS' },
  { id: 'nvidia/nemotron-3-super-120b-a12b:free', displayName: 'Nemotron 3 Super 120B (NVIDIA)', provider: 'openrouter', notes: 'Free, 120B reasoning model, slower' },
  { id: 'z-ai/glm-4.5-air:free', displayName: 'GLM 4.5 Air (Z.AI)', provider: 'openrouter', notes: 'Free, alt reasoning model' },
  { id: 'minimax/minimax-m2.5:free', displayName: 'MiniMax M2.5', provider: 'openrouter', notes: 'Free, different model family' },

  // Claude (BYO key)
  { id: 'claude-sonnet-4-5', displayName: 'Claude Sonnet 4.5', provider: 'claude', notes: 'Premium, requires Anthropic API key', requiresKey: true },
  { id: 'claude-opus-4-5', displayName: 'Claude Opus 4.5', provider: 'claude', notes: 'Most capable, requires Anthropic API key', requiresKey: true },
];

const DEFAULT_MODELS: Record<AIProvider, string> = {
  gemini: 'gemini-2.5-flash',
  openrouter: 'openai/gpt-oss-120b:free',
  claude: 'claude-sonnet-4-5',
};

/**
 * Default ensemble pair (Option I):
 * Gemini 2.5 Flash (Google transformer) + GPT-OSS 120B (OpenAI MoE).
 * Different families → meaningful consensus signal.
 */
export const DEFAULT_ENSEMBLE: Array<{ provider: AIProvider; model: string }> = [
  { provider: 'gemini', model: 'gemini-2.5-flash' },
  { provider: 'openrouter', model: 'openai/gpt-oss-120b:free' },
];

// ============================================================================
// Main orchestrator
// ============================================================================

export async function runAIAnalysis(req: AIAnalysisRequest): Promise<AIAnalysisResponse> {
  const start = Date.now();
  const model = req.model || DEFAULT_MODELS[req.provider];
  const userMessage = buildUserMessage(req);

  let rawText: string;
  let tokensUsed: number | undefined;

  if (req.provider === 'gemini') {
    const result = await callGemini(req.apiKey, model, req.systemPrompt, userMessage);
    rawText = result.rawText;
    tokensUsed = result.tokensUsed;
  } else if (req.provider === 'claude') {
    const result = await callClaude(req.apiKey, model, req.systemPrompt, userMessage);
    rawText = result.rawText;
    tokensUsed = result.tokensUsed;
  } else if (req.provider === 'openrouter') {
    const result = await callOpenRouter(req.apiKey, model, req.systemPrompt, userMessage);
    rawText = result.rawText;
    tokensUsed = result.tokensUsed;
  } else {
    throw new Error(`Unknown provider: ${req.provider}`);
  }

  const parsed = parseAIResponse(rawText);

  return {
    ...parsed,
    rawText,
    tokensUsed,
    durationMs: Date.now() - start,
    model,
    provider: req.provider,
  };
}

// ============================================================================
// Ensemble orchestrator
// ============================================================================

export interface EnsembleProviderConfig {
  provider: AIProvider;
  model: string;
  apiKey: string;
}

export interface EnsembleResult {
  responses: Array<
    | { status: 'success'; provider: AIProvider; model: string; response: AIAnalysisResponse }
    | { status: 'error'; provider: AIProvider; model: string; error: string }
  >;
  durationMs: number;
}

/**
 * Runs all providers in parallel with Promise.allSettled — one failure never
 * blocks another. Returns all responses (successful + failed) for the UI
 * to merge via ensembleConsensus.mergePicks().
 */
export async function runEnsembleAnalysis(
  providers: EnsembleProviderConfig[],
  baseReq: Omit<AIAnalysisRequest, 'provider' | 'apiKey' | 'model'>,
): Promise<EnsembleResult> {
  const start = Date.now();

  const promises = providers.map(async (cfg) => {
    try {
      const response = await runAIAnalysis({
        ...baseReq,
        provider: cfg.provider,
        apiKey: cfg.apiKey,
        model: cfg.model,
      });
      return {
        status: 'success' as const,
        provider: cfg.provider,
        model: cfg.model,
        response,
      };
    } catch (err) {
      return {
        status: 'error' as const,
        provider: cfg.provider,
        model: cfg.model,
        error: err instanceof Error ? err.message : 'Unknown error',
      };
    }
  });

  const responses = await Promise.all(promises);

  return {
    responses,
    durationMs: Date.now() - start,
  };
}
