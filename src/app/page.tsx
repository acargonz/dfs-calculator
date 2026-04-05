import Calculator from '../components/Calculator';

export default function Home() {
  return (
    <main className="min-h-screen">
      <div className="max-w-3xl mx-auto px-4 py-10 sm:px-6 lg:px-8">
        <header className="mb-10">
          <h1
            className="text-3xl font-bold tracking-tight"
            style={{ color: 'var(--accent)' }}
          >
            DFS Calculator
          </h1>
          <p className="mt-2 text-sm" style={{ color: 'var(--text-secondary)' }}>
            NBA player prop edge calculator. Select games or paste lines to find the best plays.
          </p>
        </header>
        <Calculator />
      </div>
    </main>
  );
}
