import { chromium } from 'playwright';

const out = process.env.SHOT_DIR || 'shots';
/** Ancho de cada celda de la línea de tiempo, en px de CSS — igual valor
 * fijo que usa scripts/batch-transform.mjs para clicar la regla. */
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
await page.evaluate(() => {
  window.__trace.onion.enabled = false;
  window.__trace.touch();
});

let box = await page.locator('.canvas-surface').boundingBox();
let cx = box.x + box.width / 2;
let cy = box.y + box.height / 2;

/** `newProject` puede cambiar el tamaño/posición real del lienzo en
 * pantalla (encaja al nuevo tamaño) — hay que volver a medir antes de
 * seguir usando `cx`/`cy` para arrastrar o para `screenToDoc`. */
async function refreshCanvasBox() {
  box = await page.locator('.canvas-surface').boundingBox();
  cx = box.x + box.width / 2;
  cy = box.y + box.height / 2;
}

async function drag(from, to, steps = 10) {
  await page.mouse.move(from[0], from[1]);
  await page.mouse.down();
  await page.mouse.move(to[0], to[1], { steps });
  await page.mouse.up();
  await page.waitForTimeout(150);
}

/** Píxeles con alfa por encima de ruido en un cel concreto, buscado por id
 * de capa y fotograma — no por referencia de objeto, a propósito: tras
 * `loadDocument` los objetos son nuevos, así que cualquier comprobación que
 * sobreviva a una recarga tiene que ir por id, igual que hace
 * `rehydrateHistoryOp`. */
async function inkAt(layerId, frame) {
  return inkInRect(layerId, frame, null);
}

/** Igual que `inkAt`, pero acotado a un rect en espacio documento — hace
 * falta para el escenario del lote: tras moverlo, el cel entero SÍ tiene
 * tinta (la copia en el destino), así que "el origen quedó vacío" sólo
 * significa algo si se mide en la región de origen, no en el cel completo. */
async function inkInRect(layerId, frame, rect) {
  return page.evaluate(
    ({ layerId, frame, rect }) => {
      const e = window.__trace;
      const layer = e.doc.layers.find((l) => l.id === layerId);
      const cel = layer?.cels.get(frame);
      if (!cel) return 0;
      const full = { x: 0, y: 0, x2: e.doc.width, y2: e.doc.height };
      const r = rect
        ? {
            x: Math.max(0, Math.floor(rect.x)),
            y: Math.max(0, Math.floor(rect.y)),
            x2: Math.min(e.doc.width, Math.ceil(rect.x2)),
            y2: Math.min(e.doc.height, Math.ceil(rect.y2)),
          }
        : full;
      const px = e.renderer.readRect(cel.surface, r);
      let n = 0;
      for (let i = 3; i < px.length; i += 4) if (px[i] > 40) n++;
      return n;
    },
    { layerId, frame, rect },
  );
}

const celCount = (layerId) =>
  page.evaluate((id) => window.__trace.doc.layers.find((l) => l.id === id)?.cels.size ?? -1, layerId);

const canUndo = () => page.evaluate(() => window.__trace.history.canUndo);

/** Guarda el proyecto y lo vuelve a cargar en el mismo motor — el mismo
 * camino que "cerrar y reabrir" (autoguardado o .trace manual), ver
 * `serializeProject`/`deserializeProject` en io.ts. */
async function saveAndReload() {
  return page.evaluate(async () => {
    const { serializeProject, deserializeProject } = await import('/src/core/io.ts');
    const e = window.__trace;
    const bytes = await serializeProject(e);
    const { doc, historyOps } = await deserializeProject(e, bytes);
    e.loadDocument(doc);
    e.loadHistoryOps(historyOps);
    return { canUndo: e.history.canUndo, size: bytes.length, opsRestored: historyOps.length };
  });
}

/* ------------------------------------------------------------------ */

