import React from 'react';
import { formatTokens } from '../../utils/formatTokens';

const CATEGORY_COLORS: Record<string, string> = {
  'System prompt': '#3498db',
  'System tools': '#2ecc71',
  'System tools (deferred)': '#1abc9c',
  'MCP tools': '#e67e22',
  'MCP tools (deferred)': '#e91e63',
  Skills: '#f1c40f',
  Messages: '#9b59b6',
  'Autocompact buffer': '#e74c3c',
  'Free space': '#455a64',
};

const FALLBACK_PALETTE = [
  '#1abc9c',
  '#e91e63',
  '#00bcd4',
  '#ff9800',
  '#8bc34a',
  '#795548',
  '#607d8b',
  '#ff5722',
  '#673ab7',
  '#009688',
];

function hashName(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++)
    h = ((h << 5) - h + name.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function resolveColor(
  color: string | undefined,
  categoryName: string | undefined,
): string {
  if (categoryName && CATEGORY_COLORS[categoryName]) {
    return CATEGORY_COLORS[categoryName];
  }
  if (typeof color === 'string' && /^(#|rgb|hsl)/.test(color)) return color;
  const idx = categoryName ? hashName(categoryName) : 0;
  return FALLBACK_PALETTE[idx % FALLBACK_PALETTE.length]!;
}

export interface PieSegment {
  name: string;
  tokens: number;
  color?: string;
}

export interface PieChartProps {
  segments: PieSegment[];
}

interface PieArc extends PieSegment {
  dashArray: string;
  dashOffset: number;
  pct: number;
}

export function PieChart({ segments }: PieChartProps) {
  const total = segments.reduce((sum, s) => sum + (s.tokens || 0), 0);
  if (total === 0) return null;

  const radius = 80;
  const circumference = 2 * Math.PI * radius;
  const size = 200;
  const center = size / 2;

  let offset = 0;
  const arcs: PieArc[] = segments
    .filter((s) => s.tokens > 0)
    .map((s) => {
      const pct = s.tokens / total;
      const dashLength = pct * circumference;
      const arc: PieArc = {
        ...s,
        dashArray: `${dashLength} ${circumference - dashLength}`,
        dashOffset: -offset,
        pct,
      };
      offset += dashLength;
      return arc;
    });

  return (
    <div className="flex flex-col items-center gap-4">
      <svg
        viewBox={`0 0 ${size} ${size}`}
        width="200"
        height="200"
        className="max-w-full"
      >
        {arcs.map((arc, i) => (
          <circle
            key={i}
            cx={center}
            cy={center}
            r={radius}
            fill="none"
            stroke={resolveColor(arc.color, arc.name)}
            strokeWidth="32"
            strokeDasharray={arc.dashArray}
            strokeDashoffset={arc.dashOffset}
            transform={`rotate(-90 ${center} ${center})`}
          />
        ))}
      </svg>
      <div className="flex flex-wrap gap-x-4 gap-y-2 justify-center">
        {arcs.map((arc, i) => (
          <div
            key={i}
            className="flex items-center gap-1.5 text-xs text-muted-foreground"
          >
            <span
              className="inline-block w-2.5 h-2.5 rounded-sm shrink-0"
              style={{ background: resolveColor(arc.color, arc.name) }}
            />
            <span>
              {arc.name} ({formatTokens(arc.tokens)})
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default PieChart;
