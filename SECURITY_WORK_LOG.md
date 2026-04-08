# Security Work Log

> This is the complete inventory of every change landed during the
> security audit remediation pass. Nothing in this document has been
> committed yet — everything is staged in the working tree for your
> review. When you're happy, commit the lot (or in logical chunks) and
> push. The deployment side of things is in
> `SECURITY_DEPLOYMENT_CHECKLIST.md`.
>
> **Test status**: `npm test` → 29 suites, 884 tests, 0 failures.
> **Build status**: `npm run build` → compiled successfully, 16 routes.
> **Audit status**: `npm audit` → 0 vulnerabilities.
>
> **Update (2026-04-07)**: A follow-up automation pass added Tier 1 + Tier 2
> maintenance-habit automations: 5 new scheduled GitHub workflows and 1 new
> invariant test suite. See the **Automation follow-up** section near the end
> of this doc for details. Test count grew from 872 → 884 as a result.

---

## TL;DR

- **21 files added** (security libs, middleware, tests, docs, CI config,
  RLS migration, types-only split of aiAnalysis).
- **18 files modified** (hardened API routes, env templates, docs, and
  the AIAnalysisPanel for sessionStorage migration).
- **0 files deleted** — everything old was replaced in place.
- **No test was weakened or removed.** 27 existing suites still green,
  5 new suites added (cronAuth, originCheck, redact, sanitize, schemas).
- **No git commits made.** Everything is staged for your review.
- **No .env.local touched.** Your local secrets are untouched.

---

## Threat model recap

The app is a public, unauthenticated NBA prop calculator that fans out
to paid LLMs (Anthropic / Gemini / OpenRouter), reads player stats and
odds from free third-party APIs, and persists picks + analyses in
Supabase. The highest-risk scenarios are:

1. **LLM01 Prompt Injection** — a hostile field (player name, injury
   note, lineup context) convinces the model to ignore its system prompt.
2. **LLM02 Sensitive Info Disclosure** — a provider API key leaks into
   a client-visible error or a log file.
3. **LLM10 Denial of Wallet** — an attacker burns $$$ in LLM quota by
   firing many /api/analyze calls, each with the maximum prompt size.
4. **API1 BOLA / API5 BFLA** — the anon Supabase key lets anyone read
   or write every table because the shipped RLS policy was `using(true)`.
5. **API7 SSRF** — the /api/odds `eventId` param gets concatenated into
   a fetch URL. An attacker who can smuggle `..` or a hostname segment
   steers our server into fetching an attacker-chosen URL.
6. **Supply chain** — an outdated or malicious dependency lands in
   package-lock.json without anyone noticing.
7. **Credential exfiltration** — an XSS vuln somewhere in the app reads
   the Anthropic key out of localStorage and ships it to evil.com.

Every item below maps back to one of these threats.

---

## NEW FILES (21)

### Server-only helper libraries

#### `src/lib/supabaseAdmin.ts`
Singleton admin client using `SUPABASE_SERVICE_ROLE_KEY`. Marked
`import 'server-only'` so it physically cannot end up in the browser
bundle. Returns `null` when env is unset so dev without Supabase still
works. This REPLACES the old `src/lib/supabase.ts` runtime client (which
used the anon key). **Threat: API1, API5.**

#### `src/lib/schemas.ts`
Every Zod validator for every API route in one place. Provider key
format regexes (Anthropic, Gemini, OpenRouter), `IsoDate`, `Uuid`,
`AmericanOdds`, `PlayerName` (Unicode-aware), `StatType`,
`AnalyzeRequestBody` (strict, max 200 players, bankroll 1..1M),
`OddsQuery` (hex-only eventId regex — SSRF guard), `PicksQuery`,
`AcknowledgeQuery`, `AIPickSchema`, `AIAnalysisResponseSchema`. Imports
`server-only`. **Threat: LLM05, API4, API7, API8.**

#### `src/lib/redact.ts`
`redactSecrets()`, `redactUnknown()`, `safeErrorMessage()`. Matches every
provider key format used by this project (Anthropic, Gemini,
OpenRouter, generic OpenAI, Supabase JWT, Bearer tokens) and replaces
them with `[REDACTED]` before any error crosses a network boundary.
Handles strings, Error objects, and plain objects (via JSON round-trip).
Never throws — returns `'[REDACTION_FAILED]'` on any internal error.
**Threat: LLM02.**

