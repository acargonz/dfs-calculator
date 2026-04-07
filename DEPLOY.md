# DEPLOY.md — DFS Calculator Production Runbook

Step-by-step guide for deploying the app to Vercel with cron-driven pick
tracking + CLV snapshots. Read the whole file before starting — a few
steps depend on earlier ones (e.g. migrations must be applied before the
first cron fires, CRON_SECRET must match between Vercel and the request).

**Target time**: ~30 minutes end-to-end on first deploy.
**Rollback time**: <2 minutes (see §9).

---

## 0. Pre-flight

Before touching Vercel, verify the local state is clean:

```bash
npm test              # all suites green
npm run build         # no type errors, no ESLint failures
npm audit             # 0 vulnerabilities
node scripts/verify-setup.mjs    # checks env + supabase connectivity
```

If any of the above fails, **stop** — do not deploy.

You should also have:
- A Supabase project (URL + anon key on hand)
- A Vercel account linked to the GitHub repo
- The following API keys:
  - `ODDS_API_KEY` (The Odds API — free tier is 500 req/mo, enough for daily cron)
  - `GEMINI_API_KEY` (Google AI Studio — free 15 RPM / 1M tokens per day)
  - `BALLDONTLIE_API_KEY` (balldontlie — free tier — **position lookups only**)
  - `CLAUDE_API_KEY` (optional — BYO-key also supported from the UI)

---

## 1. Apply Supabase migrations (REQUIRED — do this first)

**Why first?** The cron jobs (§4) write to columns introduced in Migration 001
(`closing_snapshot_at`, `bet_odds_over`, `system_alerts` table, etc.). If the
first cron fires before the migration is applied, every `UPDATE` will fail
with `column "closing_snapshot_at" does not exist` and the pick history will
sit in an inconsistent state.

Run these **in order** in the Supabase SQL editor
(Project → SQL Editor → New query → paste → **Run**):

### 1a. `supabase/schema.sql` — base schema
If this is a fresh project, apply the base schema first. Skip if `picks` and
`analyses` tables already exist.

### 1b. `supabase/migrations/001_pick_history_capture.sql`
Adds:
- `picks.bet_odds_over` / `picks.bet_odds_under` (bet-time odds snapshot)
- `picks.closing_odds_over` / `picks.closing_odds_under` / `picks.closing_line` / `picks.closing_snapshot_at` (CLV tracking)
- `picks.bookmaker`, `picks.home_away`, `picks.flat_unit_stake`
- `picks.raw_calculator_prob`, `picks.raw_calculator_tier`
- `picks.pace_modifier`, `picks.injury_modifier`
- Indexes on `bookmaker` and `closing_snapshot_at`
- `system_alerts` table + indexes + RLS policy

All statements use `IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS`, so running
twice is safe.

**Verification query** (paste in SQL editor after running):
```sql
select column_name from information_schema.columns
where table_name = 'picks' and column_name in (
  'bet_odds_over', 'closing_odds_over', 'closing_snapshot_at',
  'bookmaker', 'home_away', 'raw_calculator_prob', 'pace_modifier'
)
order by column_name;
-- Should return 7 rows. Anything less → migration failed, re-run it.

select count(*) from system_alerts;
-- Should return 0 (or a number, not an error). Error → table missing.
```

### 1c. `supabase/migrations/002_backfill_calculator_prob.sql`
Backfills any rows written by the pre-fix `aiAnalysis.ts` normalizer bug
(stringified `finalProbability` → 6000% display). Skip if you have no
existing picks in the `picks` table.

Idempotent — safe to re-run.

### 1d. Seed the algorithmic prompt
```bash
node scripts/seed-prompt.mjs
```
This inserts Algorithmic Prompts V1 and V2 into the `prompts` table and
promotes V2 to `active` (so the postseason Kelly rules apply automatically).
Idempotent.

---

## 2. Generate a CRON_SECRET

Vercel cron jobs authenticate by sending `Authorization: Bearer <secret>`.
The route (`/api/snapshot-closing-lines` and `/api/resolve-picks`) checks
`process.env.CRON_SECRET` and returns 401 if the header is missing or wrong.
If `CRON_SECRET` is unset, **the routes are open** — fine in dev, **not fine
in production**. Never deploy with `CRON_SECRET` unset.

