# Vizzy — architecture map

Native VJ/visuals app: a **Tauri 2** shell (Rust core) hosting a **React + TypeScript**
UI that drives a **wgpu** render engine. Patch-based generation (JSON patches, not raw
GLSL). Rebuilt from a former Electron app — there is no backward-compat layer, and the
old Electron data dir (`~/Library/Application Support/vizzy`) is dead; the Tauri app uses
`~/Library/Application Support/com.driptap.vizzy` (the bundle identifier).

## Where things live

### `src-tauri/` — Rust core (the native host)
- `src/lib.rs` — Tauri builder: registers `tauri_plugin_fs`, `tauri_plugin_dialog`, and
  the custom commands/events. Start here to see what IPC the frontend can call.
- `src/audio.rs`, `src/midi.rs` — native audio capture / MIDI, surfaced as commands+events.
- `src/ollama.rs` — managed local LLM runtime (downloaded into `<userData>/ollama-runtime/`).
- `tauri.conf.json` — identifier (`com.driptap.vizzy`), product name, window config.
- `capabilities/default.json` — **fs plugin permissions + scope**. The scope (`$APPDATA`,
  `$APPDATA/**`) governs which paths the frontend may read/write. ⚠️ See persistence note.

### `src/` — React/TS frontend
- `App.tsx` — top-level composition; wires the hooks together. `main.tsx` — entry.
- `types.ts` — shared types: `LibraryEntry` union (`ShaderEntry`/`DeckEntry`/`ModelEntry`/
  `SpriteEntry`/`SceneEntry`), `SessionSnapshot`, patch/scene specs.
- `platform/` — host abstraction so the UI never imports Tauri APIs directly.
  - `index.ts` — `getPlatform()` picks `tauri` vs a no-op `browser` fallback (dev/jsdom).
  - `tauri.ts` — real file IO via `@tauri-apps/plugin-fs`, dirs via `appDataDir()`, drops,
    dialogs, ollama.
- `lib/` — host-agnostic logic. **Persistence lives here — see `src/lib/CLAUDE.md`.**
- `hooks/` — React state + side-effect wiring:
  - `usePerformanceState.ts` — the live mixer/deck state (opacity, scale, pos, fx, …).
  - `useSessionPersistence.ts` — autosave (debounced) + restore of `session.json`.
  - `useLibrary.ts` — **boot sequence**: load library → seed first-run example OR restore
    session. Also all library CRUD handlers.
  - `useEngineRig.ts` — owns the `NativeRenderEngine` ref. `useGeneration.ts` — patch gen.
  - `useAudioControls.ts` / `useMidiControls.ts` — bind native audio/MIDI to state.
  - `useLlmSetup.ts` / `useMasterWindow.ts` — LLM bootstrap, second output window.
- `engine/` — TS bridges to the native engines (`NativeRenderEngine`, `NativeAudioEngine`,
  `MidiEngine`).
- `llm/` — prompt/templating to turn natural language into patches/scenes (`patches.ts`,
  `scenes.ts`, `models.ts`, `ollama.ts`).
- `components/` — UI (TopBar, deck/channel controls, library panel, etc.).

## Persistence at a glance
Two kinds of saved data, both under `<userData>` (`com.driptap.vizzy`):
- **Library** — one JSON per entry in `shaders/`; assets copied into `models/`, `sprites/`.
  Written by `src/lib/shaderLibrary.ts`, loaded by `listShaders()` at boot.
- **Session** — the live arrangement in `session.json`. Written/restored by
  `src/lib/session.ts` + `hooks/useSessionPersistence.ts`.

⚠️ **fs scope constraint (macOS/unix):** the fs scope `$APPDATA/**` does **not** match
dotfiles, because `tauri-plugin-fs` defaults `require_literal_leading_dot = true` on unix —
any write of a hidden file under `<userData>` is silently rejected. **Never write a dotfile
through the platform fs layer.** This previously broke the first-run marker (`.vizzy-seeded`)
and, through it, session restore; the marker is now `vizzy-seeded.json`. See `src/lib/CLAUDE.md`.
