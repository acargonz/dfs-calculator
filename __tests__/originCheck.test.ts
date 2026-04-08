/**
 * originCheck.test.ts — unit tests for src/lib/originCheck.ts
 *
 * The origin check is the first gate on /api/analyze and a few other
 * mutation routes. It's a cheap CSRF / hot-link shield; when it breaks,
 * an `<img src="/api/analyze" />` on a malicious page could burn provider
 * tokens for any logged-in user (OWASP API8:2023 Security Misconfiguration).
 *
 * These tests run in the jest node environment so they can mutate
 * process.env freely and construct fake NextRequest objects without
 * spinning up Next itself.
 */

import type { NextRequest } from 'next/server';
import { isAllowedOrigin } from '../src/lib/originCheck';

/** Build a fake NextRequest with only the headers we care about. */
function makeRequest(headers: Record<string, string>): NextRequest {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return {
    headers: {
      get(name: string): string | null {
        return lower[name.toLowerCase()] ?? null;
      },
    },
  } as unknown as NextRequest;
}

describe('isAllowedOrigin', () => {
  // Snapshot + restore env between tests so one test's config can't
  // leak into the next.
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    // Start each test with a clean slate — explicitly unset the vars
    // the origin check reads.
    delete process.env.NEXT_PUBLIC_SITE_URL;
    delete process.env.ALLOWED_ORIGINS;
    delete process.env.VERCEL_URL;
    process.env.NODE_ENV = 'test';
  });

  afterAll(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('fails closed when the allowlist is empty in production', () => {
    process.env.NODE_ENV = 'production';
    const req = makeRequest({ origin: 'https://example.com' });
    expect(isAllowedOrigin(req)).toBe(false);
  });

  it('allows localhost in development even without NEXT_PUBLIC_SITE_URL', () => {
    process.env.NODE_ENV = 'development';
    const req = makeRequest({ origin: 'http://localhost:3000' });
    expect(isAllowedOrigin(req)).toBe(true);
  });

  it('allows a request whose Origin matches NEXT_PUBLIC_SITE_URL', () => {
    process.env.NEXT_PUBLIC_SITE_URL = 'https://dfs-calculator.example.com';
    const req = makeRequest({ origin: 'https://dfs-calculator.example.com' });
    expect(isAllowedOrigin(req)).toBe(true);
  });

  it('allows a request whose Origin matches NEXT_PUBLIC_SITE_URL with trailing slash', () => {
    process.env.NEXT_PUBLIC_SITE_URL = 'https://dfs-calculator.example.com/';
    const req = makeRequest({ origin: 'https://dfs-calculator.example.com' });
    expect(isAllowedOrigin(req)).toBe(true);
  });

  it('rejects a request from a different origin', () => {
    process.env.NEXT_PUBLIC_SITE_URL = 'https://dfs-calculator.example.com';
    const req = makeRequest({ origin: 'https://evil.com' });
    expect(isAllowedOrigin(req)).toBe(false);
  });

  it('allows a request whose Referer (but not Origin) matches', () => {
    process.env.NEXT_PUBLIC_SITE_URL = 'https://dfs-calculator.example.com';
    const req = makeRequest({
      referer: 'https://dfs-calculator.example.com/calc',
    });
    expect(isAllowedOrigin(req)).toBe(true);
  });

  it('rejects a request with neither Origin nor Referer', () => {
    process.env.NEXT_PUBLIC_SITE_URL = 'https://dfs-calculator.example.com';
    const req = makeRequest({});
    expect(isAllowedOrigin(req)).toBe(false);
  });

  it('allows an origin from ALLOWED_ORIGINS (comma-separated)', () => {
    process.env.NEXT_PUBLIC_SITE_URL = 'https://main.example.com';
    process.env.ALLOWED_ORIGINS =
      'https://staging.example.com, https://preview.example.com';
    const req = makeRequest({ origin: 'https://preview.example.com' });
    expect(isAllowedOrigin(req)).toBe(true);
  });

  it('allows an origin matching the runtime VERCEL_URL', () => {
    process.env.VERCEL_URL = 'dfs-preview-abc123.vercel.app';
    const req = makeRequest({
      origin: 'https://dfs-preview-abc123.vercel.app',
    });
    expect(isAllowedOrigin(req)).toBe(true);
  });

  it('rejects a substring-match attempt (must be prefix + /)', () => {
    process.env.NEXT_PUBLIC_SITE_URL = 'https://dfs-calculator.example.com';
    // Attempting to fool the check with a lookalike subdomain
    const req = makeRequest({
      origin: 'https://dfs-calculator.example.com.evil.com',
    });
    expect(isAllowedOrigin(req)).toBe(false);
  });

  it('rejects an origin that is a prefix of the allowed one', () => {
    process.env.NEXT_PUBLIC_SITE_URL = 'https://dfs-calculator.example.com';
    const req = makeRequest({ origin: 'https://dfs-calculator.example' });
    expect(isAllowedOrigin(req)).toBe(false);
  });
});
