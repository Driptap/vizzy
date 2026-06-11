export const DEFAULT_ENDPOINT = 'http://localhost:11434/api/generate';
export const DEFAULT_MODEL = 'qwen2.5-coder';

export const SYSTEM_PROMPT = `You are an expert GLSL shader programmer writing code for a live VJ performance.
Write ONLY valid GLSL fragment shader code. Do not include markdown or explanations.
You must strictly use the following uniforms which are already provided by the engine:
uniform float u_time;       // Time in seconds
uniform vec2 u_resolution;  // Screen resolution in pixels
uniform float u_audio_low;  // Bass frequency amplitude (0.0 to 1.0)
uniform float u_audio_mid;  // Midrange frequency amplitude (0.0 to 1.0)
uniform float u_audio_high; // Treble frequency amplitude (0.0 to 1.0)
uniform float u_audio_level;// Overall volume amplitude (0.0 to 1.0)

Additional hard rules:
- Do NOT redeclare the uniforms above, and do not add precision or #version directives.
- A varying vec2 vUv (0.0 to 1.0 across the screen) is available.
- Write output to gl_FragColor.
- Put brightness and shape into RGB and set gl_FragColor.a to 1.0; alpha is
  treated as a brightness multiplier by the mixer, not as transparency over
  other layers.
- You may define helper functions, #defines and consts above void main().`;

const REQUEST_TIMEOUT_MS = 120000;

/**
 * Sequential generation queue: jobs run one at a time so concurrent deck
 * generations don't lock the GPU Ollama is running on.
 */
export class GenerationQueue {
  /**
   * @param {object} opts
   * @param {() => string} opts.getModel
   * @param {() => string} opts.getEndpoint
   * @param {(deckIndex: number, status: string, error?: string|null) => void} opts.onStatus
   */
  constructor({ getModel, getEndpoint, onStatus }) {
    this.getModel = getModel;
    this.getEndpoint = getEndpoint || (() => DEFAULT_ENDPOINT);
    this.onStatus = onStatus;
    this.queue = [];
    this.busy = false;
  }

  /**
   * @param {number} deckIndex
   * @param {string} prompt
   * @param {(rawResponse: string) => void} onResponse called with the raw LLM
   *   text; the caller owns parsing/compiling and subsequent status updates.
   */
  enqueue(deckIndex, prompt, onResponse) {
    // a re-click replaces that deck's pending job rather than stacking
    this.queue = this.queue.filter((job) => job.deckIndex !== deckIndex);
    this.queue.push({ deckIndex, prompt, onResponse });
    this.onStatus(deckIndex, 'queued');
    this.pump();
  }

  async pump() {
    if (this.busy) return;
    const job = this.queue.shift();
    if (!job) return;
    this.busy = true;

    try {
      this.onStatus(job.deckIndex, 'generating');
      const raw = await this.request(job.prompt);
      job.onResponse(raw);
    } catch (err) {
      console.error('[PromptVJ] Generation failed:', err);
      this.onStatus(job.deckIndex, 'error', err.message || 'Generation failed');
    } finally {
      this.busy = false;
      this.pump();
    }
  }

  async request(userPrompt) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(this.getEndpoint(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          model: this.getModel(),
          prompt: `${SYSTEM_PROMPT}\n\nUser request: ${userPrompt}`,
          stream: false,
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Ollama ${res.status}: ${body.slice(0, 200) || res.statusText}`);
      }
      const data = await res.json();
      return data.response || '';
    } catch (err) {
      if (err.name === 'AbortError') throw new Error('Ollama request timed out');
      if (err instanceof TypeError) throw new Error('Ollama unreachable — is `ollama serve` running?');
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }
}
