/**
 * AtlasArtifactSwitcher — a small segmented control over the artifact kinds
 * that currently exist for the task. Lets the user switch which stored
 * artifact (plan / flowchart / architecture) is shown in the iframe. Renders
 * nothing when fewer than two kinds exist (no point in a one-segment switch).
 */

import { cn } from '../../lib/utils';
import { ARTIFACT_KINDS, type ArtifactKind } from '@shared/types/atlas';

export const ARTIFACT_KIND_LABELS: Record<ArtifactKind, string> = {
  plan: 'Plan',
  flowchart: 'Flowchart',
  architecture: 'Architecture',
};

interface AtlasArtifactSwitcherProps {
  available: ArtifactKind[];
  activeKind: ArtifactKind;
  onSelect: (kind: ArtifactKind) => void;
}

export default function AtlasArtifactSwitcher({
  available,
  activeKind,
  onSelect,
}: AtlasArtifactSwitcherProps) {
  if (available.length < 2) return null;
  // Keep a stable kind order regardless of fetch/insertion order.
  const ordered = ARTIFACT_KINDS.filter((k) => available.includes(k));

  return (
    <div
      className="inline-flex items-center gap-0.5 rounded-md border border-border bg-card p-0.5"
      role="tablist"
      data-testid="atlas-artifact-switcher"
    >
      {ordered.map((kind) => (
        <button
          key={kind}
          type="button"
          role="tab"
          aria-selected={kind === activeKind}
          onClick={() => onSelect(kind)}
          className={cn(
            'rounded px-2.5 py-1 text-xs font-medium transition-colors',
            kind === activeKind
              ? 'bg-primary text-primary-foreground'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {ARTIFACT_KIND_LABELS[kind]}
        </button>
      ))}
    </div>
  );
}
