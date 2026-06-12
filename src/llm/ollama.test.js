import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  DEFAULT_BASE,
  MANAGED_BASE,
  getBaseUrl,
  setBaseUrl,
  checkServer,
  resolveServer,
  listInstalledModels,
  pullModel,
  GenerationQueue,
  SYSTEM_PROMPT,
} from './ollama';

const jsonResponse = (data, ok = true, status = 200) => ({
  ok,
  status,
  statusText: 'status',
  json: async () => data,
  text: async () => JSON.stringify(data),
});

// minimal streaming body from a list of already-chunked strings
const streamBody = (chunks) => {
  const encoder = new TextEncoder();
  let i = 0;
  return {
    getReader: () => ({
      read: async () =>
        i < chunks.length
          ? { done: false, value: encoder.encode(chunks[i++]) }
          : { done: true, value: undefined },
    }),
  };
};

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  setBaseUrl(DEFAULT_BASE);
});

describe('checkServer', () => {
  it('returns the version on success', async () => {
    fetch.mockResolvedValue(jsonResponse({ version: '0.5.1' }));
    expect(await checkServer('http://x')).toBe('0.5.1');
    expect(fetch).toHaveBeenCalledWith('http://x/api/version', expect.anything());
  });

  it('returns "unknown" when the version field is missing', async () => {
    fetch.mockResolvedValue(jsonResponse({}));
    expect(await checkServer('http://x')).toBe('unknown');
  });

  it('returns null on a non-ok response', async () => {
    fetch.mockResolvedValue(jsonResponse({}, false, 500));
    expect(await checkServer('http://x')).toBeNull();
  });

  it('returns null when fetch rejects', async () => {
    fetch.mockRejectedValue(new TypeError('unreachable'));
    expect(await checkServer('http://x')).toBeNull();
  });
});

describe('resolveServer', () => {
  it('prefers the user-run server on the default port', async () => {
    fetch.mockResolvedValue(jsonResponse({ version: '1' }));
    expect(await resolveServer()).toBe(DEFAULT_BASE);
    expect(getBaseUrl()).toBe(DEFAULT_BASE);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('falls back to the managed server', async () => {
    fetch
      .mockRejectedValueOnce(new TypeError('down'))
      .mockResolvedValueOnce(jsonResponse({ version: '1' }));
    expect(await resolveServer()).toBe(MANAGED_BASE);
    expect(getBaseUrl()).toBe(MANAGED_BASE);
  });

  it('returns null (and leaves the base unchanged) when nothing answers', async () => {
    fetch.mockRejectedValue(new TypeError('down'));
    expect(await resolveServer()).toBeNull();
    expect(getBaseUrl()).toBe(DEFAULT_BASE);
  });
});

describe('listInstalledModels', () => {
  it('lists tags with :latest stripped', async () => {
    fetch.mockResolvedValue(
      jsonResponse({
        models: [{ name: 'qwen2.5-coder:latest' }, { name: 'llama3.1:8b' }],
      }),
    );
    expect(await listInstalledModels('http://x')).toEqual(['qwen2.5-coder', 'llama3.1:8b']);
  });

  it('returns [] on errors and non-ok responses', async () => {
    fetch.mockRejectedValueOnce(new TypeError('down'));
    expect(await listInstalledModels('http://x')).toEqual([]);
    fetch.mockResolvedValueOnce(jsonResponse({}, false, 500));
    expect(await listInstalledModels('http://x')).toEqual([]);
  });
});

describe('pullModel', () => {
  it('parses NDJSON progress events, including chunks split mid-line', async () => {
    fetch.mockResolvedValue({
      ok: true,
      body: streamBody([
        '{"status":"pulling","total":100,"completed":10}\n{"status":"pulling","to',
        'tal":100,"completed":50}\n',
        '{"status":"success"}\n',
      ]),
    });
    const events = [];
    await pullModel('some-model', (e) => events.push(e), 'http://x');
    expect(events).toEqual([
      { status: 'pulling', total: 100, completed: 10 },
      { status: 'pulling', total: 100, completed: 50 },
      { status: 'success' },
    ]);
    expect(fetch).toHaveBeenCalledWith('http://x/api/pull', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ model: 'some-model' }),
    }));
  });

  it('throws on an error event from the stream', async () => {
    fetch.mockResolvedValue({
      ok: true,
      body: streamBody(['{"error":"no such model"}\n']),
    });
    await expect(pullModel('nope', null, 'http://x')).rejects.toThrow('no such model');
  });

  it('throws on an HTTP failure', async () => {
    fetch.mockResolvedValue({ ok: false, status: 404, body: null });
    await expect(pullModel('nope', null, 'http://x')).rejects.toThrow('Pull failed: HTTP 404');
  });
});

