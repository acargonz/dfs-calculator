# AGENTS.md — DFS Calculator

## Project Overview
A sports betting edge calculator for NBA player props on DFS platforms
(PrizePicks, Underdog Fantasy, DraftKings Pick6). Built with Next.js + TypeScript.

## Purpose
Convert raw player data + platform odds into actionable over/under picks
with mathematically grounded probability, EV, and stake sizing.

Supports two workflows:
1. **Batch mode** (default): Select today's NBA games → auto-fetch props + odds from The Odds API → auto-fetch player stats from PBP Stats → batch calculate all edges → display sortable results table.
2. **Single player mode**: Manual entry of one player at a time with custom odds/stats.

Fallback: Paste text from any DFS app (PrizePicks, Underdog, Pick6) and the parser extracts player names, stat types, and lines automatically.

## Tech Stack
- **Runtime:** Node.js 18+
- **Framework:** Next.js 15 (App Router)
- **Language:** TypeScript (strict mode)
- **UI:** React 19 + Tailwind CSS v4
- **Testing:** Jest 29 + ts-jest + React Testing Library
- **APIs:** The Odds API (games + props), PBP Stats (player season averages), balldontlie.io (position only)

## Project Structure
```
dfs-calculator/
├── AGENTS.md            ← YOU ARE HERE. Read this first, always.
├── CLAUDE.md            ← Quick reference for Claude Code sessions
├── .env.local           ← API keys (git-ignored)
├── .env.local.example   ← Template for API keys (committed)
├── package.json
├── tsconfig.json
├── jest.config.js
├── next.config.js
├── postcss.config.mjs   ← Tailwind CSS v4 PostCSS plugin
├── src/
│   ├── lib/
│   │   ├── math.ts          ← Pure math engine (DO NOT modify without tests)
│   │   ├── oddsApi.ts       ← Odds API types + transform functions
│   │   ├── playerStats.ts   ← Player stats fetch + cache + position mapping
│   │   ├── batchProcessor.ts ← Batch calculation engine
│   │   └── parsers.ts       ← DFS text paste parser (PrizePicks, Underdog, etc.)
│   ├── components/
│   │   ├── Calculator.tsx       ← Orchestrator: mode toggle, batch/single state
│   │   ├── PlayerForm.tsx       ← Manual input form with validation
│   │   ├── ResultsDisplay.tsx   ← Single player probability/EV/Kelly output
│   │   ├── GameSelector.tsx     ← Game selection UI (fetches games on mount)
│   │   ├── BatchResultsTable.tsx ← Sortable batch results table
│   │   ├── PasteInput.tsx       ← DFS text paste with live preview
│   │   ├── TierBadge.tsx        ← Colored badge for confidence tier
│   │   └── types.ts             ← Shared TypeScript interfaces
│   └── app/
│       ├── layout.tsx       ← Root HTML layout
│       ├── page.tsx         ← Renders <Calculator />
│       ├── globals.css      ← CSS variables + Tailwind import
│       └── api/
│           ├── odds/route.ts         ← Odds API proxy (games + props)
│           └── player-stats/route.ts ← balldontlie proxy (stats)
└── __tests__/
    ├── math.test.ts              ← 50 math tests
    ├── PlayerForm.test.tsx       ← 10 form tests
    ├── Calculator.test.tsx       ← 16 pipeline + integration tests
    ├── oddsApi.test.ts           ← 10 API transform tests
    ├── playerStats.test.ts       ← 14 position mapping tests
    ├── batchProcessor.test.ts    ← 15 batch processing tests
    ├── GameSelector.test.tsx     ← 9 game selector UI tests
    ├── BatchResultsTable.test.tsx ← 9 results table tests
    └── parsers.test.ts           ← 22 DFS text parser tests
```

## Important Commands
```bash
npm install          # Install dependencies
npm test             # Run all 155 tests — MUST pass before any change ships
npm run dev          # Start local dev server at http://localhost:3000
npm run build        # Production build (catches type errors)
npm audit            # Check for security vulnerabilities (should be 0)
```

## Workflow Rules (for AI agents)
1. **Read this file first** on every session.
2. **Never write code without a plan.** State what you'll change and why.
3. **Break work into small tasks.** One function or one component at a time.
4. **Run `npm test` after every change.** If tests fail, fix them before moving on.
5. **Never delete or weaken a test** to make code pass. Fix the code instead.
6. **Math changes require verification.** Cross-reference against scipy/Wolfram Alpha.
7. **All math functions are pure** (no side effects, no external state).
8. **UI changes don't touch math.** Math changes don't touch UI.

## Architecture — Math Pipeline
```
American Odds → americanToImplied() → implied probability
                     ↓
              devigProbit() → fair (vig-free) probability
                     ↓
Player Mean + Std → modelCountingStat() or modelPoints()
                     → raw model probability
                     ↓
              blendProbabilities() → blend model + market prob
                     ↓
              applyModifiers() → adjusted probability (pace, injury, etc.)
                     ↓
              kellyStake() → recommended bet size
                     ↓
              assignTier() → HIGH / MEDIUM / LOW / REJECT
```

