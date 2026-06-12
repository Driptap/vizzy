import type { AutEffectKey, AutomationMap, ChannelConfig, ChannelFx, ChannelLight } from '../types';

// The channel/slot model shared by the UI, the render engine and persistence:
// 2 scenes (A and B) of 4 channels each, addressed as 8 flat slots.
export const CHANNELS = 4; // channels per scene
export const SCENES = 2; // A (slots 0-3) and B (slots 4-7)
export const SLOTS = CHANNELS * SCENES;
export const SCENE_LETTERS = ['A', 'B'] as const;

export const slotIndex = (scene: number, channel: number): number =>
  scene * CHANNELS + channel;
export const sceneOfSlot = (slot: number): number => Math.floor(slot / CHANNELS);

// channel 1 of each scene starts audible so neither side of the fader is black
export const INITIAL_OPACITIES = [1, 0, 0, 0, 1, 0, 0, 0];

// per-channel fx: tilt/hue in degrees (engine takes radians), band routes
// which global band drives the deck's u_audio_level, amt = response multiplier
export const DEFAULT_FX: ChannelFx = { tilt: 0, contrast: 1, hue: 0, sat: 1, band: 'level', amt: 1 };

export const DEFAULT_LIGHT: ChannelLight = { brightness: 1, angle: 0 };

// everything starts on the base layer; lift a deck to 1-3 to stack it on top
export const DEFAULT_LAYER = 4;

// channel automation (sprites AND models): per effect {amt: 0..1, audio: bool}
// — audio couples the effect to the deck's routed level, otherwise it
// self-runs on time LFOs
export const AUT_KEYS: AutEffectKey[] = ['scl', 'rot', 'flk', 'dst', 'skw'];
export const makeDefaultAut = (): AutomationMap =>
  Object.fromEntries(AUT_KEYS.map((k) => [k, { amt: 0, audio: false }])) as AutomationMap;

// The full per-channel config carried by deck presets and session snapshots.
export const defaultChannelConfig = (): ChannelConfig => ({
  prompt: '',
  opacity: 0,
  muted: false,
  scale: 1,
  size: { x: 1, y: 1 },
  pos: { x: 0, y: 0 },
  light: { ...DEFAULT_LIGHT },
  layer: DEFAULT_LAYER,
  fx: { ...DEFAULT_FX },
  aut: makeDefaultAut(),
});
