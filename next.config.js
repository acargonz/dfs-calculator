/** @type {import('next').NextConfig} */

// Security headers applied to EVERY route.
//
// Why these specific values — sources:
//   - OWASP Secure Headers Project / HTTP Headers Cheat Sheet
//   - MDN Web Docs (HSTS, CSP, COOP/COEP, Permissions-Policy)
//   - Next.js security guide (https://nextjs.org/docs/app/guides/content-security-policy)
//
// HSTS — 2 years + includeSubDomains matches Google/Vercel recommended values
// for preload eligibility. `preload` is INTENTIONALLY omitted here because
// adding your domain to the HSTS preload list is a one-way operation that
// requires manual action at https://hstspreload.org; do it only after you're
// confident every subdomain can serve HTTPS.
//
// CSP is NOT configured here. It's emitted per-request from src/middleware.ts
// because Next.js needs a unique nonce on each response for inline scripts,
// and nonces must be generated fresh for every request (per the CSP spec).
// Putting CSP here would force us to use `'unsafe-inline'` for scripts, which
// defeats the point.
const securityHeaders = [
  {
    key: 'Strict-Transport-Security',
    value: 'max-age=63072000; includeSubDomains',
  },
  {
    key: 'X-Frame-Options',
    value: 'DENY',
  },
  {
    key: 'X-Content-Type-Options',
    value: 'nosniff',
  },
  {
    key: 'Referrer-Policy',
    value: 'strict-origin-when-cross-origin',
  },
  {
    key: 'Permissions-Policy',
    value: [
      'accelerometer=()',
      'autoplay=()',
      'camera=()',
      'display-capture=()',
      'encrypted-media=()',
      'fullscreen=(self)',
      'geolocation=()',
      'gyroscope=()',
      'interest-cohort=()',
      'magnetometer=()',
      'microphone=()',
      'midi=()',
      'payment=()',
      'picture-in-picture=()',
      'publickey-credentials-get=()',
      'sync-xhr=()',
      'usb=()',
      'xr-spatial-tracking=()',
    ].join(', '),
  },
  {
    key: 'X-DNS-Prefetch-Control',
    value: 'off',
  },
  {
    key: 'X-Permitted-Cross-Domain-Policies',
    value: 'none',
  },
];

const nextConfig = {
  // Enforce React strict mode so double-invocation catches side-effect bugs.
  reactStrictMode: true,

  // Omit the `X-Powered-By: Next.js` banner. It's a free fingerprint for
  // attackers ("oh, Next.js 15 with CVE-X"), costs nothing to hide.
  poweredByHeader: false,

  async headers() {
    return [
      {
        // Apply to every path. Cron routes / API routes get them too — the
        // headers are harmless on JSON responses and protect us if someone
        // ever points a browser at /api/picks.
        source: '/(.*)',
        headers: securityHeaders,
      },
    ];
  },
};

module.exports = nextConfig;
