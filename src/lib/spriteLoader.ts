import { getPlatform } from '../platform';

async function fileBitmap(filePath: string): Promise<ImageBitmap> {
  const buf = await getPlatform().fs.readBytes(filePath);
  return createImageBitmap(new Blob([buf as unknown as BlobPart]));
}

/** Downscaled library thumbnail (flattened onto black, like the renderer). */
export async function makeSpriteThumbnail(filePath: string): Promise<string | null> {
  try {
    const bitmap = await fileBitmap(filePath);
    const width = 160;
    const height = Math.max(1, Math.round((width * bitmap.height) / bitmap.width));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(bitmap, 0, 0, width, height);
    return canvas.toDataURL('image/jpeg', 0.8);
  } catch {
    return null;
  }
}
