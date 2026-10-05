import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import EpicFileBrowser from './EpicFileBrowser';
import type { EpicFileInfo } from '@shared/api/epics';

function file(modifiedAtMs: number): EpicFileInfo {
  return {
    name: '00-master.md',
    size: 12,
    mimeType: 'text/markdown',
    modifiedAtMs,
  };
}

describe('EpicFileBrowser', () => {
  it('reloads a selected same-name, same-size file when its mtime changes', async () => {
    const loadFile = vi
      .fn<(filename: string) => Promise<string>>()
      .mockResolvedValueOnce('old specification')
      .mockResolvedValueOnce('revised spec text');
    const renderContent = (content: string) => <p>{content}</p>;
    const { rerender } = render(
      <EpicFileBrowser
        files={[file(1)]}
        loadFile={loadFile}
        render={renderContent}
        emptyNote="empty"
      />,
    );

    expect(await screen.findByText('old specification')).toBeInTheDocument();

    rerender(
      <EpicFileBrowser
        files={[file(2)]}
        loadFile={loadFile}
        render={renderContent}
        emptyNote="empty"
      />,
    );

    expect(await screen.findByText('revised spec text')).toBeInTheDocument();
    expect(loadFile).toHaveBeenCalledTimes(2);
  });
});
