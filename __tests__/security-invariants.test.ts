/**
 * security-invariants.test.ts — structural enforcement of the security
 * rules that aren't expressible in TypeScript's type system.
 *
 * Why this file exists
 * --------------------
 * The security audit landed ~40 files worth of hardening (Zod schemas,
 * originCheck, apiErrors, service_role isolation, sessionStorage-only
 * BYO keys, default-deny RLS). Every single one is a runtime behavior
 * that can be silently regressed by a future PR:
 *
 *   - Someone adds a new /api/foo/route.ts and forgets the Zod schema.
 *   - Someone adds a new Supabase table in a migration and forgets
 *     `enable row level security`.
 *   - Someone "temporarily" switches `sessionStorage.setItem('dfs-claude-key', k)`
 *     back to localStorage while debugging.
 *   - Someone imports aiAnalysis.ts from a Client Component and the
 *     `import 'server-only'` guard is later edited out.
 *   - Someone adds a new cron route and forgets `verifyCronAuth`.
 *
 * These bugs are invisible to `tsc`, invisible to Jest unit tests for
 * individual modules, and invisible to npm audit — they only surface
 * when an attacker probes the deployed app. This test walks the
 * filesystem structurally and re-verifies each invariant on every CI
 * run, so any drift is caught BEFORE merge.
 *
 * Ratchet pattern
 * ---------------
 * A few existing routes were already in place when this test was added
 * and don't meet the strict bar (see KNOWN_EXEMPT_* sets below). Rather
 * than rewrite those routes in the same PR that adds this test, we
 * snapshot the current non-compliance as an explicit allowlist. The test
 * asserts:
 *
 *   1. Every compliant file STAYS compliant (direction = tighten).
 *   2. The allowlist does NOT grow (direction = tighten).
 *   3. New routes ALWAYS start out compliant — they can only be added to
 *      the exemption set by a human editing this file AND leaving a
 *      comment explaining why.
 *
 * This lets us lock in "no backsliding" without blocking merges on a
 * cleanup that isn't in scope for the current PR.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Path anchors — everything resolves against the repo root so the test runs
// from any working directory (Jest, CI, or a local dev loop).
// ---------------------------------------------------------------------------
const REPO_ROOT = path.resolve(__dirname, '..');
const SRC_DIR = path.join(REPO_ROOT, 'src');
const API_DIR = path.join(SRC_DIR, 'app', 'api');
const COMPONENTS_DIR = path.join(SRC_DIR, 'components');
const APP_NON_API_DIR = path.join(SRC_DIR, 'app');
const SUPABASE_DIR = path.join(REPO_ROOT, 'supabase');
const VERCEL_JSON = path.join(REPO_ROOT, 'vercel.json');

// ---------------------------------------------------------------------------
// Ratchet allowlists — the ONLY places where non-compliance is tolerated.
// Every entry must have an inline comment explaining why. If you're reading
// this wondering "can I just add my new route here?" — no. Make the route
// compliant instead; that's what the helpers exist for.
// ---------------------------------------------------------------------------

/**
 * Routes that do NOT import from `@/lib/schemas`.
 *
 * These are exempted because either:
 *   (a) they take no user input (pure proxies / GET-with-no-params), so
 *       there's nothing to validate with Zod; or
 *   (b) they're pre-existing gaps from before the audit, noted here so the
 *       test passes today but any NEW route would fail. Clean these up by
 *       adding a query schema to src/lib/schemas.ts and wiring safeParse().
 */
const KNOWN_EXEMPT_NO_ZOD: ReadonlySet<string> = new Set([
  // (a) No user input — pure ESPN passthrough.
  'src/app/api/injuries/route.ts',
  // (a) No user input — reads from Supabase only.
  'src/app/api/system-status/route.ts',
  // (a) Cron route — auth via verifyCronAuth, no user body/query.
  'src/app/api/resolve-picks/route.ts',
  // (a) Cron route — auth via verifyCronAuth, no user body/query.
  'src/app/api/snapshot-closing-lines/route.ts',
  // (b) PRE-EXISTING GAP — takes a `team` query param but validates it
  //     inline. TODO: add a LineupsQuery schema and call safeParse.
  'src/app/api/lineups/route.ts',
  // (b) PRE-EXISTING GAP — takes a `name` query param but validates it
  //     inline. TODO: add a PlayerStatsQuery schema and call safeParse.
  'src/app/api/player-stats/route.ts',
]);