console.log('\n— Un trazo sobrevive guardar y reabrir —');
await page.keyboard.press('b');
await page.waitForTimeout(100);
const layer1 = await page.evaluate(() => window.__trace.activeLayer.id);

await drag([cx - 60, cy], [cx + 60, cy], 10);
const inkAfterStroke = await inkAt(layer1, 0);
check('el trazo deja tinta', inkAfterStroke > 0, `${inkAfterStroke} px`);

const reload1 = await saveAndReload();
check('el historial queda marcado como deshacible tras recargar', reload1.canUndo === true, JSON.stringify(reload1));

await page.evaluate(() => window.__trace.history.undo());
await page.waitForTimeout(100);
const inkAfterUndo = await inkAt(layer1, 0);
const celsAfterUndo = await celCount(layer1);
check('deshacer tras recargar quita la tinta', inkAfterUndo === 0, `${inkAfterUndo} px`);
check('deshacer también quita el cel que creó el trazo', celsAfterUndo === 0, `${celsAfterUndo} cels`);

await page.evaluate(() => window.__trace.history.redo());
await page.waitForTimeout(100);
const inkAfterRedo = await inkAt(layer1, 0);
check('rehacer tras recargar devuelve la tinta', inkAfterRedo === inkAfterStroke, `${inkAfterRedo} px`);

console.log('\n— Dos trazos separados deshacen en orden tras recargar —');
await page.evaluate(() => window.__trace.newProject(800, 600, 12, 24));
await page.waitForTimeout(200);
await refreshCanvasBox();
await page.evaluate(() => {
  window.__trace.onion.enabled = false;
  window.__trace.touch();
});
await page.keyboard.press('b');
await page.waitForTimeout(100);
const layer2 = await page.evaluate(() => window.__trace.activeLayer.id);

await drag([cx - 250, cy - 150], [cx - 190, cy - 150], 8);
const inkOnlyA = await inkAt(layer2, 0);
check('el primer trazo deja tinta', inkOnlyA > 0, `${inkOnlyA} px`);

await drag([cx + 150, cy + 150], [cx + 210, cy + 150], 8);
const inkAB = await inkAt(layer2, 0);
check('el segundo trazo añade más tinta', inkAB > inkOnlyA, `${inkOnlyA} -> ${inkAB} px`);

const reload2 = await saveAndReload();
check('2 pasos raster sobreviven la recarga', reload2.opsRestored === 2, JSON.stringify(reload2));

await page.evaluate(() => window.__trace.history.undo());
await page.waitForTimeout(100);
const inkAfterOneUndo = await inkAt(layer2, 0);
check(
  'deshacer una vez tras recargar quita sólo el segundo trazo',
  inkAfterOneUndo === inkOnlyA,
  `${inkAfterOneUndo} px, esperado ${inkOnlyA}`,
);

await page.evaluate(() => window.__trace.history.undo());
await page.waitForTimeout(100);
const inkAfterTwoUndos = await inkAt(layer2, 0);
const celsAfterTwoUndos = await celCount(layer2);
check('deshacer dos veces vacía el cel entero', inkAfterTwoUndos === 0, `${inkAfterTwoUndos} px`);
check('el cel creado por el primer trazo también se quita', celsAfterTwoUndos === 0, `${celsAfterTwoUndos} cels`);

console.log('\n— Un comando estructural corta la racha persistida —');
await page.evaluate(() => window.__trace.newProject(800, 600, 12, 24));
await page.waitForTimeout(200);
await refreshCanvasBox();
await page.evaluate(() => {
  window.__trace.onion.enabled = false;
  window.__trace.touch();
});
await page.keyboard.press('b');
await page.waitForTimeout(100);
const layerA = await page.evaluate(() => window.__trace.activeLayer.id);
await drag([cx - 60, cy], [cx + 60, cy], 10);
const inkLayerA = await inkAt(layerA, 0);
check('hay tinta en la primera capa', inkLayerA > 0, `${inkLayerA} px`);

