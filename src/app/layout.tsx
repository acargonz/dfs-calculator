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
      <body className="min-h-screen antialiased" style={{ background: 'var(--bg-primary)', color: 'var(--text-primary)' }}>
        {children}
      </body>
    </html>
  );
}
