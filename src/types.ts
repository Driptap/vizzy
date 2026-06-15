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

export type SourceType = 'shader' | 'model' | 'sprite' | 'video' | 'landscape' | 'scene';
export type AudioBand =
  | 'low'
  | 'mid'
  | 'high'
  | 'level'
  | 'beat'
  | 'beat-low'
  | 'beat-mid'
  | 'beat-high';
export interface AudioLevels {
  low: number;
  mid: number;
  high: number;
  level: number;
  /** Combined onset envelope 0..1 (max of enabled layers). Not smoothed. */
  beat: number;
  /** Per-layer onset envelopes 0..1 (kick / snare / hat). */
  beatLow: number;
  beatMid: number;
  beatHigh: number;
  /** Detected tempo in BPM; 0 until enough onsets accumulate. */
  bpm: number;
  /** True when the recent inter-onset intervals are consistent enough to trust. */
  bpmStable: boolean;
}

/** One beat-detection layer's live tuning (kick / snare / hat). */
export interface BeatBandConfig {
  /** feeds the combined `beat`? (the layer's own envelope is always produced) */
  enabled: boolean;
  /** onset-threshold multiplier 0.5..3 (higher = fewer beats) */
  sensitivity: number;
  /** envelope fall per tick 0.02..0.5 (higher = tighter flash) */
  decay: number;
  /** minimum gap between this layer's beats, ms 60..500 (higher = calmer) */
  gapMs: number;
  /** detection band low/high bound, Hz */
  fromHz: number;
  toHz: number;
}

export interface ChannelFx {
  tilt: number; // degrees (the engine takes radians)
  contrast: number;
  hue: number; // degrees
  sat: number;
  band: AudioBand;
  amt: number;
}

/** Per-deck post filter applied to the deck's visible output. `kind` ids match
 *  FILTER_KINDS in the Rust engine (params.rs) and the `switch` in filter.wgsl;
 *  `amount` and `param2` are the two generic 0..1 controls the shader reads. */
export type FilterKind =
  | 'none'
  | 'invert'
  | 'hue'
  | 'posterize'
  | 'pixelate'
  | 'scanlines'
  | 'edge'
  | 'rgbSplit'
  | 'kaleido'
  | 'swirl'
  | 'blur'
  | 'lumaKey'
  | 'ripple';

export interface ChannelFilter {
  kind: FilterKind;
  amount: number;
  param2: number;
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
  filter: ChannelFilter;
  /** video playback controls — only meaningful on video decks */
  video?: VideoPlayback;
}

// ---- LLM-generated deck patches ----

/** A vec3 of cosine-palette coefficients. */
export type PatchVec3 = [number, number, number];

/** Named preset, or custom IQ cosine coefficients (col = a + b·cos(τ(c·t+d))). */
export type PatchPalette =
  | { preset: string }
  | { a: PatchVec3; b: PatchVec3; c: PatchVec3; d: PatchVec3 };

export interface PatchWarp {
  type: string;
  amount?: number;
  audio?: AudioBand;
}

export type PatchAudioTarget = 'scale' | 'brightness' | 'speed';

export interface PatchAudioRoute {
  band: AudioBand;
  target: PatchAudioTarget;
  amount: number;
}

export interface PatchPost {
  /** feedback decay 0..0.97; > 0 turns the history buffer on */
  trail?: number;
  /** MilkDrop-style per-frame feedback zoom (1 = none, 1.02 = classic) */
  feedZoom?: number;
  feedRotate?: number;
  posterize?: number;
  scanlines?: number;
  grain?: number;
  vignette?: number;
}

/**
 * A structured deck visual: the LLM fills this in instead of writing shader
 * code; the Rust composer assembles trusted WGSL blocks from it. A spec that
 * parses always renders. Mirrors src-tauri/src/render/patch.rs.
 */
export interface PatchSpec {
  generator: string;
  params?: Record<string, number>;
  palette?: PatchPalette;
  warps?: PatchWarp[];
  motion?: { speed?: number; rotate?: number };
  audio?: PatchAudioRoute[];
  post?: PatchPost;
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

/** Patch entries (deck visuals) predate `kind` and simply omit it. */
export interface ShaderEntry extends EntryBase {
  kind?: undefined;
  patch: PatchSpec;
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

export interface VideoEntry extends EntryBase {
  kind: 'video';
  file: string;
}

export type VideoLoopMode = 'loop' | 'once' | 'ping';

/** Per-deck video playback controls (sent to the native player each frame). */
export interface VideoPlayback {
  /** playback speed magnitude, 0..4 */
  rate: number;
  /** play backward */
  reverse: boolean;
  loopMode: VideoLoopMode;
  /** lock the clip loop to the global BPM, stretched to `beatDiv` beats */
  beatSync: boolean;
  beatDiv: number;
  /** restart the clip on each detected beat */
  beatJump: boolean;
  /** pulse playback speed with the beat envelope */
  beatRate: boolean;
  /** flip play direction on each beat */
  beatFlip: boolean;
}

export interface SceneEntry extends EntryBase {
  kind: 'scene';
  spec: SceneSpec;
  /** the prompt that generated it, for re-rolls */
  prompt?: string;
}

export type AssetEntry = ModelEntry | SpriteEntry | VideoEntry;
export type LibraryEntry =
  | ShaderEntry
  | DeckEntry
  | ModelEntry
  | SpriteEntry
  | VideoEntry
  | SceneEntry;

/** A deck-preset channel: config plus a reference to what was running. */
export type DeckChannelConfig = Partial<ChannelConfig> & {
  shaderId?: string;
  modelId?: string;
  spriteId?: string;
  /** a video clip entry */
  videoId?: string;
  /** a model entry staged in landscape mode (fly-over terrain) */
  landscapeId?: string;
  /** a procedural scene entry */
  sceneId?: string;
};

// ---- engine channel sources & staging ----

/** What is currently running on an engine slot (also persisted in sessions). */
export type ChannelSource =
  | { type: 'shader'; patch: PatchSpec }
  | { type: 'model'; modelId: string }
  | { type: 'sprite'; spriteId: string }
  | { type: 'video'; videoId: string }
  | { type: 'landscape'; modelId: string }
  | { type: 'scene'; spec: SceneSpec };

/** A resolved, ready-to-stage source. */
export type StageableSource =
  | { type: 'shader'; patch: PatchSpec }
  | { type: 'model'; entry: ModelEntry }
  | { type: 'sprite'; entry: SpriteEntry }
  | { type: 'video'; entry: VideoEntry }
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
  /** when true, the detected tempo drives `bpm` */
  bpmSync?: boolean;
  /** per-layer beat-detector tuning [low, mid, high] */
  beatBands?: BeatBandConfig[];
  slots: SessionSlot[];
}
