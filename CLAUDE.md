# CLAUDE.md — DFS Calculator

Read AGENTS.md first for full project context, math pipeline, and calibration data.

## Tech Stack
- **Framework:** Next.js 15 (App Router)
- **Language:** TypeScript (strict mode)
- **UI:** React 19 + Tailwind CSS v4
- **Testing:** Jest 29 + ts-jest + React Testing Library
- **APIs:** The Odds API + balldontlie.io (via server-side API routes)
- **Runtime:** Node.js 18+

## Commands
```bash
npm test             # Run all tests (155 total)
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
│       ├── odds/route.ts       ← The Odds API proxy
│       └── player-stats/route.ts ← balldontlie proxy
├── components/
│   ├── Calculator.tsx          ← Orchestrator: batch/single mode, state, math
│   ├── PlayerForm.tsx          ← Manual input form (controlled, validated)
│   ├── ResultsDisplay.tsx      ← Single player results
│   ├── GameSelector.tsx        ← Game selection (auto-fetches games)
│   ├── BatchResultsTable.tsx   ← Sortable batch results table
│   ├── PasteInput.tsx          ← DFS text paste with live preview
│   ├── TierBadge.tsx           ← Colored pill for HIGH/MEDIUM/LOW/REJECT
│   └── types.ts                ← Shared TypeScript interfaces
└── lib/
    ├── math.ts                 ← Pure math engine (DO NOT modify without tests)
    ├── oddsApi.ts              ← Odds API types + transforms
    ├── playerStats.ts          ← Player stats fetch + cache
    ├── batchProcessor.ts       ← Batch calculation engine
    └── parsers.ts              ← DFS text paste parser

__tests__/
├── math.test.ts                ← 50 math tests
├── PlayerForm.test.tsx         ← 10 form tests
├── Calculator.test.tsx         ← 16 pipeline + integration tests
├── oddsApi.test.ts             ← 10 API transform tests
├── playerStats.test.ts         ← 14 position mapping tests
├── batchProcessor.test.ts      ← 15 batch processing tests
├── GameSelector.test.tsx       ← 9 game selector UI tests
├── BatchResultsTable.test.tsx  ← 9 results table tests
└── parsers.test.ts             ← 22 DFS text parser tests
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

## Environment Variables (.env.local)
```
ODDS_API_KEY=your_key_here
BALLDONTLIE_API_KEY=your_key_here
```

## Deployment (Vercel)
1. Push to GitHub
2. Connect repo in Vercel dashboard
3. Add environment variables (ODDS_API_KEY, BALLDONTLIE_API_KEY)
4. Deploy — Vercel auto-detects Next.js

## MCP Servers (recommended)
- **Context7** — Live framework docs (Next.js, React, Tailwind)
- **Chrome DevTools** — Browser debugging and visual verification