// "Añadir capa" no lleva `op`: no se puede reconstruir desde disco, así que
// corta la racha ahí — todo lo anterior (el trazo en layerA) se queda
// fuera de lo persistido.
const layerB = await page.evaluate(() => {
  const e = window.__trace;
  e.addLayer();
  return e.activeLayer.id;
});
await page.waitForTimeout(100);
await drag([cx - 60, cy + 100], [cx + 60, cy + 100], 10);
const inkLayerB = await inkAt(layerB, 0);
check('hay tinta en la segunda capa', inkLayerB > 0, `${inkLayerB} px`);

const reload3 = await saveAndReload();
check(
  'sólo el paso más reciente (el trazo en layerB) sobrevive',
  reload3.opsRestored === 1,
  JSON.stringify(reload3),
);
check('el historial queda deshacible tras recargar', reload3.canUndo === true, JSON.stringify(reload3));

await page.evaluate(() => window.__trace.history.undo());
await page.waitForTimeout(100);
const inkLayerBAfterUndo = await inkAt(layerB, 0);
check('deshacer revierte el trazo de layerB', inkLayerBAfterUndo === 0, `${inkLayerBAfterUndo} px`);

const canUndoAfterChain = await canUndo();
check(
  '"añadir capa" y el trazo de layerA no sobrevivieron: no queda nada más que deshacer',
  canUndoAfterChain === false,
);
const layerCountAfter = await page.evaluate(() => window.__trace.doc.layers.length);
check('layerB sigue existiendo (sólo se deshizo el dibujo, no la capa)', layerCountAfter === 2, `${layerCountAfter} capas`);
const inkLayerAAfterChain = await inkAt(layerA, 0);
check('el trazo de layerA, no persistido, se queda como estaba al guardar', inkLayerAAfterChain === inkLayerA, `${inkLayerAAfterChain} px`);

