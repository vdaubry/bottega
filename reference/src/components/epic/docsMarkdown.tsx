/**
 * Markdown configuration for the epic's two document surfaces — the
 * architecture document and the technical-specification documents, both
 * rendered through `EpicMarkdownBrowser`: the shared `markdownComponents`,
 * plus one override — a ```mermaid fence renders as a diagram (with its
 * "Open full size" affordance) instead of a code block.
 *
 * Scoped deliberately to those surfaces, still not chat. The documents
 * genuinely contain diagrams (the architecture and specification agents are
 * told to draw them), whereas chat transcripts routinely quote mermaid *as
 * source* — someone pasting a broken diagram to ask about it should see their
 * text, not an error card. Global chat markdown is untouched.
 */

import type { ComponentProps, ComponentType } from 'react';
import { type Components } from 'react-markdown';
import ExpandableMermaidDiagram from './ExpandableMermaidDiagram';
import { markdownComponents, remarkPlugins } from '../markdownComponents';

export { remarkPlugins };

/** Code-block children arrive as a string or an array of strings. */
function toSource(children: unknown): string {
  return (Array.isArray(children) ? children.join('') : ((children as string) ?? '')).replace(
    /\n$/,
    '',
  );
}

// react-markdown types every slot as ElementType (an intrinsic tag name is a
// legal override), which is too wide to spread props into. The shared config
// always supplies a component here, so narrow it once.
const BaseCode = markdownComponents.code as ComponentType<ComponentProps<'code'>>;

export const docsMarkdownComponents: Components = {
  ...markdownComponents,
  code: (props) => {
    const { className, children } = props;
    if (className?.includes('language-mermaid')) {
      // The inline diagram renders its own error card for invalid sources, so
      // a diagram an agent got wrong degrades to a readable message plus the
      // source — never a blank spot in the document. The viewer's open/closed
      // state lives inside the affordance: this table is a module constant,
      // and a per-render table would remount every diagram in the document.
      return <ExpandableMermaidDiagram source={toSource(children)} className="my-3" />;
    }
    return <BaseCode {...props} />;
  },
};
