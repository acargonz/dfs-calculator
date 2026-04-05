import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'DFS Calculator — NBA Player Prop Edge',
  description:
    'NBA player prop edge calculator for DFS platforms. Get probability, EV, and stake recommendations.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-slate-900 text-slate-200 antialiased">
        {children}
      </body>
    </html>
  );
}
