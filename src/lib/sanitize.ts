/**
 * Input sanitizers for strings that end up inside LLM prompts.
 *
 * The DFS app trusts its own calculator output 99% of the time, but the
 * player name and stat type fields originate from The Odds API (for
 * batch mode) or DFS text parsers (for paste mode). Either source could
 * theoretically echo content that looks like a prompt-injection payload
 * ("ignore previous instructions…"), and we build a markdown table with
 * those fields rendered inline into the user message — so a single
 * backtick-delimited line can break out of the table cell and pose as a
 * new instruction to the LLM.
 *
 * Mitigation strategy (OWASP LLM01:2025 — Prompt Injection):
 *   1. Reject any control character, angle bracket, backtick, or pipe —
 *      these break table cells and markdown parsers.
 *   2. Collapse any whitespace run into a single space so a long newline
 *      blob can't push fake "instruction" text past the table footer.
 *   3. Truncate aggressively. No legitimate NBA player name is > 64 chars.
 *   4. Return a safe default for anything that doesn't pass — we'd rather
 *      display "Unknown Player" than send an attack string to the model.
 *
 * These helpers are PURE and SYNCHRONOUS so they can be called from inside
 * a hot loop without worrying about async backpressure.
 */

const MAX_NAME_LEN = 64;
const MAX_STAT_LEN = 32;

// Control chars (C0 + DEL + C1) + markdown breakers: <>`|\\ + newlines.
// Keep apostrophes and diacritics so real names survive untouched.
const DISALLOWED = /[\u0000-\u001F\u007F-\u009F<>`|\\]/g;

/** Sanitize a player name. Returns "Unknown Player" on empty/invalid. */
export function sanitizePlayerName(raw: unknown): string {
  if (typeof raw !== 'string') return 'Unknown Player';
  const cleaned = raw
    .replace(DISALLOWED, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME_LEN);
  if (cleaned.length === 0) return 'Unknown Player';
  return cleaned;
}

/** Sanitize a stat type string (e.g. "points", "rebounds"). */
export function sanitizeStatType(raw: unknown): string {
  if (typeof raw !== 'string') return 'unknown';
  const cleaned = raw
    .replace(DISALLOWED, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .slice(0, MAX_STAT_LEN);
  return cleaned.length > 0 ? cleaned : 'unknown';
}

/**
 * Sanitize a free-text field that will be rendered in the LLM prompt. Used
 * for injury report comments, lineup context, etc. These can legitimately
 * contain punctuation and longer content, so we only strip control chars
 * + angle brackets / backticks / pipes / backslashes (the markdown and
 * prompt-injection breakers) and cap length.
 *
 * Note: all newlines (\r, \n, CRLF) are part of the C0 control-char range
 * U+0000..U+001F and therefore get stripped entirely. That's intentional:
 * a stray newline inside an injury note is an injection vector because it
 * can pose as a new instruction to the model. If a future caller needs to
 * preserve newlines, build a dedicated sanitizer that escapes leading-
 * whitespace markdown lines instead of accepting raw \n.
 */
export function sanitizeFreeText(raw: unknown, maxLen = 4000): string {
  if (typeof raw !== 'string') return '';
  return raw.replace(DISALLOWED, '').slice(0, maxLen);
}
