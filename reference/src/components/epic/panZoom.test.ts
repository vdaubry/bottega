import { describe, it, expect } from 'vitest';
import {
  FITTED_CAMERA,
  MAX_SCALE,
  MIN_SCALE,
  cameraFrom,
  cameraOffset,
  cameraScale,
  clampOffset,
  clampScale,
  fitScale,
  zoomAbout,
  type Size,
} from './panZoom';

// Two real architecture diagrams (epic run #4) — deliberately different sizes,
// which is what the size-relative camera exists to survive.
const LANDSCAPE = { width: 1962, height: 1337 };
const SQUARE = { width: 2245, height: 2241 };
const VIEWPORT = { width: 1424, height: 808 };

describe('clampScale', () => {
  it('keeps the scale inside the usable range', () => {
    expect(clampScale(0.0001)).toBe(MIN_SCALE);
    expect(clampScale(1000)).toBe(MAX_SCALE);
    expect(clampScale(1.5)).toBe(1.5);
  });

  it('falls back to 1:1 on a non-finite scale', () => {
    expect(clampScale(Number.NaN)).toBe(1);
    expect(clampScale(Number.POSITIVE_INFINITY)).toBe(1);
  });
});

describe('fitScale', () => {
  it('fits on the tighter axis', () => {
    expect(fitScale({ width: 2000, height: 4000 }, { width: 1000, height: 1000 })).toBe(0.25);
  });

  it('never magnifies past 1:1 — a small diagram stays at its natural size', () => {
    expect(fitScale({ width: 200, height: 100 }, { width: 1000, height: 1000 })).toBe(1);
  });

  it('is a no-op before the viewport has been measured', () => {
    expect(fitScale({ width: 2000, height: 2000 }, { width: 0, height: 0 })).toBe(1);
  });
});

describe('zoomAbout', () => {
  it('pins the canvas point under the anchor across a zoom', () => {
    const offset = { x: -100, y: -50 };
    const anchor = { x: 300, y: 200 };
    const canvasPoint = { x: anchor.x - offset.x, y: anchor.y - offset.y };

    const next = zoomAbout(offset, 1, 2, anchor);

    expect(next.x + canvasPoint.x * 2).toBeCloseTo(anchor.x, 5);
    expect(next.y + canvasPoint.y * 2).toBeCloseTo(anchor.y, 5);
  });

  it('is a no-op when the previous scale is unusable', () => {
    expect(zoomAbout({ x: 5, y: 5 }, 0, 2, { x: 1, y: 1 })).toEqual({ x: 5, y: 5 });
  });
});

describe('clampOffset', () => {
  const content = { width: 2000, height: 1000 };
  const viewport = { width: 800, height: 600 };

  it('centres an axis where the scaled canvas is smaller than the viewport', () => {
    expect(clampOffset({ x: -999, y: 999 }, content, viewport, 0.2)).toEqual({ x: 200, y: 200 });
  });

  it('never lets an oversized canvas be dragged away from the viewport', () => {
    expect(clampOffset({ x: 500, y: 500 }, content, viewport, 1)).toEqual({ x: 0, y: 0 });
    expect(clampOffset({ x: -9999, y: -9999 }, content, viewport, 1)).toEqual({
      x: -1200,
      y: -400,
    });
  });

  it('leaves an in-range offset alone', () => {
    expect(clampOffset({ x: -300, y: -100 }, content, viewport, 1)).toEqual({ x: -300, y: -100 });
  });
});

describe('the size-relative camera', () => {
  it('fits diagrams of different sizes from the same fitted camera', () => {
    // This is the whole reason the camera is stored relative to fit: one
    // FITTED_CAMERA opens any diagram fitted, whereas an absolute scale taken
    // from the landscape one would show the square one 1.7x too far in.
    const landscapeScale = cameraScale(FITTED_CAMERA, LANDSCAPE, VIEWPORT);
    const squareScale = cameraScale(FITTED_CAMERA, SQUARE, VIEWPORT);

    expect(landscapeScale).not.toBeCloseTo(squareScale, 2);
    expect(LANDSCAPE.width * landscapeScale).toBeLessThanOrEqual(VIEWPORT.width + 0.5);
    expect(LANDSCAPE.height * landscapeScale).toBeLessThanOrEqual(VIEWPORT.height + 0.5);
    expect(SQUARE.width * squareScale).toBeLessThanOrEqual(VIEWPORT.width + 0.5);
    expect(SQUARE.height * squareScale).toBeLessThanOrEqual(VIEWPORT.height + 0.5);
  });

  const centreOf = (camera: { zoom: number; u: number; v: number }, content: Size) => {
    const scale = cameraScale(camera, content, VIEWPORT);
    const offset = cameraOffset(camera, content, VIEWPORT);
    return {
      u: (VIEWPORT.width / 2 - offset.x) / scale / content.width,
      v: (VIEWPORT.height / 2 - offset.y) / scale / content.height,
    };
  };

  it('parks the same fraction of each canvas at the viewport centre', () => {
    // Zoomed 3x, looking slightly right of and below the middle — reachable on
    // both diagrams, so both land on exactly the requested fraction.
    const camera = { zoom: 3, u: 0.6, v: 0.6 };

    for (const content of [LANDSCAPE, SQUARE]) {
      const centre = centreOf(camera, content);
      expect(centre.u).toBeCloseTo(0.6, 3);
      expect(centre.v).toBeCloseTo(0.6, 3);
    }
  });

  it('pulls a camera aimed past the edge back to the edge, never further in', () => {
    // At 3x on SQUARE there is not enough canvas left of the right edge to park
    // u=0.9 in the middle, so the view stops at the edge instead of showing a
    // band of empty background.
    const centre = centreOf({ zoom: 3, u: 0.9, v: 0.5 }, SQUARE);

    expect(centre.u).toBeLessThan(0.9);
    expect(centre.u).toBeGreaterThan(0.5);
    expect(centre.v).toBeCloseTo(0.5, 3);
  });

  it('round-trips a concrete scale + offset back into the same camera', () => {
    const camera = { zoom: 2.5, u: 0.4, v: 0.6 };
    const scale = cameraScale(camera, SQUARE, VIEWPORT);
    const offset = cameraOffset(camera, SQUARE, VIEWPORT);

    const roundTripped = cameraFrom(scale, offset, SQUARE, VIEWPORT);

    expect(roundTripped.zoom).toBeCloseTo(camera.zoom, 5);
    expect(roundTripped.u).toBeCloseTo(camera.u, 5);
    expect(roundTripped.v).toBeCloseTo(camera.v, 5);
  });

  it('reports what a drag actually achieved after clamping', () => {
    // Dragging far past the edge while fitted cannot move anything: the fitted
    // canvas is already centred, so the camera comes back centred.
    const scale = cameraScale(FITTED_CAMERA, LANDSCAPE, VIEWPORT);
    const dragged = clampOffset({ x: 5000, y: 5000 }, LANDSCAPE, VIEWPORT, scale);

    const camera = cameraFrom(scale, dragged, LANDSCAPE, VIEWPORT);

    expect(camera.zoom).toBeCloseTo(1, 5);
    expect(camera.u).toBeCloseTo(0.5, 5);
    expect(camera.v).toBeCloseTo(0.5, 5);
  });

  it('survives a viewport that has not been measured yet', () => {
    expect(cameraScale(FITTED_CAMERA, LANDSCAPE, { width: 0, height: 0 })).toBe(1);
    expect(cameraFrom(1, { x: 0, y: 0 }, { width: 0, height: 0 }, { width: 0, height: 0 })).toEqual(
      { zoom: 1, u: 0, v: 0 },
    );
  });
});
