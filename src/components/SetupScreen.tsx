import { useCallback, useEffect, useRef, useState } from 'react';
import {
  MANAGED_BASE,
  resolveServer,
  listInstalledModels,
  pullModel,
  setBaseUrl,
} from '../llm/ollama';
import { MODEL_CATALOG } from '../llm/models';
import type { PullProgress } from '../llm/ollama';
import { getPlatform } from '../platform';

function fmtBytes(n: number | undefined): string {
  if (!n) return '…';
  const gb = n / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(n / 1024 ** 2)} MB`;
}

function ProgressBar({ value }: { value: number }) {
  return (
    <div className="h-2 w-full overflow-hidden rounded bg-neutral-800">
      <div
        className="h-full rounded bg-cyan-500 transition-[width] duration-200"
        style={{ width: `${Math.round((value || 0) * 100)}%` }}
      />
    </div>
  );
}

/**
 * First-run / model-manager overlay. Shown when no Ollama server is
 * reachable or the selected model isn't installed. Flow: find a server
 * (user's own 11434 wins) -> else offer a managed download -> pick a model
 * from the catalog -> pull it with progress -> hand back to the app.
 */
interface SetupScreenProps {
  model: string;
  onModelChange: (tag: string) => void;
  onReady: () => void;
  onSkip: () => void;
}

type Stage = 'probing' | 'no-server' | 'installing' | 'starting' | 'model' | 'pulling';

interface DownloadProgress {
  received: number;
  total: number;
  extracting?: boolean;
}

export function SetupScreen({ model, onModelChange, onReady, onSkip }: SetupScreenProps) {
  const [stage, setStage] = useState<Stage>('probing');
  const [error, setError] = useState<string | null>(null);
  const [installed, setInstalled] = useState<string[]>([]);
  const [selected, setSelected] = useState(
    MODEL_CATALOG.some((m) => m.tag === model) ? model : MODEL_CATALOG.find((m) => m.default)!.tag,
  );
  const [download, setDownload] = useState<DownloadProgress>({ received: 0, total: 0 });
  const [pull, setPull] = useState({ status: '', completed: 0, total: 0 });
  const [ownOllama, setOwnOllama] = useState(false);
  const probingRef = useRef(false);

  const probe = useCallback(async () => {
    if (probingRef.current) return;
    probingRef.current = true;
    setError(null);
    setStage('probing');
    try {
      let base = await resolveServer();
      if (!base) {
        // a previously downloaded managed runtime can be restarted silently
        const status = await getPlatform().ollama.status();
        if (status.installed) {
          setStage('starting');
          if (await getPlatform().ollama.start()) {
            setBaseUrl(MANAGED_BASE);
            base = MANAGED_BASE;
          }
        }
      }
      if (!base) {
        setStage('no-server');
        return;
      }
      const tags = await listInstalledModels(base);
      setInstalled(tags);
      if (tags.includes(model) || tags.includes(`${model}:latest`)) onReady();
      else setStage('model');
    } finally {
      probingRef.current = false;
    }
  }, [model, onReady]);

  useEffect(() => {
    probe();
  }, [probe]);

  const handleInstall = useCallback(async () => {
    setStage('installing');
    setError(null);
    try {
      await getPlatform().ollama.install((p) => {
        if (p.phase === 'download')
          setDownload({ received: p.received ?? 0, total: p.total ?? 0 });
        if (p.phase === 'extract') setDownload((d) => ({ ...d, extracting: true }));
      });
      setStage('starting');
      const ok = await getPlatform().ollama.start();
      if (!ok) throw new Error('Ollama installed but the server failed to start');
      setBaseUrl(MANAGED_BASE);
      const tags = await listInstalledModels(MANAGED_BASE);
      setInstalled(tags);
      setStage('model');
    } catch (err) {
      setError((err as Error).message || String(err));
      setStage('no-server');
    }
  }, []);

  const handlePull = useCallback(async () => {
    const tag = selected;
    if (installed.includes(tag) || installed.includes(`${tag}:latest`)) {
      onModelChange(tag);
      onReady();
      return;
    }
    setStage('pulling');
    setError(null);
    try {
      await pullModel(tag, (evt: PullProgress) =>
        setPull({ status: evt.status || '', completed: evt.completed || 0, total: evt.total || 0 }),
      );
      onModelChange(tag);
      onReady();
    } catch (err) {
      setError((err as Error).message || String(err));
      setStage('model');
    }
  }, [selected, installed, onModelChange, onReady]);

  const isInstalled = (tag: string) => installed.includes(tag) || installed.includes(`${tag}:latest`);

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-neutral-950/95 p-6">
      <div className="w-full max-w-2xl rounded-xl border border-neutral-800 bg-neutral-900 p-6 shadow-2xl">
        <h2 className="text-lg font-black tracking-widest text-cyan-400">
          GIVE VIZZY A BRAIN
        </h2>
        <p className="mt-1 text-xs leading-relaxed text-neutral-400">
          Vizzy turns prompts into shaders with a local LLM. Nothing leaves your
          machine — but it needs a model runtime (Ollama) and a model.
        </p>

        {error && (
          <p className="mt-3 rounded border border-red-900 bg-red-950/60 px-3 py-2 text-xs text-red-300">
            {error}
          </p>
        )}

        {stage === 'probing' && (
          <p className="mt-6 animate-pulse text-sm text-neutral-300">Looking for Ollama…</p>
        )}

        {stage === 'starting' && (
          <p className="mt-6 animate-pulse text-sm text-neutral-300">Starting Ollama…</p>
        )}

        {stage === 'no-server' && (
          <div className="mt-5 space-y-4">
            <button
              type="button"
              onClick={handleInstall}
              className="w-full rounded bg-cyan-600 px-4 py-3 text-sm font-bold text-white transition-colors hover:bg-cyan-500"
            >
              Download Ollama for me
            </button>
            <p className="text-[11px] leading-relaxed text-neutral-500">
              Fetches the official Ollama build from GitHub into Vizzy's data
              folder and runs it on a private port — it won't touch an Ollama
              you install later. Tens of MB on macOS; up to ~1 GB on
              Windows/Linux (GPU libraries are chunky).
            </p>

            <button
              type="button"
              onClick={() => setOwnOllama((v) => !v)}
              className="text-xs text-neutral-400 underline hover:text-neutral-200"
            >
              I'd rather install Ollama myself
            </button>
            {ownOllama && (
              <div className="rounded border border-neutral-800 bg-neutral-950 p-3 text-[11px] leading-relaxed text-neutral-400">
                Grab it from{' '}
                <span className="text-cyan-400">ollama.com/download</span>, make
                sure it's running (the desktop app starts it automatically),
                then hit Retry.
                <button
                  type="button"
                  onClick={probe}
                  className="ml-2 rounded bg-neutral-700 px-2 py-0.5 font-semibold text-neutral-200 hover:bg-neutral-600"
                >
                  Retry
                </button>
              </div>
            )}
          </div>
        )}

        {stage === 'installing' && (
          <div className="mt-6 space-y-2">
            <p className="text-sm text-neutral-300">
              {download.extracting
                ? 'Unpacking…'
                : `Downloading Ollama — ${fmtBytes(download.received)}${
                    download.total ? ` of ${fmtBytes(download.total)}` : ''
                  }`}
            </p>
            <ProgressBar
              value={download.total ? download.received / download.total : 0}
            />
          </div>
        )}

        {stage === 'model' && (
          <div className="mt-5">
            <p className="mb-2 text-[10px] uppercase tracking-wider text-neutral-500">
              Pick a model — bigger = better shaders, slower + hungrier
            </p>
            <div className="max-h-72 space-y-1.5 overflow-y-auto pr-1">
              {MODEL_CATALOG.map((m) => (
                <label
                  key={m.tag}
                  className={`flex cursor-pointer items-center gap-3 rounded border px-3 py-2 transition-colors ${
                    selected === m.tag
                      ? 'border-cyan-500 bg-cyan-950/40'
                      : 'border-neutral-800 bg-neutral-950 hover:border-neutral-600'
                  }`}
                >
                  <input
                    type="radio"
                    name="model"
                    checked={selected === m.tag}
                    onChange={() => setSelected(m.tag)}
                    className="accent-cyan-500"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-2">
                      <span className="text-sm font-semibold text-neutral-200">{m.name}</span>
                      {m.default && (
                        <span className="text-[9px] font-bold uppercase text-cyan-400">
                          default
                        </span>
                      )}
                      {isInstalled(m.tag) && (
                        <span className="text-[9px] font-bold uppercase text-emerald-400">
                          installed ✓
                        </span>
                      )}
                    </span>
                    <span className="block truncate text-[11px] text-neutral-500">{m.blurb}</span>
                  </span>
                  <span className="shrink-0 text-right text-[10px] leading-tight text-neutral-400">
                    {m.download} download
                    <br />~{m.ram} RAM
                  </span>
                </label>
              ))}
            </div>
            <button
              type="button"
              onClick={handlePull}
              className="mt-4 w-full rounded bg-cyan-600 px-4 py-3 text-sm font-bold text-white transition-colors hover:bg-cyan-500"
            >
              {isInstalled(selected) ? 'Use this model' : 'Download model & start'}
            </button>
          </div>
        )}

        {stage === 'pulling' && (
          <div className="mt-6 space-y-2">
            <p className="text-sm text-neutral-300">
              Pulling <span className="font-semibold text-cyan-400">{selected}</span> —{' '}
              {pull.total
                ? `${fmtBytes(pull.completed)} of ${fmtBytes(pull.total)}`
                : pull.status || 'starting…'}
            </p>
            <ProgressBar value={pull.total ? pull.completed / pull.total : 0} />
            <p className="text-[11px] text-neutral-500">
              Big download, one time only. Plug in, make tea.
            </p>
          </div>
        )}

        <div className="mt-5 flex justify-end border-t border-neutral-800 pt-3">
          <button
            type="button"
            onClick={onSkip}
            className="text-xs text-neutral-500 hover:text-neutral-300"
          >
            Skip for now — library decks still work, generation won't
          </button>
        </div>
      </div>
    </div>
  );
}
