/**
 * Tab strip for the Explore view: a pinned Schema tab followed by closable file
 * tabs. A file opened by a single click is a *preview* tab, rendered italic and
 * reused by the next single click; double-clicking the tab pins it (standard
 * IDE behaviour).
 */

import React from 'react';
import { Network, X } from 'lucide-react';
import { cn } from '../../lib/utils';
import { SCHEMA_TAB_ID, fileTabId } from './atlasTabsReducer';

interface AtlasTabsProps {
  filePaths: string[];
  activeTabId: string;
  previewPath: string | null;
  onSelect: (id: string) => void;
  onPin: (path: string) => void;
  onCloseFile: (path: string) => void;
}

const basename = (path: string): string => path.split('/').pop() || path;

function AtlasTabs({
  filePaths,
  activeTabId,
  previewPath,
  onSelect,
  onPin,
  onCloseFile,
}: AtlasTabsProps) {
  const tabClass = (id: string): string =>
    cn(
      'flex max-w-48 flex-shrink-0 cursor-pointer items-center gap-1.5 border-r border-border px-3 py-1.5 text-sm',
      activeTabId === id
        ? 'bg-background text-foreground'
        : 'bg-muted/40 text-muted-foreground hover:text-foreground',
    );

  return (
    <div className="flex flex-shrink-0 overflow-x-auto border-b border-border bg-muted/20">
      <button
        type="button"
        className={tabClass(SCHEMA_TAB_ID)}
        onClick={() => onSelect(SCHEMA_TAB_ID)}
      >
        <Network className="h-3.5 w-3.5 flex-shrink-0" />
        Schema
      </button>
      {filePaths.map((path) => {
        const isPreview = path === previewPath;
        return (
          <div
            key={path}
            className={tabClass(fileTabId(path))}
            role="tab"
            title={isPreview ? `${path} — double-click to keep open` : path}
            onClick={() => onSelect(fileTabId(path))}
            onDoubleClick={() => onPin(path)}
          >
            <span className={cn('truncate', isPreview && 'italic')}>{basename(path)}</span>
            <button
              type="button"
              aria-label={`Close ${basename(path)}`}
              className="rounded p-0.5 hover:bg-accent"
              onClick={(e) => {
                e.stopPropagation();
                onCloseFile(path);
              }}
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

export default AtlasTabs;
