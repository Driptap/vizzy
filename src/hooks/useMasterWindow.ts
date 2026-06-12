import { useCallback, useEffect, useRef, useState } from 'react';
import type { EngineRef } from './useEngineRig';

// Master out lives in its own window: window.open keeps it in this renderer
// process, so the engine blits straight into its canvas each frame.
export function useMasterWindow(engineRef: EngineRef) {
  const masterWindowRef = useRef<Window | null>(null);
  const [masterOpen, setMasterOpen] = useState(false);

  useEffect(
    () => () => {
      const popup = masterWindowRef.current;
      if (popup && !popup.closed) popup.close();
    },
    [],
  );

  const handleToggleMaster = useCallback(() => {
    const existing = masterWindowRef.current;
    if (existing && !existing.closed) {
      existing.close(); // pagehide handler below does the detach
      return;
    }

    const popup = window.open('', 'vizzy-master', 'width=1280,height=720');
    if (!popup) return;
    masterWindowRef.current = popup;

    const doc = popup.document;
    doc.title = 'Vizzy — Master Out';
    doc.body.innerHTML = '';
    doc.body.style.cssText = 'margin:0;background:#000;overflow:hidden;';
    const canvas = doc.createElement('canvas');
    canvas.style.cssText = 'display:block;width:100vw;height:100vh;';
    canvas.title = 'Double-click for fullscreen';
    doc.body.appendChild(canvas);
    canvas.addEventListener('dblclick', () => {
      if (doc.fullscreenElement) doc.exitFullscreen();
      else canvas.requestFullscreen().catch(() => {});
    });

    popup.addEventListener('pagehide', () => {
      if (masterWindowRef.current === popup) {
        masterWindowRef.current = null;
        engineRef.current?.setMasterCanvas(null);
        setMasterOpen(false);
      }
    });

    engineRef.current?.setMasterCanvas(canvas);
    setMasterOpen(true);
  }, [engineRef]);

  return { masterOpen, handleToggleMaster };
}
