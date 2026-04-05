# DFS Calculator v2.0

NBA player prop edge calculator for DFS platforms (PrizePicks, Underdog, Pick6).

## What It Does
Takes player stats + platform odds → outputs probability, EV, Kelly stake, and confidence tier for over/under picks.

## Setup (Mac or Windows)

```bash
# 1. Install Node.js 18+ from https://nodejs.org
# 2. Open Terminal (Mac) or PowerShell (Windows)

cd path/to/dfs-calculator
npm install
npm test        # Should show: Tests: 50 passed
npm run dev     # Opens at http://localhost:3000
```

## How It Works
1. Enter a player's recent scoring mean (e.g., 25.3 PPG)
2. Enter the platform's line (e.g., 23.5)
3. Enter the over/under odds (e.g., -110 / -110)
4. The calculator outputs:
   - Fair probability (vig removed via probit de-vig)
   - Model probability (based on negative binomial distribution)
   - Blended probability (60% model / 40% market)
   - Expected value
   - Recommended stake (1/4 Kelly)
   - Confidence tier (HIGH / MEDIUM / LOW / REJECT)

## For AI Agents
Read `AGENTS.md` first. It contains the full project spec, architecture,
math decisions, and workflow rules.
