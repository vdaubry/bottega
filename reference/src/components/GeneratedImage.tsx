/**
 * GeneratedImage — a model-generated image in the chat transcript.
 *
 * Shows a thumbnail large enough to read the image's details, and opens the
 * full-size viewer on click. No provider gives a display size for its images
 * (Codex's `image_gen` reports only where the file was saved), so the size is
 * ours: the image is fitted inside a `THUMBNAIL_MAX_WIDTH` × `THUMBNAIL_MAX_HEIGHT`
 * box, never upscaled, and never wider than the message column — which is what
 * makes it smaller on a phone. The intrinsic size comes from the transcript, so
 * the box is reserved before the bytes arrive and the chat does not jump.
 */

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ExternalLink, ImageOff, Maximize2, X } from 'lucide-react';
import { Button } from './ui/button';

const THUMBNAIL_MAX_WIDTH = 640;
const THUMBNAIL_MAX_HEIGHT = 480;

export interface GeneratedImageProps {
  src: string;
  /** Intrinsic pixel size, when the transcript recorded it. */
  width?: number | undefined;
  height?: number | undefined;
}

/** CSS width of the thumbnail for an image of a known intrinsic size. */
export function thumbnailWidth(width: number, height: number): number {
  return Math.round(
    Math.min(width, THUMBNAIL_MAX_WIDTH, (THUMBNAIL_MAX_HEIGHT * width) / height),
  );
}

interface ImageViewerProps {
  src: string;
  onClose: () => void;
}

/**
 * The full-size viewer. Opens with the whole image fitted to the screen (at
 * its own pixel size when that is smaller); clicking the image switches to
 * actual pixels in a scrollable pane, and back. Portals to `document.body` so
 * the chat's `prose` styles cannot reach it.
 */
function ImageViewer({ src, onClose }: ImageViewerProps) {
  const [actualSize, setActualSize] = useState(false);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  // Focus in on open, back on close.
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panelRef.current?.focus();
    return () => previouslyFocused?.focus();
  }, []);

  return createPortal(
    <div
      ref={panelRef}
      tabIndex={-1}
      className="fixed inset-0 z-50 flex flex-col bg-black/90 outline-none"
      role="dialog"
      aria-modal="true"
      aria-label="Generated image"
    >
      <div className="flex shrink-0 items-center justify-end gap-1 p-2 text-white">
        <Button
          variant="ghost"
          size="sm"
          className="h-8 text-white hover:bg-white/15 hover:text-white"
          onClick={() => setActualSize((prev) => !prev)}
          title={actualSize ? 'Fit to screen' : 'Actual size'}
        >
          <Maximize2 className="mr-1.5 h-3.5 w-3.5" />
          {actualSize ? 'Fit' : '100%'}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 w-8 p-0 text-white hover:bg-white/15 hover:text-white"
          onClick={() => window.open(src, '_blank', 'noopener,noreferrer')}
          title="Open in a new tab"
          aria-label="Open in a new tab"
        >
          <ExternalLink className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 w-8 p-0 text-white hover:bg-white/15 hover:text-white"
          onClick={onClose}
          title="Close (Esc)"
          aria-label="Close"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>

      {/* Clicking the backdrop around the image closes; clicking the image zooms. */}
      <div
        data-testid="image-viewer-backdrop"
        className={`min-h-0 flex-1 p-2 pt-0 sm:p-4 sm:pt-0 ${
          actualSize ? 'overflow-auto' : 'flex items-center justify-center overflow-hidden'
        }`}
        onClick={(event) => {
          if (event.target === event.currentTarget) onClose();
        }}
      >
        <img
          src={src}
          alt="Generated image, full size"
          onClick={() => setActualSize((prev) => !prev)}
          className={
            actualSize
              ? 'block max-w-none cursor-zoom-out'
              : 'block max-h-full max-w-full cursor-zoom-in object-contain'
          }
        />
      </div>
    </div>,
    document.body,
  );
}

function GeneratedImage({ src, width, height }: GeneratedImageProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <div className="my-2 inline-flex items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400">
        <ImageOff className="h-4 w-4" />
        Generated image unavailable
      </div>
    );
  }

  const hasSize = !!width && !!height;

  return (
    <>
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        title="View full size"
        aria-label="View generated image full size"
        className="my-2 block max-w-full cursor-zoom-in overflow-hidden rounded-lg border border-gray-200 bg-gray-100 transition-shadow hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:border-gray-700 dark:bg-gray-800"
        style={
          hasSize
            ? { width: thumbnailWidth(width, height), aspectRatio: `${width} / ${height}` }
            : undefined
        }
      >
        <img
          src={src}
          alt="Generated image"
          loading="lazy"
          onError={() => setFailed(true)}
          className={hasSize ? 'block h-full w-full' : 'block h-auto max-h-[480px] w-auto max-w-full'}
          {...(hasSize ? { width, height } : {})}
        />
      </button>
      {isOpen && <ImageViewer src={src} onClose={() => setIsOpen(false)} />}
    </>
  );
}

export default GeneratedImage;
