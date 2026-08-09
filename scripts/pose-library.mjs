import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

const out = process.env.SHOT_DIR || 'shots';

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

const box = await page.locator('.canvas-surface').boundingBox();
const cx = box.x + box.width / 2;
const cy = box.y + box.height / 2;

async function stroke(points) {
  await page.mouse.move(points[0][0], points[0][1]);
  await page.mouse.down();
  for (const [x, y] of points.slice(1)) await page.mouse.move(x, y, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(150);
}

/** Ver CLAUDE.md "Trampas conocidas": el camino fiable para leer o mostrar
 *  un cambio de estado es renderFrameToImageData, no una captura del
 *  lienzo interactivo (que puede quedarse con el fotograma anterior). */
async function inkCountAtFrame(frame, docRect) {
  return page.evaluate(({ frame, r }) => {
    const e = window.__trace;
    const data = e.renderFrameToImageData(frame);
    let n = 0;
    const x0 = Math.max(0, Math.floor(r.x));
    const x1 = Math.min(data.width, Math.ceil(r.x2));
    const y0 = Math.max(0, Math.floor(r.y));
    const y1 = Math.min(data.height, Math.ceil(r.y2));
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * data.width + x) * 4;
        if (data.data[i] < 200 || data.data[i + 1] < 200 || data.data[i + 2] < 200) n++;
      }
    }
    return n;
  }, { frame, r: docRect });
}

