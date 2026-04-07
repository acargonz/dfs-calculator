import CalibrationDashboard from '@/components/CalibrationDashboard';

export const metadata = {
  title: 'DFS Calculator — Calibration',
  description:
    'Reliability curve, cumulative profit, bootstrap confidence intervals, and by-bookmaker breakdowns.',
};

/**
 * /calibration — deep-dive calibration diagnostics.
 *
 * Complements /history (row-level table with filters) by focusing on
 * visualizations that show whether the model is well calibrated:
 *
 *   - Reliability curve (AI vs raw, with y=x reference)
 *   - Cumulative profit curve with drawdown annotation
 *   - Headline metrics with 95% bootstrap confidence intervals
 *   - Performance broken down by bookmaker
 *
 * The page is a thin server wrapper. All of the data fetching and
 * visualization happens in the CalibrationDashboard client component.
 */
export default function CalibrationPage() {
  return (
    <main className="min-h-screen">
      <div className="mx-auto max-w-5xl px-4 py-10 sm:px-6 lg:px-8">
        <header className="mb-8 flex items-end justify-between">
          <div>
            <h1
              className="text-3xl font-bold tracking-tight"
              style={{ color: 'var(--accent)' }}
            >
              Calibration
            </h1>
            <p
              className="mt-2 text-sm"
              style={{ color: 'var(--text-secondary)' }}
            >
              Reliability curve, cumulative profit, bootstrap CIs, and
              bookmaker breakdowns.
            </p>
          </div>
          <nav className="flex items-center gap-4 text-sm">
            <a
              href="/history"
              className="underline opacity-70 hover:opacity-100"
              style={{ color: 'var(--text-secondary)' }}
            >
              Pick History →
            </a>
            <a
              href="/"
              className="underline opacity-70 hover:opacity-100"
              style={{ color: 'var(--text-secondary)' }}
            >
              ← Back to calculator
            </a>
          </nav>
        </header>

        <CalibrationDashboard />
      </div>
    </main>
  );
}
