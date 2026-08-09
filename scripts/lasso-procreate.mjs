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

async function tapAt(at) {
  await page.mouse.move(at[0], at[1]);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(120);
}

async function dragFreehand(points, stepsPerSegment = 6) {
  await page.mouse.move(points[0][0], points[0][1]);
  await page.mouse.down();
  for (let i = 1; i < points.length; i++) {
    await page.mouse.move(points[i][0], points[i][1], { steps: stepsPerSegment });
  }
  await page.mouse.up();
  await page.waitForTimeout(150);
}

/** Convierte una coordenada de pantalla (viewport) a espacio documento,
 *  igual que hace CanvasView antes de llamar al motor. */
async function toDoc(screenXY) {
  return page.evaluate(
    (p) => window.__trace.screenToDoc(p),
    { x: screenXY[0] - box.x, y: screenXY[1] - box.y },
  );
}

const state = () =>
  page.evaluate(() => {
    const e = window.__trace;
    return {
      active: e.selection.active,
      bounds: e.selection.bounds,
      pendingPoints: e.pendingLasso ? e.pendingLasso.points.length : null,
    };
});

/* ------------------------------------------------------------------ */

console.log('\n— Lienzo vacío: herramienta lazo —');
await page.keyboard.press('l');
await page.waitForTimeout(100);

console.log('\n— Polígono por toques, cerrado tocando el nodo de origen —');
const p0 = [cx - 200, cy - 150];
const p1 = [cx + 200, cy - 150];
const p2 = [cx, cy + 150];
await tapAt(p0);
await tapAt(p1);
let s = await state();
check('cada toque suelto añade un vértice', s.pendingPoints === 2, `${s.pendingPoints} puntos`);

const originVisible = await page.locator('.lasso-origin').count();
check('el nodo de origen aparece en el lienzo', originVisible === 1, `${originVisible}`);
const barCount = await page.locator('.sel-bar').count();
check('sólo la barra del lazo se muestra (no la de selección normal)', barCount === 1, `${barCount}`);

await tapAt(p2);
s = await state();
check('el tercer toque añade el tercer vértice', s.pendingPoints === 3, `${s.pendingPoints} puntos`);

await page.locator('.lasso-origin').click();
await page.waitForTimeout(200);
s = await state();
check('tocar el nodo de origen cierra el lazo', s.pendingPoints === null);
check('la selección queda activa tras cerrar', s.active === true);

const d0 = await toDoc(p0);
const d1 = await toDoc(p1);
const d2 = await toDoc(p2);
const expMinX = Math.min(d0.x, d1.x, d2.x);
const expMaxX = Math.max(d0.x, d1.x, d2.x);
const expMinY = Math.min(d0.y, d1.y, d2.y);
const expMaxY = Math.max(d0.y, d1.y, d2.y);
check(
  'los límites cubren el triángulo tocado',
  Math.abs(s.bounds.x - expMinX) < 4 &&
    Math.abs(s.bounds.x2 - expMaxX) < 4 &&
    Math.abs(s.bounds.y - expMinY) < 4 &&
    Math.abs(s.bounds.y2 - expMaxY) < 4,
  `esperado x:${expMinX.toFixed(1)}-${expMaxX.toFixed(1)} y:${expMinY.toFixed(1)}-${expMaxY.toFixed(1)} — obtenido x:${s.bounds.x}-${s.bounds.x2} y:${s.bounds.y}-${s.bounds.y2}`,
);
await page.screenshot({ path: `${out}/lasso-01-poligono.png` });

