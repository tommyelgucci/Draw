import { chromium } from 'playwright';

const out = process.env.SHOT_DIR || 'shots';
const FRAME_W = 26;

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

async function setFrame(f) {
  await page.evaluate((frame) => window.__trace.setFrame(frame), f);
  await page.waitForTimeout(100);
}

/** Tinta en `rect` (espacio documento) del cel EFECTIVO en `frame` — el que
 *  quedaría visible ahí por sostenido, igual que `celAt`. */
async function effectiveInkAt(frame, rect) {
  return page.evaluate((p) => {
    const e = window.__trace;
    const layer = e.activeLayer;
    let best = null;
    let bestFrame = -1;
    for (const [f, cel] of layer.cels) {
      if (f <= p.frame && f > bestFrame) {
        bestFrame = f;
        best = cel;
      }
    }
    if (!best) return 0;
    const px = e.renderer.readRect(best.surface, p.rect);
    let n = 0;
    for (let i = 3; i < px.length; i += 4) if (px[i] > 40) n++;
    return n;
  }, { frame, rect });
}

async function docRectAround(screenX, screenY, half = 45) {
  const a = await page.evaluate((p) => window.__trace.screenToDoc(p), { x: screenX - box.x - half, y: screenY - box.y - half });
  const b = await page.evaluate((p) => window.__trace.screenToDoc(p), { x: screenX - box.x + half, y: screenY - box.y + half });
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    x2: Math.max(a.x, b.x),
    y2: Math.max(a.y, b.y),
  };
}

/* ------------------------------------------------------------------ */

await page.evaluate(() => {
  window.__trace.onion.enabled = false;
  // Cuadros justos para que duplicar el rango [0,6] fuerce a ampliar
  // frameCount (destino hasta el 13) — comprueba las dos cosas a la vez.
  window.__trace.setFrameCount(8);
  window.__trace.touch();
});

console.log('\n— Tres dibujos distintos: A en el 0, B en el 3, C en el 6 —');
await page.keyboard.press('b');
await page.waitForTimeout(100);

const posA = [cx - 220, cy];
const posB = [cx, cy];
const posC = [cx + 220, cy];

await setFrame(0);
await drag([posA[0] - 25, posA[1]], [posA[0] + 25, posA[1]]);
await setFrame(3);
await page.evaluate(() => {
  const e = window.__trace;
  e.addCel(e.activeLayer.id, 3, false);
});
await drag([posB[0] - 25, posB[1]], [posB[0] + 25, posB[1]]);
await setFrame(6);
await page.evaluate(() => {
  const e = window.__trace;
  e.addCel(e.activeLayer.id, 6, false);
});
await drag([posC[0] - 25, posC[1]], [posC[0] + 25, posC[1]]);
await setFrame(0);

const rectA = await docRectAround(...posA);
const rectB = await docRectAround(...posB);
const rectC = await docRectAround(...posC);

const inkA0 = await effectiveInkAt(0, rectA);
check('A pintó algo en el cuadro 0', inkA0 > 20, `${inkA0} px`);

console.log('\n— Marcar el rango 0-6 en la regla —');
await page.evaluate(() => window.__uiStore.getState().setPanel(null));
await page.locator('button[title^="Marcar rango"]').click();
await page.waitForTimeout(100);
const rulerBox = await page.locator('.ruler').boundingBox();
const xAt = (f) => rulerBox.x + f * FRAME_W + FRAME_W / 2;
const yMid = rulerBox.y + rulerBox.height / 2;
await page.mouse.move(xAt(0), yMid);
await page.mouse.down();
await page.mouse.move(xAt(6), yMid, { steps: 6 });
await page.mouse.up();
await page.waitForTimeout(150);

let range = await page.evaluate(() => {
  const s = window.__uiStore.getState();
  return { start: s.frameRangeStart, end: s.frameRangeEnd };
});
check('el rango marcado es 0-6', range.start === 0 && range.end === 6, JSON.stringify(range));

const actionsBar = page.locator('.frame-range-actions');
check('aparece la barra de acciones del rango', (await actionsBar.count()) === 1);
const label = await actionsBar.locator('.frame-range-actions__label').textContent();
check('la barra cuenta 7 cuadros marcados', label.includes('7'), label);

