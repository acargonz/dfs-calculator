'use client';

/**
 * SystemStatusCard — the home-page banner that shows AI/calibration health.
 *
 * Renders a colored card with:
 *   - A traffic-light header (green / blue / amber / red) based on the highest
 *     severity alert currently active OR previewed
 *   - Headline metrics: total picks, hit rate, flat ROI, 7-day CLV
 *   - The full list of active alerts (with acknowledge buttons)
 *   - The full list of preview alerts (informational only — these are alerts
 *     that WOULD fire if the cron ran right now, even though they haven't
 *     been persisted yet)
 *
 * The card is fetched once on mount. To refresh, the user can click the
 * "Refresh" button. Acknowledging an alert refetches automatically.
 *
 * In dev / unconfigured environments, the card shows a friendly "Database not
 * configured" placeholder so the rest of the app stays usable.
 */

import { useEffect, useState, useCallback } from 'react';
import type { SystemStats } from '../lib/monitoringRules';
import type { PendingAlert } from '../lib/alertEvaluator';
import type { SystemAlertRow } from '../lib/supabase';

interface SystemStatusResponse {
  stats: SystemStats;
  previewAlerts: PendingAlert[];
  activeAlerts: SystemAlertRow[];
  meta: { configured: boolean; alertFetchError?: string | null };
}

type Severity = 'info' | 'warning' | 'critical' | 'ok';

const SEVERITY_STYLES: Record<Severity, string> = {
  ok: 'bg-emerald-900/15 border-emerald-700/40 text-emerald-300',
  info: 'bg-blue-900/15 border-blue-700/40 text-blue-300',
  warning: 'bg-amber-900/15 border-amber-600/40 text-amber-300',
  critical: 'bg-red-900/20 border-red-600/40 text-red-300',
};

const SEVERITY_LABELS: Record<Severity, string> = {
  ok: 'All systems normal',
  info: 'Information',
  warning: 'Action recommended',
  critical: 'Critical — review immediately',
};

const SEVERITY_DOT: Record<Severity, string> = {
  ok: 'bg-emerald-400',
  info: 'bg-blue-400',
  warning: 'bg-amber-400',
  critical: 'bg-red-500 animate-pulse',
};

function formatPct(value: number, digits = 1): string {
  if (!Number.isFinite(value)) return '—';
  return `${(value * 100).toFixed(digits)}%`;
}

function formatPp(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const sign = value >= 0 ? '+' : '';
  return `${sign}${(value * 100).toFixed(2)}pp`;
}

function highestSeverity(
  active: SystemAlertRow[],
  preview: PendingAlert[],
): Severity {
  const all: Severity[] = [
    ...active.map((a) => a.severity as Severity),
    ...preview.map((p) => p.severity as Severity),
  ];
  if (all.includes('critical')) return 'critical';
  if (all.includes('warning')) return 'warning';
  if (all.includes('info')) return 'info';
  return 'ok';
}