console.log('\n— Trazo en mano alzada, cerrado desde la barra flotante —');
await dragFreehand([
  [cx - 180, cy - 120],
  [cx + 60, cy - 200],
  [cx + 220, cy - 40],
  [cx + 120, cy + 160],
  [cx - 160, cy + 140],
]);
s = await state();
check(
  'el arrastre en mano alzada deja varios puntos sin cerrar',
  s.pendingPoints !== null && s.pendingPoints > 4,
  `${s.pendingPoints} puntos`,
);
const closeBtn = page.locator('.sel-bar button.is-key');
check('la barra ofrece "Cerrar"', (await closeBtn.count()) === 1);
await closeBtn.click();
await page.waitForTimeout(200);
s = await state();
check('"Cerrar" en la barra confirma el lazo', s.pendingPoints === null && s.active === true);
await page.screenshot({ path: `${out}/lasso-02-mano-alzada.png` });

console.log('\n— Combinar toques (polígono) y arrastre (mano alzada) en el mismo lazo —');
// El primer punto del lazo (`q0`) lleva encima el nodo de origen — tocar
// justo ahí para "seguir" el trazo cerraría el lazo en vez de extenderlo
// (comportamiento correcto: tocar el origen siempre cierra). Por eso el
// arrastre que sigue arranca cerca del ÚLTIMO vértice, no del primero.
const q0 = [cx - 220, cy];
await dragFreehand([q0, [cx - 40, cy - 180]]);
s = await state();
const afterFirstDrag = s.pendingPoints;
check('el primer arrastre añade puntos de mano alzada', afterFirstDrag > 1, `${afterFirstDrag} puntos`);

const q1 = [cx + 200, cy - 60];
await tapAt(q1);
s = await state();
check('el toque intermedio añade un vértice recto', s.pendingPoints === afterFirstDrag + 1, `${s.pendingPoints} puntos`);

await dragFreehand([q1, [cx + 100, cy + 180]]);
s = await state();
check(
  'el segundo arrastre retoma el trazo en mano alzada desde el último vértice',
  s.pendingPoints > afterFirstDrag + 1,
  `${s.pendingPoints} puntos`,
);

await page.locator('.lasso-origin').click();
await page.waitForTimeout(200);
s = await state();
check('el lazo mixto se cierra igual que uno puro', s.pendingPoints === null && s.active === true);
await page.screenshot({ path: `${out}/lasso-03-mixto.png` });

console.log('\n— Escape cancela y no toca la selección previa —');
await page.keyboard.press('Control+a');
await page.waitForTimeout(150);
const beforeEscape = await state();
check('Ctrl+A deja una selección de referencia', beforeEscape.active === true);

await tapAt([cx - 100, cy - 100]);
await tapAt([cx + 100, cy - 100]);
s = await state();
check('el nuevo lazo está en marcha', s.pendingPoints === 2);

await page.keyboard.press('Escape');
await page.waitForTimeout(200);
s = await state();
check('Escape descarta el lazo', s.pendingPoints === null);
check(
  'Escape restaura exactamente la selección previa',
  s.active === beforeEscape.active &&
    s.bounds.x === beforeEscape.bounds.x &&
    s.bounds.y === beforeEscape.bounds.y &&
    s.bounds.x2 === beforeEscape.bounds.x2 &&
    s.bounds.y2 === beforeEscape.bounds.y2,
  JSON.stringify({ before: beforeEscape.bounds, after: s.bounds }),
);

console.log('\n— La herramienta de rectángulo no cambió de comportamiento —');
await page.keyboard.press('Control+d');
await page.waitForTimeout(150);
await page.keyboard.press('m');
await page.waitForTimeout(100);
await page.mouse.move(cx - 90, cy - 70);
await page.mouse.down();
await page.mouse.move(cx + 90, cy + 70, { steps: 10 });
await page.mouse.up();
await page.waitForTimeout(200);
s = await state();
check('selectRect sigue siendo un único gesto de arrastre', s.active === true, JSON.stringify(s.bounds));
check('selectRect no deja pendingLasso', s.pendingPoints === null);

console.log('\n— Consola —');
check('sin errores en consola', errors.length === 0, errors.join(' | '));

console.log(`\n${failures === 0 ? 'TODO EN VERDE' : `${failures} FALLOS`}\n`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
