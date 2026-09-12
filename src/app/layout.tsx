import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Deckwright — AI Presentation Builder',
  description: 'Generate, refine, and edit presentations with an agentic AI loop.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="antialiased bg-(--app-bg) text-(--app-fg)">{children}</body>
    </html>
  );
}