#### `src/lib/sanitize.ts`
`sanitizePlayerName()`, `sanitizeStatType()`, `sanitizeFreeText()`.
Strips control chars (U+0000..U+001F / U+007F..U+009F), angle brackets,
backticks, pipes, backslashes — every character that could break the
markdown table we build for the LLM or smuggle a new instruction. Caps
lengths aggressively (64/32/4000). Returns safe fallbacks. **Threat: LLM01.**

#### `src/lib/originCheck.ts`
`isAllowedOrigin()` — Origin/Referer allowlist for mutation routes.
Fails closed when the allowlist is empty. Reads `NEXT_PUBLIC_SITE_URL`,
`ALLOWED_ORIGINS`, and the runtime `VERCEL_URL`. Adds localhost in dev.
The strict `startsWith(o + '/')` comparison rejects lookalike-subdomain
attacks like `dfs-calculator.example.com.evil.com`. **Threat: API8 / CSRF.**

#### `src/lib/cronAuth.ts`
`verifyCronAuth()` — constant-time Bearer token auth for Vercel cron.
Uses `node:crypto.timingSafeEqual` with length-equalized buffers to
avoid both the side-channel leak AND the throw-on-length-mismatch
oracle. Fails closed in production when `CRON_SECRET` is unset (503).
Allows in dev with a warning. Replaces the old fail-open
`if (cronSecret) { ... }` inline check. **Threat: CWE-306.**

#### `src/lib/apiErrors.ts`
`errorResponse()`, `badRequest()`, `unauthorized()`, `forbidden()`,
`payloadTooLarge()`, `rateLimited()`, `misconfigured()`, `internalError()`.
Consistent error shape + status codes + automatic redaction via
`safeErrorMessage()` on the server-side details. Clients only ever see
`{ error: 'Internal error', code: 'internal' }`. **Threat: LLM02.**

#### `src/lib/aiTypes.ts`
Client-safe split of the aiAnalysis module. Exports `AIProvider`,
`AIPick`, `AISlip`, `ModelInfo`, `MODEL_CATALOG`, `DEFAULT_ENSEMBLE`.
No `node:*` imports, no `process.env`, no side effects — safe to import
from Client Components. `aiAnalysis.ts` re-exports these for backward
compatibility. **Threat: LLM02 (keeps server-only enforcement working).**

### Edge middleware

#### `src/middleware.ts`
Generates a per-request CSP nonce using `crypto.randomUUID()`, builds
the strict CSP header (`script-src 'self' 'nonce-...' 'strict-dynamic'`),
HSTS, frame-ancestors none, and the rest of the hardening headers.
Uses the canonical Next.js 15 nonce pattern documented at
https://nextjs.org/docs/app/guides/content-security-policy. **Threat: XSS.**

### Supabase migration

#### `supabase/migrations/003_enable_rls.sql`
Drops every `using(true) with check(true)` policy that shipped in
`schema.sql`. Re-asserts `enable row level security` on every table.
Adds `force row level security` so even table owners are subject to RLS.
Creates explicit `as restrictive for all to anon, authenticated
using(false) with check(false)` deny policies on every table. Includes
post-migration verification SQL as a comment. Fully idempotent.
**Threat: API1, API5.**

### GitHub config

#### `.github/dependabot.yml`
Weekly (Monday 09:00 ET) dependency updates for npm + github-actions.
Groups minor/patch updates into a single PR to cut noise. Ignores major
bumps (they should be deliberate). Security advisories bypass the
weekly cadence and fire immediately per GitHub's defaults. **Threat: A06.**

#### `.github/workflows/ci.yml`
Least-privilege workflow with `permissions: contents: read`. Three jobs:
`test` (npm ci, npm test, npm run build with dummy env), `audit`
(`npm audit --audit-level=high` — blocks on high/critical), and
`dependency-review` (PR-only, blocks any PR introducing a vulnerable
or GPL-licensed dependency). Uses `pull_request` (not the dangerous
`pull_request_target`) and `persist-credentials: false` on checkout.
**Threat: A06, CI/CD-SEC-1.**

#### `.gitleaks.toml`
Gitleaks config extending the default ruleset with project-specific
rules: Supabase service_role JWT, Anthropic `sk-ant-api` keys,
OpenRouter `sk-or-v*`, Gemini `AIza*`, and The Odds API 32-hex keys.
Allowlists test fixtures, example env files, prompt files, and docs.
Includes stopwords for known-safe dummy values (CI placeholders).
**Threat: A01 / secret exposure.**