async function documentSnapshot(frame, path) {
  const dataUrl = await page.evaluate((frame) => {
    const e = window.__trace;
    const data = e.renderFrameToImageData(frame);
    const c = document.createElement('canvas');
    c.width = data.width;
    c.height = data.height;
    c.getContext('2d').putImageData(data, 0, 0);
    return c.toDataURL('image/png');
  }, frame);
  writeFileSync(path, Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64'));
}

const rect = (center, half = 50) => ({ x: center.x - half, y: center.y - half, x2: center.x + half, y2: center.y + half });

/* ------------------------------------------------------------------ */

console.log('\n— Crear el nodo y dos variantes con tinta distinta —');
const setup = await page.evaluate(({ pA, pB }) => {
  const e = window.__trace;
  const a = e.screenToDoc(pA);
  const b = e.screenToDoc(pB);
  const layer = e.createSwapNode('Boca');
  const cerrada = e.addSwapVariant(layer.id, 'Cerrada');
  const abierta = e.addSwapVariant(layer.id, 'Abierta');
  return { layerId: layer.id, cerradaId: cerrada.id, abiertaId: abierta.id, a, b };
}, {
  pA: { x: cx - 220 - box.x, y: cy - 80 - box.y },
  pB: { x: cx + 220 - box.x, y: cy + 80 - box.y },
});

// "Cerrada" quedó seleccionada al crearla (última llamada fue addSwapVariant
// de "Abierta", así que hay que volver a marcarla antes de pintar en ella).
await page.evaluate(({ layerId }) => window.__trace.selectSwapVariant(layerId, 0), setup);
await stroke([
  [cx - 220, cy - 80],
  [cx - 180, cy - 60],
  [cx - 140, cy - 80],
]);
await page.evaluate(({ layerId }) => window.__trace.selectSwapVariant(layerId, 1), setup);
// Empieza justo en `pB` (no termina ahí): el filtro One Euro suaviza y por
// tanto retrasa el EXTREMO FINAL de un trazo, no su arranque — ver
// CLAUDE.md / la lección de scripts/rig-mesh.mjs.
await stroke([
  [cx + 220, cy + 80],
  [cx + 180, cy + 60],
  [cx + 140, cy + 80],
]);

const inkCerrada = await page.evaluate(({ cerradaId }) => {
  const e = window.__trace;
  const layer = e.doc.layers.find((l) => l.swap);
  const variant = layer.swap.variants.find((v) => v.id === cerradaId);
  const px = e.renderer.readRect(variant.surface, { x: 0, y: 0, x2: e.doc.width, y2: e.doc.height });
  let n = 0;
  for (let i = 3; i < px.length; i += 4) if (px[i] > 40) n++;
  return n;
}, setup);
check('la variante "Cerrada" tiene su propia tinta', inkCerrada > 50, `${inkCerrada} px`);

console.log('\n— Fijar cada variante en un fotograma distinto —');
await page.evaluate(({ layerId }) => {
  const e = window.__trace;
  e.setFrame(0);
  e.selectSwapVariant(layerId, 0); // Cerrada, fotograma 0
  e.setFrame(10);
  e.selectSwapVariant(layerId, 1); // Abierta, fotograma 10
  e.setFrame(0);
}, setup);
await page.waitForTimeout(150);

console.log('\n— El cambio es un salto exacto, no una mezcla —');
const aRectInk = { frame0: await inkCountAtFrame(0, rect(setup.a)), frame5: await inkCountAtFrame(5, rect(setup.a)), frame10: await inkCountAtFrame(10, rect(setup.a)) };
const bRectInk = { frame0: await inkCountAtFrame(0, rect(setup.b)), frame5: await inkCountAtFrame(5, rect(setup.b)), frame10: await inkCountAtFrame(10, rect(setup.b)) };
check(
  '"Cerrada" (tinta en A) se ve en los fotogramas 0 y 5, antes del salto',
  aRectInk.frame0 > 30 && aRectInk.frame5 > 30,
  JSON.stringify(aRectInk),
);
check(
  '"Abierta" (tinta en B) no aparece todavía en los fotogramas 0 y 5',
  bRectInk.frame0 < 10 && bRectInk.frame5 < 10,
  JSON.stringify(bRectInk),
);
check(
  'en el fotograma 10 el salto ya ocurrió: aparece B y desaparece A',
  bRectInk.frame10 > 30 && aRectInk.frame10 < 10,
  `A: ${aRectInk.frame10}px, B: ${bRectInk.frame10}px`,
);

await documentSnapshot(0, `${out}/pose-library-01-cerrada.png`);
await documentSnapshot(10, `${out}/pose-library-02-abierta.png`);

console.log('\n— El mini-picker del panel funciona desde la UI real —');
await page.evaluate(() => window.__uiStore.getState().setPanel('poses'));
await page.waitForTimeout(200);
const thumbCount = await page.locator('.pose-thumb').count(); // incluye el botón "+"
check('el picker muestra las 2 miniaturas más el botón de añadir', thumbCount === 3, `${thumbCount}`);
await page.locator('.pose-cell .pose-thumb').first().click();
await page.waitForTimeout(150);
const selectedAfterClick = await page.evaluate(({ layerId }) => {
  const e = window.__trace;
  const layer = e.doc.layers.find((l) => l.id === layerId);
  return e.getSwapSelection(layer);
}, setup);
check('tocar la primera miniatura selecciona la variante 0', selectedAfterClick === 0, String(selectedAfterClick));

console.log('\n— Guardar y reabrir conserva las dos variantes con su PNG —');
const roundTrip = await page.evaluate(async () => {
  const e = window.__trace;
  const mod = await import('/src/core/io.ts');
  const bytes = await mod.serializeProject(e);
  const doc = await mod.deserializeProject(e, bytes);
  const layer = doc.layers.find((l) => l.swap);
  return {
    size: bytes.length,
    hasSwap: !!layer,
    variantCount: layer?.swap.variants.length ?? 0,
    labels: layer?.swap.variants.map((v) => v.label) ?? [],
    allNonEmpty: layer?.swap.variants.every((v) => !v.surface.empty) ?? false,
    keyframeCount: layer?.swap.selected.keys.length ?? 0,
  };
});
check('el proyecto serializado tiene contenido', roundTrip.size > 0, `${roundTrip.size} bytes`);
check('el nodo de intercambio sobrevive', roundTrip.hasSwap, JSON.stringify(roundTrip));
check('las 2 variantes sobreviven con su nombre', roundTrip.variantCount === 2 && roundTrip.labels.join(',') === 'Cerrada,Abierta', roundTrip.labels.join(','));
check('el PNG de cada variante sobrevive (ninguna queda vacía)', roundTrip.allNonEmpty === true, String(roundTrip.allNonEmpty));
check('los 2 keyframes del catálogo sobreviven', roundTrip.keyframeCount === 2, String(roundTrip.keyframeCount));

console.log('\n— Quitar una variante —');
const afterRemove = await page.evaluate(({ layerId, cerradaId }) => {
  const e = window.__trace;
  const layer = e.doc.layers.find((l) => l.id === layerId);
  const before = layer.swap.variants.length;
  e.removeSwapVariant(layerId, cerradaId);
  const afterCount = layer.swap.variants.length;
  e.history.undo();
  const afterUndo = layer.swap.variants.length;
  return { before, afterCount, afterUndo };
}, setup);
check('quitar una variante reduce el catálogo', afterRemove.afterCount === afterRemove.before - 1, JSON.stringify(afterRemove));
check('deshacer la devuelve', afterRemove.afterUndo === afterRemove.before, JSON.stringify(afterRemove));

console.log('\n— Consola —');
check('sin errores en consola', errors.length === 0, errors.join(' | '));

console.log(`\n${failures === 0 ? 'TODO EN VERDE' : `${failures} FALLOS`}\n`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
