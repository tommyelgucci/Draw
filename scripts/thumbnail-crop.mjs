import { chromium } from 'playwright';

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || undefined,
  args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

let failures = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? '  ok  ' : ' FALLA'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
};

await page.goto('http://127.0.0.1:5173/', { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);

/**
 * Un aro fino de 2px, pequeño, en una esquina de un documento grande —
 * exactamente el caso que hacía la miniatura casi invisible: reducir el
 * documento entero (1920x1080) a 64px deja un boceto de 60x60 en unos
 * pocos téxeles. Devuelve estadísticas de opacidad de la miniatura
 * resultante (`engine.celThumbnail`), no la imagen.
 */
const thumbnailStats = () =>
  page.evaluate(() => {
    const e = window.__trace;
    e.newProject(1920, 1080, 12, 1);
    const layer = e.activeLayer;
    e.addCel(layer.id, e.currentFrame, false);
    const cel = [...layer.cels.values()][0];
    const x0 = 40;
    const y0 = 40;
    const w = 60;
    const h = 60;
    const rect = { x: x0, y: y0, x2: x0 + w, y2: y0 + h };
    const px = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const onRing = x < 2 || x >= w - 2 || y < 2 || y >= h - 2;
        if (!onRing) continue;
        const o = (y * w + x) * 4;
        px[o] = 0;
        px[o + 1] = 0;
        px[o + 2] = 0;
        px[o + 3] = 255;
      }
    }
    e.renderer.writeRect(cel.surface, rect, px);
    e.touch();

    const canvas = e.celThumbnail(layer, e.currentFrame, 64);
    if (!canvas) return null;
    const ctx = canvas.getContext('2d');
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let maxAlpha = 0;
    let opaquePx = 0;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] > maxAlpha) maxAlpha = data[i];
      if (data[i] > 200) opaquePx++;
    }
    return { w: canvas.width, h: canvas.height, maxAlpha, opaquePx };
  });

console.log('\n— Miniatura de un boceto pequeño en un documento grande —');
const small = await thumbnailStats();
console.log(`  ${JSON.stringify(small)}`);
check('la miniatura no es null', small !== null);
check(
  'al menos parte del aro llega casi opaco a la miniatura (recorte a la caja del dibujo)',
  small.maxAlpha > 200,
  `maxAlpha=${small.maxAlpha}`,
);
check(
  'hay una cantidad razonable de téxeles casi opacos, no sólo 1-2 sueltos',
  small.opaquePx >= 20,
  `${small.opaquePx} téxeles`,
);

console.log('\n— Un dibujo que ya ocupa casi todo el documento no se recorta de más —');
const full = await page.evaluate(() => {
  const e = window.__trace;
  e.newProject(600, 600, 12, 1);
  const layer = e.activeLayer;
  e.addCel(layer.id, e.currentFrame, false);
  const cel = [...layer.cels.values()][0];
  const w = 600;
  const h = 600;
  const rect = { x: 0, y: 0, x2: w, y2: h };
  const px = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      px[o] = 200;
      px[o + 1] = 40;
      px[o + 2] = 40;
      px[o + 3] = 255;
    }
  }
  e.renderer.writeRect(cel.surface, rect, px);
  e.touch();
  const canvas = e.celThumbnail(layer, e.currentFrame, 64);
  return { w: canvas.width, h: canvas.height };
});
console.log(`  ${JSON.stringify(full)}`);
// Documento cuadrado lleno de punta a punta: la miniatura debe seguir siendo
// cuadrada de 64x64 (camino sin recortar), no una caja recortada más chica.
check('la miniatura de un lienzo lleno sigue siendo 64x64', full.w === 64 && full.h === 64, JSON.stringify(full));

console.log('\n— Un cel vacío sigue devolviendo null —');
const empty = await page.evaluate(() => {
  const e = window.__trace;
  e.newProject(400, 400, 12, 1);
  const layer = e.activeLayer;
  return e.celThumbnail(layer, e.currentFrame, 64);
});
check('cel vacío -> null', empty === null);

console.log('\n— Consola —');
check('sin errores en consola', errors.length === 0, errors.join(' | '));

console.log(`\n${failures === 0 ? 'TODO EN VERDE' : `${failures} FALLOS`}\n`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
