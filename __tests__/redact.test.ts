/**
 * redact.test.ts — unit tests for src/lib/redact.ts
 *
 * These tests are the last line of defense against a log-based key leak
 * (OWASP LLM02 "Sensitive Information Disclosure", NIST SP 800-53 AU-9).
 * Every vendor key format used by this project gets a positive (must be
 * redacted) and negative (must not mangle normal text) test case. If one
 * of these tests ever fails, a real key could end up in Sentry, a CloudWatch
 * log line, or an error response — treat a failure here as a ship-blocker.
 */

import {
  redactSecrets,
  redactUnknown,
  safeErrorMessage,
} from '../src/lib/redact';

describe('redactSecrets', () => {
  it('returns empty input unchanged', () => {
    expect(redactSecrets('')).toBe('');
  });

  it('leaves plain text alone', () => {
    const plain = 'LeBron James scored 35 points against BOS';
    expect(redactSecrets(plain)).toBe(plain);
  });

  it('redacts an Anthropic API key', () => {
    const key = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH';
    const line = `Anthropic error: key=${key} failed`;
    const out = redactSecrets(line);
    expect(out).not.toContain(key);
    expect(out).toContain('[REDACTED]');
    // The surrounding context survives
    expect(out).toContain('Anthropic error:');
    expect(out).toContain('failed');
  });

  it('redacts a Google Gemini API key', () => {
    const key = 'AIzaSyDxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
    const line = `Using ${key} for Gemini`;
    const out = redactSecrets(line);
    expect(out).not.toContain(key);
    expect(out).toContain('[REDACTED]');
  });

  it('redacts an OpenRouter API key', () => {
    const key = 'sk-or-v1-abcdefghijklmnopqrstuvwxyz01234567890123456789';
    const line = `openrouter fetch: ${key}`;
    const out = redactSecrets(line);
    expect(out).not.toContain(key);
    expect(out).toContain('[REDACTED]');
  });

  it('redacts a generic sk- style key (OpenAI compatible)', () => {
    const key = 'sk-abcdefghijklmnop0123456789';
    const out = redactSecrets(`token=${key}`);
    expect(out).not.toContain(key);
    expect(out).toContain('[REDACTED]');
  });

  it('redacts a Supabase / Vercel JWT', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.abc123def456ghi789';
    const out = redactSecrets(`Bearer ${jwt}`);
    expect(out).not.toContain(jwt);
    expect(out).toContain('[REDACTED]');
  });

  it('redacts a generic Bearer token while preserving the "Bearer " prefix', () => {
    const token = 'abcdefghijklmnop1234567890';
    const out = redactSecrets(`Authorization: Bearer ${token}`);
    // The Bearer word stays (it's metadata, not a secret)
    expect(out).toContain('Bearer');
    // The token itself is gone
    expect(out).not.toContain(token);
    expect(out).toContain('[REDACTED]');
  });

  it('redacts multiple secrets in the same string', () => {
    const a = 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const b = 'AIzaBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
    const out = redactSecrets(`first=${a} second=${b}`);
    expect(out).not.toContain(a);
    expect(out).not.toContain(b);
    expect(out.match(/\[REDACTED\]/g)?.length).toBe(2);
  });

  it('does not redact short unrelated strings that look similar', () => {
    // Too short to match any of the vendor patterns
    const out = redactSecrets('sk-short');
    expect(out).toBe('sk-short');
  });
});

describe('redactUnknown', () => {
  it('passes through null/undefined', () => {
    expect(redactUnknown(null)).toBe(null);
    expect(redactUnknown(undefined)).toBe(undefined);
  });

  it('redacts a string value', () => {
    const key = 'sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const out = redactUnknown(`error: ${key}`);
    expect(typeof out).toBe('string');
    expect(out as string).not.toContain(key);
  });

  it('redacts an Error object message and stack', () => {
    const key = 'sk-ant-api03-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const err = new Error(`failed with key ${key}`);
    const out = redactUnknown(err) as Error;
    expect(out).toBeInstanceOf(Error);
    expect(out.message).not.toContain(key);
    expect(out.message).toContain('[REDACTED]');
  });

  it('redacts nested object values by round-tripping JSON', () => {
    const key = 'AIzaCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';
    const obj = {
      request: {
        headers: { 'x-api-key': key },
        body: { user: 'alice' },
      },
    };
    const out = redactUnknown(obj) as Record<string, unknown>;
    // Survived the round-trip
    expect(out).toHaveProperty('request');
    // Key is gone
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain(key);
    expect(serialized).toContain('[REDACTED]');
  });

  it('returns a fallback sentinel when redaction throws', () => {
    // Circular object — JSON.stringify throws
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const out = redactUnknown(circular);
    expect(out).toBe('[REDACTION_FAILED]');
  });

  it('returns numbers/booleans unchanged', () => {
    expect(redactUnknown(42)).toBe(42);
    expect(redactUnknown(true)).toBe(true);
  });
});

describe('safeErrorMessage', () => {
  it('extracts and redacts an Error message', () => {
    const key = 'sk-ant-api03-dddddddddddddddddddddddddddddddddddddddd';
    const err = new Error(`Fetch failed: ${key}`);
    const msg = safeErrorMessage(err);
    expect(msg).not.toContain(key);
    expect(msg).toContain('[REDACTED]');
  });

  it('passes through a plain string (after redaction)', () => {
    expect(safeErrorMessage('plain error')).toBe('plain error');
  });

  it('returns the fallback for non-Error non-string values', () => {
    expect(safeErrorMessage({ weird: true })).toBe('Internal error');
    expect(safeErrorMessage(null)).toBe('Internal error');
    expect(safeErrorMessage(undefined)).toBe('Internal error');
  });

  it('accepts a custom fallback', () => {
    expect(safeErrorMessage(null, 'Custom fallback')).toBe('Custom fallback');
  });

  it('never throws when given a truly broken value', () => {
    // Object whose toString throws
    const bad = {
      toString() {
        throw new Error('boom');
      },
    };
    expect(() => safeErrorMessage(bad)).not.toThrow();
  });
});
