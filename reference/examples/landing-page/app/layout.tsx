import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Bottega — a web UI for Claude Code',
  description:
    'Bottega is an open-source web interface for Claude Code. Drive coding sessions from your browser, on desktop or mobile.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="bg-ink-50 text-ink-900">{children}</body>
    </html>
  );
}
