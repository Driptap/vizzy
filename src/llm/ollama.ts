import type { DeckStatus } from '../types';

export const DEFAULT_MODEL = 'qwen2.5-coder';

// A user-run Ollama on the default port wins; the app-managed one (spawned
// by src-tauri/src/ollama.rs) listens one port up.
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
  /** the mode's system prompt (patch or scene generation) */
  system: string | null;
  /** JSON schema for Ollama structured outputs, or null for free text */
  format: object | null;
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
    format: object | null = null,
  ): void {
    // a re-click replaces that deck's pending job rather than stacking
    this.queue = this.queue.filter((job) => job.deckIndex !== deckIndex);
    this.queue.push({ deckIndex, prompt, onResponse, repair, system, format });
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
      const raw = await this.request(job.prompt, job.repair, job.system, job.format);
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
    system: string | null = null,
    format: object | null = null,
  ): Promise<string> {
    let fullPrompt = system ? `${system}\n\nUser request: ${userPrompt}` : userPrompt;
    if (repair) {
      fullPrompt +=
        `\n\nYour previous response for this request FAILED. Fix it and return the` +
        ` corrected, complete JSON only.\n\nPrevious response:\n${repair.code}` +
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
          // Structured outputs: constrain decoding to the mode's schema so
          // malformed JSON stops being a failure mode at the source.
          ...(format ? { format } : {}),
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
