import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import AtlasArtifactSwitcher from './AtlasArtifactSwitcher';

describe('AtlasArtifactSwitcher', () => {
  it('renders nothing when fewer than two kinds exist', () => {
    const { container } = render(
      <AtlasArtifactSwitcher available={['plan']} activeKind="plan" onSelect={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders a segment per available kind in a stable order', () => {
    render(
      <AtlasArtifactSwitcher
        available={['architecture', 'plan']}
        activeKind="plan"
        onSelect={vi.fn()}
      />,
    );
    const tabs = screen.getAllByRole('tab');
    // ARTIFACT_KINDS order is plan, flowchart, architecture → plan before architecture.
    expect(tabs.map((t) => t.textContent)).toEqual(['Plan', 'Architecture']);
  });

  it('marks the active kind selected and fires onSelect on click', () => {
    const onSelect = vi.fn();
    render(
      <AtlasArtifactSwitcher
        available={['plan', 'flowchart']}
        activeKind="plan"
        onSelect={onSelect}
      />,
    );
    const flowchart = screen.getByRole('tab', { name: 'Flowchart' });
    expect(screen.getByRole('tab', { name: 'Plan' })).toHaveAttribute('aria-selected', 'true');
    expect(flowchart).toHaveAttribute('aria-selected', 'false');

    fireEvent.click(flowchart);
    expect(onSelect).toHaveBeenCalledWith('flowchart');
  });
});