Generate a fresh 256-bit hex secret:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```
Copy the output. You'll paste it into Vercel in §3.

Also append it to your local `.env.local` (the file already has this block
from `.env.local.example`):
```
CRON_SECRET=<paste_the_value_here>
```

---

## 3. Link the Vercel project + set environment variables

### 3a. Link the repo
1. Log into <https://vercel.com/dashboard>.
2. Click **Add New → Project**.
3. Select the GitHub repo (`dfs-calculator`).
4. Framework preset: Vercel auto-detects **Next.js** — leave as is.
5. Build & Output Settings: leave as defaults (`npm run build` → `.next`).
6. **Do not click Deploy yet.** Open the **Environment Variables** section
   first (§3b), otherwise the first deploy will run without any secrets.

### 3b. Add environment variables
In the Environment Variables panel, add each of the following. For each one,
set **all three scopes** (Production, Preview, Development) unless noted:

| Key | Value | Scope |
|---|---|---|
| `ODDS_API_KEY` | from <https://the-odds-api.com> | all |
| `GEMINI_API_KEY` | from <https://aistudio.google.com> | all |
| `BALLDONTLIE_API_KEY` | from <https://balldontlie.io> | all |
| `CLAUDE_API_KEY` | from <https://console.anthropic.com> (optional) | all |
| `NEXT_PUBLIC_SUPABASE_URL` | `https://<project>.supabase.co` | all |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon key | all |
| `CRON_SECRET` | value generated in §2 | **Production only** |

Notes:
- `CRON_SECRET` is Production-only so local `vercel dev` runs without
  needing the header (the `if (cronSecret)` guard in the routes leaves them
  open when unset).
- `NEXT_PUBLIC_*` vars are exposed to the browser on purpose. Supabase RLS
  protects the anon key (see `supabase/schema.sql` for the policies).
- `BALLDONTLIE_API_KEY` is **still required** for `/api/player-stats` (used
  for position lookups via `/v1/players`, which works on the free tier).
  Box-score resolution no longer needs it — we switched to ESPN in §5.

### 3c. Deploy
Click **Deploy**. First build takes ~2 minutes on hobby tier.

---

## 4. Cron schedule (automatic once deployed)

`vercel.json` at the repo root declares two cron jobs:

```json
{
  "crons": [
    { "path": "/api/snapshot-closing-lines", "schedule": "0 23 * * *" },
    { "path": "/api/resolve-picks",          "schedule": "0 12 * * *" }
  ]
}
```

### 4a. Timing in human hours

| Cron | UTC | ET (EDT) | ET (EST) | Purpose |
|---|---|---|---|---|
| snapshot-closing-lines | 23:00 daily | **7:00 PM** | 6:00 PM | Snapshots over/under odds for every today-dated pick that isn't yet closed. Runs ~30–60 min before first tip. |
| resolve-picks          | 12:00 daily | **8:00 AM** | 7:00 AM | Resolves yesterday's (and any <14 day old) unresolved picks against ESPN box scores. |

Vercel schedules are always in **UTC**. There's no DST adjustment — the ET
offset drifts by 1 hour twice a year. If the snapshot starts cutting it too
close to tip-off in March/November, bump it to `0 22 * * *` (6 PM ET year-round)
or `0 21 * * *` (5 PM ET year-round).

### 4b. Idempotency guarantees
Both crons are **idempotent** — re-running them is a no-op:

- **snapshot-closing-lines** filters `WHERE date = today AND closing_snapshot_at IS NULL`.
  A pick that's already been snapshotted is excluded.
- **resolve-picks** filters `WHERE won IS NULL AND pushed = false AND date < today`.
  A pick that's already been resolved (won/lost/pushed/DNP) is excluded.

This means you can **manually invoke** either route without worrying about
double-writes. See §6 for manual trigger commands.

### 4c. Duration budget
Both routes declare:
```typescript
export const runtime = 'nodejs';
export const maxDuration = 60;   // Vercel Hobby tier max
```

Typical durations in production:
- **snapshot-closing-lines**: ~10 Odds API calls + ~50 Supabase updates ≈ **5–10s**
- **resolve-picks**: ~10 ESPN calls + ~50 Supabase updates ≈ **7–15s**

60s is ~6× the observed p99. If either route ever times out, the logs will
show `FUNCTION_INVOCATION_TIMEOUT` — investigate ESPN API degradation or
Supabase latency before raising the limit.

---

## 5. Data source summary (for future debugging)

| Route | Data source | Auth | Rate limit |
|---|---|---|---|
| `/api/odds` | The Odds API v4 | `?apiKey=…` | 500 req/mo free |
| `/api/player-stats` | PBP Stats + balldontlie `/v1/players` | header on balldontlie | generous |
| `/api/injuries` | ESPN `site.api.espn.com` | **none** | generous |
| `/api/lineups` | ESPN `site.api.espn.com` | **none** | generous |
| `/api/snapshot-closing-lines` | The Odds API v4 | `?apiKey=…` | same as /api/odds |
| `/api/resolve-picks` | **ESPN scoreboard + summary** | **none** | generous |

