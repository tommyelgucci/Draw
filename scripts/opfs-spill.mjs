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

const box = await page.locator('.canvas-surface').boundingBox();
const cx = box.x + box.width / 2;
const cy = box.y + box.height / 2;

/*
 * `serializeProject` suelta cada cel de la GPU/RAM justo después de
 * codificarlo a PNG, volcando una copia cruda a OPFS y restaurándola antes
 * de devolver el control (ver `spillAfterEncode` en `core/io.ts`) — así un
 * proyecto de cientos de cels no acumula en RAM los píxeles de todos a la
 * vez durante el propio guardado. Este test comprueba: (1) el vaivén por
 * disco no cambia ni un píxel, (2) no deja archivos huérfanos, y (3) que el
 * candado de entrada — atajos de teclado y lienzo — bloquea de verdad
 * mientras `busy` está activo, que es la única razón por la que ese vaivén
 * es seguro sin tocar cómo funciona deshacer/rehacer.
 */

const opfsSupported = await page.evaluate(() => !!navigator.storage?.getDirectory);
console.log(`\n(OPFS ${opfsSupported ? 'disponible' : 'no disponible'} en este navegador)`);

console.log('\n— El guardado no cambia los píxeles, y no deja archivos huérfanos —');
const roundTrip = await page.evaluate(async () => {
  const e = window.__trace;
  const { serializeProject, deserializeProject } = await import('/src/core/io.ts');

  e.newProject(640, 480, 12, 1);
  const layerA = e.activeLayer;
  e.addLayer();
  const layerB = e.activeLayer;

  const paintRect = (layer, x0, y0, x1, y1, rgba) => {
    e.setActiveLayer(layer.id);
    e.addCel(layer.id, 0, false);
    const cel = [...layer.cels.values()][0];
    const w = x1 - x0;
    const h = y1 - y0;
    const px = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      px[i * 4] = rgba[0];
      px[i * 4 + 1] = rgba[1];
      px[i * 4 + 2] = rgba[2];
      px[i * 4 + 3] = rgba[3];
    }
    e.renderer.writeRect(cel.surface, { x: x0, y: y0, x2: x1, y2: y1 }, px);
    e.touch();
    return cel;
  };

  const celA = paintRect(layerA, 20, 20, 120, 120, [220, 30, 30, 255]);
  const celB = paintRect(layerB, 300, 200, 420, 340, [30, 30, 220, 255]);

  const full = { x: 0, y: 0, x2: 640, y2: 480 };
  const beforeA = e.renderer.readRect(celA.surface, full);
  const beforeB = e.renderer.readRect(celB.surface, full);

  const bytes = await serializeProject(e);

  const afterA = e.renderer.readRect(celA.surface, full);
  const afterB = e.renderer.readRect(celB.surface, full);
  const sameA = beforeA.length === afterA.length && beforeA.every((v, i) => v === afterA[i]);
  const sameB = beforeB.length === afterB.length && beforeB.every((v, i) => v === afterB[i]);

  let orphanFiles = -1;
  if (navigator.storage?.getDirectory) {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('trace-spill', { create: true });
    orphanFiles = 0;
    for await (const _ of dir.values()) orphanFiles++;
  }

  const { doc } = await deserializeProject(e, bytes);
  const reloadedA = doc.layers.find((l) => l.id === layerA.id).cels.get(0);
  const reloadedB = doc.layers.find((l) => l.id === layerB.id).cels.get(0);

  return {
    sameA,
    sameB,
    orphanFiles,
    reloadedANotEmpty: !reloadedA.surface.empty,
    reloadedBNotEmpty: !reloadedB.surface.empty,
  };
});
console.log(`  ${JSON.stringify(roundTrip)}`);
check('los píxeles de la capa A son idénticos tras guardar', roundTrip.sameA);
check('los píxeles de la capa B son idénticos tras guardar', roundTrip.sameB);
check('el cel A sobrevive en el proyecto recargado', roundTrip.reloadedANotEmpty);
check('el cel B sobrevive en el proyecto recargado', roundTrip.reloadedBNotEmpty);
if (opfsSupported) {
  check('no quedan archivos huérfanos en OPFS tras el guardado', roundTrip.orphanFiles === 0, `${roundTrip.orphanFiles} archivos`);
}

