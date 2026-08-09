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

async function drag(from, to, steps = 10) {
  await page.mouse.move(from[0], from[1]);
  await page.mouse.down();
  await page.mouse.move(to[0], to[1], { steps });
  await page.mouse.up();
  await page.waitForTimeout(150);
}

/**
 * Píxeles con tinta dentro de un rectángulo en espacio documento, leídos del
 * framebuffer visible — necesario aquí porque `renderFrameToImageData` usa
 * `includeWet: false` (el camino de exportación) y por tanto no muestra la
 * vista previa de un flotante en marcha. `gl.readPixels` sí refleja lo que
 * de verdad se está viendo, con `preserveDrawingBuffer: false` incluido.
 */
async function inkCountInRect(docRect) {
  return page.evaluate((r) => {
    const c = document.querySelector('canvas');
    const e = window.__trace;
    const gl = c.getContext('webgl2');
    const dpr = c.width / c.clientWidth;
    const a = e.docToScreen({ x: r.x, y: r.y });
    const b = e.docToScreen({ x: r.x2, y: r.y2 });
    const x0 = Math.max(0, Math.round(Math.min(a.x, b.x) * dpr));
    const x1 = Math.min(c.width, Math.round(Math.max(a.x, b.x) * dpr));
    const topCss = Math.min(a.y, b.y);
    const bottomCss = Math.max(a.y, b.y);
    const y0 = Math.max(0, Math.round((c.clientHeight - bottomCss) * dpr));
    const y1 = Math.min(c.height, Math.round((c.clientHeight - topCss) * dpr));
    const w = x1 - x0;
    const h = y1 - y0;
    if (w <= 0 || h <= 0) return 0;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(x0, y0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let n = 0;
    for (let i = 0; i < px.length; i += 4) if (px[i] < 200 || px[i + 1] < 200 || px[i + 2] < 200) n++;
    return n;
  }, docRect);
}

async function setFrame(f) {
  await page.evaluate((frame) => window.__trace.setFrame(frame), f);
  await page.waitForTimeout(120);
}

/* ------------------------------------------------------------------ */

await page.evaluate(() => {
  window.__trace.onion.enabled = false;
  window.__trace.touch();
});

console.log('\n— Preparar tres dibujos iguales en los cuadros 0, 5 y 10 —');
await page.keyboard.press('b');
await page.waitForTimeout(100);

await setFrame(0);
await drag([cx - 30, cy], [cx + 30, cy], 8);

await setFrame(5);
await page.evaluate(() => {
  const e = window.__trace;
  e.addCel(e.activeLayer.id, 5, false);
});
await drag([cx - 30, cy], [cx + 30, cy], 8);

await setFrame(10);
await page.evaluate(() => {
  const e = window.__trace;
  e.addCel(e.activeLayer.id, 10, false);
});
await drag([cx - 30, cy], [cx + 30, cy], 8);

await setFrame(0);

const celCount = await page.evaluate(() => window.__trace.activeLayer.cels.size);
check('la capa activa tiene 3 dibujos', celCount === 3, `${celCount} cels`);

// Rectángulo de documento centrado en el dibujo original — para leer el
// framebuffer con inkCountInRect. El destino se calcula sumando el `tx` que
// se le pasa a `updateFloating` DIRECTAMENTE en espacio documento, sin pasar
// por `screenToDoc`: `tx`/`ty` ya están en píxeles de documento (ver
// `floatingMatrixFor`), y mezclar ambos espacios con el zoom de por medio
// habría dado un rectángulo de destino que no coincide con el real.
const originDoc = await page.evaluate(
  (p) => window.__trace.screenToDoc(p),
  { x: cx - box.x - 45, y: cy - box.y - 20 },
);
const originDoc2 = await page.evaluate(
  (p) => window.__trace.screenToDoc(p),
  { x: cx - box.x + 45, y: cy - box.y + 20 },
);
const origRect = {
  x: Math.min(originDoc.x, originDoc2.x),
  y: Math.min(originDoc.y, originDoc2.y),
  x2: Math.max(originDoc.x, originDoc2.x),
  y2: Math.max(originDoc.y, originDoc2.y),
};
const TX_DOC = 300;
const shiftedRect = {
  x: origRect.x + TX_DOC,
  y: origRect.y,
  x2: origRect.x2 + TX_DOC,
  y2: origRect.y2,
};

const paintedAt0 = await inkCountInRect(origRect);
check('hay tinta que seleccionar en el cuadro 0', paintedAt0 > 20, `${paintedAt0} px`);

console.log('\n— Seleccionar el dibujo y marcar el rango 0-10 en la línea de tiempo —');
await page.keyboard.press('m');
await page.waitForTimeout(100);
await drag([cx - 60, cy - 40], [cx + 60, cy + 40]);
let selActive = await page.evaluate(() => window.__trace.selection.active);
check('queda una selección activa', selActive === true);

await page.locator('button[title^="Marcar rango"]').click();
await page.waitForTimeout(100);
const rulerBox = await page.locator('.ruler').boundingBox();
const xAt = (f) => rulerBox.x + f * FRAME_W + FRAME_W / 2;
const yMid = rulerBox.y + rulerBox.height / 2;
await page.mouse.move(xAt(0), yMid);
await page.mouse.down();
await page.mouse.move(xAt(10), yMid, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(150);

let range = await page.evaluate(() => {
  const s = window.__uiStore.getState();
  return { start: s.frameRangeStart, end: s.frameRangeEnd };
});
check('el arrastre en la regla marca 0-10', range.start === 0 && range.end === 10, JSON.stringify(range));

const rangeBand = await page.locator('.frame-range-band').count();
check('la banda del rango se dibuja', rangeBand === 1);

console.log('\n— "Transformar rango" levanta los 3 cels a la vez —');
const rangeBtn = page.locator('.sel-bar button', { hasText: 'Transformar rango' });
check('aparece el botón "Transformar rango"', (await rangeBtn.count()) === 1);
await rangeBtn.click();
await page.waitForTimeout(150);

const liftState = await page.evaluate(() => {
  const e = window.__trace;
  return {
    hasFloating: e.floating !== null,
    celCount: e.floating ? e.floating.cels.length : 0,
    frames: e.floating ? e.floating.cels.map((c) => c.celFrame).sort((a, b) => a - b) : [],
  };
});
check('el flotante levanta exactamente los 3 cels', liftState.celCount === 3, JSON.stringify(liftState));
check(
  'levanta los cels que empiezan en 0, 5 y 10',
  JSON.stringify(liftState.frames) === JSON.stringify([0, 5, 10]),
  JSON.stringify(liftState.frames),
);

const rangeClearedAfterLift = await page.evaluate(() => {
  const s = window.__uiStore.getState();
  return { start: s.frameRangeStart, end: s.frameRangeEnd, mode: s.rangeSelectMode };
});
check(
  'usar el botón consume el rango marcado',
  rangeClearedAfterLift.start === null && rangeClearedAfterLift.mode === false,
  JSON.stringify(rangeClearedAfterLift),
);

console.log('\n— Mover el lote desplaza el dibujo en los 3 cuadros —');
await page.evaluate((tx) => window.__trace.updateFloating({ tx, ty: 0 }), TX_DOC);
await page.waitForTimeout(150);

for (const f of [0, 5, 10]) {
  await setFrame(f);
  const atOrigin = await inkCountInRect(origRect);
  const atShifted = await inkCountInRect(shiftedRect);
  check(
    `cuadro ${f}: el hueco queda donde estaba el dibujo`,
    atOrigin < paintedAt0 * 0.15,
    `${atOrigin} px (original ${paintedAt0})`,
  );
  check(`cuadro ${f}: la vista previa aparece en el destino`, atShifted > paintedAt0 * 0.5, `${atShifted} px`);
}

console.log('\n— Un cuadro fuera del lote no se ve afectado —');
// El cuadro 3 hereda el dibujo sostenido del cuadro 0, así que también debe
// mostrar el hueco y la vista previa desplazada — mismo cel, misma edición.
await setFrame(3);
const heldAtOrigin = await inkCountInRect(origRect);
const heldAtShifted = await inkCountInRect(shiftedRect);
check('cuadro 3 (sostenido desde el 0) también muestra el hueco', heldAtOrigin < paintedAt0 * 0.15, `${heldAtOrigin} px`);
check('cuadro 3 también muestra la vista previa', heldAtShifted > paintedAt0 * 0.5, `${heldAtShifted} px`);
await setFrame(0);

console.log('\n— Confirmar aplica los 3 cuadros en un único paso de historial —');
const historyBefore = await page.evaluate(() => window.__trace.history.past.length);
await page.evaluate(() => window.__trace.commitFloating());
await page.waitForTimeout(200);
const historyAfter = await page.evaluate(() => window.__trace.history.past.length);
check('confirmar añade un único paso de historial', historyAfter === historyBefore + 1, `${historyBefore} -> ${historyAfter}`);

for (const f of [0, 5, 10]) {
  await setFrame(f);
  const atOrigin = await inkCountInRect(origRect);
  const atShifted = await inkCountInRect(shiftedRect);
  check(`cuadro ${f}: confirmado, el destino tiene tinta`, atShifted > paintedAt0 * 0.5, `${atShifted} px`);
  check(`cuadro ${f}: confirmado, el origen sigue vacío`, atOrigin < paintedAt0 * 0.15, `${atOrigin} px`);
}

console.log('\n— Deshacer revierte los 3 cuadros de una vez —');
await page.keyboard.press('Control+z');
await page.waitForTimeout(200);
for (const f of [0, 5, 10]) {
  await setFrame(f);
  const atOrigin = await inkCountInRect(origRect);
  check(`cuadro ${f}: deshacer devuelve la tinta al origen`, atOrigin > paintedAt0 * 0.5, `${atOrigin} px`);
}

console.log('\n— Rehacer vuelve a aplicar los 3 cuadros —');
await page.keyboard.press('Control+Shift+z');
await page.waitForTimeout(200);
for (const f of [0, 5, 10]) {
  await setFrame(f);
  const atShifted = await inkCountInRect(shiftedRect);
  check(`cuadro ${f}: rehacer vuelve a mover la tinta`, atShifted > paintedAt0 * 0.5, `${atShifted} px`);
}

console.log('\n— Cancelar un lote no toca la historia —');
await setFrame(0);
await page.keyboard.press('m');
await page.waitForTimeout(100);
await drag([cx + 60, cy - 40], [cx + 180, cy + 40]);
await page.locator('button[title^="Marcar rango"]').click();
await page.waitForTimeout(100);
await page.mouse.move(xAt(0), yMid);
await page.mouse.down();
await page.mouse.move(xAt(10), yMid, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(150);
const liftedForCancel = await page.evaluate(() => window.__trace.liftSelectionRange(0, 10));
check('se puede levantar un segundo lote', liftedForCancel === true);
const historyBeforeCancel = await page.evaluate(() => window.__trace.history.past.length);
await page.evaluate(() => window.__trace.cancelFloating());
await page.waitForTimeout(150);
const historyAfterCancel = await page.evaluate(() => window.__trace.history.past.length);
check('cancelar no añade pasos de historial', historyAfterCancel === historyBeforeCancel, `${historyBeforeCancel} -> ${historyAfterCancel}`);
check('cancelar suelta el flotante', await page.evaluate(() => window.__trace.floating === null));

await page.screenshot({ path: `${out}/batch-transform-01.png` });

console.log('\n— Consola —');
check('sin errores en consola', errors.length === 0, errors.join(' | '));

console.log(`\n${failures === 0 ? 'TODO EN VERDE' : `${failures} FALLOS`}\n`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
