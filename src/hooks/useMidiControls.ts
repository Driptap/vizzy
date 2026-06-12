import { useCallback, useEffect, useRef, useState } from 'react';
import { MidiEngine } from '../engine/MidiEngine';

interface MidiControlsOptions {
  onControlValue: (controlId: string, value: number) => void;
}

// MIDI learn/binding state around a mount-once MidiEngine. The value handler
// is routed through a ref so rebinding callbacks never re-creates the engine.
export function useMidiControls({ onControlValue }: MidiControlsOptions) {
  const midiRef = useRef<MidiEngine | null>(null);
  const onControlValueRef = useRef(onControlValue);
  onControlValueRef.current = onControlValue;

  const [midiLearn, setMidiLearn] = useState(false);
  const [armedControl, setArmedControl] = useState<string | null>(null);
  const [controlMap, setControlMap] = useState<Record<string, number>>({});
  const [midiInputs, setMidiInputs] = useState(0);

  useEffect(() => {
    const midi = new MidiEngine({
      onControlValue: (controlId, value) => onControlValueRef.current(controlId, value),
      onLearned: () => {
        setArmedControl(null);
        setControlMap(midi.controlMap());
      },
    });
    midiRef.current = midi;
    setControlMap(midi.controlMap());
    midi
      .init()
      .then(() => setMidiInputs(midi.inputCount))
      .catch((err) => console.warn('[Vizzy] MIDI unavailable:', err));
    return () => midi.dispose();
  }, []);

  const handleToggleMidiLearn = useCallback(() => {
    setMidiLearn((prev) => {
      if (prev) {
        midiRef.current?.disarm();
        setArmedControl(null);
      }
      return !prev;
    });
  }, []);

  const handleArm = useCallback((controlId: string) => {
    midiRef.current?.arm(controlId);
    setArmedControl(controlId);
  }, []);

  return { midiLearn, armedControl, controlMap, midiInputs, handleToggleMidiLearn, handleArm };
}