console.log('\n— Un lote de transformación (varios cels) sobrevive —');
// Recarga la página entera en vez de `newProject`: aísla este escenario del
// resto (documento en blanco, motor nuevo) sin arrastrar el estado de los
// tres anteriores.
await page.goto('http://127.0.0.1:5173/', { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
await refreshCanvasBox();
await page.evaluate(() => {
  window.__trace.onion.enabled = false;
  window.__trace.touch();
});
await page.keyboard.press('b');
await page.waitForTimeout(100);
const layerC = await page.evaluate(() => window.__trace.activeLayer.id);

await drag([cx - 30, cy - 30], [cx + 30, cy + 30], 8);
await page.evaluate(() => {
  const e = window.__trace;
  e.setFrame(5);
  e.addCel(e.activeLayer.id, 5, false);
});
await page.waitForTimeout(100);
await drag([cx - 30, cy - 30], [cx + 30, cy + 30], 8);
await page.evaluate(() => window.__trace.setFrame(0));
await page.waitForTimeout(100);

// La región de origen (donde estaba el dibujo) y la de destino (adonde lo
// mueve `tx`) en espacio documento — hace falta para medir tinta en cada
// una por separado: el cel entero SIEMPRE tiene tinta después del lote (la
// copia movida sigue estando dentro del mismo cel), así que "el origen
// quedó vacío" sólo es una comprobación real si se mide justo ahí.
const TX_DOC = 200;
const origCorner1 = await page.evaluate((p) => window.__trace.screenToDoc(p), {
  x: cx - 55 - box.x,
  y: cy - 55 - box.y,
});
const origCorner2 = await page.evaluate((p) => window.__trace.screenToDoc(p), {
  x: cx + 55 - box.x,
  y: cy + 55 - box.y,
});
const origRect = {
  x: Math.min(origCorner1.x, origCorner2.x),
  y: Math.min(origCorner1.y, origCorner2.y),
  x2: Math.max(origCorner1.x, origCorner2.x),
  y2: Math.max(origCorner1.y, origCorner2.y),
};
const destRect = { x: origRect.x + TX_DOC, y: origRect.y, x2: origRect.x2 + TX_DOC, y2: origRect.y2 };

const inkOrigBeforeLift0 = await inkInRect(layerC, 0, origRect);
check('hay tinta en la región de origen antes del lote', inkOrigBeforeLift0 > 0, `${inkOrigBeforeLift0} px`);

await page.keyboard.press('m');
await page.waitForTimeout(100);
await drag([cx - 80, cy - 80], [cx + 80, cy + 80]);
let selActive = await page.evaluate(() => window.__trace.selection.active);
check('queda una selección activa sobre el dibujo', selActive === true);

await page.locator('button[title^="Marcar rango"]').click();
await page.waitForTimeout(100);
const rulerBox = await page.locator('.ruler').boundingBox();
const xAt = (f) => rulerBox.x + f * FRAME_W + FRAME_W / 2;
const yMid = rulerBox.y + rulerBox.height / 2;
await page.mouse.move(xAt(0), yMid);
await page.mouse.down();
await page.mouse.move(xAt(5), yMid, { steps: 6 });
await page.mouse.up();
await page.waitForTimeout(150);

const rangeBtn = page.locator('.sel-bar button', { hasText: 'Transformar rango' });
check('aparece el botón "Transformar rango"', (await rangeBtn.count()) === 1);
await rangeBtn.click();
await page.waitForTimeout(150);
const floatingCels = await page.evaluate(() => window.__trace.floating?.cels.length ?? 0);
check('el lote levanta los 2 cels', floatingCels === 2, `${floatingCels} cels`);

await page.evaluate((tx) => window.__trace.updateFloating({ tx, ty: 0 }), TX_DOC);
await page.waitForTimeout(150);
await page.evaluate(() => window.__trace.commitFloating());
await page.waitForTimeout(150);

const inkOrigFrame0 = await inkInRect(layerC, 0, origRect);
const inkOrigFrame5 = await inkInRect(layerC, 5, origRect);
const inkDestFrame0 = await inkInRect(layerC, 0, destRect);
const inkDestFrame5 = await inkInRect(layerC, 5, destRect);
check(
  'tras el lote, la región de origen queda sin tinta en ambos cels',
  inkOrigFrame0 === 0 && inkOrigFrame5 === 0,
  `f0=${inkOrigFrame0} f5=${inkOrigFrame5}`,
);
check(
  'la tinta aparece en la región de destino en ambos cels',
  inkDestFrame0 > 0 && inkDestFrame5 > 0,
  `f0=${inkDestFrame0} f5=${inkDestFrame5}`,
);

const reload4 = await saveAndReload();
// La racha persistida son sólo los últimos 2 pasos con `op`: el trazo del
// cuadro 5 y el lote — `addCel` (para crear el cuadro 5) no lleva `op`, así
// que corta la cadena justo debajo y el trazo del cuadro 0 se queda fuera.
check('la racha persistida cubre el trazo del cuadro 5 y el lote (2 pasos)', reload4.opsRestored === 2, JSON.stringify(reload4));
check('el historial queda deshacible tras recargar', reload4.canUndo === true, JSON.stringify(reload4));

await page.evaluate(() => window.__trace.history.undo());
await page.waitForTimeout(150);
const inkRestoredFrame0 = await inkInRect(layerC, 0, origRect);
const inkRestoredFrame5 = await inkInRect(layerC, 5, origRect);
check(
  'deshacer tras recargar devuelve la tinta a la región de origen en los DOS cuadros a la vez',
  inkRestoredFrame0 > 0 && inkRestoredFrame5 > 0,
  `f0=${inkRestoredFrame0} f5=${inkRestoredFrame5}`,
);

await page.screenshot({ path: `${out}/history-persist-01-final.png` });

console.log('\n— Consola —');
check('sin errores en consola', errors.length === 0, errors.join(' | '));

console.log(`\n${failures === 0 ? 'TODO EN VERDE' : `${failures} FALLOS`}\n`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
