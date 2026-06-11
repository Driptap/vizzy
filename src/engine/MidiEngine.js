const STORAGE_KEY = 'vizzy.midiBindings';
const LEGACY_STORAGE_KEY = 'promptvj.midiBindings'; // pre-rebrand fallback

const CC_STATUS = 0xb0;

export class MidiEngine {
  /**
   * @param {object} handlers
   * @param {(controlId: string, value: number) => void} handlers.onControlValue value normalized 0..1
   * @param {(controlId: string, cc: number) => void} handlers.onLearned
   */
  constructor({ onControlValue, onLearned }) {
    this.onControlValue = onControlValue;
    this.onLearned = onLearned;
    this.access = null;
    this.armedControl = null;
    try {
      this.bindings =
        JSON.parse(
          localStorage.getItem(STORAGE_KEY) || localStorage.getItem(LEGACY_STORAGE_KEY),
        ) || {};
    } catch {
      this.bindings = {};
    }
    this.handleMessage = this.handleMessage.bind(this);
  }

  async init() {
    this.access = await navigator.requestMIDIAccess();
    this.attachInputs();
    this.access.onstatechange = () => this.attachInputs();
    return this.access;
  }

  attachInputs() {
    if (!this.access) return;
    this.access.inputs.forEach((input) => {
      input.onmidimessage = this.handleMessage;
    });
  }

  get inputCount() {
    return this.access ? this.access.inputs.size : 0;
  }

  arm(controlId) {
    this.armedControl = controlId;
  }

  disarm() {
    this.armedControl = null;
  }

  handleMessage(event) {
    const [status, cc, value] = event.data;
    if ((status & 0xf0) !== CC_STATUS) return;

    if (this.armedControl) {
      // one CC per control: drop any previous CC bound to this control
      Object.keys(this.bindings)
        .filter((key) => this.bindings[key] === this.armedControl)
        .forEach((key) => delete this.bindings[key]);
      this.bindings[cc] = this.armedControl;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.bindings));
      const learned = this.armedControl;
      this.armedControl = null;
      this.onLearned?.(learned, cc);
      return;
    }

    const control = this.bindings[cc];
    if (control) this.onControlValue?.(control, value / 127);
  }

  // inverted view for UI labels: { controlId: cc }
  controlMap() {
    const map = {};
    Object.entries(this.bindings).forEach(([cc, control]) => {
      map[control] = Number(cc);
    });
    return map;
  }

  dispose() {
    if (this.access) {
      this.access.inputs.forEach((input) => {
        input.onmidimessage = null;
      });
      this.access.onstatechange = null;
    }
  }
}
