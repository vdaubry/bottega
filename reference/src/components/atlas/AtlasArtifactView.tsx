/**
 * AtlasArtifactView — renders a generated artifact in a sandboxed iframe.
 *
 * Each artifact is a complete standalone HTML document (global CSS + inline
 * <script>). We assign it to `iframe.srcdoc` with
 * `sandbox="allow-scripts allow-popups"` (NO `allow-same-origin`), giving the
 * artifact an opaque origin: its scripts run, but it cannot read the app's
 * cookies, localStorage, or DOM. The host and artifact talk only via
 * `postMessage`:
 *   - host → artifact: { type: 'bottega-theme', theme }   (theme sync)
 *   - artifact → host: { type: 'bottega-open-source', path, line? } (open file)
 *
 * Messages are validated by `event.source === iframe.contentWindow` + shape;
 * the origin is "null" under the sandbox, so we deliberately do not gate on it.
 */

import { useEffect, useRef } from 'react';

interface AtlasArtifactViewProps {
  /** The self-contained HTML document to render. */
  html: string;
  /** Current app theme; pushed to the artifact whenever it changes. */
  isDarkMode: boolean;
  /** Called when the artifact requests a source file be opened. */
  onOpenSource: (path: string, line?: number) => void;
}

function postTheme(win: Window | null, isDarkMode: boolean): void {
  win?.postMessage({ type: 'bottega-theme', theme: isDarkMode ? 'dark' : 'light' }, '*');
}

export default function AtlasArtifactView({
  html,
  isDarkMode,
  onOpenSource,
}: AtlasArtifactViewProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const onOpenSourceRef = useRef(onOpenSource);
  onOpenSourceRef.current = onOpenSource;

  // Validate + route messages coming from the sandboxed artifact.
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const iframe = iframeRef.current;
      // Only trust messages from our own iframe's window (origin is "null"
      // under the sandbox, so source identity is the gate, not origin).
      if (!iframe || event.source !== iframe.contentWindow) return;
      const data = event.data as { type?: unknown; path?: unknown; line?: unknown } | null;
      if (!data || typeof data !== 'object') return;
      if (data.type === 'bottega-open-source' && typeof data.path === 'string') {
        const line = typeof data.line === 'number' ? data.line : undefined;
        onOpenSourceRef.current(data.path, line);
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  // Push the theme on mount/reload (the artifact also reads it in its
  // apply-before-paint script) and whenever the app theme changes.
  useEffect(() => {
    postTheme(iframeRef.current?.contentWindow ?? null, isDarkMode);
  }, [isDarkMode, html]);

  return (
    <iframe
      ref={iframeRef}
      title="Explore artifact"
      // No `allow-same-origin`: opaque origin sandbox. Scripts run; popups
      // (e.g. target=_blank links) are allowed, but app cookies/storage/DOM
      // are unreachable.
      sandbox="allow-scripts allow-popups"
      srcDoc={html}
      onLoad={() => postTheme(iframeRef.current?.contentWindow ?? null, isDarkMode)}
      className="h-full w-full border-0 bg-background"
      data-testid="atlas-artifact-view"
    />
  );
}