console.log('\n— Duplicar el rango justo después (y ampliar frameCount) —');
const frameCountBefore = await page.evaluate(() => window.__trace.doc.frameCount);
await actionsBar.locator('button', { hasText: 'Duplicar' }).click();
await page.waitForTimeout(200);

const frameCountAfter = await page.evaluate(() => window.__trace.doc.frameCount);
check('frameCount crece para que quepa la copia', frameCountAfter >= 14, `${frameCountBefore} -> ${frameCountAfter}`);

const dupKeys = await page.evaluate(() => [...window.__trace.activeLayer.cels.keys()].sort((a, b) => a - b));
check('aparecen cels nuevos en 7, 10 y 13', [7, 10, 13].every((f) => dupKeys.includes(f)), JSON.stringify(dupKeys));

const inkA7 = await effectiveInkAt(7, rectA);
const inkB10 = await effectiveInkAt(10, rectB);
const inkC13 = await effectiveInkAt(13, rectC);
check('la copia del cuadro 7 tiene el dibujo A', inkA7 > 20, `${inkA7} px`);
check('la copia del cuadro 10 tiene el dibujo B', inkB10 > 20, `${inkB10} px`);
check('la copia del cuadro 13 tiene el dibujo C', inkC13 > 20, `${inkC13} px`);

range = await page.evaluate(() => {
  const s = window.__uiStore.getState();
  return { start: s.frameRangeStart, end: s.frameRangeEnd };
});
check('duplicar consume la marca de rango', range.start === null, JSON.stringify(range));

await page.screenshot({ path: `${out}/frame-range-01-duplicado.png` });

console.log('\n— Deshacer quita las tres copias de una vez —');
const historyBeforeUndo = await page.evaluate(() => window.__trace.history.past.length);
await page.keyboard.press('Control+z');
await page.waitForTimeout(200);
const historyAfterUndo = await page.evaluate(() => window.__trace.history.past.length);
check('deshacer quitó exactamente un paso', historyAfterUndo === historyBeforeUndo - 1, `${historyBeforeUndo} -> ${historyAfterUndo}`);
const keysAfterUndo = await page.evaluate(() => [...window.__trace.activeLayer.cels.keys()].sort((a, b) => a - b));
check('las tres copias desaparecen a la vez', ![7, 10, 13].some((f) => keysAfterUndo.includes(f)), JSON.stringify(keysAfterUndo));
const frameCountAfterUndo = await page.evaluate(() => window.__trace.doc.frameCount);
check('deshacer también devuelve frameCount', frameCountAfterUndo === frameCountBefore, `${frameCountAfterUndo}`);

console.log('\n— Invertir el rango 0-6 —');
await page.evaluate(() => window.__uiStore.getState().setFrameRange(0, 6));
await page.waitForTimeout(100);
await page.locator('.frame-range-actions button', { hasText: 'Invertir' }).click();
await page.waitForTimeout(200);

const inkC0 = await effectiveInkAt(0, rectC);
const inkB1 = await effectiveInkAt(1, rectB);
const inkA4 = await effectiveInkAt(4, rectA);
const inkA6 = await effectiveInkAt(6, rectA);
check('el cuadro 0 ahora muestra el dibujo C (el que estaba al final)', inkC0 > 20, `${inkC0} px`);
check('el cuadro 1 ahora muestra el dibujo B (el del medio)', inkB1 > 20, `${inkB1} px`);
check('el cuadro 4 ahora muestra el dibujo A (el que estaba al principio)', inkA4 > 20, `${inkA4} px`);
check('el cuadro 6 sigue sosteniendo A (el sostenido llega hasta el final)', inkA6 > 20, `${inkA6} px`);

await page.screenshot({ path: `${out}/frame-range-02-invertido.png` });

console.log('\n— Deshacer también revierte la inversión de una vez —');
await page.keyboard.press('Control+z');
await page.waitForTimeout(200);
const inkA0After = await effectiveInkAt(0, rectA);
const inkC6After = await effectiveInkAt(6, rectC);
check('deshacer devuelve A al cuadro 0', inkA0After > 20, `${inkA0After} px`);
check('deshacer devuelve C al cuadro 6', inkC6After > 20, `${inkC6After} px`);

console.log('\n— Consola —');
check('sin errores en consola', errors.length === 0, errors.join(' | '));

console.log(`\n${failures === 0 ? 'TODO EN VERDE' : `${failures} FALLOS`}\n`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
