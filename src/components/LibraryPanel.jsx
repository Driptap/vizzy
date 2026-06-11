import { useEffect, useRef, useState } from 'react';

const MENU_WIDTH = 168;
const MENU_HEIGHT = 196;

export function LibraryPanel({ open, shaders, sceneLetter, onDelete, onRename, onAddToChannel }) {
  const [menu, setMenu] = useState(null); // { x, y, entry }
  const [renamingId, setRenamingId] = useState(null);
  const [draft, setDraft] = useState('');
  const menuRef = useRef(null);

  useEffect(() => {
    if (!menu) return undefined;
    const close = (e) => {
      if (!menuRef.current?.contains(e.target)) setMenu(null);
    };
    const closeAlways = () => setMenu(null);
    window.addEventListener('pointerdown', close);
    window.addEventListener('blur', closeAlways);
    window.addEventListener('resize', closeAlways);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('blur', closeAlways);
      window.removeEventListener('resize', closeAlways);
    };
  }, [menu]);

  const startRename = (entry) => {
    setRenamingId(entry.id);
    setDraft(entry.name || '');
    setMenu(null);
  };

  const commitRename = (entry) => {
    if (renamingId !== entry.id) return;
    setRenamingId(null);
    const name = draft.trim();
    if (name !== (entry.name || '')) onRename(entry, name);
  };

  return (
    <div
      className={`shrink-0 overflow-hidden transition-[width] duration-300 ${
        open ? 'w-60' : 'w-0'
      }`}
    >
      <div className="flex h-full w-60 flex-col border-r border-neutral-800 bg-neutral-900">
        <div className="border-b border-neutral-800 px-3 py-2.5">
          <span className="text-xs font-bold tracking-widest text-neutral-400">
            SHADER LIBRARY
          </span>
        </div>

        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
          {shaders.length === 0 && (
            <p className="px-2 py-4 text-center text-[10px] leading-relaxed text-neutral-600">
              Nothing saved yet — hit SAVE on a deck to capture its shader here.
            </p>
          )}
          {shaders.map((entry) => (
            <div
              key={entry.id}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ x: e.clientX, y: e.clientY, entry });
              }}
              className="group cursor-default rounded border border-neutral-800 bg-neutral-950 p-1.5 transition-colors hover:border-neutral-600"
              title="Right-click for options"
            >
              {entry.screenshot ? (
                <img
                  src={entry.screenshot}
                  alt={entry.name || 'Saved shader'}
                  draggable={false}
                  className="aspect-video w-full rounded object-cover"
                />
              ) : (
                <div className="flex aspect-video w-full items-center justify-center rounded bg-neutral-900 text-[10px] text-neutral-700">
                  no preview
                </div>
              )}
              {renamingId === entry.id ? (
                <input
                  autoFocus
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={() => commitRename(entry)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitRename(entry);
                    if (e.key === 'Escape') setRenamingId(null);
                  }}
                  placeholder="Shader name"
                  className="mt-1.5 w-full rounded border border-cyan-500 bg-neutral-900 px-1.5 py-0.5 text-[10px] text-neutral-200 focus:outline-none"
                />
              ) : (
                <p
                  className={`mt-1.5 truncate px-0.5 text-[10px] ${
                    entry.name ? 'text-neutral-300' : 'italic text-neutral-600'
                  }`}
                >
                  {entry.name || 'Untitled'}
                </p>
              )}
            </div>
          ))}
        </div>
      </div>

      {menu && (
        <div
          ref={menuRef}
          style={{
            left: Math.min(menu.x, window.innerWidth - MENU_WIDTH - 8),
            top: Math.min(menu.y, window.innerHeight - MENU_HEIGHT - 8),
          }}
          className="fixed z-50 w-42 rounded-md border border-neutral-700 bg-neutral-900 py-1 shadow-xl shadow-black/60"
        >
          {[0, 1, 2, 3].map((channel) => (
            <button
              key={channel}
              type="button"
              onClick={() => {
                onAddToChannel(menu.entry, channel);
                setMenu(null);
              }}
              className="block w-full px-3 py-1.5 text-left text-xs text-neutral-300 hover:bg-neutral-800 hover:text-cyan-300"
            >
              Add to channel {sceneLetter}
              {channel + 1}
            </button>
          ))}
          <div className="my-1 border-t border-neutral-800" />
          <button
            type="button"
            onClick={() => startRename(menu.entry)}
            className="block w-full px-3 py-1.5 text-left text-xs text-neutral-300 hover:bg-neutral-800"
          >
            Rename
          </button>
          <button
            type="button"
            onClick={() => {
              onDelete(menu.entry.id);
              setMenu(null);
            }}
            className="block w-full px-3 py-1.5 text-left text-xs text-red-400 hover:bg-red-500/10"
          >
            Delete
          </button>
        </div>
      )}
    </div>
  );
}
