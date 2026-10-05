import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { act } from 'react';
import AtlasArtifactView from './AtlasArtifactView';

const HTML = '<!doctype html><html><body>artifact</body></html>';

function fireMessage(source: Window | null, data: unknown): void {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data, source }));
  });
}

describe('AtlasArtifactView', () => {
  it('renders a sandboxed iframe (no allow-same-origin) with the html as srcdoc', () => {
    render(<AtlasArtifactView html={HTML} isDarkMode={false} onOpenSource={vi.fn()} />);
    const iframe = screen.getByTestId('atlas-artifact-view') as HTMLIFrameElement;
    expect(iframe.getAttribute('sandbox')).toBe('allow-scripts allow-popups');
    expect(iframe.getAttribute('sandbox')).not.toContain('allow-same-origin');
    expect(iframe.getAttribute('srcdoc')).toBe(HTML);
  });

  it('routes a valid bottega-open-source message from its own iframe to onOpenSource', () => {
    const onOpenSource = vi.fn();
    render(<AtlasArtifactView html={HTML} isDarkMode={false} onOpenSource={onOpenSource} />);
    const iframe = screen.getByTestId('atlas-artifact-view') as HTMLIFrameElement;

    fireMessage(iframe.contentWindow, {
      type: 'bottega-open-source',
      path: 'src/index.ts',
      line: 12,
    });

    expect(onOpenSource).toHaveBeenCalledWith('src/index.ts', 12);
  });

  it('omits the line when not a number', () => {
    const onOpenSource = vi.fn();
    render(<AtlasArtifactView html={HTML} isDarkMode={false} onOpenSource={onOpenSource} />);
    const iframe = screen.getByTestId('atlas-artifact-view') as HTMLIFrameElement;

    fireMessage(iframe.contentWindow, { type: 'bottega-open-source', path: 'a.ts' });

    expect(onOpenSource).toHaveBeenCalledWith('a.ts', undefined);
  });

  it('ignores messages from a foreign window (source mismatch)', () => {
    const onOpenSource = vi.fn();
    render(<AtlasArtifactView html={HTML} isDarkMode={false} onOpenSource={onOpenSource} />);

    // A message whose source is NOT our iframe's contentWindow (e.g. window).
    fireMessage(window, { type: 'bottega-open-source', path: 'evil.ts', line: 1 });

    expect(onOpenSource).not.toHaveBeenCalled();
  });

  it('ignores unrelated message shapes', () => {
    const onOpenSource = vi.fn();
    render(<AtlasArtifactView html={HTML} isDarkMode={false} onOpenSource={onOpenSource} />);
    const iframe = screen.getByTestId('atlas-artifact-view') as HTMLIFrameElement;

    fireMessage(iframe.contentWindow, { type: 'something-else', path: 'a.ts' });
    fireMessage(iframe.contentWindow, { type: 'bottega-open-source' }); // no path

    expect(onOpenSource).not.toHaveBeenCalled();
  });
});
