import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import GeneratedImage, { thumbnailWidth } from './GeneratedImage';

const SRC = '/api/conversations/5/images/exec-1.png?token=t';

function thumbnail() {
  return screen.getByRole('button', { name: 'View generated image full size' });
}

describe('thumbnailWidth', () => {
  it('fits a landscape image to the box width', () => {
    expect(thumbnailWidth(1536, 1024)).toBe(640);
  });

  it('fits a portrait image to the box height', () => {
    expect(thumbnailWidth(1024, 1536)).toBe(320);
  });

  it('never upscales a small image', () => {
    expect(thumbnailWidth(200, 100)).toBe(200);
  });
});

describe('GeneratedImage', () => {
  it('reserves the thumbnail box from the intrinsic size and stays inside the column', () => {
    render(<GeneratedImage src={SRC} width={1536} height={1024} />);

    const button = thumbnail();
    expect(button.style.width).toBe('640px');
    expect(button.style.aspectRatio).toBe('1536 / 1024');
    expect(button).toHaveClass('max-w-full');
    expect(screen.getByAltText('Generated image')).toHaveAttribute('src', SRC);
  });

  it('falls back to a CSS-bounded thumbnail when the size is unknown', () => {
    render(<GeneratedImage src={SRC} />);

    expect(thumbnail().style.width).toBe('');
    expect(screen.getByAltText('Generated image')).toHaveClass('max-w-full', 'max-h-[480px]');
  });

  it('opens the full-size viewer on click and toggles fit / actual size', () => {
    render(<GeneratedImage src={SRC} width={1536} height={1024} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    fireEvent.click(thumbnail());

    expect(screen.getByRole('dialog', { name: 'Generated image' })).toBeInTheDocument();
    const full = screen.getByAltText('Generated image, full size');
    expect(full).toHaveAttribute('src', SRC);
    expect(full).toHaveClass('max-h-full', 'max-w-full');

    fireEvent.click(full);
    expect(full).toHaveClass('max-w-none');
    expect(full).not.toHaveClass('max-h-full');

    fireEvent.click(screen.getByRole('button', { name: /Fit/ }));
    expect(full).toHaveClass('max-h-full', 'max-w-full');
  });

  it('closes on Escape, on the close button, and on a backdrop click', () => {
    render(<GeneratedImage src={SRC} width={1536} height={1024} />);

    fireEvent.click(thumbnail());
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    fireEvent.click(thumbnail());
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    fireEvent.click(thumbnail());
    fireEvent.click(screen.getByTestId('image-viewer-backdrop'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('says so when the image cannot be loaded', () => {
    render(<GeneratedImage src={SRC} width={1536} height={1024} />);

    fireEvent.error(screen.getByAltText('Generated image'));

    expect(screen.getByText('Generated image unavailable')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
