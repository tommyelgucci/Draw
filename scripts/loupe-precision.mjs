import { chromium } from 'playwright';

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

/** Cuenta colores distintos en el canvas de la lupa — confirma que copió
 *  contenido real del lienzo (tinta + fondo), no que se quedó en blanco. Es
 *  un `<canvas>` 2D normal (no WebGL), así que leerlo con `getImageData`
 *  directamente no tiene el problema de `preserveDrawingBuffer` del lienzo
 *  principal. */
async function loupeColorVariety() {
  return page.evaluate(() => {
    const c = document.querySelector('.loupe canvas');
    if (!c) return 0;
    const ctx = c.getContext('2d');
    const data = ctx.getImageData(0, 0, c.width, c.height).data;
    const colors = new Set();
    for (let i = 0; i < data.length; i += 4 * 37) {
      colors.add(`${data[i]},${data[i + 1]},${data[i + 2]}`);
    }
    return colors.size;
  });
}

const loupeBox = () => page.locator('.loupe').boundingBox();

/* ------------------------------------------------------------------ */

console.log('\n— Sin arrastre de precisión, no hay lupa —');
check('no existe .loupe en reposo', (await page.locator('.loupe').count()) === 0);

console.log('\n— QuickShape: arrastrar un nodo activa la lupa —');
// Dibuja un rectángulo y espera el dwell, igual que scripts/quickshape.mjs.
await page.mouse.move(cx - 100, cy - 100);
await page.mouse.down();
for (const [x, y] of [
  [cx + 100, cy - 98],
  [cx + 102, cy + 100],
  [cx - 98, cy + 102],
  [cx - 100, cy - 100],
]) {
  await page.mouse.move(x, y, { steps: 6 });
}
await page.waitForTimeout(600);
await page.mouse.up();
await page.waitForTimeout(200);
const editing = await page.evaluate(() => window.__trace.pendingQuickShape?.editing === true);
check('la forma queda en modo edición', editing);

const cornerHandle = page.locator('.sel-handle--corner').first();
const cb = await cornerHandle.boundingBox();
const cbCenter = { x: cb.x + cb.width / 2, y: cb.y + cb.height / 2 };
await page.mouse.move(cbCenter.x, cbCenter.y);
await page.mouse.down();
await page.mouse.move(cbCenter.x + 30, cbCenter.y + 30, { steps: 6 });
await page.waitForTimeout(150);

check('aparece la lupa mientras se arrastra un nodo de QuickShape', (await page.locator('.loupe').count()) === 1);
const variety1 = await loupeColorVariety();
check('la lupa muestra contenido real (varios colores)', variety1 > 1, `${variety1} colores`);
await page.screenshot({ path: `${out}/loupe-01-quickshape.png` });

await page.mouse.up();
await page.waitForTimeout(150);
check('la lupa desaparece al soltar', (await page.locator('.loupe').count()) === 0);
await page.evaluate(() => window.__trace.cancelQuickShape());
await page.waitForTimeout(150);

console.log('\n— La lupa se voltea para no salirse de la pantalla —');
// Repite el gesto pero cerca de la esquina superior derecha del viewport,
// donde por defecto (arriba-derecha del dedo) no cabría.
await page.mouse.move(cx - 100, cy - 100);
await page.mouse.down();
for (const [x, y] of [
  [cx + 100, cy - 98],
  [cx + 102, cy + 100],
  [cx - 98, cy + 102],
  [cx - 100, cy - 100],
]) {
  await page.mouse.move(x, y, { steps: 6 });
}
await page.waitForTimeout(600);
await page.mouse.up();
await page.waitForTimeout(200);

const corner2 = page.locator('.sel-handle--corner').first();
const cb2 = await corner2.boundingBox();
await page.mouse.move(cb2.x + cb2.width / 2, cb2.y + cb2.height / 2);
await page.mouse.down();
// Cerca de la esquina superior derecha del viewport.
const edgeTarget = { x: 1270, y: 10 };
await page.mouse.move(edgeTarget.x, edgeTarget.y, { steps: 8 });
await page.waitForTimeout(150);
let lb = await loupeBox();
check(
  'cerca del borde derecho, la lupa se voltea hacia la izquierda del dedo',
  lb && lb.x + lb.width < edgeTarget.x + 5,
  JSON.stringify(lb),
);
check('cerca del borde superior, la lupa se voltea hacia abajo del dedo', lb && lb.y > edgeTarget.y - 5, JSON.stringify(lb));
await page.screenshot({ path: `${out}/loupe-02-volteada.png` });
await page.mouse.up();
await page.waitForTimeout(150);
await page.evaluate(() => window.__trace.cancelQuickShape());
await page.waitForTimeout(150);

