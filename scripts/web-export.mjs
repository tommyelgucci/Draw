import { chromium } from 'playwright';
import { unzipSync } from 'fflate';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

let failures = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? '  ok  ' : ' FALLA'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
};

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || undefined,
  args: [
    '--enable-unsafe-swiftshader',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--allow-file-access-from-files',
  ],
});

/* ------------------------------------------------------------------ *
 * Parte 1: el panel real genera el snippet y lo copia al portapapeles.
 * Stub de navigator.clipboard antes de que cargue la app — Playwright no
 * concede permisos de portapapeles de forma fiable en Chromium headless.
 * ------------------------------------------------------------------ */

const appPage = await browser.newPage({ viewport: { width: 1000, height: 800 } });
await appPage.addInitScript(() => {
  window.__lastCopied = null;
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: (text) => { window.__lastCopied = text; return Promise.resolve(); } },
  });
});

const errors = [];
appPage.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
appPage.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

await appPage.goto('http://127.0.0.1:5173/', { waitUntil: 'networkidle' });
await appPage.waitForTimeout(1200);

/** Cuatro fotogramas, cada uno teñido de un color sólido distinto que cubre
 *  todo el lienzo — así el snippet exportado se puede verificar por color
 *  de píxel sin ambigüedad de posición. */
const COLORS = [
  [220, 40, 40],
  [40, 160, 40],
  [40, 90, 220],
  [230, 200, 30],
];

const setup = await appPage.evaluate((colors) => {
  const e = window.__trace;
  e.setFrameCount(colors.length);
  const layer = e.activeLayer;
  const w = e.doc.width;
  const h = e.doc.height;
  for (let f = 0; f < colors.length; f++) {
    e.setFrame(f);
    if (!layer.cels.has(f)) e.addCel(layer.id, f, false);
    const cel = layer.cels.get(f);
    const [r, g, b] = colors[f];
    const px = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      px[i * 4] = r;
      px[i * 4 + 1] = g;
      px[i * 4 + 2] = b;
      px[i * 4 + 3] = 255;
    }
    e.renderer.writeRect(cel.surface, { x: 0, y: 0, x2: w, y2: h }, px);
  }
  e.setFrame(0);
  e.touch();
  return { width: w, height: h, name: e.doc.name, safeName: (e.doc.name || 'trace').replace(/[^\w-]+/g, '_') };
}, COLORS);

console.log('\n— Panel "Exportar para web": botón de loop copia el snippet —');
await appPage.evaluate(() => window.__uiStore.getState().setPanel('export'));
await appPage.waitForTimeout(200);
await appPage.getByRole('button', { name: /loop transparente/ }).click();
const loopSnippet = await appPage.evaluate(() => window.__lastCopied);
check('el snippet de loop referencia el PNG con el nombre de descarga real', loopSnippet?.includes(`${setup.safeName}.png`), loopSnippet?.slice(0, 120));
check('el snippet de loop declara el tamaño del documento', loopSnippet?.includes(`width="${setup.width}"`) && loopSnippet?.includes(`height="${setup.height}"`));

console.log('\n— Botón de scroll copia el snippet con la carpeta indicada —');
await appPage.getByLabel('Carpeta de fotogramas en tu web').fill('assets/frames');
await appPage.getByRole('button', { name: /animación con el scroll/ }).click();
const scrollSnippetCustomFolder = await appPage.evaluate(() => window.__lastCopied);
check('el snippet usa la carpeta que se escribió en el campo', scrollSnippetCustomFolder?.includes('const folder = "assets/frames"'), scrollSnippetCustomFolder?.match(/folder = .*/)?.[0]);

// Vuelve a la carpeta por defecto ("frames") para la parte 2, donde de
// verdad se descomprimen los PNG ahí.
await appPage.getByLabel('Carpeta de fotogramas en tu web').fill('frames');
await appPage.getByRole('button', { name: /animación con el scroll/ }).click();
const scrollSnippet = await appPage.evaluate(() => window.__lastCopied);
check('el snippet de scroll tiene el mismo número de fotogramas que el documento', scrollSnippet?.includes(`frameCount = ${COLORS.length};`));

console.log('\n— Consola de la app —');
check('sin errores en consola', errors.length === 0, errors.join(' | '));

/* ------------------------------------------------------------------ *
 * Parte 2: el snippet de scroll de verdad, pegado en una página estática y
 * cargado por `file://`, redibuja el fotograma correcto al desplazarse.
 * ------------------------------------------------------------------ */

console.log('\n— El snippet de scroll pegado en una página real cambia de fotograma —');

const zipBytes = await appPage.evaluate(async () => {
  const io = await import('/src/core/io.ts');
  const blob = await io.exportSequenceZip(window.__trace);
  return Array.from(new Uint8Array(await blob.arrayBuffer()));
});
const zip = unzipSync(Uint8Array.from(zipBytes));
const entries = Object.keys(zip);
check('la secuencia exportada tiene un PNG por fotograma', entries.length === COLORS.length, `${entries.length}`);

const dir = mkdtempSync(path.join(tmpdir(), 'trace-web-export-'));
const framesDir = path.join(dir, 'frames');
mkdirSync(framesDir);
for (const [name, bytes] of Object.entries(zip)) {
  writeFileSync(path.join(framesDir, name), Buffer.from(bytes));
}
writeFileSync(path.join(dir, 'test.html'), `<!doctype html><html><body>${scrollSnippet}</body></html>`);

const staticPage = await browser.newPage({ viewport: { width: 800, height: 600 } });
const staticErrors = [];
staticPage.on('console', (m) => m.type() === 'error' && staticErrors.push(m.text()));
staticPage.on('pageerror', (e) => staticErrors.push(`pageerror: ${e.message}`));

await staticPage.goto(`file://${path.join(dir, 'test.html')}`);
await staticPage.waitForFunction(() => {
  const canvas = document.querySelector('canvas');
  return canvas && canvas.getContext('2d').getImageData(10, 10, 1, 1).data[3] > 0;
});

const pixelAt = () =>
  staticPage.evaluate(() => {
    const canvas = document.querySelector('canvas');
    const d = canvas.getContext('2d').getImageData(10, 10, 1, 1).data;
    return [d[0], d[1], d[2], d[3]];
  });

const closeTo = (px, [r, g, b]) => Math.abs(px[0] - r) < 8 && Math.abs(px[1] - g) < 8 && Math.abs(px[2] - b) < 8;

const atTop = await pixelAt();
check('sin scroll se ve el fotograma 0', closeTo(atTop, COLORS[0]), JSON.stringify(atTop));

await staticPage.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
await staticPage.waitForTimeout(150);
const atBottom = await pixelAt();
check('al final del scroll se ve el último fotograma', closeTo(atBottom, COLORS[COLORS.length - 1]), JSON.stringify(atBottom));

await staticPage.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2));
await staticPage.waitForTimeout(150);
const atMid = await pixelAt();
const midIsNeitherEnd = !closeTo(atMid, COLORS[0]) || !closeTo(atMid, COLORS[COLORS.length - 1]);
check('a media página se ve un fotograma intermedio, no siempre el mismo', midIsNeitherEnd, JSON.stringify(atMid));

check('sin errores de consola en la página estática', staticErrors.length === 0, staticErrors.join(' | '));

console.log(`\n${failures === 0 ? 'TODO EN VERDE' : `${failures} FALLOS`}\n`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
