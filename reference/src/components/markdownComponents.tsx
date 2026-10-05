/**
 * Shared react-markdown configuration for full-page document rendering —
 * extracted from TaskShowPage so the Explore view's Plan tab renders the task
 * doc identically.
 */

import React from 'react';
import { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';

export const markdownComponents: Components = {
  code: ({ className, children, ...props }) => {
    const hasLanguage = className?.startsWith('language-');
    // react-markdown delivers code-block children as a string (or string[])
    const codeString = (Array.isArray(children) ? children.join('') : children as string ?? '').replace(/\n$/, '');
    const isMultiline = codeString.includes('\n');
    const isBlock = hasLanguage || isMultiline;

    if (isBlock) {
      return (
        <pre className="bg-muted text-foreground rounded-md p-4 overflow-x-auto my-2 text-sm">
          <code className={`${className || ''} text-foreground`.trim()}>{children}</code>
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

export const remarkPlugins = [remarkGfm, remarkBreaks];
