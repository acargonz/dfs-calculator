# CLAUDE.md — DFS Calculator

Read AGENTS.md first for full project context, math pipeline, and calibration data.

## Tech Stack
- **Framework:** Next.js 15 (App Router)
- **Language:** TypeScript (strict mode)
- **UI:** React 19 + Tailwind CSS v4
- **Testing:** Jest 29 + ts-jest + React Testing Library
- **APIs:** The Odds API + PBP Stats + balldontlie.io + ESPN (injuries/rosters) + Gemini/Claude
- **Database:** Supabase (pick tracking, prompt versioning) — optional, app works without it
- **Runtime:** Node.js 18+

## Commands
```bash
npm test             # Run all tests
npm run build        # Production build — catches type errors
npm run dev          # Dev server at http://localhost:3000
npm audit            # Should show 0 vulnerabilities
```

## Workflow Rules
1. **Read AGENTS.md** at the start of every session.
2. **Plan before coding.** State what you will change and why.
3. **One small task at a time.** One function or one component per change.
4. **Run `npm test` after every change.** Fix failures before moving on.
5. **Never delete or weaken a test** to make code pass. Fix the code.
6. **Math is read-only** unless the user explicitly asks for math changes.
7. **UI changes don't touch math.** Math changes don't touch UI.

## Component Map
```
src/
├── app/
│   ├── layout.tsx              ← Root HTML layout
│   ├── page.tsx                ← Renders <Calculator />
│   ├── globals.css             ← CSS variables + Tailwind import
│   └── api/
│       ├── odds/route.ts           ← The Odds API proxy
│       ├── player-stats/route.ts   ← PBP Stats (stats) + balldontlie (position)
│       ├── injuries/route.ts       ← ESPN NBA injuries (free, no auth)
│       ├── lineups/route.ts        ← ESPN team rosters (free, no auth)
│       └── analyze/route.ts        ← AI analysis (Gemini/Claude)
├── components/
│   ├── Calculator.tsx          ← Orchestrator: batch/single mode, state, math
│   ├── PlayerForm.tsx          ← Manual input form (controlled, validated)
│   ├── ResultsDisplay.tsx      ← Single player results
│   ├── GameSelector.tsx        ← Game selection (auto-fetches games)
│   ├── BatchResultsTable.tsx   ← Sortable batch results table
│   ├── PasteInput.tsx          ← DFS text paste with live preview
│   ├── AIAnalysisPanel.tsx     ← AI analysis UI (provider select + BYO key)
│   ├── TierBadge.tsx           ← Colored pill for HIGH/MEDIUM/LOW/REJECT
│   └── types.ts                ← Shared TypeScript interfaces
└── lib/
    ├── math.ts                 ← Pure math engine (DO NOT modify without tests)
    ├── oddsApi.ts              ← Odds API types + transforms
    ├── playerStats.ts          ← Player stats client + cached fetch
    ├── playerStatsBlend.ts     ← Pure-math postseason blend (regular/playoffs/finals)
    ├── batchProcessor.ts       ← Batch calculation engine + postseason Kelly reduction
    ├── parsers.ts              ← DFS text paste parser
    ├── aiAnalysis.ts           ← AI orchestrator (Gemini + Claude + Season Phase)
    ├── promptVersions.ts       ← Supabase prompt versioning
    └── supabase.ts             ← Supabase client singleton

__tests__/
├── math.test.ts                ← Math engine tests (CV / Binomial / NegBinomial / fantasy)
├── PlayerForm.test.tsx         ← Form input + validation tests
├── Calculator.test.tsx         ← Calculator pipeline + integration tests
├── oddsApi.test.ts             ← Odds API transform + cross-reference tests
├── playerStats.test.ts         ← Position mapping + PlayerSeasonAvg shape tests
├── playerStatsBlend.test.ts    ← Pure-math blend tests (39 — postseason weights, blending)
├── batchProcessor.test.ts      ← Batch processing + postseason Kelly reduction tests
├── GameSelector.test.tsx       ← Game selector UI tests
├── BatchResultsTable.test.tsx  ← Sortable results table tests
├── parsers.test.ts             ← DFS text parser tests (incl. combo/fantasy)
└── aiAnalysis.test.ts          ← AI message build + JSON parse + Season Phase tests
```

