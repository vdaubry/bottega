/**
 * DiagramPanZoomPane — one scroll-free viewport onto a diagram canvas.
 *
 * The canvas is the diagram's intrinsic mermaid size (`size`); the viewport is
 * whatever box the layout gives us. Panning is drag-to-move, zooming is
 * wheel-toward-the-cursor.
 *
 * The pane holds NO camera state of its own: scale and offset are derived from
 * the `camera` prop every render, and gestures report back through
 * `onCameraChange`. The viewer owns the camera, so its toolbar and keyboard
 * shortcuts (fit, actual size, ±) move exactly the view the gestures do, and
 * one `Camera` can be handed to any diagram whatever its size.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { cn } from '../../lib/utils';
import {
  cameraFrom,
  cameraOffset,
  cameraScale,
  clampOffset,
  clampScale,
  zoomAbout,
  type Camera,
  type Offset,
  type Size,
} from './panZoom';

interface DiagramPanZoomPaneProps {
  svg: string;
  size: Size;
  camera: Camera;
  onCameraChange: (camera: Camera) => void;
  onViewportChange: (viewport: Size) => void;
  /**
   * False keeps the pane mounted but inert and invisible (for a viewer that
   * swaps diagrams in place); the single-diagram viewer always passes true.
   */
  isActive: boolean;
  label: string;
}

const EMPTY_VIEWPORT: Size = { width: 0, height: 0 };

function DiagramPanZoomPane({
  svg,
  size,
  camera,
  onCameraChange,
  onViewportChange,
  isActive,
  label,
}: DiagramPanZoomPaneProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState<Size>(EMPTY_VIEWPORT);
  const [isPanning, setIsPanning] = useState(false);
  const dragOrigin = useRef<{ pointerX: number; pointerY: number; offset: Offset } | null>(null);

  const scale = cameraScale(camera, size, viewport);
  const offset = cameraOffset(camera, size, viewport);

  // Measure the viewport — every camera-to-pixels conversion depends on it.
  // The inactive pane is `invisible`, not unmounted or `display:none`, so it
  // keeps a real box and stays measured while hidden.
  useLayoutEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const measure = () => {
      const rect = el.getBoundingClientRect();
      const next = { width: rect.width, height: rect.height };
      setViewport((prev) =>
        prev.width === next.width && prev.height === next.height ? prev : next,
      );
      onViewportChange(next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [onViewportChange]);

  // Wheel must be a non-passive native listener: React routes onWheel through a
  // passive root listener, where preventDefault() is a no-op and the page would
  // scroll behind the modal.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el || !isActive) return;
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = el.getBoundingClientRect();
      const anchor = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      // deltaMode 1 is lines, not pixels.
      const deltaY = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
      const nextScale = clampScale(scale * Math.exp(-deltaY * 0.0015));
      const nextOffset = clampOffset(
        zoomAbout(offset, scale, nextScale, anchor),
        size,
        viewport,
        nextScale,
      );
      onCameraChange(cameraFrom(nextScale, nextOffset, size, viewport));
    };
    el.addEventListener('wheel', handleWheel, { passive: false });
    return () => el.removeEventListener('wheel', handleWheel);
  }, [isActive, scale, offset, size, viewport, onCameraChange]);

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      dragOrigin.current = { pointerX: event.clientX, pointerY: event.clientY, offset };
      setIsPanning(true);
      event.currentTarget.setPointerCapture?.(event.pointerId);
    },
    [offset],
  );

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const origin = dragOrigin.current;
      if (!origin) return;
      const next = clampOffset(
        {
          x: origin.offset.x + (event.clientX - origin.pointerX),
          y: origin.offset.y + (event.clientY - origin.pointerY),
        },
        size,
        viewport,
        scale,
      );
      onCameraChange(cameraFrom(scale, next, size, viewport));
    },
    [size, viewport, scale, onCameraChange],
  );

  const endPan = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    dragOrigin.current = null;
    setIsPanning(false);
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  }, []);

  return (
    <div
      ref={viewportRef}
      data-testid="diagram-viewport"
      data-diagram={label}
      data-active={isActive}
      aria-hidden={!isActive}
      className={cn(
        'absolute inset-0 overflow-hidden bg-background touch-none select-none',
        isActive ? (isPanning ? 'cursor-grabbing' : 'cursor-grab') : 'invisible pointer-events-none',
      )}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endPan}
      onPointerCancel={endPan}
    >
      <div
        data-testid="diagram-canvas"
        className="absolute left-0 top-0 origin-top-left [&_svg]:!h-full [&_svg]:!max-w-none [&_svg]:!w-full"
        style={{
          width: `${size.width}px`,
          height: `${size.height}px`,
          transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
        }}
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    </div>
  );
}

export default DiagramPanZoomPane;
