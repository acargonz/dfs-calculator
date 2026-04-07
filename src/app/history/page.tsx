import HistoryClient from './HistoryClient';

export const metadata = {
  title: 'DFS Calculator — Pick History',
  description:
    'Historical picks with calibration metrics, CLV tracking, and filterable table view.',
};

/**
 * /history — server entry point.
 *
 * The actual UI lives in HistoryClient (a client component) so the page can
 * have interactive filters without us needing to plumb state through search
 * params and re-fetch on every change.
 *
 * Server-side responsibilities are minimal: just provide the layout chrome
 * and the page metadata. All data fetching happens client-side via /api/picks.
 */
export default function HistoryPage() {
  return (
    <main className="min-h-screen">
      <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6 lg:px-8">
        <header className="mb-8 flex items-end justify-between">
          <div>
            <h1
              className="text-3xl font-bold tracking-tight"
              style={{ color: 'var(--accent)' }}
            >
              Pick History
            </h1>
            <p
              className="mt-2 text-sm"
              style={{ color: 'var(--text-secondary)' }}
            >
              Calibration metrics + closing line value across all resolved picks.
            </p>
          </div>
          <nav className="flex items-center gap-4 text-sm">
            <a
              href="/calibration"
              className="underline opacity-70 hover:opacity-100"
              style={{ color: 'var(--text-secondary)' }}
            >
              Calibration →
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

        <HistoryClient />
      </div>
    </main>
  );
}