## Math Pipeline (executed in Calculator.tsx)
```
devigProbit(overOdds, underOdds)         → fair probabilities
modelCountingStat/modelPoints(mean,line) → model probabilities
blendProbabilities(model, fair, 0.6)     → 60/40 blend
applyModifiers(blended, modifiers)       → adjusted for pace/injury
kellyStake(adjusted, odds, bankroll)     → stake + EV
assignTier({ prob, ev, flags })          → HIGH/MEDIUM/LOW/REJECT
```

## Postseason Pipeline (NBA Playoffs / Finals)
```
/api/player-stats fetches three slices in parallel:
  Regular season (mandatory)  →  pbpstats SeasonType=Regular+Season
  Playoffs ex Finals (best-effort)  →  SeasonType=Playoffs&DateTo=<finals_start - 1>
  Finals (best-effort)  →  SeasonType=Playoffs&DateFrom=<finals_start>

playerStatsBlend.ts (pure functions, fully unit-tested):
  computePlayoffsWeight(games)        → linear ramp, 2.5pp/game, cap 35%
  computeFinalsWeight(games)          → linear ramp, 8pp/game, cap 40%
  computeBlendWeights(p, f)           → {regular, playoffs, finals} sums to 1
  blendStats(slices, weights)         → weighted per-game averages
  determineSeasonType(slices)         → 'regular' | 'playoffs' | 'finals'
  determineSlateSeasonType(types)     → slate-level promotion (finals > playoffs > regular)

batchProcessor.ts:
  applyPostseasonKellyReduction(result, seasonType)  → 0.75x stake when postseason

aiAnalysis.ts:
  getSlateSeasonType(batchResult)     → reads BatchResult.players[*].seasonType
  buildUserMessage()                   → emits "Season Phase: <type>" header line
                                          + Postseason Context banner when not regular
```

The Algorithmic Prompt V2 (`prompts/algorithmic-prompt-v2.txt`) adds:
  - Section 0.3a — Postseason Context Protocol (rotation, pace, defensive intensity)
  - Section 1.5a — Postseason Kelly Note (0.75x already applied — don't double-apply)
  - Section 6.1a — Postseason Confidence Tier Modifiers (+2pp playoff, +4pp Finals)

## Environment Variables (.env.local)
```
ODDS_API_KEY=your_key_here
BALLDONTLIE_API_KEY=your_key_here
GEMINI_API_KEY=your_key_here              # Free at https://aistudio.google.com
CLAUDE_API_KEY=your_key_here              # Optional, BYO-key also supported
NEXT_PUBLIC_SUPABASE_URL=your_url
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_key

# Optional — overrides the YYYY-06-04 default for the regular-playoffs/finals split.
# Update this each year once the official Game-1 date is announced.
# NBA_FINALS_START_DATE=2026-06-04
```

## Supabase Setup (first time)
1. Run `supabase/schema.sql` in the Supabase SQL editor
2. Run `node scripts/seed-prompt.mjs` to seed Algorithmic Prompts V1 + V2
   (script is idempotent — safe to re-run; promotes V2 to active and
   archives V1 so the postseason rules apply automatically)
3. Done — the app now persists all AI analyses and picks

## Updating the active prompt
When you edit `prompts/algorithmic-prompt-v2.txt` in place (e.g. tweaking
the fantasy scoring formula), the changes stay on disk until you push them
into Supabase. Re-run the seed script with the force flag:
```
node scripts/seed-prompt.mjs --force-update
```
Without the flag the script detects drift and prints a warning but leaves
the DB row untouched, so accidental edits can't clobber your active prompt.

## Deployment (Vercel)
1. Push to GitHub
2. Connect repo in Vercel dashboard
3. Add all environment variables from above
4. Deploy — Vercel auto-detects Next.js

## MCP Servers (recommended)
- **Context7** — Live framework docs (Next.js, React, Tailwind)
- **Chrome DevTools** — Browser debugging and visual verification