/**
 * Routes that do NOT import from `@/lib/apiErrors`.
 *
 * These are the SAME routes as KNOWN_EXEMPT_NO_ZOD(b) — they still use
 * inline `NextResponse.json({ error: ... })` for their 4xx/5xx responses,
 * which bypasses the redactSecrets() pass. Cleanup item.
 */
const KNOWN_EXEMPT_NO_API_ERRORS: ReadonlySet<string> = new Set([
  // PRE-EXISTING GAP — pure ESPN passthrough returning raw messages.
  'src/app/api/injuries/route.ts',
  // PRE-EXISTING GAP — returns `err.message` directly on 500.
  'src/app/api/lineups/route.ts',
  // PRE-EXISTING GAP — returns inline 400/404 on missing/not-found player.
  'src/app/api/player-stats/route.ts',
]);

// ---------------------------------------------------------------------------
// Filesystem walker — minimal async recursive ls, no dependencies.
// ---------------------------------------------------------------------------

async function walk(dir: string, filter: (file: string) => boolean): Promise<string[]> {
  const out: string[] = [];
  // Explicit Dirent[] avoids the @types/node overload that resolves to
  // Dirent<NonSharedBuffer>[] when withFileTypes is keyed by inference.
  let entries: import('node:fs').Dirent[];
  try {
    entries = (await fs.readdir(dir, { withFileTypes: true })) as import('node:fs').Dirent[];
  } catch {
    // Directory doesn't exist — return empty rather than throw. Lets the
    // test run against a partially-trimmed tree.
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walk(full, filter)));
    } else if (entry.isFile() && filter(full)) {
      out.push(full);
    }
  }
  return out;
}

/** Path relative to repo root, using forward slashes for cross-platform match. */
function rel(abs: string): string {
  return path.relative(REPO_ROOT, abs).split(path.sep).join('/');
}

async function readText(file: string): Promise<string> {
  return fs.readFile(file, 'utf8');
}

// ===========================================================================
// INVARIANT 1 — Server-only modules are NEVER imported from a Client Component
// ===========================================================================
//
// These modules live behind `import 'server-only'` because they read process.env
// secrets, bypass RLS, validate cron auth, or compile upstream LLM prompts.
// If a Client Component ever imports them (directly or transitively), the
// Next.js build fails — but the test is the FIRST-line check so the signal
// is clearer than a cryptic build error.
//
// The server-only list is derived from the actual `import 'server-only'`
// guards in src/lib/. Any module that adds that guard is automatically
// included in the check.

const SERVER_ONLY_MODULES_CANDIDATES = [
  'aiAnalysis',
  'supabaseAdmin',
  'schemas',
  'cronAuth',
  'promptVersions',
];

