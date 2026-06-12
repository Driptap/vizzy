import { getStored, setStored } from '../lib/storage';

const STORAGE_KEY = 'midiBindings';

const CC_STATUS = 0xb0;

export interface MidiHandlers {
  /** value normalized 0..1 */
  onControlValue?: (controlId: string, value: number) => void;
  onLearned?: (controlId: string, cc: number) => void;
}

/** CC number (as a string key) -> bound control id */
type Bindings = Record<string, string>;

export class MidiEngine {
  onControlValue?: MidiHandlers['onControlValue'];
  onLearned?: MidiHandlers['onLearned'];
  access: MIDIAccess | null = null;
  armedControl: string | null = null;
  bindings: Bindings;

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

  async init(): Promise<MIDIAccess> {
    this.access = await navigator.requestMIDIAccess();
    this.attachInputs();
    this.access.onstatechange = () => this.attachInputs();
    return this.access;
  }

  attachInputs(): void {
    if (!this.access) return;
    this.access.inputs.forEach((input) => {
      input.onmidimessage = this.handleMessage;
    });
  }

  get inputCount(): number {
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
  }
}
