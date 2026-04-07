'use client';

import { Fragment, useEffect, useMemo, useState } from 'react';
import type { BatchResult } from '../lib/batchProcessor';
import type { AIProvider, ModelInfo } from '../lib/aiAnalysis';
import { MODEL_CATALOG } from '../lib/aiAnalysis';
import type {
  ConsensusLabel,
  ConsensusSummary,
  MergedPick,
} from '../lib/ensembleConsensus';
import { consensusLabel } from '../lib/ensembleConsensus';
import {
  TIER_COLOR,
  bestVote,
  bestVoteForDirection,
  dominantDirection,
  selectBestPicks,
} from '../lib/aiPickSelectors';
import type { InjuryEntry } from '../app/api/injuries/route';

interface AIAnalysisPanelProps {
  batchResult: BatchResult;
  bankroll: number;
}

interface ProviderConfig {
  enabled: boolean;
  provider: AIProvider;
  model: string;
  apiKey: string;          // Stored locally; sent to server only on Analyze click
}

interface EnsembleResponse {
  ensemble: Array<
    | { status: 'success'; provider: AIProvider; model: string; response: { picks: unknown[]; slips: unknown[]; summary: string; warnings: string[]; tokensUsed?: number; durationMs: number } }
    | { status: 'error'; provider: AIProvider; model: string; error: string }
  >;
  consensus: { merged: MergedPick[]; summary: ConsensusSummary };
  durationMs: number;
  analysisId: string | null;
  promptVersion: number;
  // Set by the server whenever ANY provider in the ensemble errored with a
  // transient failure (503, 429, high demand, etc). Milliseconds to wait
  // before the UI should re-enable the Run button. Drives the live countdown.
  retryAfterMs?: number;
}

// ============================================================================
// Consensus badge
// ============================================================================

const CONSENSUS_BADGE: Record<ConsensusLabel, { bg: string; color: string; emoji: string }> = {
  agree_strong: { bg: 'rgba(16, 185, 129, 0.15)', color: '#10b981', emoji: '✓✓' },
  agree_weak: { bg: 'rgba(132, 204, 22, 0.15)', color: '#84cc16', emoji: '✓' },
  disagree_dir: { bg: 'rgba(245, 158, 11, 0.15)', color: '#f59e0b', emoji: '⚠' },
  mixed: { bg: 'rgba(251, 146, 60, 0.15)', color: '#fb923c', emoji: '~' },
  all_reject: { bg: 'rgba(239, 68, 68, 0.15)', color: '#ef4444', emoji: '✗' },
  single_source: { bg: 'rgba(156, 163, 175, 0.15)', color: '#9ca3af', emoji: '?' },
};

function ConsensusBadge({ label }: { label: ConsensusLabel }) {
  const info = CONSENSUS_BADGE[label];
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold whitespace-nowrap"
      style={{ background: info.bg, color: info.color }}
    >
      <span className="text-[10px]">{info.emoji}</span>
      {consensusLabel(label)}
    </span>
  );
}

// ============================================================================
// Vote details (per-model) — expandable row
// ============================================================================

