# CLAUDE.md — DFS Calculator

Read AGENTS.md first for full project context, math pipeline, and calibration data.

## Tech Stack
- **Framework:** Next.js 15 (App Router)
- **Language:** TypeScript (strict mode)
- **UI:** React 19 + Tailwind CSS v4
- **Testing:** Jest 29 + ts-jest + React Testing Library
- **Runtime:** Node.js 18+

## Commands
```bash
npm test             # Run all tests (75 total: 50 math + 25 UI)
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
│   ├── layout.tsx          ← Root HTML layout
│   ├── page.tsx            ← Renders <Calculator />
│   └── globals.css         ← Tailwind import + body styles
├── components/
│   ├── Calculator.tsx      ← Orchestrator: owns state, runs math pipeline
│   ├── PlayerForm.tsx      ← Input form (controlled, with validation)
│   ├── ResultsDisplay.tsx  ← Shows probabilities, EV, Kelly, tier
│   ├── TierBadge.tsx       ← Colored pill for HIGH/MEDIUM/LOW/REJECT
│   └── types.ts            ← Shared TypeScript interfaces
└── lib/
    └── math.ts             ← Pure math engine (DO NOT modify without tests)

__tests__/
├── math.test.ts            ← 50 tests for all math functions
├── PlayerForm.test.tsx     ← 10 tests for form rendering + validation
└── Calculator.test.tsx     ← 15 tests for pipeline + integration
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

## MCP Servers (recommended)
- **Context7** — Live framework docs (Next.js, React, Tailwind)
- **Chrome DevTools** — Browser debugging and visual verification
