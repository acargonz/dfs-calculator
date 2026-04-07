/**
 * Alert evaluator — runs all monitoring rules against a stats snapshot,
 * applies deduplication, and returns the list of new alerts to persist.
 *
 * This is the orchestration layer between monitoringRules.ts (pure rule
 * definitions) and the system_alerts table. It exposes a single pure
 * function, evaluateRules(), which takes stats + recent alerts and returns
 * the alerts that SHOULD be persisted. No IO, easily testable. The cron
 * route (/api/system-status) calls evaluateRules() directly and does its
 * own Supabase IO — keeping the module free of database concerns.
 *
 * DEDUPLICATION POLICY
 *
 *   Rules without a `dedupKey`:
 *     Suppressed if the SAME rule fired within `dedupWindowHours` (default 24).
 *     Used for "drawdown-30pct" and similar persistent conditions — we don't
 *     want to spam the user with the same critical alert every cron tick while
 *     they're investigating.
 *
 *   Rules WITH a `dedupKey` (e.g. milestone rules):
 *     Suppressed if any alert with the same (rule_id, dedupKey) ever existed.
 *     The "100-pick milestone" should fire exactly once, ever — even if the
 *     dedup window expires.
 *
 * The dedupKey is preserved in `metadata.__dedupKey` (with the double-underscore
 * prefix marking it as internal bookkeeping). Other fields in metadata stay
 * available for the audit trail and the UI.
 */

import type { SystemAlertRow } from './supabase';
import type { MonitoringRule, SystemStats } from './monitoringRules';

// ===================================================================
// Types
// ===================================================================

/** A new alert ready to be inserted into the system_alerts table. */
export interface PendingAlert {
  rule_id: string;
  rule_name: string;
  severity: 'info' | 'warning' | 'critical';
  message: string;
  metadata: Record<string, unknown>;
}

/** Options for evaluateRules. */
export interface EvaluateRulesOptions {
  /** Time window for non-keyed dedup, in hours. Default 24. */
  dedupWindowHours?: number;
  /** Override "now" for deterministic testing. */
  now?: Date;
}

// ===================================================================
// Constants
// ===================================================================

const DEFAULT_DEDUP_WINDOW_HOURS = 24;

// ===================================================================
// Pure rule runner
// ===================================================================

/**
 * Run a list of rules against the given stats snapshot. Returns the alerts
 * that should be created, after applying dedup against `recentAlerts`.
 *
 * Pure: no IO, no Date.now() (caller can pass `now` for determinism).
 */
export function evaluateRules(
  rules: MonitoringRule[],
  stats: SystemStats,
  recentAlerts: SystemAlertRow[],
  options: EvaluateRulesOptions = {},
): PendingAlert[] {
  const window = options.dedupWindowHours ?? DEFAULT_DEDUP_WINDOW_HOURS;
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - window * 60 * 60 * 1000);

  const pending: PendingAlert[] = [];

  for (const rule of rules) {
    const result = rule.evaluate(stats);
    if (!result) continue;

    const dedupKey = result.dedupKey;
    const isDuplicate = recentAlerts.some((alert) => {
      if (alert.rule_id !== rule.id) return false;

      if (dedupKey !== undefined) {
        // Keyed dedup: same rule + same key = always suppress
        const altMeta = (alert.metadata ?? {}) as Record<string, unknown>;
        return altMeta.__dedupKey === dedupKey;
      }

      // Window dedup: same rule within the time window
      const triggeredAt = new Date(alert.triggered_at);
      return triggeredAt >= cutoff;
    });

    if (isDuplicate) continue;

    pending.push({
      rule_id: rule.id,
      rule_name: rule.name,
      severity: rule.severity,
      message: result.message,
      metadata: {
        ...result.metadata,
        ...(dedupKey !== undefined ? { __dedupKey: dedupKey } : {}),
      },
    });
  }

  return pending;
}
