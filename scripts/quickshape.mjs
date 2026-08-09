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

/** Generador determinista: mismos "temblores" en cada corrida. */
function seededRandom(seed) {
  let s = seed;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

/**
 * Círculo con un hueco de cierre y ruido radial — así es un círculo real
 * dibujado con el dedo, no el arco perfecto de `circlePoints`. Es justo lo
 * que se ve en el primer pantallazo del bug: el trazo no vuelve exacto al
 * punto de partida.
 */
function shakyCirclePoints(cx, cy, r, gapDeg, jitter, rand, n = 26) {
  const endT = ((360 - gapDeg) / 360) * Math.PI * 2;
  return Array.from({ length: n }, (_, i) => {
    const t = (i / (n - 1)) * endT;
    const jr = r + (rand() - 0.5) * 2 * jitter;
    return [cx + Math.cos(t) * jr, cy + Math.sin(t) * jr];
  });
}

/** Línea recta con temblor perpendicular, no la recta exacta de un script. */
function shakyLinePoints(x0, y0, x1, y1, jitter, rand, n = 16) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  return Array.from({ length: n }, (_, i) => {
    const t = i / (n - 1);
    const j = (rand() - 0.5) * 2 * jitter;
    return [x0 + dx * t + nx * j, y0 + dy * t + ny * j];
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

console.log('\n— Aro de dwell —');
// El anillo comunica que la app está "esperando" — sin él el gesto es
// invisible (ver el bug reportado con capturas sin ninguna señal). No se
// comprueba que la animación interpole (en este Chromium headless el
// productor de fotogramas se para en cuanto hay eventos de puntero
// simulados, incluso con un bucle de rAF activo — se verificó aparte
// disparando la transición directamente por script), sólo que el
// mecanismo se arma en el sitio correcto y se apaga cuando toca.
await page.mouse.move(cx - 150, cy - 80);
await page.mouse.down();
await page.mouse.move(cx - 50, cy - 40, { steps: 8 });
await page.waitForTimeout(120);
let ring = await page.evaluate(() => {
  const el = document.querySelector('.dwell-ring');
  return el ? { armed: el.classList.contains('is-armed'), left: el.style.left, top: el.style.top } : null;
});
check('el aro se arma cerca del último punto', ring?.armed === true, JSON.stringify(ring));
await page.waitForTimeout(400);
ring = await page.evaluate(() => document.querySelector('.dwell-ring').classList.contains('is-armed'));
check('el aro se apaga tras completarse el dwell', ring === false);
await release();
await page.evaluate(() => window.__trace.cancelQuickShape());

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

console.log('\n— Calibración con temblor de dedo real —');
// El bug reportado: con umbrales calibrados sobre un trazo de ratón
// perfecto, un círculo con el lazo sin cerrar del todo nunca se
// reconocía, y una "línea recta" temblorosa sólo encajaba 1 de cada 10
// veces. Este bloque reproduce ambos con ruido determinista y comprueba
// la tasa de acierto con la precisión por defecto (60%).
const rand = seededRandom(7);

await drawAndHold(shakyCirclePoints(cx - 200, cy - 100, 90, 14, 10, rand));
s = await pendingShape();
check(
  'círculo con hueco de cierre y ruido: se reconoce igualmente',
  s?.kind === 'ellipse',
  JSON.stringify(s),
);
await release();
if (s?.editing) await page.evaluate(() => window.__trace.cancelQuickShape());
await page.screenshot({ path: `${out}/qs-07-circulo-tembloroso.png` });

let lineHits = 0;
const angles = [0, 18, -22, 40, -55, 70, -80, 100, -130, 160];
// Centrada en el propio centro del lienzo con medio largo corto: así
// ningún ángulo saca un extremo fuera del área dibujable (barras y línea
// de tiempo se tragan el clic si cae encima).
const lineLen = 180;
for (const deg of angles) {
  const rad = (deg * Math.PI) / 180;
  const x0 = cx + (Math.cos(rad) * lineLen) / 2;
  const y0 = cy + (Math.sin(rad) * lineLen) / 2;
  const x1 = cx - (Math.cos(rad) * lineLen) / 2;
  const y1 = cy - (Math.sin(rad) * lineLen) / 2;
  await drawAndHold(shakyLinePoints(x0, y0, x1, y1, 6, rand), 450);
  const st = await pendingShape();
  if (st?.kind === 'line') lineHits++;
  await release();
  if (st) await page.evaluate(() => window.__trace.cancelQuickShape());
}
check(
  'línea temblorosa: se reconoce la mayoría de las veces',
  lineHits >= 8,
  `${lineHits}/${angles.length}`,
);

console.log('\n— El slider de precisión cambia el resultado —');
await page.evaluate(() => window.__uiStore.getState().setQuickShapePrecision(1));
await drawAndHold(shakyLinePoints(cx - 100, cy + 200, cx + 100, cy + 180, 25, seededRandom(3)), 450);
s = await pendingShape();
check('al 100% de precisión, la misma línea temblorosa ya no encaja', s === null, JSON.stringify(s));
await release();

await page.evaluate(() => window.__uiStore.getState().setQuickShapePrecision(0.6));
await page.waitForTimeout(100);

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
