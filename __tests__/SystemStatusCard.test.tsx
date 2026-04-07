/** @jest-environment jsdom */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import SystemStatusCard from '../src/components/SystemStatusCard';
import type { PickSummary } from '../src/lib/pickHistory';

// ============================================================================
// Mock fetch helpers
// ============================================================================

function makeSummary(overrides: Partial<PickSummary> = {}): PickSummary {
  return {
    totalPicks: 0,
    resolvedPicks: 0,
    pendingPicks: 0,
    pushedPicks: 0,
    hitRate: NaN,
    hitRateByTier: { HIGH: NaN, MEDIUM: NaN, LOW: NaN, REJECT: NaN },
    brierScore: NaN,
    logLoss: NaN,
    rawBrierScore: NaN,
    rawLogLoss: NaN,
    flatROI: NaN,
    netUnits: 0,
    maxDrawdown: 0,
    maxDrawdownPct: 0,
    picksWithCLV: 0,
    averageCLV: NaN,
    ...overrides,
  };
}

interface ResponsePayload {
  stats: {
    allTime: PickSummary;
    last7Days: PickSummary;
    last30Days: PickSummary;
    baseline: PickSummary | null;
  };
  previewAlerts: unknown[];
  activeAlerts: unknown[];
  meta: { configured: boolean };
}

function mockFetchOnce(payload: Partial<ResponsePayload> & { configured?: boolean } = {}) {
  const empty = makeSummary();
  const fullPayload: ResponsePayload = {
    stats: {
      allTime: payload.stats?.allTime ?? empty,
      last7Days: payload.stats?.last7Days ?? empty,
      last30Days: payload.stats?.last30Days ?? empty,
      baseline: payload.stats?.baseline ?? null,
    },
    previewAlerts: payload.previewAlerts ?? [],
    activeAlerts: payload.activeAlerts ?? [],
    meta: { configured: payload.configured ?? true },
  };
  const fetchMock = jest.fn().mockResolvedValueOnce({
    ok: true,
    json: async () => fullPayload,
  });
  (global as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ============================================================================
// Tests
// ============================================================================

describe('SystemStatusCard', () => {
  it('shows a loading state initially', () => {
    (global as unknown as { fetch: typeof fetch }).fetch = jest
      .fn()
      .mockReturnValue(new Promise(() => {})) as unknown as typeof fetch;
    render(<SystemStatusCard />);
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it('shows the unconfigured placeholder when meta.configured is false', async () => {
    mockFetchOnce({ configured: false });
    render(<SystemStatusCard />);
    await waitFor(() => {
      expect(screen.getByText(/pick history disabled/i)).toBeInTheDocument();
    });
  });

  it('shows the all-clear state when no alerts are firing', async () => {
    mockFetchOnce({
      stats: {
        allTime: makeSummary({ resolvedPicks: 50, hitRate: 0.55, flatROI: 0.04 }),
        last7Days: makeSummary({ averageCLV: 0.015, picksWithCLV: 12 }),
        last30Days: makeSummary(),
        baseline: null,
      },
    });
    render(<SystemStatusCard />);
    await waitFor(() => {
      expect(screen.getByText(/all systems normal/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/no alerts firing/i)).toBeInTheDocument();
  });

  it('renders headline metrics from allTime + last7Days', async () => {
    mockFetchOnce({
      stats: {
        allTime: makeSummary({ resolvedPicks: 137, hitRate: 0.532, flatROI: 0.038 }),
        last7Days: makeSummary({ averageCLV: 0.022, picksWithCLV: 15 }),
        last30Days: makeSummary(),
        baseline: null,
      },
    });
    render(<SystemStatusCard />);
    await waitFor(() => {
      expect(screen.getByText('137')).toBeInTheDocument();
    });
    expect(screen.getByText('53.2%')).toBeInTheDocument();
    expect(screen.getByText('3.8%')).toBeInTheDocument();
    expect(screen.getByText('+2.20pp')).toBeInTheDocument();
  });

  it('shows preview alerts when present', async () => {
    mockFetchOnce({
      previewAlerts: [
        {
          rule_id: 'milestone',
          rule_name: 'Pick Count Milestone',
          severity: 'info',
          message: 'Reached 100 picks',
          metadata: { milestone: 100 },
        },
      ],
    });
    render(<SystemStatusCard />);
    await waitFor(() => {
      expect(screen.getByText(/preview/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/Reached 100 picks/)).toBeInTheDocument();
    expect(screen.getByText(/Pick Count Milestone/)).toBeInTheDocument();
  });

  it('shows active alerts with an Ack button', async () => {
    mockFetchOnce({
      activeAlerts: [
        {
          id: 'alert-uuid-1',
          rule_id: 'drawdown-30pct',
          rule_name: '30% Drawdown',
          severity: 'critical',
          message: 'CRITICAL: Bankroll is down 35.0% from peak.',
          metadata: { maxDrawdownPct: 0.35 },
          triggered_at: '2026-04-06T12:00:00Z',
          acknowledged_at: null,
          acknowledged_by: null,
          dismissed: false,
          auto_action_taken: null,
        },
      ],
    });
    render(<SystemStatusCard />);
    await waitFor(() => {
      expect(screen.getByText(/active alerts/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/30% Drawdown/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /ack/i })).toBeInTheDocument();
  });

  it('uses the highest severity for the banner colour (critical wins)', async () => {
    mockFetchOnce({
      activeAlerts: [
        {
          id: 'a',
          rule_id: 'x',
          rule_name: 'X',
          severity: 'critical',
          message: 'm',
          metadata: null,
          triggered_at: '2026-04-06T12:00:00Z',
          acknowledged_at: null,
          acknowledged_by: null,
          dismissed: false,
          auto_action_taken: null,
        },
      ],
      previewAlerts: [
        { rule_id: 'y', rule_name: 'Y', severity: 'info', message: 'm', metadata: {} },
      ],
    });
    render(<SystemStatusCard />);
    await waitFor(() => {
      expect(screen.getByText(/critical — review immediately/i)).toBeInTheDocument();
    });
  });

  it('refresh button refetches the status', async () => {
    const fetchMock = jest.fn();
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        stats: {
          allTime: makeSummary({ resolvedPicks: 10 }),
          last7Days: makeSummary(),
          last30Days: makeSummary(),
          baseline: null,
        },
        previewAlerts: [],
        activeAlerts: [],
        meta: { configured: true },
      }),
    });
    (global as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const user = userEvent.setup();
    render(<SystemStatusCard />);
    await waitFor(() => {
      expect(screen.getByText('10')).toBeInTheDocument();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: /refresh/i }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  it('shows an error state when the fetch fails', async () => {
    (global as unknown as { fetch: typeof fetch }).fetch = jest.fn().mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({ error: 'Boom' }),
    }) as unknown as typeof fetch;
    render(<SystemStatusCard />);
    await waitFor(() => {
      expect(screen.getByText(/system status unavailable/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/boom/i)).toBeInTheDocument();
  });
});