console.log('\n— El candado de guardado bloquea el lienzo —');
await page.evaluate(() => {
  const e = window.__trace;
  e.newProject(640, 480, 12, 1);
});
await page.waitForTimeout(150);
const beforeLock = await page.evaluate(() => window.__trace.activeLayer.cels.size);
await page.evaluate(() => window.__uiStore.getState().setBusy('Guardando…'));
await page.mouse.move(cx, cy);
await page.mouse.down();
await page.mouse.move(cx + 40, cy + 40, { steps: 6 });
await page.mouse.up();
await page.waitForTimeout(150);
const duringLock = await page.evaluate(() => ({
  cels: window.__trace.activeLayer.cels.size,
  isDrawing: window.__trace.isDrawing,
}));
check(
  'ningún trazo empieza mientras el lienzo está bloqueado',
  duringLock.cels === beforeLock && !duringLock.isDrawing,
  JSON.stringify(duringLock),
);
await page.evaluate(() => window.__uiStore.getState().setBusy(null));
await page.mouse.move(cx, cy);
await page.mouse.down();
await page.mouse.move(cx + 40, cy + 40, { steps: 6 });
await page.mouse.up();
await page.waitForTimeout(150);
const afterUnlock = await page.evaluate(() => window.__trace.activeLayer.cels.size);
check('con el candado suelto, el mismo gesto sí dibuja', afterUnlock > beforeLock, `${beforeLock} -> ${afterUnlock}`);

console.log('\n— El candado de guardado bloquea deshacer/rehacer —');
// Proyecto propio para esta sección: contar cels (no el booleano `canUndo`)
// es la señal precisa — con una pila de más de un paso, `canUndo` se queda
// en `true` tanto si Ctrl+Z se bloqueó como si deshizo uno de varios, y esa
// ambigüedad no sirve para detectar de verdad si el candado funcionó.
await page.evaluate(() => window.__trace.newProject(640, 480, 12, 1));
await page.waitForTimeout(150);
await page.mouse.move(cx, cy);
await page.mouse.down();
await page.mouse.move(cx + 40, cy + 40, { steps: 6 });
await page.mouse.up();
await page.waitForTimeout(150);
const celsAfterDraw = await page.evaluate(() => window.__trace.activeLayer.cels.size);
check('hay un trazo para deshacer antes de la prueba', celsAfterDraw === 1, `${celsAfterDraw} cels`);

await page.evaluate(() => window.__uiStore.getState().setBusy('Guardando…'));
await page.keyboard.press('Control+z');
await page.waitForTimeout(80);
const celsDuringLock = await page.evaluate(() => window.__trace.activeLayer.cels.size);
check(
  'Ctrl+Z no deshace mientras el guardado está en curso',
  celsDuringLock === celsAfterDraw,
  `${celsDuringLock} cels`,
);

await page.evaluate(() => window.__uiStore.getState().setBusy(null));
await page.keyboard.press('Control+z');
await page.waitForTimeout(80);
const celsAfterUnlock = await page.evaluate(() => window.__trace.activeLayer.cels.size);
check(
  'con el candado suelto, Ctrl+Z sí deshace',
  celsAfterUnlock < celsAfterDraw,
  `${celsAfterDraw} -> ${celsAfterUnlock}`,
);

console.log('\n— whenIdle() espera a que termine el trazo en curso —');
const idle = await page.evaluate(async () => {
  const e = window.__trace;
  const base = window.__uiStore.getState().brushes.find((b) => b.id === 'ink');
  const brush = { ...base, size: 12 };
  e.beginStroke({ x: 40, y: 40, pressure: 1, altitude: Math.PI / 2, azimuth: 0, time: 0 }, { brush, color: { r: 0, g: 0, b: 0 } });

  let resolved = false;
  const p = e.whenIdle().then(() => {
    resolved = true;
  });
  await new Promise((r) => setTimeout(r, 100));
  const resolvedWhileDrawing = resolved;

  e.endStroke();
  await p;
  return { resolvedWhileDrawing, resolvedAfterEnd: resolved };
});
console.log(`  ${JSON.stringify(idle)}`);
check('whenIdle() NO se resuelve mientras el trazo sigue en curso', idle.resolvedWhileDrawing === false);
check('whenIdle() se resuelve en cuanto el trazo termina', idle.resolvedAfterEnd === true);

console.log('\n— Consola —');
check('sin errores en consola', errors.length === 0, errors.join(' | '));

console.log(`\n${failures === 0 ? 'TODO EN VERDE' : `${failures} FALLOS`}\n`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
