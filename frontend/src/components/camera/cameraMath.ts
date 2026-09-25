/**
 * The camera's arithmetic, kept apart from the DOM so it can be tested: what
 * part of a video frame the viewfinder shows (so the photo is exactly what was
 * framed), and the document clean-up applied in Document mode.
 */

export interface Crop {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

/**
 * The centred region of a `videoW`x`videoH` frame with aspect `aspect`
 * (width/height), narrowed further by `zoom` (1 = no zoom). Matches CSS
 * object-fit: cover plus a centred scale, so what you see is what you get.
 */
export function viewfinderCrop(videoW: number, videoH: number, aspect: number, zoom = 1): Crop {
  const z = Math.max(1, zoom);
  let sw = videoW;
  let sh = videoW / aspect;
  if (sh > videoH) {
    sh = videoH;
    sw = videoH * aspect;
  }
  sw /= z;
  sh /= z;
  return { sx: (videoW - sw) / 2, sy: (videoH - sh) / 2, sw, sh };
}

/** Portrait phones frame 3:4, landscape screens 4:3. */
export function frameAspect(viewportW: number, viewportH: number): number {
  return viewportH >= viewportW ? 3 / 4 : 4 / 3;
}

/**
 * Document mode: paper white, ink dark, colour dropped. A levels stretch
 * between the 5th and 95th percentile of brightness, then a gentle S-curve,
 * so shadows and uneven light fall away without erasing faint handwriting.
 * Works in place on RGBA pixels.
 */
export function enhanceDocument(pixels: Uint8ClampedArray): void {
  const histogram = new Uint32Array(256);
  const count = pixels.length / 4;
  for (let i = 0; i < pixels.length; i += 4) {
    const y = (pixels[i] * 299 + pixels[i + 1] * 587 + pixels[i + 2] * 114) / 1000;
    pixels[i] = y; // keep luma in the red channel for the second pass
    histogram[y | 0] += 1;
  }
  const at = (fraction: number) => {
    let seen = 0;
    for (let v = 0; v < 256; v += 1) {
      seen += histogram[v];
      if (seen >= count * fraction) return v;
    }
    return 255;
  };
  const low = at(0.05);
  const high = Math.max(low + 1, at(0.95));
  const table = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v += 1) {
    const x = Math.min(1, Math.max(0, (v - low) / (high - low)));
    // Smoothstep: contrast in the middle, detail kept at the ends.
    table[v] = Math.round(255 * (x * x * (3 - 2 * x)));
  }
  for (let i = 0; i < pixels.length; i += 4) {
    const v = table[pixels[i] | 0];
    pixels[i] = v;
    pixels[i + 1] = v;
    pixels[i + 2] = v;
  }
}

/** Distance between two touch points, for pinch-to-zoom. */
export function pinchDistance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function clampZoom(value: number, max: number): number {
  return Math.min(Math.max(1, value), Math.max(1, max));
}
