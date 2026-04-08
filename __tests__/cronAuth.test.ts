/**
 * cronAuth.test.ts — unit tests for src/lib/cronAuth.ts
 *
 * Tests the fail-closed Bearer-token verifier used by the Vercel cron
 * routes (/api/resolve-picks, /api/snapshot-closing-lines). A regression
 * here could leave those endpoints world-callable, which is an OWASP
 * CWE-306 "Missing Authentication for Critical Function".
 *
 * Exercises:
 *   - Production fail-closed when CRON_SECRET is unset → 503
 *   - Dev allow-with-warning when CRON_SECRET is unset → null (pass)
 *   - Correct Bearer token → null (pass)
 *   - Wrong Bearer token → 401
 *   - Missing Authorization header → 401
 *   - Token with wrong length → 401 (length-equalized compare)
 *   - Malformed Authorization header (no "Bearer " prefix) → 401
 */

import type { NextRequest } from 'next/server';
import { verifyCronAuth } from '../src/lib/cronAuth';
import { setNodeEnv } from './helpers/env';

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

describe('verifyCronAuth', () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    delete process.env.CRON_SECRET;
    setNodeEnv('test');
  });

  afterAll(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('returns 503 in production when CRON_SECRET is unset', async () => {
    setNodeEnv('production');
    const res = verifyCronAuth(makeRequest({}));
    expect(res).not.toBeNull();
    expect(res?.status).toBe(503);
  });

  it('returns null (allows) in development when CRON_SECRET is unset', () => {
    // Suppress the warn() so the test output stays clean
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    setNodeEnv('development');
    const res = verifyCronAuth(makeRequest({}));
    expect(res).toBeNull();
    warnSpy.mockRestore();
  });

  it('returns null when the Authorization header matches Bearer <secret>', () => {
    setNodeEnv('production');
    process.env.CRON_SECRET = 'super-secret-value';
    const res = verifyCronAuth(
      makeRequest({ authorization: 'Bearer super-secret-value' }),
    );
    expect(res).toBeNull();
  });

  it('returns 401 when the Bearer token is wrong', () => {
    setNodeEnv('production');
    process.env.CRON_SECRET = 'super-secret-value';
    const res = verifyCronAuth(
      makeRequest({ authorization: 'Bearer wrong-secret-value' }),
    );
    expect(res).not.toBeNull();
    expect(res?.status).toBe(401);
  });

  it('returns 401 when the Authorization header is missing', () => {
    setNodeEnv('production');
    process.env.CRON_SECRET = 'super-secret-value';
    const res = verifyCronAuth(makeRequest({}));
    expect(res).not.toBeNull();
    expect(res?.status).toBe(401);
  });

  it('returns 401 when the Bearer token is the wrong length', () => {
    setNodeEnv('production');
    process.env.CRON_SECRET = 'super-secret-value';
    const res = verifyCronAuth(makeRequest({ authorization: 'Bearer short' }));
    expect(res).not.toBeNull();
    expect(res?.status).toBe(401);
  });

  it('returns 401 for a malformed Authorization header (no Bearer prefix)', () => {
    setNodeEnv('production');
    process.env.CRON_SECRET = 'super-secret-value';
    const res = verifyCronAuth(
      makeRequest({ authorization: 'super-secret-value' }),
    );
    expect(res).not.toBeNull();
    expect(res?.status).toBe(401);
  });

  it('returns 401 for a token that starts with the right characters but differs later', () => {
    setNodeEnv('production');
    process.env.CRON_SECRET = 'super-secret-value';
    const res = verifyCronAuth(
      makeRequest({ authorization: 'Bearer super-secret-valuX' }),
    );
    expect(res).not.toBeNull();
    expect(res?.status).toBe(401);
  });
});
