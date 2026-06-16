import { useCallback, useEffect, useState } from 'react';
import { getPlatform } from '../platform';

// Tracks and toggles the host window's fullscreen state. The native side is the
// source of truth: we seed from it on mount and re-sync on every change event
// (so an Esc/WM exit updates the button too).
export function useFullscreen() {
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    const platform = getPlatform();
    let active = true;
    void platform.window
      .isFullscreen()
      .then((on) => {
        if (active) setIsFullscreen(on);
      })
      .catch(() => {});
    const unsubscribe = platform.window.onFullscreenChange((on) => setIsFullscreen(on));
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const toggle = useCallback(async () => {
    const platform = getPlatform();
    const current = await platform.window.isFullscreen().catch(() => isFullscreen);
    await platform.window.setFullscreen(!current).catch(() => {});
    setIsFullscreen(!current);
  }, [isFullscreen]);

  return { isFullscreen, toggle };
}
