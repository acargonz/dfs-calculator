/**
 * API key / secret redaction utilities.
 *
 * Used when building error messages, log lines, or debug output that might
 * accidentally contain a provider key. The rule (OWASP LLM02, Anthropic's
 * API key best practices, NIST SP 800-53 AU-9) is: a compromised log file
 * should never be a compromised key.
 *
 * Matches every key format used by this project:
 *   - Anthropic Claude:  sk-ant-api03-XXXX... (or api04 after 2026)
 *   - Google Gemini:     AIzaXXXXXXXXXXXX...
 *   - OpenAI / OpenRouter: sk-XXXX... / sk-or-XXXX...
 *   - Supabase service:  eyJhbGciOi... (JWT, base64url-dotted)
 *   - Generic Bearer tokens: any 20+ char [A-Za-z0-9_-] run after "Bearer "
 *
 * The redaction replaces the whole match with "[REDACTED]" — not a partial
 * mask — because showing the last 4 chars of a key to an attacker who has
 * access to the logs is still a partial compromise.
 *
 * This module is pure/sync so it can be used in hot paths without cost.
 */

// Concrete vendor patterns. Order matters for readability — more specific
// first so substring scan doesn't cause one pattern to "eat" characters that
// the next pattern would have matched differently.
const SECRET_PATTERNS: RegExp[] = [
  // Anthropic API keys — sk-ant-apiNN-XXXX...
  /sk-ant-api\d{2}-[A-Za-z0-9_-]{20,}/g,
  // Google API keys — AIzaXXXX...
  /\bAIza[A-Za-z0-9_-]{30,}\b/g,
  // OpenRouter — sk-or-v1-XXXX...
  /sk-or-[A-Za-z0-9_-]{20,}/g,
  // Generic OpenAI-style — sk-XXXX... (must come after sk-ant/sk-or)
  /\bsk-[A-Za-z0-9]{20,}\b/g,
  // Supabase / Vercel JWTs (three base64url segments separated by .)
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
  // Bearer <token> in Authorization headers
  /(Bearer\s+)[A-Za-z0-9_\-.~+/=]{20,}/gi,
];

/**
 * Replace every secret-looking substring with a placeholder. Safe to call
 * on any string — non-matching input is returned unchanged.
 */
export function redactSecrets(input: string): string {
  if (!input) return input;
  let out = input;
  for (const pattern of SECRET_PATTERNS) {
    // Use function-form replace so we can keep a captured "Bearer " prefix
    // intact (pattern 6) while still wiping the token.
    out = out.replace(pattern, (_match, prefix?: string) => {
      if (prefix) return `${prefix}[REDACTED]`;
      return '[REDACTED]';
    });
  }
  return out;
}

/**
 * Apply redaction to an unknown value. Strings are redacted directly;
 * Error objects have their `message` and `stack` copied into a new Error
 * (because Error.message can be frozen or read-only depending on the
 * runtime); plain objects are serialized via JSON.stringify then redacted
 * and re-parsed. Anything else returns unchanged.
 *
 * Never throws — redaction is best-effort. A redaction failure is always
 * better than a process crash inside an error handler.
 */
export function redactUnknown(value: unknown): unknown {
  try {
    if (value == null) return value;
    if (typeof value === 'string') return redactSecrets(value);
    if (value instanceof Error) {
      const cleaned = new Error(redactSecrets(value.message));
      if (value.stack) cleaned.stack = redactSecrets(value.stack);
      return cleaned;
    }
    if (typeof value === 'object') {
      const json = JSON.stringify(value);
      const redacted = redactSecrets(json);
      return JSON.parse(redacted);
    }
    return value;
  } catch {
    return '[REDACTION_FAILED]';
  }
}

/**
 * Safe error-message extractor for API error responses. Guarantees:
 *   - Never returns the raw API key
 *   - Never leaks a stack trace
 *   - Never throws (returns a generic fallback on any failure)
 */
export function safeErrorMessage(err: unknown, fallback = 'Internal error'): string {
  try {
    if (err instanceof Error) return redactSecrets(err.message) || fallback;
    if (typeof err === 'string') return redactSecrets(err) || fallback;
    return fallback;
  } catch {
    return fallback;
  }
}