## Architecture — Batch Processing Pipeline
```
GameSelector → fetchGames() → user selects games
                     ↓
              fetchProps(eventId) → PlayerProp[] per game
                     ↓
              fetchPlayerStats(name) → PlayerSeasonAvg (cached)
                     ↓
              processBatch(props, fetchStatsFn)
                  → for each prop: getStatMean → calculate() → result
                     ↓
              sortResults() → HIGH first, then EV desc
                     ↓
              BatchResultsTable → sortable, copyable results
```

## Architecture — API Routes
- `/api/odds?type=games` → proxies The Odds API for today's NBA events
- `/api/odds?type=props&eventId=xxx` → proxies The Odds API for player prop odds
- `/api/player-stats?name=LeBron+James` → proxies balldontlie.io for season averages

API keys are stored in `.env.local` (server-side only, never exposed to client).

## Key Math Decisions (and why)
- **Probit de-vig** (not multiplicative or power): Handles heavy favourites
  better, matches Pinnacle sharp-market behaviour.
- **Negative Binomial** (not Poisson): Allows overdispersion (variance > mean),
  which is how real NBA stats behave.
- **Fractional Kelly** (1/4 standard, 1/8 demon): Full Kelly is too aggressive
  for prop betting variance.
- **CV lookup table** for default std: Position- and stat-specific coefficients
  of variation calibrated to NBA data.

## CV Calibration (coefficients of variation)
These determine how "spread out" the model thinks a player's stat distribution is.
Lower CV = tighter distribution = more confident predictions when mean ≠ line.

| Position | Points | Rebounds | Assists | Steals | Blocks | Threes | Fantasy | PRA  | P+R  | P+A  | R+A  |
|----------|--------|----------|---------|--------|--------|--------|---------|------|------|------|------|
| PG       | 0.33   | 0.38     | 0.38    | 0.65   | 0.70   | 0.55   | 0.20    | 0.22 | 0.25 | 0.25 | 0.30 |
| SG       | 0.30   | 0.36     | 0.40    | 0.65   | 0.70   | 0.55   | 0.20    | 0.22 | 0.24 | 0.25 | 0.30 |
| SF       | 0.33   | 0.33     | 0.42    | 0.65   | 0.65   | 0.58   | 0.20    | 0.22 | 0.24 | 0.26 | 0.30 |
| PF       | 0.33   | 0.30     | 0.45    | 0.65   | 0.60   | 0.60   | 0.20    | 0.22 | 0.23 | 0.27 | 0.28 |
| C        | 0.35   | 0.28     | 0.48    | 0.70   | 0.55   | 0.65   | 0.20    | 0.22 | 0.23 | 0.28 | 0.27 |

**Points CVs are lower (0.30–0.35)** because scoring is the primary stat being
modelled and players' shot volumes are more consistent than raw rebound/assist
opportunity variance.

**Combo/Fantasy CVs are the lowest (0.20–0.30)** because summing multiple stats
reduces relative variability (diversification effect). Fantasy has the lowest CV
since it combines 5+ weighted stats.

### DraftKings Fantasy Scoring Formula
```
FPTS = (PTS × 1) + (REB × 1.25) + (AST × 1.5) + (STL × 2) + (BLK × 2) + (3PM × 0.5) - (TO × 0.5)
```

### Supported Stat Types
- **Individual:** points, rebounds, assists, steals, blocks, threes
- **Combo:** pra (Pts+Rebs+Asts), pts+rebs, pts+asts, rebs+asts
- **Fantasy:** fantasy (DraftKings standard scoring)

## Tier Thresholds
| Tier   | Min Prob | Min EV  | Flags             |
|--------|----------|---------|-------------------|
| HIGH   | ≥ 0.58   | ≥ 0.08  | 0 major           |
| MEDIUM | ≥ 0.54   | ≥ 0.05  | ≤ 1 major, < 2 minor |
| LOW    | ≥ 0.50   | ≥ 0.02  | any               |
| REJECT | below LOW thresholds                      |

## Environment Variables
```
ODDS_API_KEY=your_key_here        # The Odds API (https://the-odds-api.com)
BALLDONTLIE_API_KEY=your_key_here # balldontlie.io
```

## Deployment
This app is designed for Vercel deployment:
1. Push to GitHub
2. Connect repo in Vercel dashboard
3. Set environment variables (ODDS_API_KEY, BALLDONTLIE_API_KEY)
4. Deploy — Vercel auto-detects Next.js

## Known Constraints
- CV table is NBA-specific. Other sports would need different calibration.
- normCDF uses erfc-based approximation (max error < 1.5e-7).
- Pasted DFS text defaults to -110/-110 odds since DFS apps don't show odds.
- balldontlie.io has rate limits; player stats are cached in-memory per session.

## Cross-Platform Compatibility
- Runs identically on macOS and Windows.
- No OS-specific dependencies or scripts.
