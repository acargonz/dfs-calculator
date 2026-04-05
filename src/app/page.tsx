import Calculator from '../components/Calculator';

export default function Home() {
  return (
    <main className="min-h-screen">
      <div className="max-w-2xl mx-auto px-4 py-8 sm:px-6 lg:px-8">
        <header className="mb-8">
          <h1 className="text-3xl font-bold text-white tracking-tight">
            DFS Calculator
          </h1>
          <p className="mt-2 text-slate-400">
            NBA player prop edge calculator. Enter player data to get
            probability, expected value, and stake recommendations.
          </p>
        </header>
        <Calculator />
      </div>
    </main>
  );
}
