import Calculator from '../components/Calculator';
import SystemStatusCard from '../components/SystemStatusCard';

export default function Home() {
  return (
    <main className="min-h-screen">
      <div className="max-w-3xl mx-auto px-4 py-10 sm:px-6 lg:px-8">
        <header className="mb-6 flex items-end justify-between gap-4">
          <div>
            <h1
              className="text-3xl font-bold tracking-tight"
              style={{ color: 'var(--accent)' }}
            >
              DFS Calculator
            </h1>
            <p className="mt-2 text-sm" style={{ color: 'var(--text-secondary)' }}>
              NBA player prop edge calculator. Select games or paste lines to find the best plays.
            </p>
          </div>
          <nav className="flex shrink-0 items-center gap-4 text-sm">
            <a
              href="/calibration"
              className="underline opacity-70 hover:opacity-100"
              style={{ color: 'var(--text-secondary)' }}
            >
              Calibration →
            </a>
            <a
              href="/history"
              className="underline opacity-70 hover:opacity-100"
              style={{ color: 'var(--text-secondary)' }}
            >
              Pick history →
            </a>
          </nav>
        </header>

        <div className="mb-8">
          <SystemStatusCard />
        </div>

        <Calculator />
      </div>
    </main>
  );
}
