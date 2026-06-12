import { useCallback, useEffect, useState } from 'react';
import type { EngineRef } from './useEngineRig';

// Master out is a native window owned by the render core: it keeps running
// at full rate even when this webview is hidden or minimized.
export function useMasterWindow(engineRef: EngineRef) {
  const [masterOpen, setMasterOpen] = useState(false);

  // the native window has its own close button; mirror it into UI state
  useEffect(() => {
    engineRef.current?.onMasterClosed(() => setMasterOpen(false));
  }, [engineRef]);

  const handleToggleMaster = useCallback(() => {
    const engine = engineRef.current;
    if (!engine) return;
    void (masterOpen ? engine.closeMaster() : engine.openMaster())
      .then(setMasterOpen)
      .catch((err) => console.error('[Vizzy] Master window failed:', err));
  }, [engineRef, masterOpen]);

  return { masterOpen, handleToggleMaster };
}
