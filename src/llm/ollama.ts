import { selectRecipe } from './recipes';
import type { DeckStatus } from '../types';

export const DEFAULT_MODEL = 'qwen2.5-coder';

// A user-run Ollama on the default port wins; the app-managed one (spawned
// by electron/ollama-manager.cjs) listens one port up.
export const DEFAULT_BASE = 'http://127.0.0.1:11434';
export const MANAGED_BASE = 'http://127.0.0.1:11435';

let baseUrl = DEFAULT_BASE;
export const getBaseUrl = (): string => baseUrl;
export const setBaseUrl = (url: string): void => {
  baseUrl = url;
};
export const DEFAULT_ENDPOINT = `${DEFAULT_BASE}/api/generate`;

/** @returns the server's version string, or null if unreachable */
export async function checkServer(base: string, timeoutMs = 1500): Promise<string | null> {
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
export async function resolveServer(): Promise<string | null> {
  for (const base of [DEFAULT_BASE, MANAGED_BASE]) {
    if (await checkServer(base)) {
      setBaseUrl(base);
      return base;
    }
  }
  return null;
}

/** @returns array of installed model tags (":latest" stripped) */
export async function listInstalledModels(base: string = baseUrl): Promise<string[]> {
  try {
    const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return [];
    const data = await res.json();
    return ((data.models || []) as { name: string }[]).map((m) =>
      m.name.replace(/:latest$/, ''),
    );
  } catch {
    return [];
  }
}

/** One NDJSON progress event from Ollama's pull endpoint. */
export interface PullProgress {
  status?: string;
  total?: number;
  completed?: number;
  error?: string;
}

/**
 * Pull a model with streaming progress. Ollama emits NDJSON lines like
 * {status, total, completed}; onProgress receives the latest of each.
 */
export async function pullModel(
  tag: string,
  onProgress?: ((evt: PullProgress) => void) | null,
  base: string = baseUrl,
): Promise<void> {
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
    buffered = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      const evt = JSON.parse(line) as PullProgress;
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

/** The failed attempt resent to the model for a repair pass. */
export interface RepairContext {
  code: string;
  error: string;
}

export type DeckStatusCallback = (
  deckIndex: number,
  status: DeckStatus,
  error?: string | null,
) => void;

interface GenerationJob {
  deckIndex: number;
  prompt: string;
  onResponse: (raw: string) => void;
  repair: RepairContext | null;
  /** overrides the GLSL system prompt (e.g. procedural scene generation) */
  system: string | null;
}

interface GenerationQueueOptions {
  getModel: () => string;
  getEndpoint?: () => string;
  onStatus: DeckStatusCallback;
}

/**
 * Sequential generation queue: jobs run one at a time so concurrent deck
 * generations don't lock the GPU Ollama is running on.
 */
export class GenerationQueue {
  getModel: () => string;
  getEndpoint: () => string;
  onStatus: DeckStatusCallback;
  queue: GenerationJob[];
  busy: boolean;

  constructor({ getModel, getEndpoint, onStatus }: GenerationQueueOptions) {
    this.getModel = getModel;
    this.getEndpoint = getEndpoint || (() => `${getBaseUrl()}/api/generate`);
    this.onStatus = onStatus;
    this.queue = [];
    this.busy = false;
  }

  /**
   * @param onResponse called with the raw LLM text; the caller owns
   *   parsing/compiling and subsequent status updates.
   */
  enqueue(
    deckIndex: number,
    prompt: string,
    onResponse: (raw: string) => void,
    repair: RepairContext | null = null,
    system: string | null = null,
  ): void {
    // a re-click replaces that deck's pending job rather than stacking
    this.queue = this.queue.filter((job) => job.deckIndex !== deckIndex);
    this.queue.push({ deckIndex, prompt, onResponse, repair, system });
    this.onStatus(deckIndex, 'queued');
    this.pump();
  }

  async pump(): Promise<void> {
    if (this.busy) return;
    const job = this.queue.shift();
    if (!job) return;
    this.busy = true;

    try {
      this.onStatus(job.deckIndex, 'generating');
      const raw = await this.request(job.prompt, job.repair, job.system);
      job.onResponse(raw);
    } catch (err) {
      console.error('[Vizzy] Generation failed:', err);
      this.onStatus(job.deckIndex, 'error', (err as Error).message || 'Generation failed');
    } finally {
      this.busy = false;
      this.pump();
    }
  }

  async request(
    userPrompt: string,
    repair: RepairContext | null = null,
    systemOverride: string | null = null,
  ): Promise<string> {
    // Append at most ONE style recipe, and only when the prompt matches —
    // keeps the local model's context small while raising genre quality.
    // A system override (scene generation) replaces all of that wholesale.
    const recipe = systemOverride ? null : selectRecipe(userPrompt);
    if (recipe) console.log(`[Vizzy] Style recipe matched: ${recipe.title}`);
    const system =
      systemOverride ??
      (recipe
        ? `${SYSTEM_PROMPT}\n\n## Style guidance — ${recipe.title}\n${recipe.guidance}`
        : SYSTEM_PROMPT);

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
      if ((err as Error).name === 'AbortError') throw new Error('Ollama request timed out');
      if (err instanceof TypeError) throw new Error('Ollama unreachable — is `ollama serve` running?');
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }
}
