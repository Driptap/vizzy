import { useCallback, useState, type RefObject } from 'react';
import type { AudioEngine } from '../engine/AudioEngine';

// Audio-input UI state over the AudioEngine owned by the rig.
export function useAudioControls(audioRef: RefObject<AudioEngine | null>) {
  const [audioActive, setAudioActive] = useState(false);
  const [audioDevices, setAudioDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDevice, setSelectedDevice] = useState('');

  const refreshDevices = useCallback(async () => {
    setAudioDevices(await audioRef.current!.listDevices());
  }, [audioRef]);

  const handleToggleAudio = useCallback(async () => {
    const audio = audioRef.current!;
    if (audio.active) {
      await audio.stop();
      setAudioActive(false);
      return;
    }
    try {
      await audio.start(selectedDevice || undefined);
      setAudioActive(true);
      await refreshDevices(); // labels only populate after permission is granted
    } catch (err) {
      console.error('[Vizzy] Audio input failed:', err);
      setAudioActive(false);
    }
  }, [audioRef, selectedDevice, refreshDevices]);

  const handleSelectDevice = useCallback(
    async (deviceId: string) => {
      setSelectedDevice(deviceId);
      const audio = audioRef.current!;
      if (audio.active) {
        try {
          await audio.start(deviceId || undefined);
        } catch (err) {
          console.error('[Vizzy] Audio input failed:', err);
          setAudioActive(false);
        }
      }
    },
    [audioRef],
  );

  return {
    audioActive,
    audioDevices,
    selectedDevice,
    handleToggleAudio,
    handleSelectDevice,
  };
}
