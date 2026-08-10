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

async function drag(from, to, steps = 8) {
  await page.mouse.move(from[0], from[1]);
  await page.mouse.down();
  await page.mouse.move(to[0], to[1], { steps });
  await page.mouse.up();
  await page.waitForTimeout(150);
}

/** Tinta del cel activo dentro de un rectángulo en espacio documento. */
async function inkInRect(rect) {
  return page.evaluate((r) => {
    const e = window.__trace;
    const layer = e.activeLayer;
    const cel = [...layer.cels.values()][0];
    if (!cel) return 0;
    const px = e.renderer.readRect(cel.surface, r);
    let n = 0;
    for (let i = 3; i < px.length; i += 4) if (px[i] > 40) n++;
    return n;
  }, rect);
}

async function docRectAround(screenX, screenY, half = 45) {
  const a = await page.evaluate((p) => window.__trace.screenToDoc(p), { x: screenX - box.x - half, y: screenY - box.y - half });
  const b = await page.evaluate((p) => window.__trace.screenToDoc(p), { x: screenX - box.x + half, y: screenY - box.y + half });
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), x2: Math.max(a.x, b.x), y2: Math.max(a.y, b.y) };
}

/* ------------------------------------------------------------------ */

await page.evaluate(() => {
  window.__trace.onion.enabled = false;
  window.__trace.touch();
});
await page.keyboard.press('b');
await page.waitForTimeout(100);

await page.evaluate(() => window.__uiStore.getState().setPanel('brush'));
await page.waitForTimeout(150);
const verticalBtn = page.locator('.panel__actions .action', { hasText: 'Vertical' });
const horizontalBtn = page.locator('.panel__actions .action', { hasText: 'Horizontal' });
check('los botones de simetría existen en el panel de pincel', (await verticalBtn.count()) === 1 && (await horizontalBtn.count()) === 1);

console.log('\n— Sin simetría: un trazo no deja tinta espejada —');
const spotDoc = { x: cx - 220, y: cy - 120 };
const mirrorVDoc = { x: cx + 220, y: cy - 120 };
const rectSpot = await docRectAround(spotDoc.x, spotDoc.y);
const rectMirrorV = await docRectAround(mirrorVDoc.x, mirrorVDoc.y);

await drag([spotDoc.x - 20, spotDoc.y], [spotDoc.x + 20, spotDoc.y]);
let inkSpot = await inkInRect(rectSpot);
let inkMirror = await inkInRect(rectMirrorV);
check('hay tinta donde se dibujó', inkSpot > 20, `${inkSpot} px`);
check('sin simetría, no hay tinta al otro lado', inkMirror < 5, `${inkMirror} px`);
await page.keyboard.press('Control+z');
await page.waitForTimeout(150);

console.log('\n— Activar "Vertical" en el panel de pincel —');
await verticalBtn.click();
await page.waitForTimeout(100);
let symState = await page.evaluate(() => window.__trace.symmetry);
check('queda vertical', symState.vertical === true && symState.horizontal === false, JSON.stringify(symState));
const vBtnActive = await verticalBtn.evaluate((el) => el.classList.contains('is-active'));
check('el botón "Vertical" se marca activo', vBtnActive === true);
const guideLines = await page.locator('.symmetry-overlay line').count();
check('se ve una línea guía (un eje activo)', guideLines === 1, `${guideLines}`);

await drag([spotDoc.x - 20, spotDoc.y], [spotDoc.x + 20, spotDoc.y]);
inkSpot = await inkInRect(rectSpot);
inkMirror = await inkInRect(rectMirrorV);
check('el trazo original sigue apareciendo', inkSpot > 20, `${inkSpot} px`);
check('aparece el reflejo vertical al otro lado', inkMirror > 20, `${inkMirror} px`);

const historyBeforeUndo = await page.evaluate(() => window.__trace.history.past.length);
await page.keyboard.press('Control+z');
await page.waitForTimeout(150);
const historyAfterUndo = await page.evaluate(() => window.__trace.history.past.length);
check('un solo trazo simétrico es un único paso de deshacer', historyAfterUndo === historyBeforeUndo - 1);
inkSpot = await inkInRect(rectSpot);
inkMirror = await inkInRect(rectMirrorV);
check('deshacer quita las dos mitades a la vez', inkSpot < 5 && inkMirror < 5, `${inkSpot} / ${inkMirror} px`);

await page.screenshot({ path: `${out}/symmetry-01-vertical.png` });

console.log('\n— Desactivar "Vertical" y activar "Horizontal" —');
await verticalBtn.click();
await horizontalBtn.click();
await page.waitForTimeout(100);
symState = await page.evaluate(() => window.__trace.symmetry);
check('queda sólo horizontal', symState.vertical === false && symState.horizontal === true, JSON.stringify(symState));

const mirrorHDoc = { x: spotDoc.x, y: cy + (cy - spotDoc.y) };
const rectMirrorH = await docRectAround(mirrorHDoc.x, mirrorHDoc.y);
await drag([spotDoc.x - 20, spotDoc.y], [spotDoc.x + 20, spotDoc.y]);
inkSpot = await inkInRect(rectSpot);
let inkMirrorH = await inkInRect(rectMirrorH);
check('aparece el reflejo horizontal', inkMirrorH > 20, `${inkMirrorH} px`);
await page.keyboard.press('Control+z');
await page.waitForTimeout(150);

console.log('\n— Las dos a la vez: simetría en las 4 vías —');
await verticalBtn.click();
await page.waitForTimeout(100);
symState = await page.evaluate(() => window.__trace.symmetry);
check('quedan las dos a la vez', symState.vertical === true && symState.horizontal === true, JSON.stringify(symState));
const guideLinesBoth = await page.locator('.symmetry-overlay line').count();
check('se ven las dos líneas guía', guideLinesBoth === 2, `${guideLinesBoth}`);

