import { useEffect, useRef, useState } from 'react';
import { getPlatform } from '../platform';
import { MODEL_EXTENSIONS, SPRITE_EXTENSIONS, VIDEO_EXTENSIONS } from '../lib/assetTypes';
import type {
  DeckEntry,
  LibraryEntry,
  ModelEntry,
  SceneEntry,
  ShaderEntry,
  SpriteEntry,
  VideoEntry,
} from '../types';

type TabId = 'shaders' | 'scenes' | 'decks' | 'models' | 'sprites' | 'videos';

interface ContextMenu {
  x: number;
  y: number;
  entry: LibraryEntry;
  kind: TabId;
}

const MENU_WIDTH = 168;
// tallest menu (models: assign + landscape groups); used for edge clamping
const MENU_HEIGHT = 330;

const TABS: { id: TabId; label: string }[] = [
  { id: 'shaders', label: 'SHDR' },
  { id: 'scenes', label: 'SCN' },
  { id: 'decks', label: 'DECKS' },
  { id: 'models', label: '3D' },
  { id: 'sprites', label: 'IMG' },
  { id: 'videos', label: 'VID' },
];


// tabs whose content comes from files on disk (open button + drag-drop)
const FILE_TABS: Partial<Record<TabId, { extensions: string[]; buttonLabel: string }>> = {
  models: { extensions: MODEL_EXTENSIONS, buttonLabel: '+ OPEN MODEL…' },
  sprites: { extensions: SPRITE_EXTENSIONS, buttonLabel: '+ OPEN IMAGE…' },
  videos: { extensions: VIDEO_EXTENSIONS, buttonLabel: '+ OPEN VIDEO…' },
};

interface LibraryPanelProps {
  open: boolean;
  shaders: ShaderEntry[];
  scenes: SceneEntry[];
  decks: DeckEntry[];
  models: ModelEntry[];
  sprites: SpriteEntry[];
  videos: VideoEntry[];
  sceneLetter: string;
  onSaveDeck: () => void | Promise<void>;
  onAssignDeck: (entry: DeckEntry, scene: number) => void;
  onAddPaths: (paths: string[]) => void;
  onAssignModel: (entry: ModelEntry, channel: number) => void;
  onAssignLandscape: (entry: ModelEntry, channel: number) => void;
  onAssignSprite: (entry: SpriteEntry, channel: number) => void;
  onAssignVideo: (entry: VideoEntry, channel: number) => void;
  onAssignScene: (entry: SceneEntry, channel: number) => void;
  onDelete: (entry: LibraryEntry) => void;
  onRename: (entry: LibraryEntry, name: string) => void;
  onAddToChannel: (entry: ShaderEntry, channel: number) => void;
}

