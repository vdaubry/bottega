/**
 * MermaidDiagram — renders one mermaid source string to inline SVG, shrunk to
 * fit its container (mermaid's own `width="100%"` + `max-width` behaviour).
 *
 * That makes it an OVERVIEW, not a reading surface: a ~2000px-wide epic
 * diagram in a half-page card lands around 0.2×. Use it for thumbnails and
 * hand the reading job to a pan/zoom viewport (DiagramModal, reached through
 * ExpandableMermaidDiagram's "Open full size" affordance).
 *
 * The sources are LLM-generated, so invalid syntax is a NORMAL input: a render
 * failure surfaces as an inline error card (message + the raw source), never a
 * page crash. A stale-build failure gets a different card — see
 * MermaidErrorCard. Theme-aware — re-renders when the app theme flips.
 */

import { useMermaidSvg } from '../hooks/useMermaidSvg';
import MermaidErrorCard from './MermaidErrorCard';
import { cn } from '../lib/utils';

interface MermaidDiagramProps {
  source: string;
  className?: string | undefined;
}

function MermaidDiagram({ source, className }: MermaidDiagramProps) {
  const { svg, error, errorKind } = useMermaidSvg(source);

  if (error) {
    return (
      <MermaidErrorCard
        error={error}
        errorKind={errorKind ?? 'syntax'}
        source={source}
        className={className}
      />
    );
  }

  if (!svg) {
    return (
      <div className={cn('flex items-center justify-center p-8 text-sm text-muted-foreground', className)}>
        Rendering diagram…
      </div>
    );
  }

  return (
    <div
      className={cn('overflow-x-auto [&_svg]:max-w-full [&_svg]:h-auto', className)}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

export default MermaidDiagram;