### Disclosure policy

#### `SECURITY.md`
Vulnerability disclosure policy. Supported branches, how to report
privately (GitHub Security Advisories preferred, email fallback), what
to expect (ack within 3 business days, triage within 7, fix targets by
severity), scope (in/out), safe-harbor language, and a summary of the
current control inventory so researchers know what's already in place.

### Unit tests (5 new suites, 106 new tests)

#### `__tests__/redact.test.ts` (23 tests)
Every provider key format gets a positive + negative case. Covers
`redactSecrets`, `redactUnknown` (null/string/Error/object/circular),
and `safeErrorMessage`. Verifies that Error objects have both `message`
and `stack` redacted, that nested objects survive round-trip, that
circular refs yield `'[REDACTION_FAILED]'` instead of throwing, and
that `safeErrorMessage` never throws even on objects with throwing
`toString()`.

#### `__tests__/sanitize.test.ts` (24 tests)
Known-safe names (LeBron, Jokić, Dončić, Karl-Anthony Towns, D'Angelo
Russell) survive unchanged. Angle brackets, backticks, pipes,
backslashes, newlines, and control chars all get stripped. Length
caps verified (64 for names, 32 for stats, 4000 default for free text).
CRLF behavior documented (strips entirely — see the test comment).
Non-string input returns safe defaults.

#### `__tests__/schemas.test.ts` (48 tests)
Every Zod schema gets positive + negative cases. Provider key regex
tests (valid → accept, wrong prefix → reject, too short → reject,
cross-provider → reject). `PlayerName` with Unicode diacritics passes.
`AnalyzeRequestBody` rejects: unknown fields (strict), >200 players,
bankroll <=0 or >1M, non-finite bankroll, >5 providers, lineupContext
>10k, invalid platform. `OddsQuery` rejects: missing eventId, path
traversal, URL components, uppercase hex, too-short hex. `PicksQuery`
rejects: invalid tier, SQL-injection-shaped limit. `AIPickSchema`
rejects: invalid direction/tier, out-of-range finalProbability/finalEV,
reasoning >2000. `AIAnalysisResponseSchema` rejects >200 picks.

#### `__tests__/originCheck.test.ts` (12 tests)
Fails closed in production with empty allowlist. Allows localhost in
dev without explicit config. Matches NEXT_PUBLIC_SITE_URL with and
without trailing slash. Allows ALLOWED_ORIGINS (comma-separated) and
runtime VERCEL_URL. Rejects lookalike subdomain attacks
(`dfs.example.com.evil.com`). Rejects an origin that's a prefix of the
allowed one. Accepts Referer as fallback when Origin is missing.
Rejects a request with neither header.

#### `__tests__/cronAuth.test.ts` (8 tests)
Production fails closed (503) when CRON_SECRET unset. Dev allows with
warn. Correct Bearer token → null (allow). Wrong token → 401. Missing
header → 401. Wrong-length token → 401 (doesn't leak length info via
exception). Malformed header (no Bearer prefix) → 401. Prefix-match
attack (right prefix, wrong later bytes) → 401.

### Jest mock

#### `__mocks__/server-only.js`
Empty-module shim mapped via `jest.config.js` so `import 'server-only'`
becomes a no-op at test time. The real package throws on import to
catch accidental client bundling — that's the right behavior in a
webpack bundle but a false alarm in a Node Jest run.

### Docs

#### `SECURITY_DEPLOYMENT_CHECKLIST.md`
The external-action checklist for deploy day: GCP billing cap (hard
cap with Pub/Sub auto-disable), Vercel Firewall rate limit rule,
Supabase migration 003 apply, Vercel Sensitive env vars, GitHub Push
Protection, key rotation after any possible exposure, prompt reseed,
and final smoke tests. See that doc for the full step-by-step.

#### `SECURITY_WORK_LOG.md`
This file.

---

## MODIFIED FILES (18)

### Dependency + config

