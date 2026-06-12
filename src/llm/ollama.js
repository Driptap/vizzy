import { selectRecipe } from './recipes';

export const DEFAULT_MODEL = 'qwen2.5-coder';

// A user-run Ollama on the default port wins; the app-managed one (spawned
// by electron/ollama-manager.cjs) listens one port up.
export const DEFAULT_BASE = 'http://127.0.0.1:11434';
export const MANAGED_BASE = 'http://127.0.0.1:11435';

let baseUrl = DEFAULT_BASE;
export const getBaseUrl = () => baseUrl;
export const setBaseUrl = (url) => {
  baseUrl = url;
};
export const DEFAULT_ENDPOINT = `${DEFAULT_BASE}/api/generate`;

/** @returns the server's version string, or null if unreachable */
export async function checkServer(base, timeoutMs = 1500) {
  try {
    const res = await fetch(`${base}/api/version`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return (await res.json()).version || 'unknown';
  } catch {
    return null;
  }
}

/** Probe user-run then managed server; sets the module base URL on a hit. */
export async function resolveServer() {
  for (const base of [DEFAULT_BASE, MANAGED_BASE]) {
    if (await checkServer(base)) {
      setBaseUrl(base);
      return base;
    }
  }
  return null;
}

/** @returns array of installed model tags (":latest" stripped) */
export async function listInstalledModels(base = baseUrl) {
  try {
    const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.models || []).map((m) => m.name.replace(/:latest$/, ''));
  } catch {
    return [];
  }
}

/**
 * Pull a model with streaming progress. Ollama emits NDJSON lines like
 * {status, total, completed}; onProgress receives the latest of each.
 */
export async function pullModel(tag, onProgress, base = baseUrl) {
  const res = await fetch(`${base}/api/pull`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: tag }),
  });
  if (!res.ok || !res.body) {
    throw new Error(`Pull failed: HTTP ${res.status}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });
    const lines = buffered.split('\n');
    buffered = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      const evt = JSON.parse(line);
      if (evt.error) throw new Error(evt.error);
      onProgress?.(evt);
    }
  }
}

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
- There are NO texture samplers and no previous-frame buffer — everything must
  be procedural. Loops must have constant bounds.
- This is GLSL ES 1.00: every float literal needs a decimal point (1.0, not 1);
  function arguments must be floats (pow(x, 2.0), not pow(x, 2)); convert int
  loop counters with float(i) before using them in float math.
- Do NOT use Shadertoy conventions: no mainImage, iTime, iResolution, iChannel.
  Use void main(), u_time and u_resolution.
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
    this.getEndpoint = getEndpoint || (() => `${getBaseUrl()}/api/generate`);
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
  enqueue(deckIndex, prompt, onResponse, repair = null) {
    // a re-click replaces that deck's pending job rather than stacking
    this.queue = this.queue.filter((job) => job.deckIndex !== deckIndex);
    this.queue.push({ deckIndex, prompt, onResponse, repair });
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
      const raw = await this.request(job.prompt, job.repair);
      job.onResponse(raw);
    } catch (err) {
      console.error('[Vizzy] Generation failed:', err);
      this.onStatus(job.deckIndex, 'error', err.message || 'Generation failed');
    } finally {
      this.busy = false;
      this.pump();
    }
  }

  async request(userPrompt, repair = null) {
    // Append at most ONE style recipe, and only when the prompt matches —
    // keeps the local model's context small while raising genre quality.
    const recipe = selectRecipe(userPrompt);
    if (recipe) console.log(`[Vizzy] Style recipe matched: ${recipe.title}`);
    const system = recipe
      ? `${SYSTEM_PROMPT}\n\n## Style guidance — ${recipe.title}\n${recipe.guidance}`
      : SYSTEM_PROMPT;

    let fullPrompt = `${system}\n\nUser request: ${userPrompt}`;
    if (repair) {
      fullPrompt +=
        `\n\nYour previous shader for this request FAILED. Fix it and return the` +
        ` corrected, complete fragment shader code only.\n\nPrevious code:\n${repair.code}` +
        `\n\nError:\n${repair.error}`;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(this.getEndpoint(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          model: this.getModel(),
          prompt: fullPrompt,
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
