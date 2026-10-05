/**
 * Lazy file tree for the Explore view — children are fetched per directory on
 * first expand (port of CodeAtlas's tree.ts semantics). A single click opens a
 * file in a reusable preview tab; a double click pins it. The row of the active
 * file stays highlighted.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, FileText, Folder } from 'lucide-react';
import { cn } from '../../lib/utils';
import { api } from '../../utils/api';
import type { AtlasTreeEntry } from '@shared/types/atlas';

interface AtlasFileTreeProps {
  taskId: number;
  activePath: string | null;
  /** `preview` true for a single click (reusable tab), false to pin it. */
  onOpenFile: (path: string, preview: boolean) => void;
  onError: (message: string) => void;
}

function AtlasFileTree({ taskId, activePath, onOpenFile, onError }: AtlasFileTreeProps) {
  // '' is the workspace root; every other key is a directory's relative path.
  const [children, setChildren] = useState<Record<string, AtlasTreeEntry[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState<Set<string>>(new Set());

  const loadDir = useCallback(
    async (dirPath: string) => {
      setLoading((prev) => new Set(prev).add(dirPath));
      try {
        const response = await api.atlas.tree(taskId, dirPath);
        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error || 'Failed to list directory');
        }
        const entries = await response.json();
        setChildren((prev) => ({ ...prev, [dirPath]: entries }));
      } catch (error) {
        onError(error instanceof Error ? error.message : String(error));
      } finally {
        setLoading((prev) => {
          const next = new Set(prev);
          next.delete(dirPath);
          return next;
        });
      }
    },
    [taskId, onError],
  );

  useEffect(() => {
    void loadDir('');
  }, [loadDir]);

  const toggleDir = useCallback(
    (dirPath: string) => {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(dirPath)) {
          next.delete(dirPath);
        } else {
          next.add(dirPath);
        }
        return next;
      });
      if (children[dirPath] === undefined) void loadDir(dirPath);
    },
    [children, loadDir],
  );

  const renderEntries = (dirPath: string, depth: number): React.ReactNode => {
    const entries = children[dirPath];
    if (!entries) {
      return loading.has(dirPath) ? (
        <div
          className="py-1 text-xs text-muted-foreground"
          style={{ paddingLeft: `${depth * 12 + 24}px` }}
        >
          Loading…
        </div>
      ) : null;
    }
    return entries.map((entry) =>
      entry.type === 'dir' ? (
        <div key={entry.path}>
          <button
            type="button"
            className="flex w-full items-center gap-1 rounded px-1.5 py-0.5 text-left text-sm text-foreground/80 hover:bg-accent"
            style={{ paddingLeft: `${depth * 12 + 6}px` }}
            onClick={() => toggleDir(entry.path)}
          >
            {expanded.has(entry.path) ? (
              <ChevronDown className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
            )}
            <Folder className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
            <span className="truncate">{entry.name}</span>
          </button>
          {expanded.has(entry.path) && renderEntries(entry.path, depth + 1)}
        </div>
      ) : (
        <button
          key={entry.path}
          type="button"
          className={cn(
            'flex w-full items-center gap-1 rounded px-1.5 py-0.5 text-left text-sm hover:bg-accent',
            activePath === entry.path
              ? 'bg-accent text-accent-foreground'
              : 'text-foreground/80',
          )}
          style={{ paddingLeft: `${depth * 12 + 24}px` }}
          onClick={() => onOpenFile(entry.path, true)}
          onDoubleClick={() => onOpenFile(entry.path, false)}
        >
          <FileText className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
          <span className="truncate">{entry.name}</span>
        </button>
      ),
    );
  };

  return <div className="overflow-y-auto py-1 pr-1">{renderEntries('', 0)}</div>;
}

export default AtlasFileTree;
