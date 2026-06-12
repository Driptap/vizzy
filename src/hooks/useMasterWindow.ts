import { useCallback, useEffect, useRef, useState } from 'react';
import { NativeRenderEngine } from '../engine/NativeRenderEngine';
import type { EngineRef } from './useEngineRig';

// Master out lives in its own window. On Tauri it's a native wgpu surface
// owned by the Rust core; in a browser, window.open keeps it in this renderer
// process so the engine blits straight into its canvas each frame.
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

  // the native window has its own close button; mirror it into UI state
  useEffect(() => {
    const engine = engineRef.current;
    if (engine instanceof NativeRenderEngine) {
      engine.onMasterClosed(() => setMasterOpen(false));
    }
  }, [engineRef]);

  const handleToggleMaster = useCallback(() => {
    const engine = engineRef.current;
    if (engine instanceof NativeRenderEngine) {
      void (masterOpen ? engine.closeMaster() : engine.openMaster())
        .then(setMasterOpen)
        .catch((err) => console.error('[Vizzy] Master window failed:', err));
      return;
    }
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
  }, [engineRef, masterOpen]);

  return { masterOpen, handleToggleMaster };
}
