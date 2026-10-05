/**
 * MermaidErrorCard — the two ways a diagram can fail to appear, told apart.
 *
 * A mermaid render can reject for reasons that have nothing to do with the
 * diagram: mermaid pulls its per-type renderers in with a runtime `import()`,
 * so a page left open across a rebuild asks for a chunk URL that has since been
 * renamed and the import rejects. Reporting that as "Diagram failed to render"
 * over a dump of the source sends the reader off debugging perfectly good
 * mermaid. The actual fix is a reload, so say that and offer the button.
 *
 * Syntax failures keep the old treatment — the sources are LLM-generated, and
 * there the source IS the evidence worth showing.
 */

import type { MermaidErrorKind } from '../hooks/useMermaidSvg';
import { Button } from './ui/button';
import { cn } from '../lib/utils';

interface MermaidErrorCardProps {
  error: string;
  errorKind: MermaidErrorKind;
  /** Only rendered for syntax failures, where it's the useful evidence. */
  source?: string | undefined;
  className?: string | undefined;
}

function MermaidErrorCard({ error, errorKind, source, className }: MermaidErrorCardProps) {
  if (errorKind === 'stale-build') {
    return (
      <div
        className={cn(
          'rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm',
          className,
        )}
      >
        <p className="mb-2 font-medium text-amber-700 dark:text-amber-400">
          Diagram couldn&apos;t load
        </p>
        <p className="mb-3 text-muted-foreground">
          The app was rebuilt after this page was opened, so the diagram renderer it asks for is no
          longer being served. The diagram itself is fine — reload to pick up the new build.
        </p>
        <Button size="sm" variant="outline" onClick={() => window.location.reload()}>
          Reload page
        </Button>
        <p className="mt-3 break-words text-xs text-muted-foreground/70">{error}</p>
      </div>
    );
  }

  return (
    <div
      className={cn('rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm', className)}
    >
      <p className="mb-2 font-medium text-destructive">Diagram failed to render</p>
      <p className="mb-2 break-words text-muted-foreground">{error}</p>
      {source ? <pre className="overflow-x-auto rounded bg-muted p-2 text-xs">{source}</pre> : null}
    </div>
  );
}

export default MermaidErrorCard;