describe('GenerationQueue', () => {
  const makeQueue = (overrides = {}) => {
    const onStatus = vi.fn();
    const queue = new GenerationQueue({
      getModel: () => 'test-model',
      getEndpoint: () => 'http://x/api/generate',
      onStatus,
      ...overrides,
    });
    return { queue, onStatus };
  };

  it('emits queued -> generating and delivers the raw response', async () => {
    fetch.mockResolvedValue(jsonResponse({ response: 'GLSL HERE' }));
    const { queue, onStatus } = makeQueue();
    const onResponse = vi.fn();

    queue.enqueue(2, 'a plain gradient', onResponse);
    expect(onStatus).toHaveBeenCalledWith(2, 'queued');
    await vi.waitFor(() => expect(onResponse).toHaveBeenCalledWith('GLSL HERE'));
    expect(onStatus).toHaveBeenCalledWith(2, 'generating');
    // parsing/compiling statuses are the caller's job — no further transitions
    expect(onStatus).not.toHaveBeenCalledWith(2, 'error', expect.anything());
  });

  it('sends the system prompt and model in the request body', async () => {
    fetch.mockResolvedValue(jsonResponse({ response: 'ok' }));
    const { queue } = makeQueue();
    queue.enqueue(0, 'a plain gradient', vi.fn());
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());

    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body.model).toBe('test-model');
    expect(body.stream).toBe(false);
    expect(body.prompt).toContain(SYSTEM_PROMPT);
    expect(body.prompt).toContain('User request: a plain gradient');
  });

  it('appends a style recipe when the prompt matches one', async () => {
    fetch.mockResolvedValue(jsonResponse({ response: 'ok' }));
    const { queue } = makeQueue();
    queue.enqueue(0, 'an infinite fractal zoom', vi.fn());
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());

    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body.prompt).toContain('## Style guidance — Escape-time fractals');
  });

  it('a system override replaces the GLSL prompt and skips recipes', async () => {
    fetch.mockResolvedValue(jsonResponse({ response: 'ok' }));
    const { queue } = makeQueue();
    // 'fractal' would normally trigger a style recipe — the override wins
    queue.enqueue(0, 'an infinite fractal tunnel', vi.fn(), null, 'CUSTOM SCENE CONTRACT');
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());

    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body.prompt).toContain('CUSTOM SCENE CONTRACT');
    expect(body.prompt).not.toContain(SYSTEM_PROMPT.slice(0, 60));
    expect(body.prompt).not.toContain('## Style guidance');
    expect(body.prompt).toContain('User request: an infinite fractal tunnel');
  });

  it('includes the failing code and error in a repair request', async () => {
    fetch.mockResolvedValue(jsonResponse({ response: 'ok' }));
    const { queue } = makeQueue();
    queue.enqueue(0, 'a plain gradient', vi.fn(), {
      code: 'void main() { broken }',
      error: "ERROR: 0:3 'broken' : undeclared identifier",
    });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());

    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body.prompt).toContain('FAILED');
    expect(body.prompt).toContain('void main() { broken }');
    expect(body.prompt).toContain('undeclared identifier');
  });

  it('runs jobs strictly one at a time', async () => {
    let release;
    fetch
      .mockReturnValueOnce(new Promise((res) => { release = () => res(jsonResponse({ response: 'one' })); }))
      .mockResolvedValueOnce(jsonResponse({ response: 'two' }));
    const { queue } = makeQueue();
    const first = vi.fn();
    const second = vi.fn();

    queue.enqueue(0, 'first', first);
    queue.enqueue(1, 'second', second);
    expect(fetch).toHaveBeenCalledTimes(1); // second job waits

    release();
    await vi.waitFor(() => expect(second).toHaveBeenCalledWith('two'));
    expect(first).toHaveBeenCalledWith('one');
  });

  it('replaces a pending job for the same deck instead of stacking', async () => {
    let release;
    fetch
      .mockReturnValueOnce(new Promise((res) => { release = () => res(jsonResponse({ response: 'busy' })); }))
      .mockResolvedValue(jsonResponse({ response: 'replacement' }));
    const { queue } = makeQueue();
    const stale = vi.fn();
    const fresh = vi.fn();

    queue.enqueue(0, 'occupies the queue', vi.fn());
    queue.enqueue(3, 'first attempt', stale);
    queue.enqueue(3, 'second attempt', fresh);
    release();

    await vi.waitFor(() => expect(fresh).toHaveBeenCalledWith('replacement'));
    expect(stale).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('reports an error status and keeps pumping after a failed job', async () => {
    fetch
      .mockResolvedValueOnce({ ok: false, status: 500, statusText: 'boom', text: async () => 'oh no' })
      .mockResolvedValueOnce(jsonResponse({ response: 'fine' }));
    const { queue, onStatus } = makeQueue();
    const ok = vi.fn();

    queue.enqueue(0, 'fails', vi.fn());
    queue.enqueue(1, 'succeeds', ok);

    await vi.waitFor(() => expect(ok).toHaveBeenCalledWith('fine'));
    expect(onStatus).toHaveBeenCalledWith(0, 'error', expect.stringContaining('Ollama 500'));
  });

  it('maps network failures to a friendly unreachable message', async () => {
    fetch.mockRejectedValue(new TypeError('fetch failed'));
    const { queue, onStatus } = makeQueue();
    queue.enqueue(0, 'anything', vi.fn());
    await vi.waitFor(() =>
      expect(onStatus).toHaveBeenCalledWith(
        0,
        'error',
        'Ollama unreachable — is `ollama serve` running?',
      ),
    );
  });

  it('maps an aborted request to a timeout message', async () => {
    const abortError = new Error('aborted');
    abortError.name = 'AbortError';
    fetch.mockRejectedValue(abortError);
    const { queue, onStatus } = makeQueue();
    queue.enqueue(0, 'anything', vi.fn());
    await vi.waitFor(() =>
      expect(onStatus).toHaveBeenCalledWith(0, 'error', 'Ollama request timed out'),
    );
  });

  it('defaults the endpoint to the resolved base URL', () => {
    setBaseUrl('http://custom:9999');
    const queue = new GenerationQueue({ getModel: () => 'm', onStatus: vi.fn() });
    expect(queue.getEndpoint()).toBe('http://custom:9999/api/generate');
  });
});
