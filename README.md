# Vizzy

Local MVP desktop app for live VJing: write text prompts that a local LLM turns
into GLSL fragment shaders, compiled on the fly across 4 decks, mixed with a
MIDI controller, all reacting to live audio input.

## Prerequisites

- Node.js 20+ (only if running from source — packaged builds are on the
  [latest release](https://github.com/Driptap/vizzy/releases/latest))
- [Ollama](https://ollama.com) running locally with a code-capable model
  (see below)

## Installing Ollama

Vizzy generates shaders with a local LLM via Ollama — nothing leaves your
machine, no API keys needed.

1. **Install** the runtime:
   - **macOS** — download from [ollama.com/download](https://ollama.com/download),
     or `brew install --cask ollama-app` (the GUI app cask, not the `ollama`
     formula — the app bundles and manages the server for you)
   - **Windows** — download and run the installer from
     [ollama.com/download](https://ollama.com/download)
   - **Linux** — `curl -fsSL https://ollama.com/install.sh | sh`
2. **Run it.** The macOS/Windows desktop app starts the server automatically
   (llama icon in the menu bar / tray). On Linux or with a CLI-only install,
   run `ollama serve`. Vizzy expects the default port, 11434.
3. **Pull a model.** The default Vizzy requests is `qwen2.5-coder` (~4.7 GB):
   `ollama pull qwen2.5-coder` (or `npm run model:pull` from a source
   checkout). Any model that can write GLSL works — the model name is
   editable in Vizzy's top bar.

## Run

```bash
npm install
npm run model:pull   # download the default Ollama model (qwen2.5-coder)
npm run dev          # vite dev server + electron, hot reload
npm start            # production build + electron
```

## Usage

1. **Audio** — pick an input device in the top bar and hit *Enable Audio*
   (device labels appear after the first permission grant). The four bands
   (`u_audio_low/mid/high/level`) are lerp-smoothed and fed to every deck
   shader each frame.
2. **Generate** — type a prompt in a deck and hit *Generate*. Requests are
   queued sequentially so multiple decks don't fight over the LLM GPU. Status
   flow: Queued → Generating → Compiling → Active (or Compile Failed — the
   previous visual keeps running).
3. **Mix** — the 4 vertical faders set each deck's weight in the additive
   master composite.
4. **MIDI** — toggle *MIDI Learn*, click a fader, move a physical control:
   that CC is bound (persisted in localStorage). Toggle Learn off to perform.
5. **Library** — the *Library* button slides in a left panel that can stay
   open. Each deck has a small *SAVE* button that captures the running shader
   (with a screenshot of the live preview) into the library instantly and
   namelessly — no typing mid-performance; rename later. Right-click a saved
   shader for *Add to channel 1–4*, *Rename* (inline, in place of the label)
   and *Delete*. Shaders are stored as JSON files in
   `<userData>/shaders/` (on macOS: `~/Library/Application Support/vizzy/shaders/`).

## Architecture

- `src/engine/RenderEngine.js` — three.js: 4 off-screen render targets, each a
  fullscreen quad with an active ShaderMaterial; staged LLM shaders are
  validated (raw GL precompile + hidden three.js render) before being swapped
  in. A master composite shader mixes the 4 targets to the main canvas.
  Deck previews are read back at 160×90, round-robin one deck per frame.
- `src/engine/AudioEngine.js` — getUserMedia → AnalyserNode (fftSize 512),
  band averages lerped at 0.15/frame.
- `src/engine/MidiEngine.js` — Web MIDI CC listener with learn-mode binding.
- `src/llm/ollama.js` — sequential generation queue + system prompt wrapper.
- `src/llm/parser.js` — extracts the GLSL body (helpers + `void main()`)
  from raw LLM output, stripping markdown/prose and reserved redeclarations.

## Troubleshooting

- **CORS errors against Ollama** — recent Ollama versions allow
  `http://localhost:*` and `file://` origins by default; if yours doesn't,
  start it with `OLLAMA_ORIGINS='*' ollama serve`.
- **"Ollama unreachable"** — check `ollama serve` is running on port 11434.
- **Black master output** — deck 1 starts at full opacity, others at 0;
  check the mixer faders.
