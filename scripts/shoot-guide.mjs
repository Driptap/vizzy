// Regenerates docs/guide/*.png: drives the Vizzy React UI in Chrome (the
// renderer-only dev server) and captures cropped screenshots of the controls
// each getting-started step refers to. Browser mode = no native engine, so the
// deck/scene previews are black, but every button renders.
//
// Usage:
//   npm run dev:renderer        # in one terminal (serves :5173)
//   npm run guide:shots         # in another
// Override the browser or URL via env if needed:
//   CHROME_PATH=/path/to/chrome APP_URL=http://localhost:5173/ npm run guide:shots
import puppeteer from 'puppeteer-core';
import { mkdir } from 'node:fs/promises';

const CHROME =
  process.env.CHROME_PATH ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const APP_URL = process.env.APP_URL || 'http://localhost:5173/';
const OUT = new URL('../docs/guide/', import.meta.url).pathname;

// Find a bounding rect in the page for a spec, optionally climbing parents or
// to a `closest` ancestor. Returns {x,y,width,height} in CSS px or null.
const RECT_FN = (spec) => {
  const pick = (s) => {
    let el = null;
    if (s.css) el = document.querySelector(s.css);
    else if (s.title)
      el = [...document.querySelectorAll('[title]')].find((e) =>
        e.getAttribute('title').includes(s.title),
      );
    else if (s.aria)
      el = [...document.querySelectorAll('[aria-label]')].find((e) =>
        e.getAttribute('aria-label').includes(s.aria),
      );
    else if (s.placeholder)
      el = document.querySelector(`[placeholder*="${s.placeholder}"]`);
    else if (s.text) {
      // status dots (●) and whitespace mean exact-equality is brittle; prefer
      // an exact trim match, fall back to substring, then the smallest element.
      const all = [...document.querySelectorAll('button,span,a,label')];
      let cands = all.filter((e) => e.textContent.trim() === s.text);
      if (!cands.length) cands = all.filter((e) => e.textContent.trim().includes(s.text));
      el = cands.sort((a, b) => {
        const ra = a.getBoundingClientRect();
        const rb = b.getBoundingClientRect();
        return ra.width * ra.height - rb.width * rb.height;
      })[0];
    }
    if (!el) return null;
    if (s.closest) el = el.closest(s.closest) || el;
    for (let i = 0; i < (s.up || 0); i += 1) el = el.parentElement || el;
    const r = el.getBoundingClientRect();
    return { x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height };
  };
  const specs = spec.group || [spec];
  const rects = specs.map(pick).filter(Boolean);
  if (!rects.length) return null;
  const x1 = Math.min(...rects.map((r) => r.x));
  const y1 = Math.min(...rects.map((r) => r.y));
  const x2 = Math.max(...rects.map((r) => r.x + r.width));
  const y2 = Math.max(...rects.map((r) => r.y + r.height));
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
};

async function main() {
  await mkdir(OUT, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--force-color-profile=srgb', '--hide-scrollbars'],
    defaultViewport: { width: 1500, height: 900, deviceScaleFactor: 2 },
  });
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('  [page error]', e.message));
  await page.goto(APP_URL, { waitUntil: 'networkidle2', timeout: 30000 });

  // crop helper: union the rects for `spec`, pad, clip, save.
  const shot = async (name, spec, pad = 12) => {
    const r = await page.evaluate(RECT_FN, spec);
    if (!r) {
      console.log(`  ✗ ${name}: no match`);
      return;
    }
    const clip = {
      x: Math.max(0, r.x - pad),
      y: Math.max(0, r.y - pad),
      width: Math.min(1500, r.width + pad * 2),
      height: r.height + pad * 2,
    };
    await page.screenshot({ path: `${OUT}${name}.png`, clip });
    console.log(`  ✓ ${name}.png  (${Math.round(clip.width)}×${Math.round(clip.height)})`);
  };

  // Step 00 — the first-run setup overlay ("give Vizzy a brain"). It opens a
  // beat after the LLM probe fails in the browser; wait for it, then capture.
  await page
    .waitForFunction(
      () =>
        [...document.querySelectorAll('*')].some((e) =>
          /ollama/i.test(e.textContent || ''),
        ),
      { timeout: 8000 },
    )
    .catch(() => console.log('  (setup overlay not detected — continuing)'));
  await new Promise((r) => setTimeout(r, 400));
  await page.screenshot({ path: `${OUT}step00-setup.png` });
  console.log('  ✓ step00-setup.png  (full screen)');

  // Dismiss the overlay (Skip / "Continue without") to reveal the rig.
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((e) =>
      /skip|without|later|continue/i.test(e.textContent || ''),
    );
    if (b) b.click();
  });
  await new Promise((r) => setTimeout(r, 500));

  // Type the example prompt into deck 1 so Generate lights up for the shot.
  const ta = await page.$('[placeholder*="neon plasma"]');
  if (ta) {
    await ta.click();
    await page.keyboard.type('neon plasma tunnel pulsing with the bass', { delay: 4 });
  }

  // Full rig for context.
  await page.screenshot({ path: `${OUT}rig-full.png` });
  console.log('  ✓ rig-full.png  (full screen)');

  // Top bar strip (top 52px, full width) — shows LLM/Model/Audio/Master/etc.
  await page.screenshot({ path: `${OUT}topbar.png`, clip: { x: 0, y: 0, width: 1500, height: 52 } });
  console.log('  ✓ topbar.png');

  // Step 00 detail — LLM status + Model picker.
  await shot('step00-llm-model', {
    group: [{ text: 'LLM' }, { text: 'Model' }, { css: 'select' }],
  });

  // Step 01 — CUE A/B and the deck builder (prompt + GLSL/SCENE + Generate).
  await shot('step01-cue', { group: [{ text: 'CUE A' }, { text: 'CUE B' }] });
  await shot('step01-generate', {
    group: [
      { placeholder: 'neon plasma' },
      { title: 'GLSL: the model writes' },
      { text: 'Generate' },
    ],
  });

  // Step 02 — the Audio group: device dropdown + Live toggle.
  await shot('step02-audio', {
    group: [{ text: 'Audio' }, { title: 'Capture audio so the visuals react' }],
  });

  // Step 03 — the A–B crossfader.
  await shot('step03-crossfader', { aria: 'Scene crossfader', up: 1 }, 16);

  // "More" — filters, MIDI, master/share, BPM, save, library.
  // The filter <select> only mounts when a deck's FILTER tab is active.
  await page.evaluate(() => {
    const t = [...document.querySelectorAll('button')].find(
      (b) => b.textContent.trim() === 'FILTER',
    );
    if (t) t.click();
  });
  await new Promise((r) => setTimeout(r, 250));
  await shot('more-filter', { aria: 'Deck 1 filter', up: 1 });
  await shot('more-midi', { text: 'MIDI Learn' });
  await shot('more-master-share', {
    group: [
      { title: 'Open the crossfaded master' },
      { title: 'Share the master output' },
      { title: 'Soft bloom on the master' },
    ],
  });
  await shot('more-bpm', { group: [{ text: 'BPM' }, { aria: 'Tempo in BPM' }] });
  await shot('more-library', { text: 'Library' });

  await browser.close();
  console.log(`\nDone → docs/guide/`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
