// Standardised API error helpers — ensures every 4xx/5xx response from
// this app has the same shape, never leaks stack traces, and never echoes
// API keys or upstream error details verbatim.
//
// Design notes:
//   - Clients get a short, generic `error` string keyed to a tight enum.
//     That's all they need to show a UI message.
//   - An optional `code` discriminator lets the frontend tell "rate
//     limited" apart from "bad input" without parsing error strings.
//   - The real cause is logged server-side only, after passing through
//     redactSecrets() so accidental key leakage is impossible even if a
//     provider's error message contained one.
//
// Never throw inside an error helper — they're called from inside catch
// blocks and a throw-in-catch produces the worst developer experience.

import { NextResponse } from 'next/server';
import { redactSecrets, safeErrorMessage } from './redact';

type ErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'payload_too_large'
  | 'rate_limited'
  | 'misconfigured'
  | 'upstream_error'
  | 'internal';

const CODE_TO_STATUS: Record<ErrorCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  payload_too_large: 413,
  rate_limited: 429,
  misconfigured: 503,
  upstream_error: 502,
  internal: 500,
};

/** Build a NextResponse from a code + user-facing message. */
export function errorResponse(
  code: ErrorCode,
  message: string,
  extra?: Record<string, unknown>,
): NextResponse {
  const status = CODE_TO_STATUS[code];
  return NextResponse.json(
    {
      error: redactSecrets(message),
      code,
      ...(extra ?? {}),
    },
    { status },
  );
}

/** 400 helper. */
export function badRequest(message: string, extra?: Record<string, unknown>): NextResponse {
  return errorResponse('bad_request', message, extra);
}

/** 401 helper. */
export function unauthorized(message = 'Unauthorized'): NextResponse {
  return errorResponse('unauthorized', message);
}

/** 403 helper. */
export function forbidden(message = 'Forbidden'): NextResponse {
  return errorResponse('forbidden', message);
}

/** 413 helper — request body too large. */
export function payloadTooLarge(limitBytes: number): NextResponse {
  return errorResponse('payload_too_large', `Payload exceeds ${limitBytes} bytes`);
}

/** 429 helper. */
export function rateLimited(retryAfterSeconds?: number): NextResponse {
  const res = errorResponse('rate_limited', 'Too many requests');
  if (typeof retryAfterSeconds === 'number') {
    res.headers.set('Retry-After', String(Math.max(1, Math.floor(retryAfterSeconds))));
  }
  return res;
}

/** 503 helper — the server is missing required configuration. */
export function misconfigured(what: string): NextResponse {
  return errorResponse('misconfigured', `Service misconfigured: ${what}`);
}

/** 500 helper — logs the full error server-side, returns a generic 500. */
export function internalError(err: unknown, context?: string): NextResponse {
  const redacted = safeErrorMessage(err);
  // eslint-disable-next-line no-console
  console.error(`[api-error]${context ? ` ${context}` : ''}:`, redacted);
  return errorResponse('internal', 'Internal error');
}
