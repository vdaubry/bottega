/**
 * EpicFileBrowser — the list-plus-viewer shell the epic's document surfaces
 * share: the markdown the stages write (`EpicMarkdownBrowser`, mounted once
 * over the architecture document and once over the technical-specification
 * documents) and the uploaded functional spec (`EpicSpecFilesSection`).
 *
 * They differ only in where the bytes come from and how they are rendered, so
 * both are passed in. Content is fetched on selection and cached per file
 * version. Agents revise documents in place, so the server-provided mtime is
 * part of the cache key and a same-name, same-size rewrite is still reloaded.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { FileText } from 'lucide-react';
import { cn } from '../../lib/utils';
import type { EpicFileInfo } from '@shared/api/epics';

export interface EpicFileBrowserProps {
  files: EpicFileInfo[];
  /** Resolves a filename to its text, or throws. */
  loadFile: (filename: string) => Promise<string>;
  render: (content: string, filename: string) => ReactNode;
  /** Shown in place of everything when there are no files yet. */
  emptyNote: string;
}

function EpicFileBrowser({ files, loadFile, render, emptyNote }: EpicFileBrowserProps) {
  const [selected, setSelected] = useState<string | null>(null);
  const [cache, setCache] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  // Default to the first file — for documents that is `00-master.md`, the map
  // the specification agent is told to write first.
  const firstFile = files[0]?.name ?? null;
  const selectedFile = files.find((file) => file.name === selected) ?? null;
  const selectedVersion = selectedFile
    ? `${selectedFile.size}:${selectedFile.modifiedAtMs}`
    : null;
  const cacheKey = selected && selectedVersion ? `${selected}:${selectedVersion}` : null;
  useEffect(() => {
    setSelected((current) =>
      current && files.some((f) => f.name === current) ? current : firstFile,
    );
  }, [files, firstFile]);

  // Selecting a file is the ONLY trigger for loading it: a click that also
  // fetched would race this effect and read the same file twice. The loader
  // and the cache live in refs so the effect depends on the selection alone
  // (the app-wide handlers-in-a-ref convention).
  const loadFileRef = useRef(loadFile);
  loadFileRef.current = loadFile;
  const cacheRef = useRef(cache);
  cacheRef.current = cache;

  useEffect(() => {
    if (!selected || !cacheKey) return;
    setError(null);
    if (cacheRef.current[cacheKey] !== undefined) return;

    let cancelled = false;
    setIsLoading(true);
    loadFileRef
      .current(selected)
      .then((content) => {
        if (!cancelled) setCache((prev) => ({ ...prev, [cacheKey]: content }));
      })
      .catch(() => {
        if (!cancelled) setError(`Could not read ${selected}.`);
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [cacheKey, selected]);

  if (files.length === 0) {
    return (
      <p className="rounded-md border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
        {emptyNote}
      </p>
    );
  }

  const content = cacheKey ? cache[cacheKey] : undefined;

  return (
    <div className="grid gap-3 md:grid-cols-[minmax(0,14rem)_1fr]">
      <ul className="space-y-1">
        {files.map((file) => (
          <li key={file.name}>
            <button
              type="button"
              onClick={() => setSelected(file.name)}
              className={cn(
                'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted/60',
                selected === file.name && 'bg-muted font-medium',
              )}
            >
              <FileText className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{file.name}</span>
            </button>
          </li>
        ))}
      </ul>

      <div className="min-w-0 rounded-md border border-border bg-card p-4">
        {error ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : content === undefined ? (
          <p className="text-sm text-muted-foreground">{isLoading ? 'Loading…' : 'Select a file.'}</p>
        ) : (
          render(content, selected!)
        )}
      </div>
    </div>
  );
}

export default EpicFileBrowser;
