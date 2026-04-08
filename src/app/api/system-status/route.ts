/**
 * /api/system-status — the home-page status banner data source.
 *
 * Bundles three things into one response so the SystemStatusCard component
 * can render with a single fetch:
 *
 *   1. Multi-window stats (allTime, last7Days, last30Days, baseline) so the
 *      banner can show "X picks resolved, Y% hit rate, Z% CLV" alongside
 *      whatever rules fire.
 *
 *   2. A live preview of which monitoring rules WOULD fire right now
 *      (computed via evaluateRules with dryRun-style logic — not persisted).
 *      This means the user sees alerts even when the daily cron hasn't run
 *      yet, and even in dev where there's no cron.
 *
 *   3. The currently-active (unacknowledged, undismissed) alerts that have
 *      already been persisted by the cron job. Sorted by severity then time.
 *
 * The "current preview" + "persisted alerts" duality:
 *   - The PREVIEW is a live snapshot from the rules engine. It updates every
 *     time the user opens the app — useful for immediate feedback.
 *   - The PERSISTED alerts are the audit trail. They're what the cron job
 *     wrote, with the original message + metadata captured at trigger time.
 *
 * In the UI, the SystemStatusCard prefers the persisted alerts (since those
 * are the ones the user can acknowledge), but the preview is shown alongside
 * for fresh visibility before the next cron tick.
 *
 * Returns an empty stats payload if Supabase isn't configured (dev mode).
 */

import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabaseAdmin';
import { internalError } from '@/lib/apiErrors';
import { fetchPicks, summarizePicks } from '@/lib/pickHistory';
import { evaluateRules } from '@/lib/alertEvaluator';
import { MONITORING_RULES, type SystemStats } from '@/lib/monitoringRules';
import type { SystemAlertRow } from '@/lib/supabase';

const DEFAULT_BANKROLL = 100;
const BASELINE_PICK_COUNT = 50;

export async function GET() {
  const supabase = getSupabaseAdmin();

  if (!supabase) {
    // Empty payload for dev / unconfigured environments
    const empty = summarizePicks([]);
    return NextResponse.json({
      stats: {
        allTime: empty,
        last7Days: empty,
        last30Days: empty,
        baseline: null,
      } satisfies SystemStats,
      previewAlerts: [],
      activeAlerts: [],
      meta: { configured: false },
    });
  }

  try {
    // 1. All-time picks (one query, then in-JS slicing for the time windows)
    const allPicks = await fetchPicks(supabase, { limit: 5000 });

    const today = new Date();
    const sevenDaysAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
    const thirtyDaysAgo = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);

    const last7 = allPicks.filter((p) => new Date(p.date) >= sevenDaysAgo);
    const last30 = allPicks.filter((p) => new Date(p.date) >= thirtyDaysAgo);

    // Baseline = first N picks chronologically (sorted ascending by date)
    const sortedAsc = [...allPicks].sort((a, b) =>
      a.created_at.localeCompare(b.created_at),
    );
    const baselinePicks = sortedAsc.slice(0, BASELINE_PICK_COUNT);
    const baselineSummary =
      baselinePicks.length === BASELINE_PICK_COUNT
        ? summarizePicks(baselinePicks, DEFAULT_BANKROLL)
        : null;

    const stats: SystemStats = {
      allTime: summarizePicks(allPicks, DEFAULT_BANKROLL),
      last7Days: summarizePicks(last7, DEFAULT_BANKROLL),
      last30Days: summarizePicks(last30, DEFAULT_BANKROLL),
      baseline: baselineSummary,
    };

    // 2. Live preview of which rules would fire right now
    // (Pass empty recent-alerts so all rules fire freely in the preview.
    // Persisted alerts are dedupped by the cron job, not the preview.)
    const previewAlerts = evaluateRules(MONITORING_RULES, stats, []);

    // 3. Persisted active alerts (unacknowledged, undismissed)
    const { data: rawActive, error: alertErr } = await supabase
      .from('system_alerts')
      .select('*')
      .is('acknowledged_at', null)
      .eq('dismissed', false)
      .order('triggered_at', { ascending: false })
      .limit(50);

    const activeAlerts =
      (rawActive ?? []) as SystemAlertRow[];

    return NextResponse.json({
      stats,
      previewAlerts,
      activeAlerts,
      meta: {
        configured: true,
        alertFetchError: alertErr?.message ?? null,
      },
    });
  } catch (err) {
    return internalError(err, 'system-status');
  }
}
