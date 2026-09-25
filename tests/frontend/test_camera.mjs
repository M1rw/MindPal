/**
 * The camera's arithmetic: the photo is exactly what the viewfinder framed, and
 * Document mode turns a dim, tinted page into clean black on white.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { clampZoom, enhanceDocument, frameAspect, pinchDistance, viewfinderCrop } from '../../frontend/src/components/camera/cameraMath.ts';

const close = (a, b, message) => assert.ok(Math.abs(a - b) < 1e-6, `${message}: ${a} vs ${b}`);

describe('viewfinder crop', () => {
  it('a portrait 3:4 frame from a portrait 3:4 stream takes the whole frame', () => {
    assert.deepEqual(viewfinderCrop(1440, 1920, 3 / 4), { sx: 0, sy: 0, sw: 1440, sh: 1920 });
  });

  it('a landscape stream in a portrait frame keeps the full height and trims the sides', () => {
    const crop = viewfinderCrop(1920, 1080, 3 / 4);
    close(crop.sh, 1080, 'height');
    close(crop.sw, 810, 'width');
    close(crop.sx, 555, 'centred');
    assert.equal(crop.sy, 0);
  });

  it('a stream taller than the frame trims top and bottom', () => {
    const crop = viewfinderCrop(1080, 1920, 3 / 4);
    close(crop.sw, 1080, 'width');
    close(crop.sh, 1440, 'height');
    close(crop.sy, 240, 'centred');
  });

  it('zoom narrows the crop around the centre and never widens it', () => {
    const crop = viewfinderCrop(1440, 1920, 3 / 4, 2);
    assert.deepEqual(crop, { sx: 360, sy: 480, sw: 720, sh: 960 });
    assert.deepEqual(viewfinderCrop(1440, 1920, 3 / 4, 0.5), viewfinderCrop(1440, 1920, 3 / 4, 1));
  });

  it('portrait screens frame 3:4, landscape 4:3', () => {
    assert.equal(frameAspect(430, 932), 3 / 4);
    assert.equal(frameAspect(932, 430), 4 / 3);
  });
});

describe('document clean-up', () => {
  it('stretches a grey, tinted page to white paper and dark ink, in greyscale', () => {
    // 100 pixels: 90 dull yellowish "paper", 10 greyish "ink".
    const pixels = new Uint8ClampedArray(100 * 4);
    for (let i = 0; i < 100; i += 1) {
      const ink = i % 10 === 0;
      pixels.set(ink ? [70, 70, 80, 255] : [190, 180, 150, 255], i * 4);
    }
    enhanceDocument(pixels);
    for (let i = 0; i < 100; i += 1) {
      const [r, g, b, a] = pixels.subarray(i * 4, i * 4 + 4);
      assert.equal(r, g);
      assert.equal(g, b);
      assert.equal(a, 255, 'alpha untouched');
      if (i % 10 === 0) assert.equal(r, 0, 'ink goes black');
      else assert.equal(r, 255, 'paper goes white');
    }
  });

  it('a flat image does not divide by zero', () => {
    const pixels = new Uint8ClampedArray(16).fill(128);
    enhanceDocument(pixels);
    assert.ok([...pixels].every((v) => Number.isFinite(v)));
  });
});

describe('zoom gestures', () => {
  it('pinch distance and zoom limits', () => {
    assert.equal(pinchDistance({ x: 0, y: 0 }, { x: 3, y: 4 }), 5);
    assert.equal(clampZoom(0.4, 3), 1);
    assert.equal(clampZoom(2.2, 3), 2.2);
    assert.equal(clampZoom(9, 3), 3);
  });
});
