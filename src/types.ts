// Domain types shared across the engine, hooks, persistence and UI.

export type DeckStatus =
  | 'idle'
  | 'queued'
  | 'generating'
  | 'compiling'
  | 'active'
  | 'failed'
  | 'error';

export interface DeckUiState {
  status: DeckStatus;
  error: string | null;
}

export type SourceType = 'shader' | 'model' | 'sprite';
export type AudioBand = 'low' | 'mid' | 'high' | 'level';
export interface AudioLevels {
  low: number;
  mid: number;
  high: number;
  level: number;
}

export interface ChannelFx {
  tilt: number; // degrees (the engine takes radians)
  contrast: number;
  hue: number; // degrees
  sat: number;
  band: AudioBand;
  amt: number;
}

export type AutEffectKey = 'scl' | 'rot' | 'flk' | 'dst' | 'skw';
export interface AutEffect {
  amt: number;
  audio: boolean;
}
export type AutomationMap = Record<AutEffectKey, AutEffect>;

export interface ChannelSize {
  x: number;
  y: number;
}

/** The full per-channel config carried by deck presets and session slots. */
export interface ChannelConfig {
  prompt: string;
  opacity: number;
  muted: boolean;
  scale: number;
  size: ChannelSize;
  fx: ChannelFx;
  aut: AutomationMap;
}

// ---- library entries (one JSON file each in <userData>/shaders/) ----

interface EntryBase {
  id: string;
  name?: string;
  screenshot?: string | null;
  createdAt: number;
}

/** Plain shader entries predate `kind` and simply omit it. */
export interface ShaderEntry extends EntryBase {
  kind?: undefined;
  code: string;
}

export interface DeckEntry extends EntryBase {
  kind: 'deck';
  channels: DeckChannelConfig[];
}

export interface ModelEntry extends EntryBase {
  kind: 'model';
  file: string;
}

export interface SpriteEntry extends EntryBase {
  kind: 'sprite';
  file: string;
}

export type AssetEntry = ModelEntry | SpriteEntry;
export type LibraryEntry = ShaderEntry | DeckEntry | ModelEntry | SpriteEntry;

/** A deck-preset channel: config plus a reference to what was running. */
export type DeckChannelConfig = Partial<ChannelConfig> & {
  shaderId?: string;
  modelId?: string;
  spriteId?: string;
};

// ---- engine channel sources & staging ----

/** What is currently running on an engine slot (also persisted in sessions). */
export type ChannelSource =
  | { type: 'shader'; code: string | null }
  | { type: 'model'; modelId: string }
  | { type: 'sprite'; spriteId: string };

/** A resolved, ready-to-stage source. */
export type StageableSource =
  | { type: 'shader'; code: string }
  | { type: 'model'; entry: ModelEntry }
  | { type: 'sprite'; entry: SpriteEntry };

export type StageResult = { ok: true } | { ok: false; error: string };

// ---- session persistence ----

export type SessionSlot = Partial<ChannelConfig> & { source?: ChannelSource };

export interface SessionSnapshot {
  version: 1;
  crossfade: number;
  cueScene: number;
  slots: SessionSlot[];
}
