import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => {
  cleanup();
  localStorage.clear();
});

// jsdom has no canvas implementation; the app only needs a small slice of the
// 2D API (thumbnails, gradient seeds), so a method stub is enough.
const ctx2dStub = () => ({
  canvas: null,
  fillStyle: '',
  font: '',
  textAlign: '',
  shadowColor: '',
  shadowBlur: 0,
  strokeStyle: '',
  lineWidth: 0,
  fillRect: () => {},
  drawImage: () => {},
  putImageData: () => {},
  beginPath: () => {},
  arc: () => {},
  stroke: () => {},
  fill: () => {},
  fillText: () => {},
  createLinearGradient: () => ({ addColorStop: () => {} }),
});

HTMLCanvasElement.prototype.getContext = function getContext() {
  const ctx = ctx2dStub();
  ctx.canvas = this;
  return ctx;
};
HTMLCanvasElement.prototype.toDataURL = function toDataURL(type = 'image/png') {
  return `data:${type};base64,stub`;
};

// jsdom ships no ImageData (RenderEngine's preview readback uses it)
if (typeof globalThis.ImageData === 'undefined') {
  globalThis.ImageData = class ImageData {
    constructor(width, height) {
      this.width = width;
      this.height = height;
      this.data = new Uint8ClampedArray(width * height * 4);
    }
  };
}

// used by the example-seed sprite drawing
globalThis.Path2D = class Path2D {
  moveTo() {}
  lineTo() {}
  closePath() {}
};
