// Preview readback post-processing.
// GL framebuffers are bottom-up; ImageData is top-down — flip rows.
// Premultiply alpha into RGB (alpha = brightness, matching the composite
// shader) so the preview shows exactly what the master mix will show.
export function flipAndPremultiply(
  buf: Uint8Array,
  image: ImageData,
  width: number,
  height: number,
): void {
  const rowBytes = width * 4;
  const out = image.data;
  for (let y = 0; y < height; y += 1) {
    const srcRow = (height - 1 - y) * rowBytes;
    const dstRow = y * rowBytes;
    for (let x = 0; x < rowBytes; x += 4) {
      const a = buf[srcRow + x + 3] / 255;
      out[dstRow + x] = buf[srcRow + x] * a;
      out[dstRow + x + 1] = buf[srcRow + x + 1] * a;
      out[dstRow + x + 2] = buf[srcRow + x + 2] * a;
      out[dstRow + x + 3] = 255;
    }
  }
}
