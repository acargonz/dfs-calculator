# Security Deployment Checklist

> This document lists **only the external actions you need to take** after
> merging the security audit PR. Everything that could be done in source
> code has already been done and is waiting for your review — see
> `SECURITY_WORK_LOG.md` for the full inventory. The items below require
> access to the GCP console, Vercel dashboard, Supabase dashboard, or
> GitHub repo settings and must be done by a human with the correct
> credentials.

Work through the checklist top to bottom. Each step is independently
valuable; if you run out of time, stop at any point and the app is still
strictly more secure than before.

---

## 0. Before you start

- [ ] Read `SECURITY_WORK_LOG.md` so you know what's changed in code.
- [ ] Review the diff (`git status` + `git diff`) — nothing has been
      committed. Everything is staged for your review.
- [ ] Run `npm test` and `npm run build` locally once more if you want to
      double-check the tree is green before committing.

Commit and push when you're satisfied with the diff.

---

## 1. GCP Cloud Billing — hard cap (CRITICAL, ~5 min)

**Why:** This is the single strongest defense against OWASP LLM10:2025
"Denial of Wallet" for the Gemini provider. Without this, a bug or a
determined attacker could run up a bill faster than you can notice. With
it, GCP will physically disable billing on the project the moment the
budget threshold is crossed, and any further Gemini API calls will hard-
fail. Even a compromised service account can't spend past the cap.

**Steps:**
1. Go to https://console.cloud.google.com/billing
2. Click the billing account you use for Gemini → **Budgets & alerts**.
3. Click **Create budget**.
4. Name: `dfs-calculator-hard-cap`
5. Time range: `Monthly`
6. Projects: select the GCP project that holds your Gemini API key.
7. Services: leave at **All services** (simpler).
8. Amount: set a budget you're comfortable losing. For a personal
   project, $25/month is generous.
9. **Actions → Connect a Pub/Sub topic** (required for the auto-disable
   function below).
10. Follow Google's guide at
    https://cloud.google.com/billing/docs/how-to/disable-billing-with-notifications
    to wire the Pub/Sub topic into a Cloud Function that calls
    `cloudbilling.projects.updateBillingInfo` to set `billingAccountName`
    to empty string when the budget exceeds 100%. Google provides a
    ready-to-use Python sample in that doc — copy/paste it.
11. Test the wire-up by temporarily setting the budget to $0.01 and
    making a small Gemini request. Confirm billing gets disabled.
    Reset the budget to your real number.

- [ ] GCP hard cap is in place and proven to actually disable billing
      when the budget is exceeded.

---

## 2. Vercel Firewall — rate limit rule for /api/analyze (HIGH, ~3 min)

**Why:** Second line of defense against LLM10 Denial of Wallet. Even on
the Hobby tier (1 rule max), a single rate-limit rule on `/api/analyze`
cuts a volumetric abuser down to a trickle and buys you time to notice.
This complements the in-code Content-Length cap, origin check, and Zod
validation.

**Steps:**
1. Go to https://vercel.com/dashboard → your `dfs-calculator` project.
2. Settings → **Firewall** → **Custom Rules** → **New Rule**.
3. Name: `analyze-rate-limit`
4. Condition: `Path` equals `/api/analyze`
5. Action: `Rate Limit`
6. Algorithm: `Fixed Window`
7. Threshold: `30` requests per `60` seconds per `IP`
8. Action after threshold: `Deny (429)`
9. Save. It takes effect within ~60s of saving.
10. Test: `for i in {1..40}; do curl -X POST https://<your-url>/api/analyze -d '{}' -H 'content-type: application/json'; done` — after ~30 calls you should start seeing 429s.

- [ ] Vercel Firewall rate-limit rule is saved and verified with a
      curl loop.

---

## 3. Supabase — apply RLS migration 003 (CRITICAL, ~2 min)

**Why:** Without this, the Supabase anon key has full read/write access
to every table via the legacy `using(true)` policies shipped in
`schema.sql`. Migration 003 drops those, enables default-deny, and forces
RLS even for table owners. After this, the service_role key held only in
`.env.local` / Vercel is the ONLY way to access the data.

**Steps:**
1. Go to https://supabase.com/dashboard → your project → **SQL Editor**.
2. Click **New query**.
3. Open `supabase/migrations/003_enable_rls.sql` from the repo.
4. Copy the entire file into the SQL Editor.
5. Click **Run** (or Ctrl/Cmd+Enter).
6. Verify with the query at the bottom of the file — every table should
   show `rowsecurity = true` AND `forcerowsecurity = true`, and only the
   `deny anon all on <table>` policies should remain.
7. Quick sanity check: in a new terminal, hit any REST endpoint with the
   anon key, e.g.:
   ```
   curl -H "apikey: <anon-key>" \
        -H "Authorization: Bearer <anon-key>" \
        'https://<project>.supabase.co/rest/v1/picks?limit=1'
   ```
   You should get `[]` (empty array) back — not data. That's RLS doing
   its job.

- [ ] Migration 003 applied, verification query run, anon key confirmed
      to return empty data.

---

## 4. Vercel — set SUPABASE_SERVICE_ROLE_KEY as a Sensitive env var (HIGH, ~2 min)

**Why:** The app now reads from Supabase via the service_role key (which
bypasses RLS by design). Vercel's "Sensitive" env var flag prevents the
value from being viewable in the dashboard after save, so an attacker
with read-only dashboard access can't lift the key.

