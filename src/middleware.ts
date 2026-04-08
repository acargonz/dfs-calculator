/**
 * Edge middleware — runs on every request before the route handler.
 *
 * Responsibilities:
 *   1. Generate a fresh Content-Security-Policy nonce per request.
 *   2. Attach that nonce to both the request headers (so Server Components
 *      can read it via `headers().get('x-nonce')` and forward it to any
 *      inline <script> they render) AND the response `Content-Security-Policy`
 *      header so the browser only runs scripts tagged with that nonce.
 *
 * Why middleware (not next.config.js headers)?
 *   - CSP nonces MUST be unique per response. `next.config.js` headers are
 *     static — they'd be the same value on every request, which defeats
 *     the purpose of a nonce (attacker could just copy it).
 *   - Middleware runs in the Edge runtime on every request, so we can
 *     generate `crypto.randomUUID()` per request at near-zero cost.
 *
 * Source: https://nextjs.org/docs/app/guides/content-security-policy
 *
 * Design notes:
 *   - The CSP below is intentionally STRICT ('self' only for most sources)
 *     because the DFS Calculator doesn't embed third-party widgets or
 *     iframes. If you add Stripe / YouTube / etc. later you'll need to
 *     allow those hosts explicitly.
 *   - `strict-dynamic` lets Next.js's own chunk loader work without us
 *     having to enumerate every webpack-generated script URL. Any script
 *     loaded by a nonce-tagged parent inherits the trust.
 *   - `unsafe-inline` is present in style-src because Tailwind v4 + Next
 *     use inline style attributes for CSS-in-JS transitions. That's the
 *     standard trade-off; most hardening guides accept it.
 *   - `connect-src` includes all the hostnames we fetch from server-side
 *     (the browser never hits these directly, but CSP is enforced on the
 *     browser, so any server-to-client redirect would need them allowed).
 */

import { NextResponse, type NextRequest } from 'next/server';

const isDev = process.env.NODE_ENV !== 'production';

export function middleware(request: NextRequest) {
  // Fresh per-request nonce. Base64 encoding matches Next.js's documented
  // pattern for `<script nonce>`. randomUUID has ~122 bits of entropy which
  // is plenty — attackers can't guess the nonce and therefore can't inject
  // a script that passes CSP.
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');

  const cspDirectives = [
    `default-src 'self'`,
    // script-src: the nonce gates inline <script>; strict-dynamic lets Next
    // webpack chunks loaded from a nonce'd parent script run freely.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' ${isDev ? "'unsafe-eval'" : ''}`.trim(),
    // style-src: Tailwind + Next inject inline styles; we accept that cost.
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' blob: data:`,
    `font-src 'self' data:`,
    // connect-src: fetch destinations from the browser. Our API is same-
    // origin, and we don't do any cross-origin XHR today — lock it to self.
    `connect-src 'self'`,
    `frame-ancestors 'none'`,
    `form-action 'self'`,
    `base-uri 'self'`,
    `object-src 'none'`,
    // upgrade-insecure-requests prevents any stray http:// URL from being
    // fetched without upgrading to https — cheap defense-in-depth.
    `upgrade-insecure-requests`,
  ];
  // Clean up double-spaces that show up when the unsafe-eval ternary is off.
  const cspValue = cspDirectives.join('; ').replace(/\s+/g, ' ').trim();

  // Forward the nonce + CSP value to Server Components via request headers.
  // They can read these via `headers()` and attach the nonce to any <script>.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('content-security-policy', cspValue);

  const response = NextResponse.next({
    request: { headers: requestHeaders },
  });
  response.headers.set('content-security-policy', cspValue);
  return response;
}

/**
 * Match every path except Next.js internals and static assets. We can't
 * usefully CSP-protect the webpack chunk files themselves (they're served
 * from /_next) and adding headers there just bloats the response.
 *
 * Matcher syntax reference:
 *   https://nextjs.org/docs/app/building-your-application/routing/middleware#matcher
 */
export const config = {
  matcher: [
    {
      source:
        '/((?!api/|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
