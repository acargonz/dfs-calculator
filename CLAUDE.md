# CLAUDE.md — DFS Calculator

`AGENTS.md` holds full project context, math pipeline, and calibration data.
**Read it on demand, not preemptively** — see *Context discipline* below.

## Tech Stack
Next.js 15 (App Router) · TypeScript strict · React 19 · Tailwind v4 · Jest 29 · Supabase (optional) · Node 18+
APIs: The Odds API, PBP Stats, balldontlie.io, ESPN, Gemini/Claude

## Commands
```bash
npm test             # Run all tests
npm run build        # Production build — catches type errors
npm run dev          # Dev server at http://localhost:3000
npm audit            # Should show 0 vulnerabilities
```

## Workflow Rules
1. **Read AGENTS.md** only when the task warrants it.
2. **Plan before coding.** State what you will change and why.
3. **One small task at a time.** One function or one component per change.
4. **Run `npm test` after every change.** Fix failures before moving on.
5. **Never delete or weaken a test** to make code pass. Fix the code.
6. **Math is read-only** unless the user explicitly asks for math changes.
7. **UI changes don't touch math.** Math changes don't touch UI.

## Context discipline (avoid the "prompt too long" error)
Static context (this file, MEMORY.md) is small. The bloat comes from
accumulated tool results during a session. Apply these rules:
- **Don't `Read` whole files just to "get oriented".** Wait until you need them.
- **Use `Grep`/`Glob` first.** Only `Read` the matched range.
- **For large files, use `offset`/`limit`** to grab the relevant slice.
- **Don't re-read** files already shown earlier in the conversation.
- **Prefer `files_with_matches` mode** over `content` for scanning — pull content only after narrowing the file list.
- **Architecture, file paths, and the component tree** are derivable from the codebase. Don't memorize them — `Glob` when needed.
- **For multi-file exploration or deep research, delegate to the `Explore` subagent** (`Agent` tool, `subagent_type=Explore`). Subagents run in their own context — only their summary returns to the main session, so their read history never bloats yours. This is the structural fix for "I had to read 30 files to answer one question."

## Pre-commit self-review (enforced by hook)
Every `git commit` Bash call is intercepted by
`.claude/hooks/pre-commit-review.mjs` and **blocked** unless the commit
message body contains the marker:

```
Reviewed-by: claude-self-review
```

When the hook fires:
1. Run the `/simplify` skill on the staged changes (reviews for sloppy
   code, dead branches, over-engineering, premature abstraction).
2. Address anything it finds.
3. Retry the commit with the marker added to the message body, e.g.:
   ```
   git commit -m "$(cat <<'EOF'
   fix: handle null player stats

   Reviewed-by: claude-self-review
   EOF
   )"
   ```

Never add the marker without actually running the review — it is a
*promise* that you ran it, not a bypass token.

## Session continuity (`.claude/WIP.md`)
A SessionStart hook (`.claude/hooks/load-wip.mjs`) auto-injects the contents
of `.claude/WIP.md` into every new session, so work resumes cleanly after
`/clear`. **Maintain it.** Update `.claude/WIP.md` at natural milestones —
after a task completes, before long pauses, when switching context, or when
the user says "save where we are." Keep it brief and actionable: what we're
doing, status checklist, next concrete action, open questions, dated. The
file itself shows the format. Always verify the snapshot against `git status`
and recent commits before continuing — it may be stale if work happened
outside Claude Code.

## Environment Variables
The full list lives in `.env.local.example`. Read that file when you need
it instead of duplicating it here. Server-only keys must never be prefixed
with `NEXT_PUBLIC_`.

## Deploy / Supabase setup
Full procedural runbook lives in `DEPLOY.md` (pre-flight, migrations,
cron secret, Vercel setup, smoke tests, rollback). Read it on demand.
The post-deploy security checklist lives in
`SECURITY_DEPLOYMENT_CHECKLIST.md`.

## Security model — quick gotchas
Full inventory in `SECURITY.md` and `SECURITY_WORK_LOG.md`. Never violate:
- **Never** import `aiAnalysis.ts`, `promptVersions.ts`, `supabaseAdmin.ts`,
  `cronAuth.ts`, or `schemas.ts` from a Client Component. They're
  `import 'server-only'` and the build will fail. Use `aiTypes.ts` for
  client-safe shared types.
- **All** API route bodies use Zod validators from `src/lib/schemas.ts`.
  New route → new schema.
- **BYO API keys** live in `sessionStorage` (tab-scoped). Don't revert to
  `localStorage`.
- **Error responses** must use `internalError(err, scope)` from
  `apiErrors.ts`. Never `NextResponse.json({ error: err.message })`.
- **Cron routes** must call `verifyCronAuth(request)` at the top.
  Never write `if (cronSecret) { ... }` — that's a fail-open bug.