function VoteDetails({ pick }: { pick: MergedPick }) {
  return (
    <div className="space-y-2 px-3 pb-3 pt-1">
      {pick.votes.map((vote, i) => {
        const tierColor =
          vote.pick.confidenceTier === 'A' ? '#10b981'
          : vote.pick.confidenceTier === 'B' ? '#f59e0b'
          : vote.pick.confidenceTier === 'C' ? '#fb923c'
          : '#ef4444';
        return (
          <div
            key={i}
            className="rounded-lg p-3 text-xs"
            style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-subtle)' }}
          >
            <div className="flex flex-wrap items-center gap-2 mb-2">
              <span className="font-semibold" style={{ color: 'var(--text-primary)' }}>
                {vote.model}
              </span>
              <span className="text-[10px] uppercase opacity-60">{vote.provider}</span>
              <span className="font-bold" style={{ color: tierColor }}>
                Tier {vote.pick.confidenceTier}
              </span>
              <span style={{ color: 'var(--text-secondary)' }}>
                — {vote.pick.direction === 'over' ? 'OVER' : 'UNDER'} {vote.pick.line}
              </span>
              {vote.pick.finalEV !== undefined && vote.pick.finalEV !== null && (
                <span style={{ color: vote.pick.finalEV > 0 ? '#10b981' : '#ef4444' }}>
                  EV {(vote.pick.finalEV * 100).toFixed(1)}%
                </span>
              )}
            </div>
            <div className="leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
              {vote.pick.reasoning || '(no reasoning provided)'}
            </div>
            {vote.pick.flags && vote.pick.flags.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {vote.pick.flags.map((f, j) => (
                  <span
                    key={j}
                    className="rounded px-1.5 py-0.5 text-[10px]"
                    style={{
                      background: f.severity === 'major' ? 'rgba(239, 68, 68, 0.15)' : 'rgba(245, 158, 11, 0.15)',
                      color: f.severity === 'major' ? '#ef4444' : '#f59e0b',
                    }}
                  >
                    {f.type}: {f.note}
                  </span>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ============================================================================
// Provider config row
// ============================================================================

function ProviderRow({
  config,
  onChange,
  models,
}: {
  config: ProviderConfig;
  onChange: (next: ProviderConfig) => void;
  models: ModelInfo[];
}) {
  const labelStyle = { color: 'var(--text-secondary)' };
  const inputStyle = {
    background: 'var(--bg-secondary)',
    border: '1px solid var(--border-subtle)',
    color: 'var(--text-primary)',
  };
  const providerLabel = config.provider === 'gemini' ? 'Gemini' : config.provider === 'openrouter' ? 'OpenRouter' : 'Claude';

  return (
    <div
      className="rounded-lg p-3 space-y-2"
      style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-subtle)' }}
    >
      <label className="flex items-center gap-2 font-semibold text-sm cursor-pointer" style={{ color: 'var(--text-primary)' }}>
        <input
          type="checkbox"
          checked={config.enabled}
          onChange={(e) => onChange({ ...config, enabled: e.target.checked })}
        />
        {providerLabel}
        {config.provider === 'claude' && <span className="text-[10px] uppercase opacity-60">BYO key required</span>}
        {config.provider === 'gemini' && <span className="text-[10px] uppercase opacity-60">free tier</span>}
        {config.provider === 'openrouter' && <span className="text-[10px] uppercase opacity-60">free tier</span>}
      </label>

      {config.enabled && (
        <>
          <div>
            <label className="block text-[11px] mb-1" style={labelStyle}>Model</label>
            <select
              value={config.model}
              onChange={(e) => onChange({ ...config, model: e.target.value })}
              className="w-full rounded-md px-2 py-1.5 text-xs focus:outline-none"
              style={inputStyle}
            >
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.displayName}
                </option>
              ))}
            </select>
            {(() => {
              const info = models.find((m) => m.id === config.model);
              return info?.notes ? (
                <p className="text-[10px] mt-0.5 opacity-60" style={labelStyle}>{info.notes}</p>
              ) : null;
            })()}
          </div>

          <div>
            <label className="block text-[11px] mb-1" style={labelStyle}>
              API Key {config.provider !== 'claude' && '(optional — uses app default if blank)'}
            </label>
            <input
              type="password"
              value={config.apiKey}
              onChange={(e) => onChange({ ...config, apiKey: e.target.value })}
              placeholder={config.provider === 'claude' ? 'sk-ant-...' : 'leave blank to use app default'}
              className="w-full rounded-md px-2 py-1.5 text-xs focus:outline-none font-mono"
              style={inputStyle}
            />
          </div>
        </>
      )}
    </div>
  );
}

// ============================================================================
// Picks-table helpers
// ============================================================================

const ALL_CONSENSUS: ConsensusLabel[] = [
  'agree_strong',
  'agree_weak',
  'mixed',
  'disagree_dir',
  'single_source',
  'all_reject',
];

// ============================================================================
// Main panel
// ============================================================================

export default function AIAnalysisPanel({ batchResult, bankroll }: AIAnalysisPanelProps) {
  // Provider configs — start with default ensemble enabled
  const [providers, setProviders] = useState<ProviderConfig[]>(() => {
    const defaults: ProviderConfig[] = [
      { enabled: true, provider: 'gemini', model: 'gemini-2.5-flash', apiKey: '' },
      { enabled: true, provider: 'openrouter', model: 'openai/gpt-oss-120b:free', apiKey: '' },
      { enabled: false, provider: 'claude', model: 'claude-sonnet-4-5', apiKey: '' },
    ];
    return defaults;
  });

  const [platform, setPlatform] = useState<'prizepicks' | 'underdog' | 'pick6'>('prizepicks');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [response, setResponse] = useState<EnsembleResponse | null>(null);
  const [injuries, setInjuries] = useState<InjuryEntry[]>([]);
  const [injuriesLoading, setInjuriesLoading] = useState(false);
  const [fetchInjuriesAuto, setFetchInjuriesAuto] = useState(true);
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set());
  const [picksCollapsed, setPicksCollapsed] = useState(false);
  const [consensusFilter, setConsensusFilter] = useState<Set<ConsensusLabel>>(
    new Set(ALL_CONSENSUS),
  );

  // Retry countdown (seconds). Populated from /api/analyze's `retryAfterMs`
  // whenever ANY provider failed with a transient error (503, 429, etc).
  // null = no countdown active, button is freely clickable.
  const [retryCountdownSec, setRetryCountdownSec] = useState<number | null>(null);

  // Load saved keys from localStorage
  useEffect(() => {
    setProviders((prev) =>
      prev.map((p) => ({
        ...p,
        apiKey: localStorage.getItem(`dfs-${p.provider}-key`) || '',
      })),
    );
  }, []);

  // Tick down the retry countdown every second. Stops at 0 (re-enabling the
  // Run button). Cleared when the user starts a fresh analysis or when the
  // component unmounts.
  useEffect(() => {
    if (retryCountdownSec === null || retryCountdownSec <= 0) return;
    const t = setTimeout(() => {
      setRetryCountdownSec((s) => {
        if (s === null) return null;
        const next = s - 1;
        return next <= 0 ? null : next;
      });
    }, 1000);
    return () => clearTimeout(t);
  }, [retryCountdownSec]);

  function updateProvider(idx: number, next: ProviderConfig) {
    setProviders((prev) => {
      const copy = [...prev];
      copy[idx] = next;
      return copy;
    });
    // Persist API key changes
    if (next.apiKey) localStorage.setItem(`dfs-${next.provider}-key`, next.apiKey);
    else localStorage.removeItem(`dfs-${next.provider}-key`);
  }

  function toggleExpand(key: string) {
    setExpandedKeys((prev) => {
      const copy = new Set(prev);
      if (copy.has(key)) copy.delete(key);
      else copy.add(key);
      return copy;
    });
  }

  function toggleConsensusFilter(label: ConsensusLabel) {
    setConsensusFilter((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  }

  async function fetchInjuries(): Promise<InjuryEntry[]> {
    setInjuriesLoading(true);
    try {
      const res = await fetch('/api/injuries');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to fetch injuries');
      return data.injuries || [];
    } finally {
      setInjuriesLoading(false);
    }
  }

  async function handleAnalyze() {
    const enabled = providers.filter((p) => p.enabled);
    if (enabled.length === 0) {
      setError('Enable at least one AI provider.');
      return;
    }
    if (enabled.some((p) => p.provider === 'claude' && !p.apiKey)) {
      setError('Claude requires an API key. Either disable Claude or provide your Anthropic key.');
      return;
    }

    setLoading(true);
    setError('');
    setResponse(null);
    // Clear any leftover countdown from the previous run so the user sees a
    // fresh button state immediately.
    setRetryCountdownSec(null);

    try {
      let injuryList = injuries;
      if (fetchInjuriesAuto && injuryList.length === 0) {
        injuryList = await fetchInjuries();
        setInjuries(injuryList);
      }

      const res = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          providers: enabled.map((p) => ({
            provider: p.provider,
            model: p.model,
            apiKey: p.apiKey || undefined,
          })),
          calculatorResults: batchResult,
          injuries: injuryList,
          bankroll,
          platform,
          jurisdiction: 'California',
          saveToDatabase: true,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        // 500 path: the whole request blew up. Server still returns a
        // retryAfterMs hint so we can start the countdown immediately.
        if (typeof data.retryAfterMs === 'number' && data.retryAfterMs > 0) {
          setRetryCountdownSec(Math.ceil(data.retryAfterMs / 1000));
        }
        throw new Error(data.error || `HTTP ${res.status}`);
      }

      setResponse(data);

      // 200 path with partial failure: start the countdown so the user sees
      // a live timer on the Clear/Run button before re-trying the failed
      // providers. Successful-only responses leave retryAfterMs undefined
      // and the countdown stays null.
      if (typeof data.retryAfterMs === 'number' && data.retryAfterMs > 0) {
        setRetryCountdownSec(Math.ceil(data.retryAfterMs / 1000));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Analysis failed');
    } finally {
      setLoading(false);
    }
  }

  const cardStyle = {
    background: 'var(--bg-card)',
    border: '1px solid var(--border-subtle)',
  };

  const sectionHeaderStyle = { color: 'var(--text-primary)' };
  const labelStyle = { color: 'var(--text-secondary)' };
  const inputStyle = {
    background: 'var(--bg-secondary)',
    border: '1px solid var(--border-subtle)',
    color: 'var(--text-primary)',
  };

  const enabledCount = providers.filter((p) => p.enabled).length;
  const successful = response?.ensemble.filter((r) => r.status === 'success') || [];
  const failed = response?.ensemble.filter((r) => r.status === 'error') || [];

  const mergedPicks = response?.consensus.merged ?? [];
  const bestPicks = useMemo(() => selectBestPicks(mergedPicks, 5), [mergedPicks]);
  const filteredPicks = useMemo(
    () => mergedPicks.filter((mp) => consensusFilter.has(mp.consensus)),
    [mergedPicks, consensusFilter],
  );

  return (
    <div data-ai-panel className="rounded-xl p-6 space-y-4 scroll-mt-6" style={cardStyle}>
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold" style={sectionHeaderStyle}>AI Ensemble Analysis</h3>
        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
          {enabledCount} provider{enabledCount !== 1 ? 's' : ''} selected
        </span>
      </div>

      {/* Settings */}
      {!response && (
        <div className="space-y-3">
          {/* Provider configs */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {providers.map((p, idx) => (
              <ProviderRow
                key={p.provider}
                config={p}
                onChange={(next) => updateProvider(idx, next)}
                models={MODEL_CATALOG.filter((m) => m.provider === p.provider)}
              />
            ))}
          </div>

          {/* Platform + injury toggle */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium mb-1" style={labelStyle}>Platform</label>
              <select
                value={platform}
                onChange={(e) => setPlatform(e.target.value as 'prizepicks' | 'underdog' | 'pick6')}
                className="w-full rounded-lg px-3 py-2 text-sm focus:outline-none"
                style={inputStyle}
              >
                <option value="prizepicks">PrizePicks</option>
                <option value="underdog">Underdog Fantasy</option>
                <option value="pick6">DraftKings Pick6</option>
              </select>
            </div>
            <label className="flex items-end gap-2 text-xs pb-2" style={labelStyle}>
              <input
                type="checkbox"
                checked={fetchInjuriesAuto}
                onChange={(e) => setFetchInjuriesAuto(e.target.checked)}
                className="rounded"
              />
              Auto-fetch ESPN injury report
            </label>
          </div>

          <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
            API keys stored locally in browser. Never sent to anyone except the AI provider.
            Default ensemble uses Gemini 2.5 Flash (Google) + GPT-OSS 120B (OpenAI via OpenRouter).
          </p>

          <button
            type="button"
            onClick={handleAnalyze}
            disabled={loading || enabledCount === 0 || (retryCountdownSec !== null && retryCountdownSec > 0)}
            className="w-full rounded-lg py-3 text-sm font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            style={{ background: 'var(--accent)', color: 'white' }}
          >
            {loading
              ? injuriesLoading
                ? 'Fetching injury report...'
                : `Analyzing with ${enabledCount} model${enabledCount !== 1 ? 's' : ''}...`
              : retryCountdownSec !== null && retryCountdownSec > 0
                ? `Retry available in ${retryCountdownSec}s...`
                : `Run Ensemble Analysis (${enabledCount} model${enabledCount !== 1 ? 's' : ''})`}
          </button>
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 space-y-1">
          <div className="text-sm text-red-400">{error}</div>
          {retryCountdownSec !== null && retryCountdownSec > 0 && (
            <div className="text-[11px] text-red-300">
              AI provider is rate-limited or overloaded. Retry available in{' '}
              <span className="font-mono font-bold">{retryCountdownSec}s</span>.
            </div>
          )}
        </div>
      )}

      {/* AI ensemble response */}
      {response && (
        <div className="space-y-4">
          {/* Per-model status badges */}
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-semibold" style={labelStyle}>Models:</span>
            {response.ensemble.map((r, i) => (
              <span
                key={i}
                className="rounded-full px-2 py-0.5 text-[11px] font-medium"
                style={{
                  background: r.status === 'success' ? 'rgba(16, 185, 129, 0.15)' : 'rgba(239, 68, 68, 0.15)',
                  color: r.status === 'success' ? '#10b981' : '#ef4444',
                }}
                title={r.status === 'error' ? r.error : `${r.response.tokensUsed || 0} tokens, ${r.response.durationMs}ms`}
              >
                {r.status === 'success' ? '✓' : '✗'} {r.model}
              </span>
            ))}
          </div>

          {/* Failed model error details */}
          {failed.length > 0 && (
            <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 space-y-1">
              <div className="text-xs font-semibold text-red-400">{failed.length} model(s) failed</div>
              {failed.map((f, i) => (
                <div key={i} className="text-[11px] text-red-300 font-mono break-all">
                  {f.model}: {f.error.slice(0, 200)}
                </div>
              ))}
              {retryCountdownSec !== null && retryCountdownSec > 0 && (
                <div className="text-[11px] text-red-300 pt-1">
                  Provider is rate-limited or overloaded. Clear results and retry in{' '}
                  <span className="font-mono font-bold">{retryCountdownSec}s</span>.
                </div>
              )}
            </div>
          )}

          {/* Consensus summary */}
          {successful.length > 0 && (
            <div
              className="rounded-lg p-3"
              style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-subtle)' }}
            >
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="font-semibold" style={sectionHeaderStyle}>
                  {response.consensus.summary.totalPicks} picks across {successful.length} model(s):
                </span>
                {response.consensus.summary.agreeStrong > 0 && (
                  <span className="text-emerald-400 font-semibold">
                    {response.consensus.summary.agreeStrong} ✓✓ Both Agree
                  </span>
                )}
                {response.consensus.summary.agreeWeak > 0 && (
                  <span className="text-lime-400 font-semibold">
                    {response.consensus.summary.agreeWeak} ✓ Weak Agree
                  </span>
                )}
                {response.consensus.summary.disagreeDir > 0 && (
                  <span className="text-amber-400 font-semibold">
                    {response.consensus.summary.disagreeDir} ⚠ Disagree
                  </span>
                )}
                {response.consensus.summary.mixed > 0 && (
                  <span className="text-orange-400 font-semibold">
                    {response.consensus.summary.mixed} ~ Mixed
                  </span>
                )}
                {response.consensus.summary.allReject > 0 && (
                  <span className="text-red-400 font-semibold">
                    {response.consensus.summary.allReject} ✗ All Reject
                  </span>
                )}
                {response.consensus.summary.singleSource > 0 && (
                  <span className="text-gray-400 font-semibold">
                    {response.consensus.summary.singleSource} ? Single Source
                  </span>
                )}
              </div>
            </div>
          )}

          {/* Best Picks highlighted card — top-confidence consensus picks */}
          {bestPicks.length > 0 && (
            <div
              className="rounded-lg p-3 space-y-2"
              style={{
                background: 'rgba(16, 185, 129, 0.06)',
                border: '1px solid rgba(16, 185, 129, 0.35)',
              }}
            >
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold" style={{ color: '#10b981' }}>
                  ★ Best Picks ({bestPicks.length})
                </span>
                <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  highest-confidence calls from the ensemble — direction chosen by the AI
                </span>
              </div>
              <div className="space-y-2">
                {bestPicks.map((mp) => {
                  const dir = dominantDirection(mp);
                  // Pin reasoning + tier to a vote that AGREES with the badge,
                  // so the displayed side and the displayed explanation never
                  // contradict each other (matters most on disagree_dir rows).
                  const top =
                    dir === 'SPLIT'
                      ? bestVote(mp)
                      : bestVoteForDirection(mp, dir) ?? bestVote(mp);
                  const tier = top?.pick.confidenceTier ?? 'C';
                  const ev = top?.pick.finalEV;
                  const dirColor = dir === 'OVER' ? '#10b981' : dir === 'UNDER' ? '#fb923c' : 'var(--text-muted)';
                  return (
                    <div
                      key={mp.key}
                      className="rounded-md p-2 text-xs space-y-1"
                      style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-subtle)' }}
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold" style={{ color: 'var(--text-primary)' }}>
                          {mp.playerName}
                        </span>
                        <span style={{ color: 'var(--text-secondary)' }}>{mp.statType}</span>
                        <span
                          className="rounded px-1.5 py-0.5 text-[10px] font-bold uppercase"
                          style={{ background: `${dirColor}22`, color: dirColor }}
                        >
                          {dir} {mp.line}
                        </span>
                        <span
                          className="rounded px-1.5 py-0.5 text-[10px] font-bold"
                          style={{ background: `${TIER_COLOR[tier]}22`, color: TIER_COLOR[tier] }}
                        >
                          Tier {tier}
                        </span>
                        <ConsensusBadge label={mp.consensus} />
                        {ev !== undefined && ev !== null && (
                          <span style={{ color: ev > 0 ? '#10b981' : '#ef4444' }}>
                            EV {ev > 0 ? '+' : ''}{(ev * 100).toFixed(1)}%
                          </span>
                        )}
                      </div>
                      <p className="leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                        {top?.pick.reasoning || '(no reasoning provided)'}
                      </p>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Merged picks table — compact, scrollable, filterable */}
          {response.consensus.merged.length > 0 && (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => setPicksCollapsed((c) => !c)}
                  className="text-xs rounded-md px-2 py-1 transition-opacity hover:opacity-80"
                  style={{ border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)' }}
                  aria-label={picksCollapsed ? 'Show picks' : 'Hide picks'}
                >
                  {picksCollapsed ? '▶' : '▼'} {picksCollapsed ? 'Show' : 'Hide'} picks
                </button>
                <span className="text-xs font-semibold" style={sectionHeaderStyle}>
                  All Picks ({response.consensus.merged.length})
                </span>
                {ALL_CONSENSUS.map((label) => {
                  const count = response.consensus.merged.filter((m) => m.consensus === label).length;
                  if (count === 0) return null;
                  const info = CONSENSUS_BADGE[label];
                  const active = consensusFilter.has(label);
                  return (
                    <button
                      key={label}
                      type="button"
                      onClick={() => toggleConsensusFilter(label)}
                      className="rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide transition-opacity"
                      style={{
                        background: info.bg,
                        color: info.color,
                        opacity: active ? 1 : 0.35,
                      }}
                      title={`Toggle ${consensusLabel(label)} filter`}
                    >
                      {count} {consensusLabel(label)}
                    </button>
                  );
                })}
              </div>

              {!picksCollapsed && (
                <div
                  className="rounded-lg overflow-auto"
                  style={{ border: '1px solid var(--border-subtle)', maxHeight: '360px' }}
                >
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 z-10" style={{ background: 'var(--bg-secondary)' }}>
                      <tr>
                        <th className="px-2 py-1.5 text-left text-[11px] font-semibold whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>Player</th>
                        <th className="px-2 py-1.5 text-left text-[11px] font-semibold whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>Stat</th>
                        <th className="px-2 py-1.5 text-left text-[11px] font-semibold whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>Side</th>
                        <th className="px-2 py-1.5 text-left text-[11px] font-semibold whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>Consensus</th>
                        <th className="px-2 py-1.5 text-left text-[11px] font-semibold whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>Votes</th>
                        <th className="px-2 py-1.5 text-right text-[11px] font-semibold whitespace-nowrap" style={{ color: 'var(--text-muted)' }}></th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredPicks.length === 0 && (
                        <tr>
                          <td
                            colSpan={6}
                            className="px-3 py-6 text-center text-xs"
                            style={{ color: 'var(--text-muted)' }}
                          >
                            No picks match the active consensus filters. Click a chip above to re-enable.
                          </td>
                        </tr>
                      )}
                      {filteredPicks.map((mp) => {
                        const expanded = expandedKeys.has(mp.key);
                        const dir = dominantDirection(mp);
                        const dirColor = dir === 'OVER' ? '#10b981' : dir === 'UNDER' ? '#fb923c' : 'var(--text-muted)';
                        return (
                          <Fragment key={mp.key}>
                            <tr
                              className="cursor-pointer hover:opacity-80"
                              style={{ borderTop: '1px solid var(--border-subtle)' }}
                              onClick={() => toggleExpand(mp.key)}
                            >
                              <td className="px-2 py-1.5 text-xs font-medium whitespace-nowrap" style={{ color: 'var(--text-primary)' }}>
                                {mp.playerName}
                              </td>
                              <td className="px-2 py-1.5 text-xs whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>{mp.statType}</td>
                              <td className="px-2 py-1.5 text-xs whitespace-nowrap font-semibold" style={{ color: dirColor }}>
                                {dir === 'SPLIT' ? `${mp.line}` : `${dir} ${mp.line}`}
                              </td>
                              <td className="px-2 py-1.5 whitespace-nowrap"><ConsensusBadge label={mp.consensus} /></td>
                              <td className="px-2 py-1.5 text-[11px] whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>
                                {mp.tierCounts.recommend > 0 && (
                                  <span className="text-emerald-400">{mp.tierCounts.recommend} rec </span>
                                )}
                                {mp.tierCounts.weak > 0 && (
                                  <span className="text-orange-400">{mp.tierCounts.weak} weak </span>
                                )}
                                {mp.tierCounts.reject > 0 && (
                                  <span className="text-red-400">{mp.tierCounts.reject} rej</span>
                                )}
                              </td>
                              <td className="px-2 py-1.5 text-right text-[11px] whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>
                                {expanded ? '▼' : '▶'}
                              </td>
                            </tr>
                            {expanded && (
                              <tr>
                                <td colSpan={6} style={{ background: 'var(--bg-card-hover, var(--bg-secondary))' }}>
                                  <VoteDetails pick={mp} />
                                </td>
                              </tr>
                            )}
                          </Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}

              {!picksCollapsed && (
                <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  Click any row to see per-model reasoning and tier breakdown.
                </p>
              )}
            </div>
          )}

          {/* Per-model summaries (collapsed by default) */}
          {successful.length > 0 && (
            <details className="rounded-lg" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-subtle)' }}>
              <summary className="cursor-pointer px-3 py-2 text-sm font-semibold" style={sectionHeaderStyle}>
                Per-model summaries + suggested slips
              </summary>
              <div className="px-3 pb-3 space-y-3">
                {successful.map((entry, i) => (
                  <div key={i} className="space-y-1 border-t pt-2" style={{ borderColor: 'var(--border-subtle)' }}>
                    <div className="text-xs font-semibold" style={sectionHeaderStyle}>{entry.model}</div>
                    <p className="text-xs" style={labelStyle}>{entry.response.summary || '(no summary)'}</p>
                    {entry.response.warnings && entry.response.warnings.length > 0 && (
                      <ul className="text-[11px] text-amber-400 list-disc pl-4">
                        {entry.response.warnings.map((w, j) => (
                          <li key={j}>{w}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                ))}
              </div>
            </details>
          )}

          <div className="flex items-center gap-3 text-xs" style={{ color: 'var(--text-muted)' }}>
            <span>Models: {successful.length}/{response.ensemble.length} succeeded</span>
            <span>• Total {(response.durationMs / 1000).toFixed(1)}s</span>
            {response.analysisId && <span>• Saved to DB</span>}
          </div>

          <button
            type="button"
            onClick={() => {
              setResponse(null);
              setExpandedKeys(new Set());
              setPicksCollapsed(false);
              setConsensusFilter(new Set(ALL_CONSENSUS));
            }}
            className="w-full rounded-lg py-2 text-sm transition-colors hover:opacity-80"
            style={{ border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)' }}
          >
            Clear AI Results
          </button>
        </div>
      )}
    </div>
  );
}
