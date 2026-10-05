import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('mermaid', () => ({
  default: { initialize: vi.fn(), render: vi.fn() },
}));

vi.mock('../../contexts/ThemeContext', () => ({
  useTheme: () => ({ isDarkMode: false, toggleTheme: vi.fn() }),
}));

import mermaid from 'mermaid';
import DiagramModal from './DiagramModal';

const SOURCE = 'flowchart LR\n  Importer --> Queue';
const SVG = '<svg data-testid="diagram-svg" viewBox="0 0 1962 1337" width="100%"></svg>';

function renderModal({ title, onClose = vi.fn() }: { title?: string; onClose?: () => void } = {}) {
  const utils = render(<DiagramModal source={SOURCE} title={title} onClose={onClose} />);
  return { onClose, ...utils };
}

async function waitForMounted() {
  await waitFor(() => expect(screen.getByTestId('diagram-canvas')).toBeInTheDocument());
}

function zoomLevel() {
  return screen.getByTestId('zoom-level');
}

describe('DiagramModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(mermaid.render).mockResolvedValue({ svg: SVG } as never);
  });

  it('opens as a labelled dialog on the fitted view', async () => {
    renderModal({ title: 'Sync pipeline' });
    await waitForMounted();

    expect(screen.getByRole('dialog', { name: 'Diagram: Sync pipeline' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Sync pipeline' })).toBeInTheDocument();
    expect(zoomLevel()).toHaveTextContent('100%');

    const viewports = screen.getAllByTestId('diagram-viewport');
    expect(viewports).toHaveLength(1);
    expect(viewports[0]).toHaveAttribute('data-active', 'true');
    expect(screen.getByTestId('diagram-svg')).toBeInTheDocument();
  });

  it('falls back to a generic name when the diagram has no title', async () => {
    renderModal();
    await waitForMounted();

    expect(screen.getByRole('dialog', { name: 'Diagram viewer' })).toBeInTheDocument();
  });

  it('zooms from the toolbar and the keyboard, and 0 refits', async () => {
    renderModal();
    await waitForMounted();

    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    await waitFor(() => expect(zoomLevel()).toHaveTextContent('125%'));
    expect(screen.getByTestId('diagram-canvas').style.transform).toContain('scale(1.25)');

    fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
    await waitFor(() => expect(zoomLevel()).toHaveTextContent('100%'));

    fireEvent.keyDown(window, { key: '+' });
    await waitFor(() => expect(zoomLevel()).toHaveTextContent('125%'));

    fireEvent.keyDown(window, { key: '0' });
    await waitFor(() => expect(zoomLevel()).toHaveTextContent('100%'));

    fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
    await waitFor(() => expect(zoomLevel()).toHaveTextContent('80%'));
    fireEvent.click(screen.getByRole('button', { name: /Fit/ }));
    await waitFor(() => expect(zoomLevel()).toHaveTextContent('100%'));
  });

  it('closes on Escape, on the Close button and on the backdrop', async () => {
    const { onClose } = renderModal();
    await waitForMounted();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByTestId('diagram-backdrop'));
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it('surfaces a render failure without dumping the source', async () => {
    vi.mocked(mermaid.render).mockRejectedValue(new Error('Parse error on line 2'));

    renderModal();

    await waitFor(() => expect(screen.getByText('Diagram failed to render')).toBeInTheDocument());
    expect(screen.getByText('Parse error on line 2')).toBeInTheDocument();
    // The inline diagram behind the modal already shows the source; here it
    // would bury the message.
    expect(screen.queryByText(/Importer --> Queue/)).not.toBeInTheDocument();
    expect(screen.queryByTestId('diagram-viewport')).not.toBeInTheDocument();
  });

  it('shows a placeholder until mermaid answers', () => {
    vi.mocked(mermaid.render).mockReturnValue(new Promise(() => undefined) as never);

    renderModal();

    expect(screen.getByText('Rendering diagram…')).toBeInTheDocument();
    expect(screen.queryByTestId('diagram-viewport')).not.toBeInTheDocument();
    expect(screen.queryByText('Diagram failed to render')).not.toBeInTheDocument();
  });

  it('takes focus on open and hands it back on close', async () => {
    const origin = document.createElement('button');
    origin.textContent = 'Open full size';
    document.body.appendChild(origin);
    origin.focus();
    expect(document.activeElement).toBe(origin);

    const { unmount } = renderModal();
    await waitForMounted();
    expect(document.activeElement).toBe(screen.getByRole('dialog'));

    unmount();
    expect(document.activeElement).toBe(origin);
    origin.remove();
  });
});