**Important history**: `/api/resolve-picks` used to depend on balldontlie's
`/v1/stats` endpoint, which requires the paid ALL-STAR tier ($9.99/mo). We
switched to ESPN's public game-summary API on 2026-04-07 — same data, free,
no auth. The adapter lives in `src/lib/espnBoxScore.ts` (32 unit tests) and
the route just does IO. See commit history for the refactor details.

---

## 6. Post-deploy smoke test

After the first deploy finishes (§3c), do these in order:

### 6a. Home page
- Open `https://<your-project>.vercel.app`
- You should see the Calculator UI with no console errors.
- Switch to **Batch mode** → **Select all games** → **Analyze**
- Verify at least one pick appears with a tier and a non-zero EV.

### 6b. AI analysis
- Click the **AI Analysis** tab on a batch result.
- Verify Gemini responds without error (Claude is optional — BYO-key works
  even without the server-side `CLAUDE_API_KEY`).
- Confirm the analysis writes to Supabase:
  ```bash
  node scripts/peek-picks.mjs
  ```
  The pick count should increase by the number of analyzed picks.

### 6c. Cron auth — manually trigger snapshot
The cron routes are publicly reachable but Bearer-authenticated. Trigger
them manually with your `CRON_SECRET`:

```bash
# Replace <SECRET> and <HOST>
curl -i -H "Authorization: Bearer <SECRET>" https://<HOST>/api/snapshot-closing-lines
```

Expected:
```json
{
  "ok": true,
  "pendingPicks": <N>,
  "gamesQueried": <M>,
  "picksUpdated": <N>,
  "picksUnmatched": 0,
  "errors": [],
  "durationMs": ...
}
```

Without the header (should fail):
```bash
curl -i https://<HOST>/api/snapshot-closing-lines
# HTTP/2 401 {"error":"Unauthorized"}
```

### 6d. Cron auth — manually trigger resolve
```bash
curl -i -H "Authorization: Bearer <SECRET>" https://<HOST>/api/resolve-picks
```
Expected (on a day with no prior pending picks):
```json
{"ok":true,"scannedDates":[],"pendingPicks":0,"resolved":0, ... }
```

### 6e. Verify picks history in Supabase
```bash
node scripts/peek-picks.mjs
```
Expected output shows totals, hit rate, and latest 10 resolved rows. If
everything is `PENDING`, wait for the first overnight cron cycle or manually
trigger `/api/resolve-picks` after you have yesterday's picks.

### 6f. Verify Vercel cron registration
In the Vercel dashboard → Project → **Settings → Cron Jobs**, you should see
both crons listed with their next-run timestamps. Next run = the next UTC
`00:12` and `00:23` after deploy.

---

## 7. First production day — what to expect

**Day 1 (deploy day)**:
- You analyze picks from the UI as usual. They land in Supabase with
  `bet_odds_over/under` populated and `closing_snapshot_at = NULL`.
- At 23:00 UTC, the snapshot cron runs and fills in `closing_*` columns for
  every pick that's still live in the Odds API (i.e. hasn't been pulled).
- Some picks may fail to snapshot if their prop was pulled before tip-off.
  That's expected. `closing_snapshot_at` stays NULL for those rows and CLV
  analysis excludes them.

**Day 2 (morning)**:
- At 12:00 UTC, the resolve cron runs and marks every Day 1 pick as
  `won=true/false`, `pushed=true`, or `DNP` (pushed=true, actual_value=null).
- Check the output of `/api/resolve-picks` in the Vercel function logs — you
  should see `resolved: N, pushed: M, dnp: K, noMatch: 0` where
  `N+M+K === pendingPicks`. Any non-zero `noMatch` means ESPN's display name
  didn't match the Odds API player name — check `src/lib/pickResolver.ts`
  and add an alias if it's a recurring player.

**Day 3+**:
- The calibration dashboard at `/calibration` shows a reliability curve,
  cumulative profit, bootstrap 95% CIs, and by-bookmaker breakdowns. It
  becomes useful around ~50 resolved picks. Expect HIGH-tier hit rates
  around 53–58% if the math is calibrated correctly. The break-even
  threshold at −110 is **52.4%** (you need to win 52.4% of −110 bets to
  cover the vig). Sustained hit rates below 52.4% on HIGH-tier picks are a
  calibration signal — see §8.

---

## 8. Monitoring + alerting

