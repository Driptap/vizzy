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

export type SourceType = 'shader' | 'model' | 'sprite' | 'landscape' | 'scene';
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

export type AutEffectKey = 'scl' | 'rot' | 'tlt' | 'flk' | 'dst' | 'skw';
export interface AutEffect {
  amt: number;
  audio: boolean;
}
export type AutomationMap = Record<AutEffectKey, AutEffect>;

export interface ChannelSize {
  x: number;
  y: number;
}

/** In-scene content offset (landscape camera pan/height, model/sprite shift). */
export interface ChannelPos {
  x: number;
  y: number;
}

/** A controllable channel parameter the looper can automate. */
export type LoopControlId =
  | 'opacity'
  | 'scale'
  | 'sizeX'
  | 'sizeY'
  | 'posX'
  | 'posY'
  | 'tilt'
  | 'contrast'
  | 'hue'
  | 'sat'
  | 'brightness'
  | 'lightAngle';

/** One automation anchor: position/value in 0..1, bend curves the segment
 *  LEAVING this point (-1 eases early, +1 eases late, 0 linear). */
export interface LoopPoint {
  t: number;
  v: number;
  bend: number;
}

/**
 * A deck's beat-locked automation loop: blocks x divider beats long. A lane's
 * presence means that control is automated; values override the knobs while
 * playing (the FADER lane multiplies the mixer fader instead).
 */
export interface DeckLoop {
  playing: boolean;
  /** 1..8 blocks */
  blocks: number;
  /** beats per block (the tempo divider) */
  divider: number;
  lanes: Partial<Record<LoopControlId, LoopPoint[]>>;
}

/** Light rig controls for lit decks (3D models, mesh landscapes). */
export interface ChannelLight {
  /** master intensity multiplier, 0..2 (1 = the built-in rig) */
  brightness: number;
  /** key-light orbit around the vertical axis, degrees */
  angle: number;
}

/** The full per-channel config carried by deck presets and session slots. */
export interface ChannelConfig {
  prompt: string;
  opacity: number;
  muted: boolean;
  scale: number;
  size: ChannelSize;
  pos: ChannelPos;
  light: ChannelLight;
  /** compositing layer 1 (top) .. 4 (base) */
  layer: number;
  fx: ChannelFx;
  aut: AutomationMap;
  loop: DeckLoop;
}

// ---- procedural fly-through scenes ----

/**
 * An LLM-generated fly-through scene: a surface expression evaluated over a
 * grid (terrain height h(x,z), or tunnel wall offset r(a,z)) plus a palette.
 * The expression language is the safe subset compiled by lib/expr.
 */
export interface SceneSpec {
  kind: 'terrain' | 'tunnel';
  surface: string;
  /** vertical relief (terrain) / wall modulation depth (tunnel), world units */
  amplitude: number;
  /** [low/wall colour, high/glow colour, fog colour] as #rrggbb */
  palette: [string, string, string];
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

export interface SceneEntry extends EntryBase {
  kind: 'scene';
  spec: SceneSpec;
  /** the prompt that generated it, for re-rolls */
  prompt?: string;
}

export type AssetEntry = ModelEntry | SpriteEntry;
export type LibraryEntry = ShaderEntry | DeckEntry | ModelEntry | SpriteEntry | SceneEntry;

/** A deck-preset channel: config plus a reference to what was running. */
export type DeckChannelConfig = Partial<ChannelConfig> & {
  shaderId?: string;
  modelId?: string;
  spriteId?: string;
  /** a model entry staged in landscape mode (fly-over terrain) */
  landscapeId?: string;
  /** a procedural scene entry */
  sceneId?: string;
};

// ---- engine channel sources & staging ----

/** What is currently running on an engine slot (also persisted in sessions). */
export type ChannelSource =
  | { type: 'shader'; code: string | null }
  | { type: 'model'; modelId: string }
  | { type: 'sprite'; spriteId: string }
  | { type: 'landscape'; modelId: string }
  | { type: 'scene'; spec: SceneSpec };

/** A resolved, ready-to-stage source. */
export type StageableSource =
  | { type: 'shader'; code: string }
  | { type: 'model'; entry: ModelEntry }
  | { type: 'sprite'; entry: SpriteEntry }
  | { type: 'landscape'; entry: ModelEntry }
  | { type: 'scene'; spec: SceneSpec };

export type StageResult = { ok: true } | { ok: false; error: string };

// ---- session persistence ----

export type SessionSlot = Partial<ChannelConfig> & { source?: ChannelSource };

export interface SessionSnapshot {
  version: 1;
  crossfade: number;
  cueScene: number;
  /** global tempo driving the deck loopers */
  bpm?: number;
  slots: SessionSlot[];
}