console.log('\n— Selección: arrastrar un tirador de transformación libre activa la lupa —');
await page.evaluate(() => window.__uiStore.getState().setTool('selectRect'));
await page.waitForTimeout(100);
await page.mouse.move(cx - 150, cy - 150);
await page.mouse.down();
await page.mouse.move(cx + 150, cy + 150, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(200);
// Rellena la selección entera: así hay tinta garantizada bajo cualquier
// tirador (incluidas las esquinas), no sólo bajo el contorno de un trazo.
await page.evaluate(() => window.__trace.fillSelection({ r: 0.1, g: 0.1, b: 0.1 }));
await page.waitForTimeout(150);
await page.evaluate(() => window.__trace.liftSelection());
await page.waitForTimeout(200);

const cornerSelHandle = page.locator('.sel-handle--corner').first();
const scb = await cornerSelHandle.boundingBox();
await page.mouse.move(scb.x + scb.width / 2, scb.y + scb.height / 2);
await page.mouse.down();
await page.mouse.move(scb.x + scb.width / 2 + 15, scb.y + scb.height / 2 + 10, { steps: 6 });
await page.waitForTimeout(150);
check('aparece la lupa al escalar una selección flotante', (await page.locator('.loupe').count()) === 1);
const variety2 = await loupeColorVariety();
check('la lupa de selección muestra contenido real', variety2 > 1, `${variety2} colores`);
await page.screenshot({ path: `${out}/loupe-03-seleccion.png` });
await page.mouse.up();
await page.waitForTimeout(150);
check('la lupa desaparece al soltar la selección', (await page.locator('.loupe').count()) === 0);
await page.evaluate(() => window.__trace.commitFloating());
await page.waitForTimeout(150);

console.log('\n— Rig: arrastrar un tirador de hueso activa la lupa —');
const setup = await page.evaluate(
  ({ p0, p1 }) => {
    const e = window.__trace;
    const start = e.screenToDoc(p0);
    const end = e.screenToDoc(p1);
    const length = Math.hypot(end.x - start.x, end.y - start.y);
    const skel = e.createSkeleton('Prueba lupa');
    const hueso = e.addBone(skel.id, 'Hueso', null, { x: start.x, y: start.y, length });
    const layer = e.doc.layers[0];
    e.attachLayerToBone(layer.id, skel.id, hueso.id);
    window.__uiStore.getState().setTool('rig');
    return { skelId: skel.id, huesoId: hueso.id, start, end };
  },
  { p0: { x: cx - 150 - box.x, y: cy - 150 - box.y }, p1: { x: cx + 150 - box.x, y: cy + 150 - box.y } },
);
await page.waitForTimeout(150);
const headPage = await page.evaluate((p) => window.__trace.docToScreen(p), setup.start);
await page.mouse.click(headPage.x + box.x, headPage.y + box.y);
await page.waitForTimeout(150);
const selected = await page.evaluate(() => window.__uiStore.getState().selectedBoneId);
check('el hueso queda seleccionado', selected === setup.huesoId, String(selected));

const boneMoveHandle = page.locator('.bone-handle--move');
const bmb = await boneMoveHandle.boundingBox();
await page.mouse.move(bmb.x + bmb.width / 2, bmb.y + bmb.height / 2);
await page.mouse.down();
await page.mouse.move(bmb.x + bmb.width / 2 + 50, bmb.y + bmb.height / 2 - 30, { steps: 6 });
await page.waitForTimeout(150);
check('aparece la lupa al mover un hueso', (await page.locator('.loupe').count()) === 1);
await page.screenshot({ path: `${out}/loupe-04-hueso.png` });
await page.mouse.up();
await page.waitForTimeout(150);
check('la lupa desaparece al soltar el hueso', (await page.locator('.loupe').count()) === 0);

console.log('\n— Consola —');
check('sin errores en consola', errors.length === 0, errors.join(' | '));

console.log(`\n${failures === 0 ? 'TODO EN VERDE' : `${failures} FALLOS`}\n`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
