import { chromium } from 'playwright';

let failures = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? '  ok  ' : ' FALLA'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
};

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || undefined,
  args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });

const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

await page.goto('http://127.0.0.1:5173/', { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);

async function stroke(points) {
  await page.mouse.move(points[0][0], points[0][1]);
  await page.mouse.down();
  for (const [x, y] of points.slice(1)) await page.mouse.move(x, y, { steps: 20 });
  await page.mouse.up();
  await page.waitForTimeout(150);
}

/* ------------------------------------------------------------------ *
 * Geometría del generador de púas, en frío: con irregularidad y aspereza
 * en 0, N carriles deben tener alfa alta en su centro y casi nula justo
 * entre dos carriles.
 * ------------------------------------------------------------------ */
console.log('\n— Geometría de las púas: carriles altos, huecos entre carriles bajos —');
const rakeGeometry = await page.evaluate(() => {
  return import('/src/core/brushTexture.ts').then((mod) => {
    const size = 128;
    const count = 6;
    const params = { seed: 1, count, length: 0.9, thickness: 0.6, irregularity: 0, roughness: 0, opacity: 1 };
    const pixels = mod.generateRakeTexturePixels(params, size);
    const laneHeight = size / count;
    const cx = Math.round(size / 2);
    const alphaAtY = (y) => pixels[(Math.round(y) * size + cx) * 4 + 3];
    const onLane = [];
    const betweenLanes = [];
    for (let i = 0; i < count; i++) {
      onLane.push(alphaAtY(laneHeight * (i + 0.5)));
      if (i < count - 1) betweenLanes.push(alphaAtY(laneHeight * (i + 1)));
    }
    return { onLane, betweenLanes };
  });
});
const avgOnLane = rakeGeometry.onLane.reduce((a, b) => a + b, 0) / rakeGeometry.onLane.length;
const avgBetweenLanes = rakeGeometry.betweenLanes.reduce((a, b) => a + b, 0) / rakeGeometry.betweenLanes.length;
check('en el centro de cada carril hay alfa alta', avgOnLane > 200, `promedio ${avgOnLane.toFixed(1)}/255`);
check('justo entre dos carriles hay alfa baja (el hueco existe)', avgBetweenLanes < 30, `promedio ${avgBetweenLanes.toFixed(1)}/255`);

/* ------------------------------------------------------------------ *
 * Panel real: abrir, presets, crear.
 * ------------------------------------------------------------------ */
console.log('\n— Panel del generador de púas: presets y creación —');
await page.evaluate(() => {
  const s = window.__uiStore.getState();
  s.setTool('brush');
  s.setPanel('brush');
});
await page.waitForTimeout(200);
await page.getByRole('button', { name: /Generar púas/ }).click();
await page.waitForTimeout(200);
const previewPixelSample = () =>
  page.evaluate(() => {
    const canvases = document.querySelectorAll('.texture-generator__preview canvas');
    const canvas = canvases[canvases.length - 1];
    const ctx = canvas.getContext('2d');
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let sum = 0;
    for (let i = 3; i < data.length; i += 4) sum += data[i];
    return sum;
  });
const beforePreset = await previewPixelSample();
await page.locator('.preset-row .chip', { hasText: 'Cerdas' }).click();
await page.waitForTimeout(150);
const afterPreset = await previewPixelSample();
check('el preset "Cerdas" cambia la vista previa', afterPreset !== beforePreset, `${beforePreset} → ${afterPreset}`);
await page.getByRole('button', { name: 'Crear textura' }).click();
await page.waitForTimeout(200);
const rakeTexId = await page.evaluate(() => {
  const s = window.__uiStore.getState();
  return s.brushes[s.brushIndex].textureId;
});
check('crear textura deja las púas activas en el pincel', typeof rakeTexId === 'string' && rakeTexId.length > 0, String(rakeTexId));

/* ------------------------------------------------------------------ *
 * "Giro al azar": con la misma textura de trazo fina, un trazo horizontal
 * debe extenderse mucho más en vertical cuando angleJitter está al máximo
 * que cuando está en 0 — las hebras giradas al azar salen de la línea.
 * ------------------------------------------------------------------ */
console.log('\n— "Giro al azar" dispersa la orientación de cada estampa —');
await page.getByRole('button', { name: /Generar trazo/ }).click();
await page.waitForTimeout(200);
await page.locator('.preset-row .chip', { hasText: 'Brizna' }).click();
await page.waitForTimeout(150);
await page.getByRole('button', { name: 'Crear textura' }).click();
await page.waitForTimeout(200);

const box = await page.locator('.canvas-surface').boundingBox();
const startScreen = { x: box.x + box.width / 2 - 250, y: box.y + box.height / 2 };
const endScreen = { x: startScreen.x + 260, y: startScreen.y };

async function verticalInkSpread() {
  const p0 = await page.evaluate((p) => window.__trace.screenToDoc(p), { x: startScreen.x - box.x, y: startScreen.y - box.y });
  const p1 = await page.evaluate((p) => window.__trace.screenToDoc(p), { x: endScreen.x - box.x, y: endScreen.y - box.y });
  return page.evaluate(({ p0, p1 }) => {
    const e = window.__trace;
    const layer = e.activeLayer;
    const cel = [...layer.cels.values()][0];
    const rect = { x: Math.min(p0.x, p1.x) - 5, y: Math.min(p0.y, p1.y) - 80, x2: Math.max(p0.x, p1.x) + 5, y2: Math.max(p0.y, p1.y) + 80 };
    const px = e.renderer.readRect(cel.surface, rect);
    const w = Math.round(rect.x2 - rect.x);
    const h = Math.round(rect.y2 - rect.y);
    let minY = Infinity, maxY = -Infinity;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (px[(y * w + x) * 4 + 3] > 40) {
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    return maxY >= minY ? maxY - minY : 0;
  }, { p0, p1 });
}

await page.evaluate(() => {
  window.__uiStore.getState().updateBrush({
    size: 90, opacity: 1, flow: 1, hardness: 1, taper: 0, spacing: 0.15, scatter: 0.5,
    pressureSize: 0, pressureOpacity: 0, followDirection: false, angleJitter: 0,
  });
});
await stroke([[startScreen.x, startScreen.y], [endScreen.x, endScreen.y]]);
const spreadNoJitter = await verticalInkSpread();

await page.evaluate(() => window.__trace.history.undo());
await page.waitForTimeout(100);
await page.evaluate(() => window.__uiStore.getState().updateBrush({ angleJitter: 1 }));
await stroke([[startScreen.x, startScreen.y], [endScreen.x, endScreen.y]]);
const spreadWithJitter = await verticalInkSpread();

check(
  'con "Giro al azar" al máximo el trazo se extiende mucho más en vertical',
  spreadWithJitter > spreadNoJitter * 1.4,
  `sin giro: ${spreadNoJitter}px, con giro: ${spreadWithJitter}px`,
);

console.log('\n— Consola —');
check('sin errores en consola', errors.length === 0, errors.join(' | '));

console.log(`\n${failures === 0 ? 'TODO EN VERDE' : `${failures} FALLOS`}\n`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
