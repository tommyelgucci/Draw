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

/**
 * Dibuja el recorrido y mantiene el ratón quieto al final: es justo lo que
 * detecta el dwell de QuickShape (ver `updateDwell` en CanvasView.tsx). El
 * temporizador son 380ms; se espera bastante más para no depender de la
 * cadencia real del navegador de pruebas.
 */
async function drawAndHold(points, holdMs = 600) {
  await page.mouse.move(points[0][0], points[0][1]);
  await page.mouse.down();
  for (const [x, y] of points.slice(1)) await page.mouse.move(x, y, { steps: 6 });
  await page.waitForTimeout(holdMs);
}

async function release() {
  await page.mouse.up();
  await page.waitForTimeout(200);
}

function circlePoints(cx, cy, r, n = 28) {
  return Array.from({ length: n }, (_, i) => {
    const t = (i / n) * Math.PI * 2;
    return [cx + Math.cos(t) * r, cy + Math.sin(t) * r];
  });
}

const pendingShape = () =>
  page.evaluate(() => {
    const p = window.__trace.pendingQuickShape;
    return p ? { kind: p.shape.kind, editing: p.editing } : null;
  });

const inkPixels = () =>
  page.evaluate(() => {
    const e = window.__trace;
    const layer = e.activeLayer;
    const cel = layer && [...layer.cels.values()][0];
    if (!cel) return 0;
    const px = e.renderer.readRect(cel.surface, { x: 0, y: 0, x2: e.doc.width, y2: e.doc.height });
    let n = 0;
    for (let i = 3; i < px.length; i += 4) if (px[i] > 40) n++;
    return n;
  });

/* ------------------------------------------------------------------ */

console.log('\n— Círculo —');
await drawAndHold(circlePoints(cx - 200, cy - 100, 90));
let s = await pendingShape();
check('el dwell reconoce una elipse', s?.kind === 'ellipse' && s.editing === false, JSON.stringify(s));
await page.screenshot({ path: `${out}/qs-01-circulo-snap.png` });

await release();
s = await pendingShape();
check('soltar pasa a modo edición, no hornea', s?.editing === true, JSON.stringify(s));
const handles = await page.locator('.sel-handle').count();
check('aparecen los tiradores (4 esquinas + rotación)', handles === 5, `${handles} tiradores`);
await page.screenshot({ path: `${out}/qs-02-circulo-editar.png` });

const beforeCommit = await inkPixels();
await page.locator('.sel-bar--commit button:first-of-type').click();
await page.waitForTimeout(250);
s = await pendingShape();
check('Confirmar hornea y limpia el pendiente', s === null);
const afterCommit = await inkPixels();
check('la imagen cambia al confirmar', afterCommit > beforeCommit, `${beforeCommit} -> ${afterCommit} px`);
await page.screenshot({ path: `${out}/qs-03-circulo-horneado.png` });

console.log('\n— Rectángulo, editar un nodo antes de confirmar —');
await drawAndHold([
  [cx - 100, cy + 50],
  [cx + 100, cy + 48],
  [cx + 102, cy + 190],
  [cx - 98, cy + 192],
  [cx - 100, cy + 50],
]);
s = await pendingShape();
check('el dwell reconoce un rectángulo', s?.kind === 'rect', JSON.stringify(s));
await release();

const beforeDrag = await page.evaluate(() => window.__trace.pendingQuickShape.shape.w);
await page.evaluate(() => {
  const e = window.__trace;
  const shape = e.pendingQuickShape.shape;
  e.dragQuickShapeNode(1, { x: shape.cx + shape.w, y: shape.cy - shape.h / 2 });
});
await page.waitForTimeout(150);
const afterDrag = await page.evaluate(() => window.__trace.pendingQuickShape.shape.w);
check('arrastrar un nodo cambia la forma en vivo', afterDrag !== beforeDrag, `${beforeDrag} -> ${afterDrag}`);
await page.screenshot({ path: `${out}/qs-04-rect-nodo.png` });

await page.locator('.sel-bar--commit button:first-of-type').click();
await page.waitForTimeout(200);
check('el rectángulo también hornea', (await pendingShape()) === null);

console.log('\n— Triángulo, cancelar —');
const beforeTriangle = await inkPixels();
await drawAndHold([
  [cx, cy - 300],
  [cx + 90, cy - 150],
  [cx + 92, cy - 148],
  [cx - 88, cy - 150],
  [cx - 90, cy - 152],
  [cx, cy - 300],
]);
s = await pendingShape();
check('el dwell reconoce un triángulo', s?.kind === 'triangle', JSON.stringify(s));
await release();
await page.locator('.sel-bar--commit button:last-of-type').click();
await page.waitForTimeout(200);
s = await pendingShape();
check('Cancelar limpia el pendiente sin hornear', s === null);
const afterTriangle = await inkPixels();
check('cancelar no deja tinta nueva', Math.abs(afterTriangle - beforeTriangle) < 20, `${beforeTriangle} -> ${afterTriangle}`);

console.log('\n— Línea —');
await drawAndHold([
  [cx - 350, cy + 250],
  [cx - 250, cy + 252],
  [cx - 150, cy + 249],
  [cx - 50, cy + 251],
]);
s = await pendingShape();
check('el dwell reconoce una línea', s?.kind === 'line', JSON.stringify(s));
await release();
await page.evaluate(() => window.__trace.commitQuickShape());
await page.waitForTimeout(150);
await page.screenshot({ path: `${out}/qs-05-linea-horneada.png` });

console.log('\n— Desactivar QuickShape —');
// El store de UI no cuelga de `window`; el botón de la barra sí es DOM real,
// así que se apaga tal cual lo haría alguien tocando la pantalla.
const toggle = page.getByRole('button', { name: /QuickShape/ });
await toggle.click();
await page.waitForTimeout(150);
const beforeOff = await inkPixels();
await drawAndHold(circlePoints(cx + 260, cy - 200, 70));
s = await pendingShape();
check('con QuickShape apagado no reconoce nada', s === null, JSON.stringify(s));
await release();
const afterOff = await inkPixels();
check('el trazo libre se pinta igual que siempre', afterOff > beforeOff, `${beforeOff} -> ${afterOff}`);
await toggle.click(); // deja la app en su estado por defecto
await page.waitForTimeout(150);
await page.screenshot({ path: `${out}/qs-06-toggle-apagado.png` });

console.log('\n— Consola —');
check('sin errores en consola', errors.length === 0, errors.join(' | '));

console.log(`\n${failures === 0 ? 'TODO EN VERDE' : `${failures} FALLOS`}\n`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
