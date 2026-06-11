import { useEffect, useRef, useState } from 'react';

const MENU_WIDTH = 168;
const MENU_HEIGHT = 200;

const TABS = [
  { id: 'shaders', label: 'SHADERS' },
  { id: 'decks', label: 'DECKS' },
];

export function LibraryPanel({
  open,
  shaders,
  decks,
  sceneLetter,
  onSaveDeck,
  onAssignDeck,
  onDelete,
  onRename,
  onAddToChannel,
}) {
  const [tab, setTab] = useState('shaders');
  const [menu, setMenu] = useState(null); // { x, y, entry, kind }
  const [renamingId, setRenamingId] = useState(null);
  const [draft, setDraft] = useState('');
  const [justSaved, setJustSaved] = useState(false);
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

  const saveDeck = async () => {
    await onSaveDeck();
    setJustSaved(true);
    setTimeout(() => setJustSaved(false), 1200);
  };

  const items = tab === 'shaders' ? shaders : decks;

  return (
    <div
      className={`shrink-0 overflow-hidden transition-[width] duration-300 ${
        open ? 'w-60' : 'w-0'
      }`}
    >
      <div className="flex h-full w-60 flex-col border-r border-neutral-800 bg-neutral-900">
        <div className="flex gap-1 border-b border-neutral-800 px-2 py-2">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={`rounded px-2.5 py-1 text-[10px] font-bold tracking-widest transition-colors ${
                tab === t.id
                  ? 'bg-neutral-700 text-cyan-300'
                  : 'text-neutral-500 hover:text-neutral-300'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {tab === 'decks' && (
          <button
            type="button"
            onClick={saveDeck}
            title={`Save scene ${sceneLetter}'s 4 channels (shaders + faders, mute, scale, W/H, fx, prompts) as a deck preset`}
            className={`mx-2 mt-2 rounded border py-1.5 text-[10px] font-bold tracking-wider transition-colors ${
              justSaved
                ? 'border-emerald-500 text-emerald-300'
                : 'border-neutral-700 text-neutral-300 hover:border-cyan-500 hover:text-cyan-300'
            }`}
          >
            {justSaved ? '✓ SAVED' : `+ SAVE DECK ${sceneLetter}`}
          </button>
        )}

        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
          {items.length === 0 && (
            <p className="px-2 py-4 text-center text-[10px] leading-relaxed text-neutral-600">
              {tab === 'shaders'
                ? 'Nothing saved yet — hit SAVE on a deck channel to capture its shader here.'
                : 'No deck presets yet — build a scene, then hit SAVE DECK to capture all 4 channels.'}
            </p>
          )}
          {items.map((entry) => (
            <div
              key={entry.id}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ x: e.clientX, y: e.clientY, entry, kind: tab });
              }}
              className="group relative cursor-default rounded border border-neutral-800 bg-neutral-950 p-1.5 transition-colors hover:border-neutral-600"
              title="Right-click for options"
            >
              {entry.screenshot ? (
                <img
                  src={entry.screenshot}
                  alt={entry.name || 'Saved entry'}
                  draggable={false}
                  className="aspect-video w-full rounded object-cover"
                />
              ) : (
                <div className="flex aspect-video w-full items-center justify-center rounded bg-neutral-900 text-[10px] text-neutral-700">
                  no preview
                </div>
              )}
              {tab === 'decks' && (
                <span className="absolute right-2.5 top-2.5 rounded bg-black/60 px-1 py-0.5 text-[8px] font-black tracking-widest text-amber-300">
                  4CH
                </span>
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
                  placeholder={tab === 'decks' ? 'Deck name' : 'Shader name'}
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
          {menu.kind === 'shaders' &&
            [0, 1, 2, 3].map((channel) => (
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
          {menu.kind === 'decks' &&
            [0, 1].map((scene) => (
              <button
                key={scene}
                type="button"
                onClick={() => {
                  onAssignDeck(menu.entry, scene);
                  setMenu(null);
                }}
                className={`block w-full px-3 py-1.5 text-left text-xs text-neutral-300 hover:bg-neutral-800 ${
                  scene === 0 ? 'hover:text-cyan-300' : 'hover:text-fuchsia-300'
                }`}
              >
                Assign to {scene === 0 ? 'A' : 'B'}
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
