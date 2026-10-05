import { describe, it, expect } from 'vitest';
import { classifyMermaidError, parseViewBoxSize } from './useMermaidSvg';

describe('parseViewBoxSize', () => {
  it('reads the intrinsic canvas size mermaid published in the viewBox', () => {
    // Shape of a real mermaid 11 render: the width/height attributes describe
    // the shrink-to-fit behaviour, only the viewBox has the natural size.
    const svg =
      '<svg aria-roledescription="flowchart-v2" viewBox="0 0 2245.4375 2241.5" ' +
      'style="max-width: 2245.4375px;" width="100%" xmlns="http://www.w3.org/2000/svg">';

    expect(parseViewBoxSize(svg)).toEqual({ width: 2245.4375, height: 2241.5 });
  });

  it('accepts a comma-separated viewBox and single quotes', () => {
    expect(parseViewBoxSize("<svg viewBox='0,0,100,50'>")).toEqual({ width: 100, height: 50 });
  });

  it('returns null when there is no usable viewBox', () => {
    expect(parseViewBoxSize('<svg width="100%">')).toBeNull();
    expect(parseViewBoxSize('<svg viewBox="0 0 100">')).toBeNull();
    expect(parseViewBoxSize('<svg viewBox="0 0 nope 50">')).toBeNull();
    expect(parseViewBoxSize('<svg viewBox="0 0 0 50">')).toBeNull();
  });
});

describe('classifyMermaidError', () => {
  it('flags a failed dynamic import as a stale build, in every engine wording', () => {
    // The exact Chromium message seen when a worktree Vite re-optimized into
    // the live server's shared dep cache and renamed the chunk underneath it.
    expect(
      classifyMermaidError(
        'Failed to fetch dynamically imported module: ' +
          'https://bottega.example.com/node_modules/.vite/deps/flowDiagram-23GEKE2U-G342IMBX.js?v=a48b8fba',
      ),
    ).toBe('stale-build');
    expect(classifyMermaidError('error loading dynamically imported module')).toBe('stale-build');
    expect(classifyMermaidError('Importing a module script failed.')).toBe('stale-build');
  });

  it('leaves real mermaid parse errors classified as syntax', () => {
    expect(classifyMermaidError('Parse error on line 2:\n...Expecting SPACE')).toBe('syntax');
    expect(classifyMermaidError('No diagram type detected matching given configuration')).toBe(
      'syntax',
    );
    // "module" alone must not be enough to excuse a bad source.
    expect(classifyMermaidError('Unknown module in diagram definition')).toBe('syntax');
  });
});