**Steps:**
1. https://vercel.com/dashboard → your project → **Settings** → **Environment Variables**.
2. Find or add `SUPABASE_SERVICE_ROLE_KEY`.
3. Paste the value from your Supabase project → Settings → API → `service_role` (secret).
4. Click the **Sensitive** toggle so the eye-icon reveal is disabled.
5. Also add / verify:
   - `SUPABASE_URL` (same as your project URL, non-sensitive OK)
   - `CRON_SECRET` — generate with `openssl rand -hex 32`
   - `NEXT_PUBLIC_SITE_URL` — set to your production URL, e.g.
     `https://dfs-calculator.vercel.app`
   - `ALLOWED_ORIGINS` — leave empty unless you have previews / staging
     that need access
6. **Remove** the old `NEXT_PUBLIC_SUPABASE_URL` and
   `NEXT_PUBLIC_SUPABASE_ANON_KEY` vars — they're no longer used and
   keeping them around is an exposure of unneeded data.
7. Redeploy so the new vars take effect.

- [ ] Service role key marked Sensitive; old anon vars removed; redeploy
      succeeded.

---

## 5. GitHub — enable Push Protection (HIGH, ~1 min)

**Why:** GitHub's Push Protection uses the same secret-scanning engine
that runs on every public repo, but it runs BEFORE the push completes
and blocks the commit if a known secret pattern is detected. This is the
last line of defense against accidentally committing `.env.local` or
pasting a key into a test file.

**Steps:**
1. https://github.com/<your-user>/dfs-calculator → **Settings** → **Code security and analysis**.
2. Enable:
   - **Secret scanning** (should already be on for public repos)
   - **Push protection** → turn on
   - **Dependabot alerts** → turn on
   - **Dependabot security updates** → turn on
3. While you're there, verify **Code scanning** is set up (the
   `ci.yml` workflow runs `npm audit` and `dependency-review-action` on
   every PR — that's the code scanning path for this repo).

- [ ] Push Protection on; Dependabot alerts + security updates on.

---

## 6. Rotate any keys that may have been exposed (HIGH, varies)

**Why:** If any of the current values for the keys below have ever been
committed (even briefly), checked into a chat message, or shared with
another tool, they are considered compromised. Before the new security
controls can be trusted, the underlying secrets must be fresh.

Check `git log` for any accidental commits of `.env.local` or inline
keys. If you find even one, rotate the corresponding key.

- [ ] Anthropic (Claude) API key — rotate at https://console.anthropic.com/settings/keys
- [ ] Google Gemini API key — rotate at https://aistudio.google.com/apikey
- [ ] OpenRouter API key — rotate at https://openrouter.ai/keys
- [ ] The Odds API key — rotate by emailing support@the-odds-api.com
      (they do not currently offer self-serve rotation; request a new
      key and tell them to revoke the old one)
- [ ] Supabase service_role key — rotate at
      Project Settings → API → **Reset service_role secret**. Note: this
      will invalidate the key in Vercel immediately, so have step 4
      ready to paste the new value before clicking reset.
- [ ] CRON_SECRET — regenerate with `openssl rand -hex 32` and update in
      Vercel. Shouldn't affect anything in production because the cron
      jobs read the value at runtime.

---

## 7. Apply the seeded prompt to Supabase (MEDIUM, ~1 min)

**Why:** The `prompt_versions` table now has default-deny RLS, so the
seed script needs to run with the service_role key. If it was already
seeded before the migration, this is a no-op; if it wasn't, the app will
fall back to the minimal hard-coded prompt until you seed.

**Steps:**
1. Make sure `.env.local` has `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` set.
2. `node scripts/seed-prompt.mjs` — the script is idempotent; safe to re-run.
3. Verify: open the Supabase dashboard → **Table editor** → `prompt_versions`.
   You should see both V1 and V2 rows, with V2 marked `status='active'`.

- [ ] Prompt versions seeded; V2 is active.

---

## 8. Final smoke test

Run through the flow end-to-end to make sure nothing is broken:

- [ ] Open the deployed site in a fresh incognito window.
- [ ] Pick a couple of games in the Game Selector.
- [ ] Click **Calculate** → batch results render with tiers.
- [ ] Click **AI Analysis** → ensemble runs and returns picks.
- [ ] Open DevTools → Application → check that `sessionStorage` (NOT
      `localStorage`) holds any BYO API key you entered. Close the tab
      and reopen — the key should be gone.
- [ ] Try to hit `/api/analyze` from `curl` with `Origin: https://evil.com`
      → should return 403.
- [ ] Try to hit `/api/resolve-picks` without `Authorization: Bearer`
      → should return 401.
- [ ] Check the Supabase `picks` table with a fresh anon-key client
      → should return empty.

If any of these fail, consult `SECURITY_WORK_LOG.md` for the file that
owns the behavior and either fix forward or revert the relevant commit.

---

## Done

When every checkbox above is ticked, the DFS Calculator has the full
defense-in-depth stack described in the audit. None of the individual
controls is load-bearing alone — the strength of the system comes from
having them layered. Keep the Dependabot PRs fresh, keep `npm audit` at
zero, and revisit this checklist any time you add a new API route or
introduce a new dependency on a paid provider.
