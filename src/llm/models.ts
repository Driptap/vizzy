// Curated open-weight models that can write GLSL, smallest first.
// Sizes are the Ollama download; RAM is a rough "runs comfortably" figure
// (unified memory on Apple Silicon, system RAM + VRAM elsewhere).
export interface CatalogModel {
  tag: string;
  name: string;
  download: string;
  ram: string;
  blurb: string;
  default?: boolean;
}

export const MODEL_CATALOG: CatalogModel[] = [
  {
    tag: 'qwen2.5-coder:1.5b',
    name: 'Qwen2.5 Coder 1.5B',
    download: '1.0 GB',
    ram: '4 GB',
    blurb: 'Tiny and instant — simple shaders, runs on anything.',
  },
  {
    tag: 'qwen2.5-coder:3b',
    name: 'Qwen2.5 Coder 3B',
    download: '1.9 GB',
    ram: '6 GB',
    blurb: 'Quick drops on modest laptops, decent shader variety.',
  },
  {
    tag: 'qwen2.5-coder',
    name: 'Qwen2.5 Coder 7B',
    download: '4.7 GB',
    ram: '8 GB',
    blurb: 'The default. Best balance of shader quality and speed.',
    default: true,
  },
  {
    tag: 'llama3.1:8b',
    name: 'Llama 3.1 8B',
    download: '4.9 GB',
    ram: '8 GB',
    blurb: 'Generalist — more surprising prompts, occasionally weirder GLSL.',
  },
  {
    tag: 'qwen2.5-coder:14b',
    name: 'Qwen2.5 Coder 14B',
    download: '9.0 GB',
    ram: '16 GB',
    blurb: 'Noticeably better shaders if your machine can take it.',
  },
  {
    tag: 'deepseek-coder-v2:16b',
    name: 'DeepSeek Coder V2 16B',
    download: '8.9 GB',
    ram: '16 GB',
    blurb: 'Strong coder, faster than its size suggests (MoE).',
  },
];

export function catalogEntry(tag: string): CatalogModel | null {
  return MODEL_CATALOG.find((m) => m.tag === tag) || null;
}
