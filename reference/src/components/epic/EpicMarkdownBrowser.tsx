/**
 * EpicMarkdownBrowser — reads a set of markdown documents a stage wrote into
 * the epic archive. The page mounts it twice: over the architecture
 * document(s) in `architecture/` and over the technical-specification
 * documents in `docs/`. It knows nothing about where the bytes come from —
 * the page passes the file list and a loader per surface.
 *
 * Rendered with `docsMarkdownComponents`, so a ```mermaid fence inside a
 * document becomes a diagram with an "Open full size" affordance. Read-only by
 * design: the documents are revised by asking in the stage's conversation,
 * never edited here — the transcript is how they got to their current state.
 */

import ReactMarkdown from 'react-markdown';
import EpicFileBrowser from './EpicFileBrowser';
import { docsMarkdownComponents, remarkPlugins } from './docsMarkdown';
import type { EpicFileInfo } from '@shared/api/epics';

export interface EpicMarkdownBrowserProps {
  files: EpicFileInfo[];
  /** Resolves a filename to its markdown, or throws. */
  loadFile: (filename: string) => Promise<string>;
  /** Shown in place of everything while the stage has written nothing. */
  emptyNote: string;
}

function EpicMarkdownBrowser({ files, loadFile, emptyNote }: EpicMarkdownBrowserProps) {
  return (
    <EpicFileBrowser
      files={files}
      loadFile={loadFile}
      emptyNote={emptyNote}
      render={(content) => (
        <div className="prose-sm max-w-none text-sm">
          <ReactMarkdown remarkPlugins={remarkPlugins} components={docsMarkdownComponents}>
            {content}
          </ReactMarkdown>
        </div>
      )}
    />
  );
}

export default EpicMarkdownBrowser;
