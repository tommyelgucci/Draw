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
  for (const [x, y] of points.slice(1)) await page.mouse.move(x, y, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(150);
}

/* ------------------------------------------------------------------ *
 * Geometría en frío: lo que pide el usuario es que UNA textura ya
 * contenga VARIAS hebras separadas — no una sola marca. Se comprueba
 * contando, en una fila horizontal cerca de la base, cuántos tramos
 * de alfa alto hay separados por huecos de alfa bajo.
 * ------------------------------------------------------------------ */
console.log('\n— Geometría: una sola textura contiene varias hebras separadas —');
const clusterGeometry = await page.evaluate(() => {
  return import('/src/core/brushTexture.ts').then((mod) => {
    const size = 128;
    const params = {
      seed: 7, count: 10, bladeLength: 0.75, lengthVariation: 0.1, thickness: 0.03,
      taper: 0.7, roughness: 0, spread: 0.85, angleSpread: 0.05, opacity: 1,
    };
    const pixels = mod.generateClusterTexturePixels(params, size);
    // Fila cerca de la base (90% de la altura, donde nacen las hebras) pero
    // ya por encima del ensanche de arranque de cada una.
    const y = Math.round(size * 0.75);
    const row = [];
    for (let x = 0; x < size; x++) row.push(pixels[(y * size + x) * 4 + 3]);
    let segments = 0;
    let inSegment = false;
    for (const a of row) {
      const on = a > 120;
      if (on && !inSegment) segments++;
      inSegment = on;
    }
    return { segments, maxAlpha: Math.max(...row) };
  });
});
check(
  'aparecen varios tramos separados de tinta en una sola fila (no un solo bloque)',
  clusterGeometry.segments >= 4,
  `${clusterGeometry.segments} tramos, alfa máx ${clusterGeometry.maxAlpha}`,
);

/* ------------------------------------------------------------------ *
 * Panel real: abrir, cambiar preset, crear textura.
 * ------------------------------------------------------------------ */
console.log('\n— Panel del generador de racimo: presets y creación —');
await page.evaluate(() => {
  const s = window.__uiStore.getState();
  s.setTool('brush');
  s.setPanel('brush');
});
await page.waitForTimeout(200);
await page.getByRole('button', { name: /Generar racimo/ }).click();
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
await page.locator('.preset-row .chip', { hasText: 'Hojas' }).click();
await page.waitForTimeout(150);
const afterPreset = await previewPixelSample();
check('el preset "Hojas" cambia la vista previa', afterPreset !== beforePreset, `${beforePreset} → ${afterPreset}`);

await page.locator('.preset-row .chip', { hasText: 'Mata de césped' }).click();
await page.waitForTimeout(150);
await page.getByRole('button', { name: 'Crear textura' }).click();
await page.waitForTimeout(200);
const clusterTexId = await page.evaluate(() => {
  const s = window.__uiStore.getState();
  return s.brushes[s.brushIndex].textureId;
});
check('crear textura deja el racimo activo en el pincel', typeof clusterTexId === 'string' && clusterTexId.length > 0, String(clusterTexId));

/* ------------------------------------------------------------------ *
 * Un solo tap ya pinta el manojo entero: varias columnas de tinta
 * separadas por huecos dentro del mismo estampado, sin arrastrar.
 * ------------------------------------------------------------------ */
console.log('\n— Un solo tap ya pinta varias hebras separadas —');
await page.evaluate(() => {
  window.__uiStore.getState().updateBrush({
    size: 260, opacity: 1, flow: 1, hardness: 1, taper: 0, spacing: 0.5, scatter: 0,
    pressureSize: 0, pressureOpacity: 0, followDirection: false, angleJitter: 0,
  });
});
const box = await page.locator('.canvas-surface').boundingBox();
const tapScreen = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
await stroke([[tapScreen.x, tapScreen.y], [tapScreen.x + 1, tapScreen.y]]);

const tapDoc = await page.evaluate((p) => window.__trace.screenToDoc(p), {
  x: tapScreen.x - box.x,
  y: tapScreen.y - box.y,
});
const tapResult = await page.evaluate(({ p }) => {
  const e = window.__trace;
  const layer = e.activeLayer;
  const cel = [...layer.cels.values()][0];
  const half = 130;
  const rect = { x: p.x - half, y: p.y - half, x2: p.x + half, y2: p.y + half };
  const px = e.renderer.readRect(cel.surface, rect);
  const w = Math.round(rect.x2 - rect.x);
  const h = Math.round(rect.y2 - rect.y);
  // Fila baja del estampado (cerca de la base de las hebras, análoga a la
  // geometría en frío) — cuenta tramos de alfa alto separados por huecos.
  const y = Math.round(h * 0.6);
  let segments = 0;
  let inSegment = false;
  for (let x = 0; x < w; x++) {
    const a = px[(y * w + x) * 4 + 3];
    const on = a > 40;
    if (on && !inSegment) segments++;
    inSegment = on;
  }
  return { segments };
}, { p: tapDoc });
check(
  'un solo tap deja varios tramos separados de tinta (el racimo, no una sola marca)',
  tapResult.segments >= 3,
  `${tapResult.segments} tramos`,
);

/* ------------------------------------------------------------------ *
 * Guardar y reabrir conserva la textura del racimo.
 * ------------------------------------------------------------------ */
console.log('\n— Guardar y reabrir conserva la textura del racimo —');
const roundTrip = await page.evaluate(async (id) => {
  const e = window.__trace;
  const mod = await import('/src/core/io.ts');
  const bytes = await mod.serializeProject(e);
  const { doc } = await mod.deserializeProject(e, bytes);
  const tex = doc.customTextures.find((t) => t.id === id);
  const alphas = new Set();
  if (tex) for (let i = 3; i < tex.pixels.length; i += 4 * 37) alphas.add(tex.pixels[i]);
  return { size: bytes.length, found: !!tex, distinctAlphas: alphas.size };
}, clusterTexId);
check('el proyecto serializado tiene contenido', roundTrip.size > 0, `${roundTrip.size} bytes`);
check('la textura del racimo sobrevive con su id', roundTrip.found, JSON.stringify(roundTrip));
check('el patrón de alfa (varias hebras, no plano) sobrevive el viaje de ida y vuelta', roundTrip.distinctAlphas > 1, `${roundTrip.distinctAlphas} valores distintos`);

console.log('\n— Consola —');
check('sin errores en consola', errors.length === 0, errors.join(' | '));

console.log(`\n${failures === 0 ? 'TODO EN VERDE' : `${failures} FALLOS`}\n`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
