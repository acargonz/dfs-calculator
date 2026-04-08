// Origin + Referer header verification for mutation routes.
//
// Purpose:
//   Acts as a cheap CSRF / hot-link shield for the /api/analyze route,
//   which uses the server-side Gemini / Claude / OpenRouter keys and is
//   the #1 "denial of wallet" target (OWASP LLM10:2025). A plain browser
//   request from evil.com to https://our-app.vercel.app/api/analyze will
//   always carry an `Origin` header set to `https://evil.com`, so a
//   strict allowlist here is enough to stop most automated abuse without
//   introducing a dependency on Redis / a token store.
//
// Why not just use a WAF rule?
//   We do both. The Vercel Firewall rule (configured in the dashboard)
//   is the 1st line of defense but Hobby tier caps us at 1 rule total.
//   This check runs AFTER the WAF rule and costs ~0.1ms, so layering
//   gives us "belt + suspenders" for the same per-request time budget.
//
// Threat model:
//   - A browser-based CSRF attack: blocked because `Origin` will be the
//     attacker site (never our allowlist).
//   - A curl/script from an attacker: NOT blocked by this alone (Origin
//     can be spoofed). That's what the GCP billing cap + Vercel WAF
//     rate limit are for. This check exists specifically to close the
//     "honest browser" attack vector, which is the majority of the
//     drive-by LLM-quota-burning attempts we'd see on a public endpoint.
//
// Dev mode:
//   When NODE_ENV !== 'production' we still enforce the check but include
//   localhost variants in the allowlist so `npm run dev` keeps working.
//
// Customisation:
//   Set NEXT_PUBLIC_SITE_URL to your primary deployed origin. Additional
//   origins can be added via ALLOWED_ORIGINS (comma-separated).

import type { NextRequest } from 'next/server';

function getAllowlist(): string[] {
  const primary = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  const extras = (process.env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const list: string[] = [];
  if (primary) list.push(primary.replace(/\/$/, ''));
  for (const e of extras) list.push(e.replace(/\/$/, ''));

  // Always allow the per-deployment Vercel URL (captured at runtime).
  // VERCEL_URL is set automatically by the Vercel platform; it is the
  // current deployment's bare hostname (no scheme), so we prefix https://.
  const vercelUrl = process.env.VERCEL_URL?.trim();
  if (vercelUrl) list.push(`https://${vercelUrl}`);

  return list;
}

/**
 * Detects whether a URL string is a localhost / 127.0.0.1 / [::1] origin
 * regardless of port. Used by the dev-mode bypass below so a developer
 * running on a non-3000 port (Next.js auto-picks when 3000 is busy)
 * doesn't get blocked. The check is intentionally lenient — it ONLY
 * runs in dev mode, and dev mode is never exposed to the public internet.
 */
function isLocalhostOrigin(value: string): boolean {
  if (!value) return false;
  try {
    const u = new URL(value);
    return (
      u.hostname === 'localhost' ||
      u.hostname === '127.0.0.1' ||
      u.hostname === '[::1]' ||
      u.hostname === '::1'
    );
  } catch {
    return false;
  }
}

/**
 * Returns true if the request's Origin header matches the allowlist.
 * Accepts same-origin requests (which may omit Origin — in that case we
 * fall back to checking Referer, which the browser always sets for
 * fetch()/XHR inside a page).
 *
 * The comparison is strict "starts with" — subdomain scoping like
 * `preview-foo.vercel.app` must be added explicitly to ALLOWED_ORIGINS.
 *
 * Dev mode (`NODE_ENV !== 'production'`) bypasses the allowlist for
 * localhost / 127.0.0.1 / [::1] regardless of port. This is safe because
 * dev mode never serves external traffic, and hardcoding port 3000
 * previously broke whenever Next.js auto-picked a different port.
 */
export function isAllowedOrigin(request: NextRequest): boolean {
  const origin = request.headers.get('origin') ?? '';
  const referer = request.headers.get('referer') ?? '';

  // Dev bypass: any localhost origin/referer passes regardless of port.
  if (process.env.NODE_ENV !== 'production') {
    if (isLocalhostOrigin(origin) || isLocalhostOrigin(referer)) return true;
  }

  const allowlist = getAllowlist();

  // Empty allowlist = fail-closed. Protects against "oh we forgot to set
  // NEXT_PUBLIC_SITE_URL in production" misconfiguration.
  if (allowlist.length === 0) return false;

  const matchesOrigin =
    origin.length > 0 && allowlist.some((o) => origin === o || origin.startsWith(`${o}/`));
  const matchesReferer =
    referer.length > 0 && allowlist.some((o) => referer === o || referer.startsWith(`${o}/`));

  // EITHER a matching Origin OR a matching Referer is enough. Some
  // privacy-preserving browsers strip Origin on same-origin POSTs; Referer
  // is the backstop. We never accept a request that has neither header.
  return matchesOrigin || matchesReferer;
}