The rules engine is live in `src/lib/monitoringRules.ts` and wired to the
home-page `SystemStatusCard`. Six rules evaluated on every page load (and
persisted by the daily cron when it's wired up):

| Rule | Severity | Fires when | Min samples |
|---|---|---|---|
| `insufficient-data` | info | < 30 resolved picks | — |
| `pick-milestone` | info | Crosses 50 / 100 / 250 / 500 / 1000 / 2500 / 5000 | — |
| `clv-7day-negative` | warning | 7-day avg CLV < −1pp | 10 CLV picks |
| `brier-degradation` | warning | Current Brier ≥ 1.2× baseline | 30 resolved, baseline of 50 |
| `drawdown-20pct` | warning | Bankroll down 20% from peak | — |
| `drawdown-30pct` | critical | Bankroll down 30% from peak | — |

The **`system_alerts` table** collects triggered rules with their severity
and metadata for audit. The `SystemStatusCard` on the home page shows both
live preview alerts (computed on-the-fly from current stats) and persisted
alerts (written by the cron). Acknowledging an alert sets
`acknowledged_at = now()` so it stops showing.

For deeper diagnosis, the `/calibration` page shows:
- Reliability curve (AI-adjusted vs raw calculator, with y=x reference)
- Cumulative profit curve with drawdown depth
- Bootstrap 95% CIs on hit rate, flat ROI, and average CLV
- Per-bookmaker hit rate + CLV breakdown

Manual inspection anytime:
```bash
node scripts/peek-picks.mjs
```

---

## 9. Rollback plan

### 9a. Rollback the code (fast — <2 minutes)
In the Vercel dashboard → Deployments → find the last known-good deploy →
click **⋯ → Promote to Production**. This flips traffic to the older deploy
without any GitHub interaction.

### 9b. Roll back migrations (slow — manual SQL)
Migrations 001 and 002 are **additive only** (no DROP COLUMN / DROP TABLE /
DELETE statements). You never need to roll them back to make an older code
version work, because the older code ignores columns it doesn't know about.

If you absolutely must drop the columns (e.g. rename conflict), do it
manually in the SQL editor one `alter table picks drop column …` at a time.
**There is no script for this.** Take a fresh backup first.

### 9c. Disable cron jobs temporarily
If a cron is misbehaving and you want to pause it without rolling back code:
1. Comment out the offending entry in `vercel.json`.
2. Commit + push.
3. Vercel re-reads `vercel.json` on deploy and unregisters the cron.

### 9d. Emergency kill switch — leak a secret?
If `CRON_SECRET` leaks:
1. Generate a new one via the `node -e` one-liner in §2.
2. Update it in Vercel → Environment Variables → edit → Production.
3. Click **Redeploy** on the latest production deployment to pick up the new
   env var (Vercel doesn't hot-reload env changes).
4. The old secret stops working the moment the redeploy finishes.

---

## 10. Known limitations

- **DST drift**: cron schedules are UTC. Times shift 1 hour vs ET twice a
  year. See §4a for the workaround.
- **Vercel Hobby tier**: 60s function timeout, 100 GB-hrs compute/mo.
  Current load is ~2 cron invocations/day × ~10s each = 20s/day = ~10 min/mo
  — nowhere near the limit.
- **500 req/mo Odds API free tier**: 1 snapshot cron = ~11 requests
  (1 events list + ~10 per-game props). 30 days × 11 = 330 req/mo, leaving
  170 for UI batch analyses. If you run batch analyses all day, upgrade to
  the paid Odds API tier.
- **ESPN schema drift**: The adapter (`src/lib/espnBoxScore.ts`) detects
  missing `MIN`/`PTS`/`REB` etc. labels and returns null for the row, which
  the resolver counts as `no_match`. If ESPN ever renames a label, the
  whole day's resolution fails gracefully (no crash, all picks stay pending).
  Watch the function logs for sudden `noMatch` spikes.

---

## Appendix — Manual cron invocation cheatsheet

```bash
# Set these once per terminal session
export HOST="https://dfs-calculator.vercel.app"         # your Vercel URL
export SECRET="<your_CRON_SECRET>"

# Trigger snapshot (use when you want CLV for today's picks before the cron)
curl -sS -H "Authorization: Bearer $SECRET" "$HOST/api/snapshot-closing-lines" | jq

# Trigger resolve (use when you want to backfill resolutions immediately)
curl -sS -H "Authorization: Bearer $SECRET" "$HOST/api/resolve-picks" | jq

# Peek at the picks table (reads from local .env.local Supabase creds)
node scripts/peek-picks.mjs

# Check which migration 001 columns are present
node scripts/check-picks-columns.mjs
```

Both routes return JSON — pipe through `jq` for pretty-printing.

---

## Changelog
- **2026-04-07** — Initial runbook. Migration 001 is mandatory Step 1.
  ESPN replaces balldontlie `/v1/stats` for resolve-picks. CRON_SECRET added
  to both cron routes.