const rectDiag = await docRectAround(mirrorVDoc.x, cy + (cy - spotDoc.y));
await drag([spotDoc.x - 20, spotDoc.y], [spotDoc.x + 20, spotDoc.y]);
inkSpot = await inkInRect(rectSpot);
inkMirror = await inkInRect(rectMirrorV);
inkMirrorH = await inkInRect(rectMirrorH);
const inkDiag = await inkInRect(rectDiag);
check('las 4 copias aparecen: original', inkSpot > 20, `${inkSpot} px`);
check('las 4 copias aparecen: vertical', inkMirror > 20, `${inkMirror} px`);
check('las 4 copias aparecen: horizontal', inkMirrorH > 20, `${inkMirrorH} px`);
check('las 4 copias aparecen: diagonal', inkDiag > 20, `${inkDiag} px`);
await page.keyboard.press('Control+z');
await page.waitForTimeout(150);

await page.screenshot({ path: `${out}/symmetry-02-cuatro-vias.png` });

console.log('\n— Apagar las dos —');
await verticalBtn.click();
await horizontalBtn.click();
await page.waitForTimeout(100);
symState = await page.evaluate(() => window.__trace.symmetry);
check('las dos quedan desactivadas', symState.vertical === false && symState.horizontal === false, JSON.stringify(symState));
check('sin ejes activos, no hay línea guía', (await page.locator('.symmetry-overlay line').count()) === 0);

async function docToPage(p) {
  const s = await page.evaluate((pt) => window.__trace.docToScreen(pt), p);
  return { x: s.x + box.x, y: s.y + box.y };
}

console.log('\n— Simetría radial —');
const radialBtn = page.locator('.panel__actions .action', { hasText: /^Radial/ });
check('el botón de simetría radial existe', (await radialBtn.count()) === 1);

await radialBtn.click();
await page.waitForTimeout(100);
symState = await page.evaluate(() => window.__trace.symmetry);
check('un toque activa radial ×4', symState.radial === 4 && !symState.vertical && !symState.horizontal, JSON.stringify(symState));
const guideLinesRadial = await page.locator('.symmetry-overlay line').count();
check('se ven 4 radios guía', guideLinesRadial === 4, `${guideLinesRadial}`);

const docCenter = await page.evaluate(() => ({ x: window.__trace.doc.width / 2, y: window.__trace.doc.height / 2 }));
const r = 150;
// Con radial×4 y el ángulo que usa `mirrorStamps`, un punto a la derecha del
// centro se repite abajo, a la izquierda y arriba — un rombo, no una cruz
// alineada a los ejes por casualidad: es la rotación real la que lo coloca ahí.
const east = { x: docCenter.x + r, y: docCenter.y };
const south = { x: docCenter.x, y: docCenter.y + r };
const west = { x: docCenter.x - r, y: docCenter.y };
const north = { x: docCenter.x, y: docCenter.y - r };

const eastPage = await docToPage(east);
await drag([eastPage.x - 15, eastPage.y], [eastPage.x + 15, eastPage.y]);

const rectAt = async (p) => docRectAround((await docToPage(p)).x, (await docToPage(p)).y, 40);
const inkEast = await inkInRect(await rectAt(east));
const inkSouth = await inkInRect(await rectAt(south));
const inkWest = await inkInRect(await rectAt(west));
const inkNorth = await inkInRect(await rectAt(north));
check('tinta en el punto dibujado', inkEast > 15, `${inkEast} px`);
check('copia rotada en la segunda posición', inkSouth > 15, `${inkSouth} px`);
check('copia rotada en la tercera posición', inkWest > 15, `${inkWest} px`);
check('copia rotada en la cuarta posición', inkNorth > 15, `${inkNorth} px`);

const historyBeforeRadialUndo = await page.evaluate(() => window.__trace.history.past.length);
await page.keyboard.press('Control+z');
await page.waitForTimeout(150);
const historyAfterRadialUndo = await page.evaluate(() => window.__trace.history.past.length);
check(
  'las 4 copias radiales son un único paso de deshacer',
  historyAfterRadialUndo === historyBeforeRadialUndo - 1,
);
check('deshacer quita las 4 copias', (await inkInRect(await rectAt(east))) < 5);
await page.screenshot({ path: `${out}/symmetry-03-radial.png` });

console.log('\n— Radial y vertical/horizontal son excluyentes —');
await verticalBtn.click();
await page.waitForTimeout(100);
symState = await page.evaluate(() => window.__trace.symmetry);
check('activar Vertical apaga la radial', symState.vertical === true && symState.radial === 0, JSON.stringify(symState));
await verticalBtn.click();
await page.waitForTimeout(100);

await radialBtn.click();
await radialBtn.click();
await page.waitForTimeout(100);
symState = await page.evaluate(() => window.__trace.symmetry);
check('la radial pasa a ×6 en el siguiente toque', symState.radial === 6, JSON.stringify(symState));
// Vuelve a apagado para no dejar el documento en un estado sorprendente
// para el resto de tests que compartan este servidor de desarrollo.
await radialBtn.click();
await radialBtn.click();
await radialBtn.click();
await page.waitForTimeout(100);
symState = await page.evaluate(() => window.__trace.symmetry);
check('vuelve a apagado tras completar el ciclo', symState.radial === 0, JSON.stringify(symState));

console.log('\n— Consola —');
check('sin errores en consola', errors.length === 0, errors.join(' | '));

console.log(`\n${failures === 0 ? 'TODO EN VERDE' : `${failures} FALLOS`}\n`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
