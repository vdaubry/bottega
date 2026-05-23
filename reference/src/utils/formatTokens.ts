export function formatTokens(tokens: number | string | null | undefined): string {
  const n = Number(tokens) || 0;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export function getPctColor(pct: number): string {
  if (pct < 50) return '#22c55e';   // green
  if (pct < 80) return '#f59e0b';   // amber
  return '#ef4444';                 // red
}