export default function SystemStatusCard() {
  const [data, setData] = useState<SystemStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [acknowledging, setAcknowledging] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/system-status', { cache: 'no-store' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const json = (await res.json()) as SystemStatusResponse;
      setData(json);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      setError(message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const acknowledge = useCallback(
    async (id: string) => {
      setAcknowledging(id);
      try {
        const res = await fetch(`/api/system-status/acknowledge?id=${id}`, {
          method: 'POST',
        });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        await load();
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        setError(`Acknowledge failed: ${message}`);
      } finally {
        setAcknowledging(null);
      }
    },
    [load],
  );

  // ---- Loading state ----
  if (loading && !data) {
    return (
      <div className="rounded-lg border border-neutral-700/40 bg-neutral-900/40 p-4">
        <div className="text-sm text-neutral-400">Loading system status…</div>
      </div>
    );
  }

  // ---- Error state ----
  if (error && !data) {
    return (
      <div className="rounded-lg border border-red-600/40 bg-red-900/15 p-4">
        <div className="text-sm font-semibold text-red-300">System status unavailable</div>
        <div className="mt-1 text-xs text-red-300/80">{error}</div>
      </div>
    );
  }

  if (!data) return null;

  // ---- Unconfigured state (no Supabase) ----
  if (!data.meta.configured) {
    return (
      <div className="rounded-lg border border-neutral-700/40 bg-neutral-900/40 p-4">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-neutral-500" />
          <span className="text-sm font-semibold text-neutral-300">
            Pick history disabled
          </span>
        </div>
        <p className="mt-1 text-xs text-neutral-400">
          Configure Supabase in <code className="rounded bg-neutral-800 px-1 py-0.5">.env.local</code>{' '}
          to enable closing-line tracking, calibration metrics, and the system status banner.
        </p>
      </div>
    );
  }

  const severity = highestSeverity(data.activeAlerts, data.previewAlerts);
  const { allTime, last7Days } = data.stats;

  return (
    <div
      data-testid="system-status-card"
      className={`rounded-lg border p-4 ${SEVERITY_STYLES[severity]}`}
    >
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className={`h-2 w-2 rounded-full ${SEVERITY_DOT[severity]}`} />
          <span className="text-sm font-semibold">{SEVERITY_LABELS[severity]}</span>
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="rounded border border-current/30 px-2 py-0.5 text-xs opacity-70 hover:opacity-100 disabled:opacity-30"
        >
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {/* Headline metrics */}
      <div className="mt-3 grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
        <Metric label="Resolved Picks" value={String(allTime.resolvedPicks)} />
        <Metric label="Hit Rate" value={formatPct(allTime.hitRate)} />
        <Metric label="Flat ROI" value={formatPct(allTime.flatROI)} />
        <Metric label="7-Day CLV" value={formatPp(last7Days.averageCLV)} />
      </div>

      {/* Active (persisted) alerts */}
      {data.activeAlerts.length > 0 && (
        <div className="mt-4 space-y-2">
          <div className="text-xs font-bold uppercase tracking-wider opacity-70">
            Active Alerts
          </div>
          {data.activeAlerts.map((a) => (
            <div
              key={a.id}
              className="flex items-start justify-between gap-3 rounded border border-current/20 bg-black/20 p-2"
            >
              <div className="flex-1">
                <div className="text-xs font-semibold">
                  [{a.severity.toUpperCase()}] {a.rule_name}
                </div>
                <div className="mt-0.5 text-xs opacity-90">{a.message}</div>
              </div>
              <button
                onClick={() => acknowledge(a.id)}
                disabled={acknowledging === a.id}
                className="shrink-0 rounded border border-current/40 px-2 py-1 text-xs hover:bg-current/10 disabled:opacity-30"
              >
                {acknowledging === a.id ? '…' : 'Ack'}
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Preview alerts (live, not yet persisted) */}
      {data.previewAlerts.length > 0 && (
        <div className="mt-4 space-y-2">
          <div className="text-xs font-bold uppercase tracking-wider opacity-70">
            Preview (Live, Unsaved)
          </div>
          {data.previewAlerts.map((a) => (
            <div
              key={a.rule_id + JSON.stringify(a.metadata)}
              className="rounded border border-current/15 bg-black/15 p-2"
            >
              <div className="text-xs font-semibold">
                [{a.severity.toUpperCase()}] {a.rule_name}
              </div>
              <div className="mt-0.5 text-xs opacity-80">{a.message}</div>
            </div>
          ))}
        </div>
      )}

      {/* Empty all-clear state */}
      {data.activeAlerts.length === 0 && data.previewAlerts.length === 0 && (
        <div className="mt-3 text-xs opacity-70">
          No alerts firing. Calibration looks healthy across all monitored rules.
        </div>
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-current/15 bg-black/15 p-2">
      <div className="text-[10px] uppercase tracking-wider opacity-60">{label}</div>
      <div className="mt-0.5 text-sm font-bold">{value}</div>
    </div>
  );
}
