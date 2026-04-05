# AGENTS.md — DFS Calculator

## Project Overview
A sports betting edge calculator for NBA player props on DFS platforms
(PrizePicks, Underdog Fantasy, DraftKings Pick6). Built with Next.js + TypeScript.

## Purpose
Convert raw player data + platform odds into actionable over/under picks
with mathematically grounded probability, EV, and stake sizing.

## Tech Stack
- **Runtime:** Node.js 18+
- **Framework:** Next.js 15 (App Router)
- **Language:** TypeScript (strict mode)
- **UI:** React 19 + Tailwind CSS v4
- **Testing:** Jest + ts-jest + React Testing Library

## Project Structure
```
dfs-calculator/
├── AGENTS.md            ← YOU ARE HERE. Read this first, always.
├── CLAUDE.md            ← Quick reference for Claude Code sessions
├── README.md            ← Human-readable setup and usage
├── package.json
├── tsconfig.json
├── jest.config.js
├── next.config.js
├── postcss.config.mjs   ← Tailwind CSS v4 PostCSS plugin
├── src/
│   ├── lib/
│   │   └── math.ts      ← Pure math engine. ALL betting math lives here.
│   ├── components/
│   │   ├── Calculator.tsx    ← Orchestrator: state + math pipeline
│   │   ├── PlayerForm.tsx    ← Input form with validation
│   │   ├── ResultsDisplay.tsx ← Probability, EV, Kelly, tier output
│   │   ├── TierBadge.tsx     ← Colored badge for confidence tier
│   │   └── types.ts          ← Shared TypeScript interfaces
│   └── app/
│       ├── layout.tsx    ← Root HTML layout
│       ├── page.tsx      ← Renders <Calculator />
│       └── globals.css   ← Tailwind import + body styles
└── __tests__/
    ├── math.test.ts          ← 50 math tests
    ├── PlayerForm.test.tsx   ← 10 form tests
    └── Calculator.test.tsx   ← 15 pipeline + integration tests
```

## Important Commands
```bash
npm install          # Install dependencies
npm test             # Run all 75 tests — MUST pass before any change ships
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

| Position | Points | Rebounds | Assists | Steals | Blocks | Threes |
|----------|--------|----------|---------|--------|--------|--------|
| PG       | 0.33   | 0.38     | 0.38    | 0.65   | 0.70   | 0.55   |
| SG       | 0.30   | 0.36     | 0.40    | 0.65   | 0.70   | 0.55   |
| SF       | 0.33   | 0.33     | 0.42    | 0.65   | 0.65   | 0.58   |
| PF       | 0.33   | 0.30     | 0.45    | 0.65   | 0.60   | 0.60   |
| C        | 0.35   | 0.28     | 0.48    | 0.70   | 0.55   | 0.65   |

**Points CVs are lower (0.30–0.35)** because scoring is the primary stat being
modelled and players' shot volumes are more consistent than raw rebound/assist
opportunity variance.

## Tier Thresholds
| Tier   | Min Prob | Min EV  | Flags             |
|--------|----------|---------|-------------------|
| HIGH   | ≥ 0.58   | ≥ 0.08  | 0 major           |
| MEDIUM | ≥ 0.54   | ≥ 0.05  | ≤ 1 major, < 2 minor |
| LOW    | ≥ 0.50   | ≥ 0.02  | any               |
| REJECT | below LOW thresholds                      |

## Known Constraints
- This runs entirely client-side. No backend API calls for odds data (yet).
- The user must manually input player means, lines, and odds.
- CV table is NBA-specific. Other sports would need different calibration.
- normCDF uses erfc-based approximation (max error < 1.5e-7).

## Cross-Platform Compatibility
- Runs identically on macOS and Windows.
- No OS-specific dependencies or scripts.
- `jest --passWithNoTests` is the only test command (no node flags needed).