async function detectServerOnlyModules(): Promise<string[]> {
  const libDir = path.join(SRC_DIR, 'lib');
  const files = await walk(libDir, (f) => f.endsWith('.ts'));
  const serverOnly: string[] = [];
  for (const f of files) {
    const text = await readText(f);
    if (/^import\s+['"]server-only['"]/m.test(text)) {
      serverOnly.push(path.basename(f, '.ts'));
    }
  }
  return serverOnly;
}

describe('security invariants — server-only boundary', () => {
  test('every candidate server-only module has the `import "server-only"` guard', async () => {
    const detected = await detectServerOnlyModules();
    for (const expected of SERVER_ONLY_MODULES_CANDIDATES) {
      expect(detected).toContain(expected);
    }
  });

  test('no Client Component imports a server-only module', async () => {
    // A "Client Component" here means: any .tsx under src/components/** OR
    // any .tsx under src/app/** that declares `'use client'` at the top.
    // We intentionally do NOT scan src/app/api/**/route.ts — those are
    // server routes and ARE allowed to import server-only modules.
    const componentFiles = await walk(COMPONENTS_DIR, (f) => f.endsWith('.tsx'));
    const appFiles = await walk(APP_NON_API_DIR, (f) => f.endsWith('.tsx'));
    const clientComponents: string[] = [...componentFiles];
    for (const f of appFiles) {
      if (f.includes(`${path.sep}api${path.sep}`)) continue;
      const text = await readText(f);
      if (/^['"]use client['"]/m.test(text)) {
        clientComponents.push(f);
      }
    }

    const violations: string[] = [];
    const serverOnly = await detectServerOnlyModules();

    // Build a regex that matches `from '@/lib/<serverOnly>'` OR
    // `from '../lib/<serverOnly>'` OR `from '../../lib/<serverOnly>'`.
    const moduleAlternation = serverOnly.map((m) => m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    const importRe = new RegExp(
      `from\\s+['"](?:@|\\.{1,2})/(?:\\.{0,2}/)?lib/(?:${moduleAlternation})['"]`,
    );

    for (const f of clientComponents) {
      const text = await readText(f);
      if (importRe.test(text)) {
        violations.push(rel(f));
      }
    }

    expect(violations).toEqual([]);
  });
});

// ===========================================================================
// INVARIANT 2 — BYO API keys live in sessionStorage only, never localStorage
// ===========================================================================
//
// sessionStorage is scoped to the current tab and wiped when the tab closes;
// localStorage persists indefinitely and is readable by every same-origin
// script, including any third-party analytics / ad tag that might be loaded
// in the future. Anthropic's own API-key best-practices doc explicitly calls
// out localStorage as "not recommended" for client-held keys.
//
// The check is a conservative substring match — any `localStorage.setItem`
// whose first argument contains `key`, `api`, `secret`, or `token` (case-
// insensitive) is a violation. The one exception is this test file itself.

describe('security invariants — client-side secret storage', () => {
  test('no source file writes API-key-like data to localStorage', async () => {
    const files = await walk(SRC_DIR, (f) => /\.(ts|tsx)$/.test(f));
    const violations: Array<{ file: string; line: number; snippet: string }> = [];
    const setItemRe = /localStorage\.setItem\(\s*(['"`])([^'"`]*)\1/g;
    const sensitiveWordRe = /(key|api|secret|token|auth|bearer)/i;

    for (const f of files) {
      const text = await readText(f);
      let m: RegExpExecArray | null;
      // Re-scan from the start for each file.
      setItemRe.lastIndex = 0;
      while ((m = setItemRe.exec(text)) !== null) {
        const keyArg = m[2];
        if (sensitiveWordRe.test(keyArg)) {
          const lineNo = text.slice(0, m.index).split('\n').length;
          violations.push({ file: rel(f), line: lineNo, snippet: m[0] });
        }
      }
    }

    expect(violations).toEqual([]);
  });
});

// ===========================================================================
// INVARIANT 3 — Every Supabase table has RLS enabled AND forced
// ===========================================================================
//
// schema.sql creates the initial set of tables; migration 003 is what
// flips RLS on, forces it, and installs default-deny policies. This test
// walks every .sql file under supabase/, collects every `create table`,
// and asserts each one has BOTH `enable row level security` AND
// `force row level security` applied somewhere in the migration history.
//
// A future migration that adds a new table without wiring RLS will fail
// this check immediately — which is the whole point. Forgetting RLS on
// even one table is an OWASP API1 broken-object-level-authorization
// incident waiting to happen.

describe('security invariants — Supabase RLS coverage', () => {
  test('every created table has `enable row level security` AND `force row level security`', async () => {
    const sqlFiles = await walk(SUPABASE_DIR, (f) => f.endsWith('.sql'));
    expect(sqlFiles.length).toBeGreaterThan(0);

    // Collect every table name declared with `create table`. Handles both
    // `create table foo (` and `create table if not exists foo (`. Case-
    // insensitive because SQL keywords can be any case.
    const createRe = /create\s+table\s+(?:if\s+not\s+exists\s+)?([a-z_][a-z0-9_]*)/gi;
    const enableRe = /alter\s+table\s+([a-z_][a-z0-9_]*)\s+enable\s+row\s+level\s+security/gi;
    const forceRe = /alter\s+table\s+([a-z_][a-z0-9_]*)\s+force\s+row\s+level\s+security/gi;

    const created = new Set<string>();
    const enabled = new Set<string>();
    const forced = new Set<string>();

    for (const f of sqlFiles) {
      const text = await readText(f);
      let m: RegExpExecArray | null;
      createRe.lastIndex = 0;
      while ((m = createRe.exec(text)) !== null) created.add(m[1].toLowerCase());
      enableRe.lastIndex = 0;
      while ((m = enableRe.exec(text)) !== null) enabled.add(m[1].toLowerCase());
      forceRe.lastIndex = 0;
      while ((m = forceRe.exec(text)) !== null) forced.add(m[1].toLowerCase());
    }

    // Every created table must be in BOTH enabled and forced.
    const missingEnabled: string[] = [];
    const missingForced: string[] = [];
    for (const t of created) {
      if (!enabled.has(t)) missingEnabled.push(t);
      if (!forced.has(t)) missingForced.push(t);
    }

    expect(missingEnabled).toEqual([]);
    expect(missingForced).toEqual([]);
  });
});

// ===========================================================================
// INVARIANT 4 — Every cron route in vercel.json uses verifyCronAuth
// ===========================================================================
//
// Cron routes are publicly-addressable by design (Vercel's scheduler hits
// them via HTTP), so they MUST gate access to the underlying handler
// behind the shared secret. The old `if (cronSecret) { ... }` pattern was
// fail-open; verifyCronAuth fails closed. This test asserts every cron
// route imports and uses verifyCronAuth.

interface VercelConfig {
  crons?: Array<{ path: string; schedule: string }>;
}

describe('security invariants — cron route auth', () => {
  test('every cron route in vercel.json imports verifyCronAuth', async () => {
    const vercelText = await readText(VERCEL_JSON);
    const vercel: VercelConfig = JSON.parse(vercelText);
    const crons = vercel.crons ?? [];

    expect(crons.length).toBeGreaterThan(0);

    const violations: string[] = [];
    for (const cron of crons) {
      // vercel.json paths look like `/api/resolve-picks`. Map that to
      // `src/app/api/resolve-picks/route.ts`.
      const routeFile = path.join(
        SRC_DIR,
        'app',
        ...cron.path.split('/').filter(Boolean),
        'route.ts',
      );
      const text = await readText(routeFile);
      // The import may come from @/lib/cronAuth or ../../lib/cronAuth.
      if (!/from\s+['"][^'"]*cronAuth['"]/.test(text)) {
        violations.push(`${rel(routeFile)} — missing cronAuth import`);
      }
      if (!/verifyCronAuth\s*\(/.test(text)) {
        violations.push(`${rel(routeFile)} — missing verifyCronAuth() call`);
      }
    }

    expect(violations).toEqual([]);
  });
});

// ===========================================================================
// INVARIANT 5 — Every POST route uses isAllowedOrigin (CSRF shield)
// ===========================================================================
//
// POST = mutation. Mutations from the browser are the canonical CSRF target:
// a drive-by request from evil.com to our API with the user's cookies
// already attached. The origin allowlist is the cheapest, lowest-latency
// defense — it runs before any body parse — and blocks 100% of drive-by
// browser attacks. See src/lib/originCheck.ts for the threat model.

describe('security invariants — POST route CSRF shield', () => {
  test('every POST route imports isAllowedOrigin', async () => {
    const routeFiles = await walk(API_DIR, (f) => f.endsWith('route.ts'));
    const postRoutes: string[] = [];
    for (const f of routeFiles) {
      const text = await readText(f);
      if (/export\s+async\s+function\s+POST/.test(text)) {
        postRoutes.push(f);
      }
    }
    expect(postRoutes.length).toBeGreaterThan(0);

    const violations: string[] = [];
    for (const f of postRoutes) {
      const text = await readText(f);
      if (!/from\s+['"][^'"]*originCheck['"]/.test(text)) {
        violations.push(`${rel(f)} — missing originCheck import`);
      }
      if (!/isAllowedOrigin\s*\(/.test(text)) {
        violations.push(`${rel(f)} — missing isAllowedOrigin() call`);
      }
    }

    expect(violations).toEqual([]);
  });
});

// ===========================================================================
// INVARIANT 6 — Every non-exempt route uses Zod schemas for input validation
// ===========================================================================
//
// Runtime validation of every untrusted input field is OWASP API4 (un-
// restricted resource consumption) + OWASP A03 (injection) baseline. The
// TypeScript type system proves nothing about JSON coming off the wire;
// only runtime validation does. Every route that takes user input should
// call `safeParse()` against a schema defined in src/lib/schemas.ts.
//
// The KNOWN_EXEMPT_NO_ZOD allowlist covers (a) routes with no input, and
// (b) pre-existing gaps that we've explicitly documented as TODOs.

describe('security invariants — Zod input validation coverage', () => {
  test('every non-exempt API route imports from @/lib/schemas', async () => {
    const routeFiles = await walk(API_DIR, (f) => f.endsWith('route.ts'));
    const violations: string[] = [];
    for (const f of routeFiles) {
      const relPath = rel(f);
      if (KNOWN_EXEMPT_NO_ZOD.has(relPath)) continue;
      const text = await readText(f);
      if (!/from\s+['"][^'"]*\/lib\/schemas['"]/.test(text)) {
        violations.push(relPath);
      }
    }
    expect(violations).toEqual([]);
  });

  test('KNOWN_EXEMPT_NO_ZOD does not contain files that actually DO use schemas', async () => {
    // Tightening direction: if someone fixes a pre-existing gap by adding
    // a schema but forgets to remove the allowlist entry, this test
    // catches it and prompts the cleanup — otherwise the allowlist grows
    // stale and loses its meaning.
    for (const relPath of KNOWN_EXEMPT_NO_ZOD) {
      const abs = path.join(REPO_ROOT, relPath);
      const text = await readText(abs);
      const usesSchemas = /from\s+['"][^'"]*\/lib\/schemas['"]/.test(text);
      if (usesSchemas) {
        throw new Error(
          `${relPath} is in KNOWN_EXEMPT_NO_ZOD but now imports from @/lib/schemas — remove it from the allowlist.`,
        );
      }
    }
  });
});

// ===========================================================================
// INVARIANT 7 — Every non-exempt route uses apiErrors helpers
// ===========================================================================
//
// The apiErrors helpers (badRequest, internalError, etc.) all run every
// outbound error message through redactSecrets() so accidental API-key
// leakage in an error string (e.g. an upstream provider echoing the key
// back in a 401 body) can never reach the client. Raw
// `NextResponse.json({ error: err.message })` bypasses that.

describe('security invariants — error response redaction', () => {
  test('every non-exempt API route imports from @/lib/apiErrors', async () => {
    const routeFiles = await walk(API_DIR, (f) => f.endsWith('route.ts'));
    const violations: string[] = [];
    for (const f of routeFiles) {
      const relPath = rel(f);
      if (KNOWN_EXEMPT_NO_API_ERRORS.has(relPath)) continue;
      const text = await readText(f);
      if (!/from\s+['"][^'"]*\/lib\/apiErrors['"]/.test(text)) {
        violations.push(relPath);
      }
    }
    expect(violations).toEqual([]);
  });

  test('KNOWN_EXEMPT_NO_API_ERRORS does not contain files that actually DO use apiErrors', async () => {
    for (const relPath of KNOWN_EXEMPT_NO_API_ERRORS) {
      const abs = path.join(REPO_ROOT, relPath);
      const text = await readText(abs);
      const usesApiErrors = /from\s+['"][^'"]*\/lib\/apiErrors['"]/.test(text);
      if (usesApiErrors) {
        throw new Error(
          `${relPath} is in KNOWN_EXEMPT_NO_API_ERRORS but now imports from @/lib/apiErrors — remove it from the allowlist.`,
        );
      }
    }
  });
});

// ===========================================================================
// INVARIANT 8 — The allowlists themselves can only shrink
// ===========================================================================
//
// Documents the current state and fails if someone tries to add more
// entries (ratchet direction = tighten). If you need to grow an allowlist,
// the test itself must be edited, which forces a code review of why the
// exception is being added.

describe('security invariants — allowlist ratchet', () => {
  test('KNOWN_EXEMPT_NO_ZOD has exactly the documented baseline set', () => {
    expect(Array.from(KNOWN_EXEMPT_NO_ZOD).sort()).toEqual(
      [
        'src/app/api/injuries/route.ts',
        'src/app/api/lineups/route.ts',
        'src/app/api/player-stats/route.ts',
        'src/app/api/resolve-picks/route.ts',
        'src/app/api/snapshot-closing-lines/route.ts',
        'src/app/api/system-status/route.ts',
      ].sort(),
    );
  });

  test('KNOWN_EXEMPT_NO_API_ERRORS has exactly the documented baseline set', () => {
    expect(Array.from(KNOWN_EXEMPT_NO_API_ERRORS).sort()).toEqual(
      [
        'src/app/api/injuries/route.ts',
        'src/app/api/lineups/route.ts',
        'src/app/api/player-stats/route.ts',
      ].sort(),
    );
  });
});