export function LibraryPanel({
  open,
  shaders,
  scenes,
  decks,
  models,
  sprites,
  videos,
  sceneLetter,
  onSaveDeck,
  onAssignDeck,
  onAddPaths,
  onAssignModel,
  onAssignLandscape,
  onAssignSprite,
  onAssignVideo,
  onAssignScene,
  onDelete,
  onRename,
  onAddToChannel,
}: LibraryPanelProps) {
  const [tab, setTab] = useState<TabId>('shaders');
  const [menu, setMenu] = useState<ContextMenu | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [justSaved, setJustSaved] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menu) return undefined;
    const close = (e: PointerEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenu(null);
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

  const startRename = (entry: LibraryEntry) => {
    setRenamingId(entry.id);
    setDraft(entry.name || '');
    setMenu(null);
  };

  const commitRename = (entry: LibraryEntry) => {
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

  const items: LibraryEntry[] =
    tab === 'shaders'
      ? shaders
      : tab === 'scenes'
        ? scenes
        : tab === 'decks'
          ? decks
          : tab === 'models'
            ? models
            : tab === 'sprites'
              ? sprites
              : videos;
  const fileTab = FILE_TABS[tab];

  return (
    <div
      className={`shrink-0 overflow-hidden transition-[width] duration-300 ${
        open ? 'w-60' : 'w-0'
      }`}
    >
      <div className="flex h-full w-60 flex-col border-r border-neutral-800 bg-neutral-900">
        <div className="flex gap-1 overflow-x-auto border-b border-neutral-800 px-2 py-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={`shrink-0 whitespace-nowrap rounded px-2.5 py-1 text-[10px] font-bold tracking-widest transition-colors ${
                tab === t.id
                  ? 'bg-neutral-700 text-cyan-300'
                  : 'text-neutral-500 hover:text-neutral-300'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {fileTab && (
          <>
            <button
              type="button"
              onClick={async () => {
                const paths = await getPlatform().pickFiles(fileTab.extensions);
                if (paths?.length) onAddPaths(paths);
              }}
              title={`Add files (${fileTab.extensions.join(', ')}) — or drag them into the window`}
              className="mx-2 mt-2 rounded border border-neutral-700 py-1.5 text-[10px] font-bold tracking-wider text-neutral-300 transition-colors hover:border-cyan-500 hover:text-cyan-300"
            >
              {fileTab.buttonLabel}
            </button>
          </>
        )}

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
              {tab === 'shaders' &&
                'Nothing saved yet — hit SAVE on a deck channel to capture its shader here.'}
              {tab === 'scenes' &&
                'No fly-through scenes yet — switch a deck to SCENE mode, generate one, then hit SAVE.'}
              {tab === 'decks' &&
                'No deck presets yet — build a scene, then hit SAVE DECK to capture all 4 channels.'}
              {tab === 'models' &&
                'No models yet — drop .glb / .obj / .stl files here, or use OPEN MODEL.'}
              {tab === 'sprites' &&
                'No sprites yet — drop .png / .jpg / .webp / .gif files here, or use OPEN IMAGE.'}
              {tab === 'videos' &&
                'No videos yet — drop .mp4 / .mov / .webm files here, or use OPEN VIDEO.'}
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
              {tab === 'scenes' && (
                <span className="absolute right-2.5 top-2.5 rounded bg-black/60 px-1 py-0.5 text-[8px] font-black tracking-widest text-fuchsia-300">
                  {(entry as SceneEntry).spec?.kind === 'tunnel' ? 'TUBE' : 'TERRA'}
                </span>
              )}
              {tab === 'decks' && (
                <span className="absolute right-2.5 top-2.5 rounded bg-black/60 px-1 py-0.5 text-[8px] font-black tracking-widest text-amber-300">
                  4CH
                </span>
              )}
              {tab === 'models' && (
                <span className="absolute right-2.5 top-2.5 rounded bg-black/60 px-1 py-0.5 text-[8px] font-black tracking-widest text-emerald-300">
                  3D
                </span>
              )}
              {tab === 'sprites' && (
                <span className="absolute right-2.5 top-2.5 rounded bg-black/60 px-1 py-0.5 text-[8px] font-black tracking-widest text-sky-300">
                  IMG
                </span>
              )}
              {tab === 'videos' && (
                <span className="absolute right-2.5 top-2.5 rounded bg-black/60 px-1 py-0.5 text-[8px] font-black tracking-widest text-violet-300">
                  VID
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
                  placeholder={
                    tab === 'scenes'
                      ? 'Scene name'
                      : tab === 'decks'
                      ? 'Deck name'
                      : tab === 'models'
                        ? 'Model name'
                        : tab === 'sprites'
                          ? 'Sprite name'
                          : tab === 'videos'
                            ? 'Video name'
                            : 'Shader name'
                  }
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
          {menu.kind !== 'decks' &&
            [0, 1, 2, 3].map((channel) => (
              <button
                key={channel}
                type="button"
                onClick={() => {
                  if (menu.kind === 'shaders') onAddToChannel(menu.entry as ShaderEntry, channel);
                  else if (menu.kind === 'scenes') onAssignScene(menu.entry as SceneEntry, channel);
                  else if (menu.kind === 'models') onAssignModel(menu.entry as ModelEntry, channel);
                  else if (menu.kind === 'videos') onAssignVideo(menu.entry as VideoEntry, channel);
                  else onAssignSprite(menu.entry as SpriteEntry, channel);
                  setMenu(null);
                }}
                className="block w-full px-3 py-1.5 text-left text-xs text-neutral-300 hover:bg-neutral-800 hover:text-cyan-300"
              >
                {menu.kind === 'shaders' || menu.kind === 'scenes' ? 'Add to channel ' : 'Assign to '}
                {sceneLetter}
                {channel + 1}
              </button>
            ))}
          {menu.kind === 'models' && (
            <>
              <div className="my-1 border-t border-neutral-800" />
              {[0, 1, 2, 3].map((channel) => (
                <button
                  key={`landscape-${channel}`}
                  type="button"
                  onClick={() => {
                    onAssignLandscape(menu.entry as ModelEntry, channel);
                    setMenu(null);
                  }}
                  title="Fly-over terrain: the mesh scrolls under a low camera — layer sprites on another channel to fly over it"
                  className="block w-full px-3 py-1.5 text-left text-xs text-neutral-300 hover:bg-neutral-800 hover:text-fuchsia-300"
                >
                  Landscape on {sceneLetter}
                  {channel + 1}
                </button>
              ))}
            </>
          )}
          {menu.kind === 'decks' &&
            [0, 1].map((scene) => (
              <button
                key={scene}
                type="button"
                onClick={() => {
                  onAssignDeck(menu.entry as DeckEntry, scene);
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
              onDelete(menu.entry);
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
