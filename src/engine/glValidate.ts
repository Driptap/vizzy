// Raw-WebGL precompile of a fragment shader: catches syntax errors cheaply
// before the more expensive three.js staging render.
/** @returns the compile error log, or null when the source compiles */
export function validateFragmentSource(
  gl: WebGLRenderingContext | WebGL2RenderingContext,
  source: string,
): string | null {
  const shader = gl.createShader(gl.FRAGMENT_SHADER)!;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  const ok = gl.getShaderParameter(shader, gl.COMPILE_STATUS);
  const log = ok ? null : gl.getShaderInfoLog(shader) || 'Unknown shader compile error';
  gl.deleteShader(shader);
  return log;
}
