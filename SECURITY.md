# Security Policy

Thanks for taking the time to help keep the DFS Calculator project safe.
This document describes how to report a security vulnerability, what is in
and out of scope, and what you can expect from us in return.

## Supported versions

The DFS Calculator is a small single-maintainer project. Only the `main`
branch currently deployed to production receives security fixes. There are
no long-lived release branches.

| Branch | Supported                                    |
| ------ | -------------------------------------------- |
| `main` | Yes — active development and production      |
| other  | No — please rebase on `main` before reporting |

## Reporting a vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**
Public issues are indexed by search engines and scraped by automated
exploitation tools within minutes.

### Preferred: GitHub Security Advisories

1. Go to the **Security** tab of this repository on GitHub.
2. Click **Report a vulnerability**.
3. Fill in the private advisory form with:
   - A description of the issue
   - Affected files / endpoints / versions
   - Reproduction steps
   - Suspected impact
4. Submit. Only the repository maintainers can see the report.

This is the fastest path — it creates a private fork, a CVE request
workflow, and a merge queue all in one place.

### Fallback: email

If you do not have a GitHub account or prefer email, you can reach the
maintainer via the contact information listed on the repository's
**About** page. Please include:

- `[SECURITY]` at the start of the subject line
- A description of the issue and its impact
- A proof of concept if you have one (ideally a minimal reproducer)
- Your preferred contact method for follow-up

Do **not** include exploit payloads that target live infrastructure unless
you have confirmed with the maintainer that sending them is acceptable.

## What to expect

- **Acknowledgement** within 3 business days.
- **Initial triage + severity estimate** within 7 business days.
- **Fix target**:
  - Critical (RCE, key leak, auth bypass): 14 days
  - High (privilege escalation, DoW, sensitive info disclosure): 30 days
  - Medium / Low: next minor release
- **Disclosure**: Once a fix has shipped and been verified in production
  for at least 48 hours, we will coordinate a public disclosure with you.
  You will be credited in the release notes unless you request otherwise.

There is no bug bounty for this project — it's a personal side project and
has no budget. What we can offer is a prompt response, credit in the
release notes, and the satisfaction of knowing the fix will ship.

## Scope

### In scope

- The Next.js app under `src/app/` and `src/components/`
- The server-side libraries under `src/lib/`
- The API routes under `src/app/api/`
- The Supabase migrations under `supabase/migrations/`
- The GitHub Actions workflows under `.github/workflows/`
- The cron job auth (`src/lib/cronAuth.ts`) and origin check
  (`src/lib/originCheck.ts`)
- The AI prompt pipeline (`src/lib/aiAnalysis.ts`) — including prompt
  injection, data exfiltration, or cost-amplification issues

### Out of scope

- Vulnerabilities in third-party dependencies — please report those
  upstream. If we're unaware of the advisory, feel free to open a normal
  issue or PR that bumps the affected dependency.
- Vulnerabilities in Supabase, Vercel, Anthropic, Google, OpenRouter, the
  Odds API, PBP Stats, balldontlie, or ESPN — report those to the
  respective vendor.
- Denial of service via sheer traffic volume — the app runs behind Vercel's
  platform-level DDoS mitigations and has a GCP billing hard cap.
- Clickjacking on pages without authentication (the app currently has
  no authentication at all).
- Missing security headers on 404 pages.
- Any finding that requires a pre-existing local shell on the maintainer's
  workstation.
- Bugs in the DFS math engine (`src/lib/math.ts`) — those are gameplay
  accuracy issues, not security vulnerabilities. Open a normal issue.

## Safe harbor

We consider good-faith security research conducted according to this
policy to be authorized. Specifically, if you:

- Make a reasonable effort to avoid privacy violations, data destruction,
  and interruption of service,
- Only interact with accounts you own or have explicit permission to test,
- Do not exfiltrate more data than is necessary to demonstrate the issue,
- Report the issue privately as described above, and
- Give us a reasonable amount of time to fix the issue before any public
  disclosure,

…then we will not pursue legal action against you for your research and
we will work with you to understand and resolve the issue quickly.

## Security controls summary

For transparency, here is what's currently in place (as of the security
audit landed in the PR that accompanies this file):

- **Origin / Referer allowlist** on all POST routes (CSRF defense).
- **Content-Length cap** of 100 KB on `/api/analyze` (DoW defense).
- **Zod schema validation** on every API request body and query string.
- **Anthropic / Gemini / OpenRouter key format regexes** before any
  upstream provider call.
- **Server-only Supabase admin client** using the service_role key —
  the anon key is never shipped to the browser.
- **Default-deny RLS** on every table in `supabase/migrations/003`.
- **Per-request CSP nonces** generated in Edge middleware.
- **HSTS, X-Frame-Options DENY, nosniff, strict Permissions-Policy** on
  every response via `next.config.js`.
- **Constant-time Bearer token verification** for Vercel cron endpoints
  (`src/lib/cronAuth.ts`).
- **BYO API key stored in `sessionStorage`**, not `localStorage` — tab-
  scoped and wiped on close.
- **Prompt injection defense** via per-request XML nonce delimiters and
  input sanitization in `src/lib/aiAnalysis.ts`.
- **Response redaction** via `src/lib/redact.ts` — API keys are replaced
  with `[REDACTED]` before any error message crosses a network boundary.
- **GCP Cloud Billing hard cap** (external, configured in the GCP
  console) — the strongest defense against LLM01 Denial of Wallet.
- **Vercel Firewall rate-limit rule** on `/api/analyze` (external,
  configured in the Vercel dashboard).
- **Dependabot + `npm audit` + `dependency-review-action`** on every PR.
- **gitleaks** configured via `.gitleaks.toml` for secret scanning.

If any of the above is missing, misconfigured, or defeated, that is
in-scope for this policy and we want to hear about it.
