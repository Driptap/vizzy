# src/lib — host-agnostic logic (persistence lives here)

All file IO goes through `getPlatform()` (see `../platform/`); nothing here imports Tauri
directly. Data is stored under `<userData>` = `~/Library/Application Support/com.driptap.vizzy`.

## Persistence files
- `session.ts` — the **performance session** (`session.json`). `saveSession` (async,
  debounced from `useSessionPersistence`), `saveSessionSync` (last-gasp on `beforeunload`),
  `loadSession` (boot). Caches the resolved path so the sync flush has a path to write to.
- `shaderLibrary.ts` — the **library**: one JSON per entry in `shaders/`, asset blobs copied
  into `models/`/`sprites/`. `listShaders()` loads all entries at boot; `saveShader/Scene/
  Deck/Model/Sprite` write; `deleteEntry` removes. Also `hasSeededMarker`/`writeSeededMarker`
  (the `.vizzy-seeded` first-run flag).
- `storage.ts` — thin `localStorage` wrapper (`vizzy.` prefix). UI prefs only (e.g.
  `libraryOpen`, LLM `model`, MIDI bindings) — **not** persistence of library/session.
- `exampleSeed.ts` — first-run example content + `dedupeExampleEntries` (cleans duplicate
  example entries left by earlier re-seed bugs). `EXAMPLE_DECK_NAME = 'Example Deck'`.
- `sourceStaging.ts` — re-stage a slot's source onto the engine on restore (`resolveSourceRef`
  + `stageSource`). Other files: `patches.ts`, `sceneGenerator.ts`, `channels.ts` (SLOTS),
  `expr.ts`, `loopControls.ts`, `spriteLoader.ts`, `assetTypes.ts`, `llmJson.ts`.

## Boot / restore flow (in `../hooks/useLibrary.ts`)
```
listShaders() → dedupe → entries
session = loadSavedSession()
  if session:   setLibrary(entries); await restoreSession(session, entries)   ← always wins
  else:         alreadySeeded = hasSeededMarker() || entries has an "Example Deck"
                if NOT seeded: seedExampleLibrary(); assign example deck to scene 0
                setLibrary(entries)
writeSeededMarker()                  ← idempotent; heals installs with no marker yet
finally: markSessionReady()          ← enables autosave (runs AFTER the awaited restore)
```
Two invariants make this correct:
- **A saved session always restores**, independent of first-run/seed detection — reopening
  the app puts you back where you were; example content is only injected on a genuine first
  launch (no session).
- **Autosave is gated until restore finishes.** `restoreSession` is `async` and awaits all
  `stageSource` calls, and `markSessionReady()` runs in the boot `finally` *after* that await,
  so the debounced save can't snapshot half-staged channels and overwrite `session.json`.

## ⚠️ fs scope constraint: no dotfiles under `<userData>` (was the root-cause bug)
The fs scope in `src-tauri/capabilities/default.json` allows `$APPDATA` and `$APPDATA/**`, but
`tauri-plugin-fs` defaults `require_literal_leading_dot = true` on unix, so a `**` glob does
**not** match a leading-dot path segment. Any hidden-file write through the platform fs layer
is silently rejected — **don't write dotfiles to `<userData>`.**

This was the original cause of "state/library not stored": `writeSeededMarker()` used to write
`.vizzy-seeded`, which the scope rejected (and `.catch(() => {})` swallowed). The marker was
never created, so boot fell back to a fragile per-webview `localStorage` flag; when that
lapsed, boot re-seeded every launch, skipped restore, and then autosave overwrote the saved
`session.json` with seeded defaults.

Resolved by: renaming the marker to **`vizzy-seeded.json`** (non-dotfile, so the write
succeeds and surfaces errors instead of swallowing them — see `shaderLibrary.ts`); restoring
the session regardless of the seed branch; awaiting staging before enabling autosave; and
dropping the `localStorage` `seeded` flag entirely (no dual path).
