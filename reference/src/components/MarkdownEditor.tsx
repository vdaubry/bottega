/**
 * MarkdownEditor.tsx - Markdown View/Edit Component
 *
 * Displays markdown content with a view/edit toggle.
 * Used for project and task documentation in the task-driven workflow.
 */

import React, {
  useState,
  useEffect,
  useCallback,
  useRef,
  type KeyboardEvent,
} from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { Edit2, Save, X, FileText, Eye } from 'lucide-react';
import { Button } from './ui/button';
import { MicButton } from './MicButton';
import { cn } from '../lib/utils';

// Markdown components for documentation rendering
const markdownComponents: Components = {
  code: ({ className, children, ...props }) => {
    const hasLanguage = className?.startsWith('language-');
    // react-markdown delivers code-block children as a string (or string[])
    const codeString = (Array.isArray(children) ? children.join('') : children as string ?? '').replace(/\n$/, '');
    const isMultiline = codeString.includes('\n');
    const isBlock = hasLanguage || isMultiline;

    if (isBlock) {
      return (
        <pre className="bg-muted text-foreground rounded-md p-4 overflow-x-auto my-2 text-sm">
          <code className={cn(className || '', 'text-foreground')}>{children}</code>
        </pre>
      );
    }

    return (
      <code className="bg-muted text-foreground px-1 py-0.5 rounded text-sm" {...props}>
        {children}
      </code>
    );
  },
  pre: ({ children }) => <>{children}</>,
  p: ({ children }) => <p className="my-1">{children}</p>,
  h1: ({ children }) => <h1 className="text-2xl font-bold mt-6 mb-3">{children}</h1>,
  h2: ({ children }) => <h2 className="text-xl font-semibold mt-6 mb-2">{children}</h2>,
  h3: ({ children }) => <h3 className="text-lg font-semibold mt-4 mb-2">{children}</h3>,
  ul: ({ children }) => <ul className="list-disc ml-4">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal ml-4">{children}</ol>,
  a: ({ href, children }) => (
    <a href={href} className="text-primary hover:underline" target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
  hr: () => <hr className="my-4 border-border" />,
  blockquote: ({ children }) => (
    <blockquote className="border-l-4 border-border pl-4 italic my-3">{children}</blockquote>
  ),
  table: ({ children }) => (
    <div className="overflow-x-auto my-3">
      <table className="min-w-full border-collapse border border-border text-sm">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-muted">{children}</thead>,
  th: ({ children }) => <th className="border border-border px-3 py-2 text-left font-semibold">{children}</th>,
  td: ({ children }) => <td className="border border-border px-3 py-2">{children}</td>,
};

const remarkPlugins = [remarkGfm, remarkBreaks];

export interface SaveResult {
  success: boolean;
  error?: string | undefined;
}

interface MarkdownEditorProps {
  content: string | null | undefined;
  onSave?: ((content: string) => Promise<SaveResult>) | undefined;
  onEditClick?: (() => void) | undefined;
  onShowClick?: (() => void) | undefined;
  isLoading?: boolean | undefined;
  placeholder?: string | undefined;
  className?: string | undefined;
  editable?: boolean | undefined;
}

function MarkdownEditor({
  content,
  onSave,
  onEditClick,
  onShowClick,
  isLoading = false,
  placeholder = 'No documentation yet. Click Edit to add content.',
  className,
  editable = true
}: MarkdownEditorProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editContent, setEditContent] = useState<string>(content ?? '');
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Sync edit content when external content changes
  useEffect(() => {
    setEditContent(content ?? '');
  }, [content]);

  const handleEdit = useCallback(() => {
    // If onEditClick is provided, use external navigation (full-page editor)
    if (onEditClick) {
      onEditClick();
      return;
    }
    // Otherwise use inline editing
    setEditContent(content ?? '');
    setIsEditing(true);
    setError(null);
  }, [content, onEditClick]);

  const handleCancel = useCallback(() => {
    setEditContent(content ?? '');
    setIsEditing(false);
    setError(null);
  }, [content]);

  const handleSave = useCallback(async () => {
    if (!onSave) return;

    setIsSaving(true);
    setError(null);

    try {
      const result = await onSave(editContent);
      if (result.success) {
        setIsEditing(false);
      } else {
        setError(result.error || 'Failed to save');
      }
    } catch (err) {
      setError((err as Error)?.message || 'Failed to save');
    } finally {
      setIsSaving(false);
    }
  }, [editContent, onSave]);

  // Handle keyboard shortcuts
  const handleKeyDown = useCallback((e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Escape') {
      handleCancel();
    } else if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      void handleSave();
    }
  }, [handleCancel, handleSave]);

  if (isLoading) {
    return (
      <div className={cn('p-4', className)}>
        <div className="animate-pulse space-y-3">
          <div className="h-4 bg-muted rounded w-3/4" />
          <div className="h-4 bg-muted rounded w-1/2" />
          <div className="h-4 bg-muted rounded w-5/6" />
        </div>
      </div>
    );
  }

  return (
    <div className={cn('flex flex-col md:h-full', className)}>
      {/* Header with actions */}
      <div className="flex items-center justify-between p-3 border-b border-border">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          {isEditing ? (
            <>
              <Edit2 className="w-4 h-4" />
              <span>Editing</span>
            </>
          ) : (
            <>
              <FileText className="w-4 h-4" />
              <span>Documentation</span>
            </>
          )}
        </div>

        {editable && (
          <div className="flex items-center gap-2">
            {isEditing ? (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleCancel}
                  disabled={isSaving}
                >
                  <X className="w-4 h-4 mr-1" />
                  Cancel
                </Button>
                <Button
                  variant="default"
                  size="sm"
                  onClick={handleSave}
                  disabled={isSaving}
                >
                  <Save className="w-4 h-4 mr-1" />
                  {isSaving ? 'Saving...' : 'Save'}
                </Button>
              </>
            ) : (
              <>
                {onShowClick && content && (
                  <Button variant="outline" size="sm" onClick={onShowClick}>
                    <Eye className="w-4 h-4 mr-1" />
                    Show
                  </Button>
                )}
                <Button variant="outline" size="sm" onClick={handleEdit}>
                  <Edit2 className="w-4 h-4 mr-1" />
                  Edit
                </Button>
              </>
            )}
          </div>
        )}
      </div>

      {/* Error message */}
      {error && (
        <div className="mx-3 mt-3 p-2 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded text-sm text-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      {/* Content area */}
      <div className="flex-1 overflow-auto p-4">
        {isEditing ? (
          <div className="flex gap-2 items-start h-full">
            <textarea
              ref={textareaRef}
              value={editContent}
              onChange={(e) => setEditContent(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Enter markdown content..."
              className="flex-1 h-full min-h-[200px] p-3 bg-background border border-border rounded-md resize-none focus:outline-none focus:ring-2 focus:ring-primary/20 font-mono text-sm"
              autoFocus
            />
            <MicButton
              onTranscript={(transcript: string) => {
                setEditContent(prev => {
                  if (!prev.trim()) return transcript;
                  return prev.trimEnd() + ' ' + transcript;
                });
                requestAnimationFrame(() => {
                  if (textareaRef.current) {
                    textareaRef.current.focus();
                  }
                });
              }}
            />
          </div>
        ) : content ? (
          <div className="prose prose-sm dark:prose-invert max-w-none break-words [overflow-wrap:anywhere]">
            <ReactMarkdown remarkPlugins={remarkPlugins} components={markdownComponents}>
              {content}
            </ReactMarkdown>
          </div>
        ) : (
          <div className="text-center text-muted-foreground py-8">
            <FileText className="w-12 h-12 mx-auto mb-3 opacity-50" />
            <p>{placeholder}</p>
          </div>
        )}
      </div>

      {/* Keyboard hints when editing */}
      {isEditing && (
        <div className="px-4 py-2 border-t border-border text-xs text-muted-foreground flex items-center gap-4">
          <span>
            <kbd className="px-1.5 py-0.5 bg-muted rounded">Ctrl</kbd>+
            <kbd className="px-1.5 py-0.5 bg-muted rounded">S</kbd> Save
          </span>
          <span>
            <kbd className="px-1.5 py-0.5 bg-muted rounded">Esc</kbd> Cancel
          </span>
        </div>
      )}
    </div>
  );
}

export default MarkdownEditor;
