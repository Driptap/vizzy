import * as THREE from 'three';

const fs = window.require('fs/promises');

export const SPRITE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];

async function fileBitmap(filePath) {
  const buf = await fs.readFile(filePath);
  return createImageBitmap(new Blob([buf]));
}

/** Image file -> texture for the sprite quad (alpha preserved). */
export async function loadSpriteTexture(filePath) {
  const bitmap = await fileBitmap(filePath);
  const texture = new THREE.CanvasTexture(bitmap);
  texture.colorSpace = THREE.SRGBColorSpace;
  return { texture, aspect: bitmap.width / bitmap.height };
}

/** Downscaled library thumbnail (flattened onto black, like the renderer). */
export async function makeSpriteThumbnail(filePath) {
  try {
    const bitmap = await fileBitmap(filePath);
    const width = 160;
    const height = Math.max(1, Math.round((width * bitmap.height) / bitmap.width));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(bitmap, 0, 0, width, height);
    return canvas.toDataURL('image/jpeg', 0.8);
  } catch {
    return null;
  }
}