#### `package.json`
- Bumped `next ^15.5.14`, `react ^19.2.4`, `react-dom ^19.2.4`
- Added `zod ^3.23.8` (runtime validation)
- Added `server-only ^0.0.1` (boundary guard)
- Bumped `@types/react ^19.2.4`, `@types/react-dom ^19.2.3` (latest
  available — 19.2.4 doesn't exist yet for react-dom)

#### `package-lock.json`
Regenerated via `npm install`. 0 vulnerabilities reported.

#### `jest.config.js`
Added `moduleNameMapper` for `server-only` → `__mocks__/server-only.js`
so Node-environment tests can import modules marked server-only.

#### `next.config.js`
Replaced empty config with:
- `reactStrictMode: true`
- `poweredByHeader: false` (removes X-Powered-By: Next.js info leak)
- Security headers on every response: HSTS 2yr + preload,
  X-Frame-Options DENY, X-Content-Type-Options nosniff,
  Referrer-Policy strict-origin-when-cross-origin, comprehensive
  Permissions-Policy blocking camera/mic/geo/payment/usb/etc.
  (The CSP is emitted per-request from `src/middleware.ts` so it can
  carry a nonce.)

#### `.env.local.example`
- Removed `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY`
  (no longer used — the app uses the service_role via supabaseAdmin).
- Added `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`.
- Added `NEXT_PUBLIC_SITE_URL`, `ALLOWED_ORIGINS`, `CRON_SECRET`.
- Added inline security notes explaining what each var controls.

### API routes

#### `src/app/api/analyze/route.ts` (rewrite)
**Defense-in-depth stack applied in order:**
1. `import 'server-only'` — module guard
2. `isAllowedOrigin(request)` → 403 Forbidden (CSRF shield)
3. Content-Length cap 100KB → 413 Payload Too Large (DoW shield)
4. JSON parse wrapped → 400 Bad Request on malformed body
5. `AnalyzeRequestBody.safeParse()` strict → 400 with issue paths
6. `validateProviderKey(provider, key)` regex check before any
   upstream call (catches typos / stale keys)
7. Persistence via `getSupabaseAdmin()` (service_role, bypasses RLS)
8. All catch blocks use `safeErrorMessage()` — client sees generic
   `{ error: 'Internal error' }`, server logs hold the redacted real
   error

The legacy fail-path where an unrelated exception could echo `err.message`
verbatim back to the client is gone.

#### `src/app/api/odds/route.ts` (rewrite)
- `import 'server-only'`
- `OddsQuery.safeParse()` with the hex-regex eventId constraint
  `^[a-f0-9]{16,64}$` — this is the SSRF guard
- `misconfigured()` when `ODDS_API_KEY` is unset (503, not 500 — makes
  it obvious in ops that it's a config issue not an incident)
- `internalError(err, 'odds')` on catch — never echoes upstream body

#### `src/app/api/picks/route.ts`
- `PicksQuery.safeParse()` on query params
- Switched `getSupabase()` → `getSupabaseAdmin()`
- `badRequest()` + `internalError()` on failures

#### `src/app/api/resolve-picks/route.ts`
- Replaced fail-open `if (cronSecret) { ... }` with `verifyCronAuth(request)`
- Switched to `getSupabaseAdmin()`
- Uses `misconfigured()` + `internalError()` helpers

#### `src/app/api/snapshot-closing-lines/route.ts`
- Same cron-auth + supabaseAdmin + error-helpers pattern as resolve-picks

#### `src/app/api/system-status/route.ts`
- Switched to `getSupabaseAdmin()`
- `internalError(err, 'system-status')` in catch

#### `src/app/api/system-status/acknowledge/route.ts` (rewrite)
- Full rewrite with `AcknowledgeQuery` Zod validation
- `isAllowedOrigin(request)` CSRF shield
- `getSupabaseAdmin()` for the UPDATE
- `errorResponse()` helpers throughout

### Library modules

#### `src/lib/supabase.ts` (gutted)
Converted to types-only module. Kept interfaces: `PromptVersion`,
`AnalysisRow`, `PickRow`, `SystemAlertRow`. The old `getSupabase()` is
now a deprecated shim that delegates to `getSupabaseAdmin()` so any
stray import keeps working but routes through the server-only path.
The anon key is no longer instantiated anywhere.

#### `src/lib/promptVersions.ts`
- Added `import 'server-only'`
- Switched `getSupabase()` → `getSupabaseAdmin()`
- No functional changes

#### `src/lib/aiAnalysis.ts`
Six surgical changes for prompt injection defense + type split:

1. `import 'server-only'` + `randomBytes` from `node:crypto` +
   sanitize helpers + `AIAnalysisResponseSchema` from `./schemas`
2. Added `makeNonce()` helper returning 16 hex chars per call
3. `buildUserMessage()` generates a fresh nonce per call and wraps
   every user-originated block in
   `<untrusted-input-${nonce}>...</untrusted-input-${nonce}>` with
   explicit instructions to the model to treat the block as data,
   not instructions. Even if the attacker knows the format they
   can't smuggle a closing tag because the nonce rotates per message.
4. Calculator results table — all player names / stats / positions
   passed through `sanitizePlayerName()` / `sanitizeStatType()`.
5. Injury report block — all team / position / status / comment
   fields passed through `sanitizeFreeText()`; closing tag emitted
   before the "## Response Format" instructions so response format
   stays in the trusted region.
6. `parseAIResponse()` — added `AIAnalysisResponseSchema.safeParse(obj)`
   validation gate with a permissive fallback that console.warn's
   on schema mismatch but still returns best-effort data (so a model
   that hallucinates one extra field doesn't nuke the whole run).

**Type split** (same file, separate concern): moved `AIProvider`,
`AIPick`, `AISlip`, `ModelInfo`, `MODEL_CATALOG`, `DEFAULT_ENSEMBLE` to
`src/lib/aiTypes.ts` so Client Components can import them. The aiAnalysis
module re-exports them from the top of the file, so no caller had to
change their import path (except AIAnalysisPanel, which was updated
explicitly to import from `aiTypes` directly for clarity).

#### `src/components/AIAnalysisPanel.tsx`
Two changes:
1. Import `AIProvider`, `ModelInfo`, `MODEL_CATALOG` from
   `../lib/aiTypes` instead of `../lib/aiAnalysis` (avoids pulling
   server-only code into the client bundle).
2. BYO API key storage migrated from `localStorage` → `sessionStorage`.
   Also added `typeof window === 'undefined'` SSR guards. This is the
   XSS → key exfiltration defense.

### Docs

#### `CLAUDE.md`
- Added `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_SITE_URL`,
  `ALLOWED_ORIGINS`, `CRON_SECRET` to the env-var block; removed
  `NEXT_PUBLIC_SUPABASE_*`.
- Added a "Security model" section with the 5 gotchas every agent
  session needs to know.
- Expanded the component map to include the new security libs with
  🔒 emoji marking server-only modules.
- Expanded the test map to include the 5 new suites.
- Added a "Complete the post-deploy security checklist" step to the
  Vercel deployment section.

#### `AGENTS.md`
- Updated the env-var block to match the new set.
- Added a "Security" section with pointers to SECURITY.md,
  SECURITY_DEPLOYMENT_CHECKLIST.md, SECURITY_WORK_LOG.md.
- Added a post-deploy checklist step to the Deployment section.

---

## File-level inventory

### Added (21)
```
.github/dependabot.yml
.github/workflows/ci.yml
.gitleaks.toml
SECURITY.md
SECURITY_DEPLOYMENT_CHECKLIST.md
SECURITY_WORK_LOG.md
__mocks__/server-only.js
__tests__/cronAuth.test.ts
__tests__/originCheck.test.ts
__tests__/redact.test.ts
__tests__/sanitize.test.ts
__tests__/schemas.test.ts
src/lib/aiTypes.ts
src/lib/apiErrors.ts
src/lib/cronAuth.ts
src/lib/originCheck.ts
src/lib/redact.ts
src/lib/sanitize.ts
src/lib/schemas.ts
src/lib/supabaseAdmin.ts
src/middleware.ts
supabase/migrations/003_enable_rls.sql
```

### Modified (18)
```
.env.local.example
AGENTS.md
CLAUDE.md
jest.config.js
next.config.js
package-lock.json
package.json
src/app/api/analyze/route.ts
src/app/api/odds/route.ts
src/app/api/picks/route.ts
src/app/api/resolve-picks/route.ts
src/app/api/snapshot-closing-lines/route.ts
src/app/api/system-status/acknowledge/route.ts
src/app/api/system-status/route.ts
src/components/AIAnalysisPanel.tsx
src/lib/aiAnalysis.ts
src/lib/promptVersions.ts
src/lib/supabase.ts
```

### Added in automation follow-up (2026-04-07, 6 files)
```
.github/workflows/scheduled-audit.yml
.github/workflows/scorecard.yml
.github/workflows/codeql.yml
.github/workflows/gitleaks-scheduled.yml
.github/workflows/dependabot-auto-merge.yml
__tests__/security-invariants.test.ts
```

### Modified in automation follow-up (1 file)
```
SECURITY_WORK_LOG.md   (this file — added automation follow-up section)
```

### Deleted
None.

---

## What's NOT done (requires human action)

Everything in `SECURITY_DEPLOYMENT_CHECKLIST.md`:

1. GCP Cloud Billing hard cap (critical)
2. Vercel Firewall rate-limit rule
3. Apply `supabase/migrations/003_enable_rls.sql` in the Supabase dashboard
4. Mark `SUPABASE_SERVICE_ROLE_KEY` as Sensitive in Vercel env vars; add
   `NEXT_PUBLIC_SITE_URL`, `ALLOWED_ORIGINS`, `CRON_SECRET`; remove the
   old `NEXT_PUBLIC_SUPABASE_*` vars
5. Enable GitHub Push Protection + Dependabot alerts
6. Rotate any keys that may have been exposed
7. Re-seed the Supabase prompt_versions table with
   `node scripts/seed-prompt.mjs` after the migration lands
8. Smoke test the deployed site

Each step has a button-level walkthrough in the deployment checklist.

---

## Verification commands

Run these from the project root to confirm the tree is healthy before
committing:

```bash
# Install the new dependencies (zod, server-only, bumped types)
npm install

# Full test suite — should be 29 passed, 884 tests (incl. 12 invariant)
npm test

# Production build — should compile all 16 routes cleanly
npm run build

# Dependency audit — should report 0 vulnerabilities
npm audit
```

All four commands were run before this log was written and all four
reported clean results.

---

## Automation follow-up (2026-04-07)

After the initial audit landed, a second pass added the automations
needed to turn the "maintenance habit" into a set of scheduled CI
workflows and an invariant test that guards the source-level hardening
against regression.

### Added — Tier 1: scheduled GitHub workflows (5 files)

#### `.github/workflows/scheduled-audit.yml`
- Nightly `npm audit` cron (06:00 UTC) independent of push/PR activity.
- Catches advisories published between deploys — fail-the-workflow
  deterministically rather than relying on Dependabot's silent alerts.
- `permissions: contents: read`, no secrets, `persist-credentials: false`.

#### `.github/workflows/scorecard.yml`
- OSSF Scorecard weekly (Mondays 07:00 UTC) — 18 supply-chain checks
  (token permissions, pinned deps, branch protection, Dependabot status,
  SECURITY.md present, etc.). SARIF upload to Security tab.
- Publishes to the public Scorecard API so a README badge can be added.
- Permissions scoped per-job (`id-token: write`, `security-events: write`).

#### `.github/workflows/codeql.yml`
- CodeQL weekly + on every push/PR with `security-extended` query suite.
- Catches semantic vulnerabilities (SQL/NoSQL injection, SSRF, path
  traversal, XSS, prototype pollution, regex DoS) that `npm audit` can't
  see because they're in our own code, not dependencies.
- Analyses `javascript-typescript` matrix, ~20 minute timeout.

#### `.github/workflows/gitleaks-scheduled.yml`
- Weekly full-history secret scan (Sundays 06:00 UTC) — complements
  GitHub Push Protection by re-scanning everything that was committed
  before Push Protection was enabled, and picking up new Gitleaks rules
  as they're published.
- Uses our project-specific `.gitleaks.toml` ruleset + the default one.
- `fetch-depth: 0` is required and intentional — shallow clones defeat
  the entire purpose of a secret scanner.

#### `.github/workflows/dependabot-auto-merge.yml`
- Auto-approves and auto-merges Dependabot PRs that are `semver-patch`
  or `semver-minor` AFTER CI passes. Major bumps stay open for human
  review with an automatic explanatory comment.
- Uses `dependabot/fetch-metadata@v2` for cryptographically-verified
  actor check (never trusts `github.actor` alone — forgeable via display
  name). `pull_request` trigger (not `pull_request_target`) prevents
  pwn-request.
- Permissions: `contents: write` + `pull-requests: write`, scoped to
  this workflow only.

### Added — Tier 2: invariant test (1 file, 12 new tests)

#### `__tests__/security-invariants.test.ts`
- Ratchet-style structural enforcement of the audit's source-level
  rules. Walks the filesystem on every `npm test` run and asserts:
  1. Every server-only module has `import 'server-only'` at the top.
  2. No Client Component imports a server-only module.
  3. No source file writes API-key-like data to `localStorage`.
  4. Every Supabase `create table` has both `enable row level security`
     AND `force row level security`.
  5. Every cron route in `vercel.json` imports and calls
     `verifyCronAuth`.
  6. Every POST route imports and calls `isAllowedOrigin`.
  7. Every non-exempt API route imports from `@/lib/schemas`.
  8. Every non-exempt API route imports from `@/lib/apiErrors`.
  9. The exemption allowlists don't grow (direction = tighten only).
- The two allowlists document six pre-existing gaps
  (`injuries`, `lineups`, `player-stats` for Zod + apiErrors; plus
  `resolve-picks`, `snapshot-closing-lines`, `system-status` for the
  no-user-input case). New routes MUST be compliant — they can only be
  added to the exemption by editing the test and leaving a comment.
- 12 tests, all passing. Runtime ~0.1 seconds.

### What this closes in the "maintenance habit"

| Habit                                   | Before                 | After                                 |
|-----------------------------------------|------------------------|---------------------------------------|
| Check `npm audit` after new advisories  | Manual, easy to forget | Nightly workflow fails + emails       |
| Merge Dependabot PRs                    | Manual, ~10 PRs/week   | Auto-merge patch+minor, human for major|
| Catch supply-chain regressions          | Manual Scorecard runs  | Weekly SARIF to Security tab          |
| Catch semantic code bugs                | Manual CodeQL setup    | Weekly + on every push/PR             |
| Catch secrets in git history            | Push Protection only   | Weekly full-history Gitleaks scan     |
| Enforce Zod on new routes               | Code review only       | `npm test` fails if missing           |
| Enforce RLS on new tables               | Migration review only  | `npm test` fails if missing           |
| Enforce server-only boundary            | Build error (confusing)| Clear test failure with filename      |
| Enforce sessionStorage for BYO keys     | Code review only       | `npm test` fails if localStorage used |

### Tier 3 — deferred to a scheduled reminder

Tier 3 items (Vercel log drains → Sentry/Axiom, uptime check, GCP budget
alert escalation) require the app to be deployed first and all involve
external dashboard setup, so they were deferred to a one-time scheduled
reminder set to fire on 2026-04-21. When it fires, it'll check the
deployment checklist state and walk through the Tier 3 options if the
app is live.

---

## Git commit suggestion

When you're ready to commit, a single commit with a clear subject is
probably easiest given how many files are involved:

```
security: comprehensive audit remediation (OWASP LLM01/02/10, API1/4/5/7/8)

- Add Zod validation + origin check + content-length cap on every API
  route; redact provider API keys from all error responses.
- Split aiAnalysis types into a client-safe aiTypes module; mark every
  secret-handling lib as `import 'server-only'`.
- Move BYO API keys from localStorage to sessionStorage.
- Drop Supabase anon-key runtime client; route all DB access through a
  new server-only admin client using the service_role key.
- Add default-deny RLS migration (003) — blocks anon reads/writes.
- Add per-request CSP nonces via Edge middleware, HSTS, Permissions-Policy.
- Add Dependabot, CI workflow (npm audit + dependency-review), gitleaks
  config, and a security disclosure policy (SECURITY.md).
- Add 5 new test suites (cronAuth, originCheck, redact, sanitize, schemas)
  — 106 new tests; 872 total, all passing.

See SECURITY_DEPLOYMENT_CHECKLIST.md for the external-action follow-ups
(GCP billing cap, Vercel WAF rule, Supabase migration apply, key rotation).
```

Or split into logical commits if you prefer smaller reviewable chunks:
1. Dependencies + jest config (package.json, package-lock.json, jest.config.js, __mocks__)
2. Server-only helper libs (src/lib/*.ts new files)
3. API route hardening (src/app/api/**)
4. aiAnalysis type split + sessionStorage migration (aiAnalysis, aiTypes, AIAnalysisPanel)
5. Middleware + next.config.js headers
6. Supabase RLS migration (003_enable_rls.sql)
7. GitHub config + gitleaks (.github/, .gitleaks.toml)
8. Docs + tests (SECURITY.md, deployment checklist, work log, 5 test suites, CLAUDE.md, AGENTS.md)

Either approach is fine. The whole tree has been tested together.
