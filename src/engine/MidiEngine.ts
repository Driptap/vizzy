import { getStored, setStored } from '../lib/storage';
import { isTauri } from '../platform';

const STORAGE_KEY = 'midiBindings';

const CC_STATUS = 0xb0;

export interface MidiHandlers {
  /** value normalized 0..1 */
  onControlValue?: (controlId: string, value: number) => void;
  onLearned?: (controlId: string, cc: number) => void;
}

/** CC number (as a string key) -> bound control id */
type Bindings = Record<string, string>;

interface NativeMidiMessage {
  status: number;
  data1: number;
  data2: number;
}

/**
 * MIDI learn/binding engine. The learn and routing logic is host-agnostic;
 * only the transport differs: the Rust core's midir event stream under
 * Tauri (whose webviews lack Web MIDI), Web MIDI in a plain browser tab.
 */
export class MidiEngine {
  onControlValue?: MidiHandlers['onControlValue'];
  onLearned?: MidiHandlers['onLearned'];
  access: MIDIAccess | null = null;
  armedControl: string | null = null;
  bindings: Bindings;
  private nativeInputs = 0;
  private nativeUnlistens: Array<() => void> = [];

  constructor({ onControlValue, onLearned }: MidiHandlers) {
    this.onControlValue = onControlValue;
    this.onLearned = onLearned;
    try {
      this.bindings = JSON.parse(getStored(STORAGE_KEY) ?? '') || {};
    } catch {
      this.bindings = {};
    }
    this.handleMessage = this.handleMessage.bind(this);
  }

  async init(): Promise<void> {
    if (isTauri()) {
      await this.initNative();
      return;
    }
    this.access = await navigator.requestMIDIAccess();
    this.attachInputs();
    this.access.onstatechange = () => this.attachInputs();
  }

  private async initNative(): Promise<void> {
    const { invoke } = await import('@tauri-apps/api/core');
    const { listen } = await import('@tauri-apps/api/event');
    this.nativeUnlistens.push(
      await listen<NativeMidiMessage>('vizzy://midi-message', (e) =>
        this.handleBytes(e.payload.status, e.payload.data1, e.payload.data2),
      ),
      await listen<{ count: number }>('vizzy://midi-ports-changed', (e) => {
        this.nativeInputs = e.payload.count;
      }),
    );
    this.nativeInputs = await invoke<number>('midi_start');
  }

  attachInputs(): void {
    if (!this.access) return;
    this.access.inputs.forEach((input) => {
      input.onmidimessage = this.handleMessage;
    });
  }

  get inputCount(): number {
    if (this.nativeUnlistens.length > 0) return this.nativeInputs;
    return this.access ? this.access.inputs.size : 0;
  }

  arm(controlId: string): void {
    this.armedControl = controlId;
  }

  disarm(): void {
    this.armedControl = null;
  }

  handleMessage(event: MIDIMessageEvent): void {
    if (!event.data) return;
    const [status, cc, value] = event.data;
    this.handleBytes(status, cc, value);
  }

  handleBytes(status: number, cc: number, value: number): void {
    if ((status & 0xf0) !== CC_STATUS) return;

    if (this.armedControl) {
      // one CC per control: drop any previous CC bound to this control
      Object.keys(this.bindings)
        .filter((key) => this.bindings[key] === this.armedControl)
        .forEach((key) => delete this.bindings[key]);
      this.bindings[cc] = this.armedControl;
      setStored(STORAGE_KEY, JSON.stringify(this.bindings));
      const learned = this.armedControl;
      this.armedControl = null;
      this.onLearned?.(learned, cc);
      return;
    }

    const control = this.bindings[cc];
    if (control) this.onControlValue?.(control, value / 127);
  }

  // inverted view for UI labels: { controlId: cc }
  controlMap(): Record<string, number> {
    const map: Record<string, number> = {};
    Object.entries(this.bindings).forEach(([cc, control]) => {
      map[control] = Number(cc);
    });
    return map;
  }

  dispose(): void {
    if (this.access) {
      this.access.inputs.forEach((input) => {
        input.onmidimessage = null;
      });
      this.access.onstatechange = null;
    }
    if (this.nativeUnlistens.length > 0) {
      this.nativeUnlistens.forEach((unlisten) => unlisten());
      this.nativeUnlistens = [];
      void import('@tauri-apps/api/core').then(({ invoke }) =>
        invoke('midi_stop').catch(() => {}),
      );
    }
  }
}
