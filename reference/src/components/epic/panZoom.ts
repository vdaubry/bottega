/**
 * Pure pan/zoom geometry for the diagram viewer.
 *
 * The canvas size is never invented here: callers pass the diagram's intrinsic
 * size (its mermaid `viewBox`), and everything below is derived from it.
 *
 * `Camera` is stored size-independently rather than in absolute pixels: zoom
 * RELATIVE to whatever "fitted" means for the diagram being viewed, and the
 * centre as a FRACTION of its canvas. In that encoding "fitted and centred" is
 * well defined before the viewport has been measured, survives a viewport
 * resize, and means the same thing for a 1962x1337 diagram as for a 2245x2241
 * one — so the viewer opens any diagram on the one `FITTED_CAMERA`, and Fit /
 * actual size are one-liners rather than per-diagram arithmetic.
 */

export interface Size {
  width: number;
  height: number;
}

export interface Offset {
  x: number;
  y: number;
}

export interface Camera {
  /** Zoom relative to "fits the viewport": 1 is fitted, 2 is twice that. */
  zoom: number;
  /** Canvas point parked at the viewport centre, as a fraction of the canvas. */
  u: number;
  v: number;
}

export const MIN_SCALE = 0.05;
export const MAX_SCALE = 4;

/** Multiplicative step for the +/− buttons and keyboard shortcuts. */
export const ZOOM_STEP = 1.25;

/** Whole diagram, centred — where the viewer opens. */
export const FITTED_CAMERA: Camera = { zoom: 1, u: 0.5, v: 0.5 };

export function clampScale(scale: number): number {
  if (!Number.isFinite(scale)) return 1;
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

/**
 * Largest scale at which `content` fits entirely inside `viewport`. Capped at
 * 1: a diagram smaller than the viewport is shown at its natural size rather
 * than blown up (magnifying past 1:1 buys no detail, it just looks broken).
 */
export function fitScale(content: Size, viewport: Size): number {
  if (content.width <= 0 || content.height <= 0) return 1;
  if (viewport.width <= 0 || viewport.height <= 0) return 1;
  return clampScale(
    Math.min(1, viewport.width / content.width, viewport.height / content.height),
  );
}

/**
 * New offset that keeps the canvas point currently under `anchor` (viewport
 * coordinates) pinned there across a scale change — i.e. zoom toward the
 * cursor, not toward the origin.
 */
export function zoomAbout(offset: Offset, from: number, to: number, anchor: Offset): Offset {
  if (from <= 0) return offset;
  const canvasX = (anchor.x - offset.x) / from;
  const canvasY = (anchor.y - offset.y) / from;
  return { x: anchor.x - canvasX * to, y: anchor.y - canvasY * to };
}

/**
 * Keeps the scaled canvas reachable: centred on any axis where it is smaller
 * than the viewport, and otherwise never dragged so far that its edge crosses
 * into the viewport.
 */
export function clampOffset(
  offset: Offset,
  content: Size,
  viewport: Size,
  scale: number,
): Offset {
  const axis = (value: number, contentPx: number, viewportPx: number): number => {
    const scaled = contentPx * scale;
    if (scaled <= viewportPx) return (viewportPx - scaled) / 2;
    return Math.min(0, Math.max(viewportPx - scaled, value));
  };
  return {
    x: axis(offset.x, content.width, viewport.width),
    y: axis(offset.y, content.height, viewport.height),
  };
}

/** Absolute CSS scale this camera means for this diagram in this viewport. */
export function cameraScale(camera: Camera, content: Size, viewport: Size): number {
  return clampScale(camera.zoom * fitScale(content, viewport));
}

/** Pan offset that parks the camera's canvas fraction at the viewport centre. */
export function cameraOffset(camera: Camera, content: Size, viewport: Size): Offset {
  const scale = cameraScale(camera, content, viewport);
  return clampOffset(
    {
      x: viewport.width / 2 - camera.u * content.width * scale,
      y: viewport.height / 2 - camera.v * content.height * scale,
    },
    content,
    viewport,
    scale,
  );
}

/**
 * The camera implied by a concrete scale + offset — how a drag or a wheel-zoom
 * reports back what it did. Round-trips exactly with `cameraOffset`.
 */
export function cameraFrom(
  scale: number,
  offset: Offset,
  content: Size,
  viewport: Size,
): Camera {
  const fit = fitScale(content, viewport);
  const width = content.width > 0 ? content.width : 1;
  const height = content.height > 0 ? content.height : 1;
  const safeScale = scale > 0 ? scale : 1;
  return {
    zoom: fit > 0 ? safeScale / fit : 1,
    u: (viewport.width / 2 - offset.x) / safeScale / width,
    v: (viewport.height / 2 - offset.y) / safeScale / height,
  };
}
