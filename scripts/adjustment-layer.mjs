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

/** Color medio del fotograma COMPUESTO en un rectángulo — mismo camino
 *  determinista que exportar (ver la nota de `preserveDrawingBuffer` en
 *  CLAUDE.md), no una captura del lienzo interactivo. */
const avgColor = (rect) =>
  page.evaluate(
    (rect) => {
      const e = window.__trace;
      const data = e.renderFrameToImageData(e.currentFrame);
      let r = 0, g = 0, b = 0, n = 0;
      for (let y = rect.y; y < rect.y2; y++) {
        for (let x = rect.x; x < rect.x2; x++) {
          const i = (y * data.width + x) * 4;
          r += data.data[i];
          g += data.data[i + 1];
          b += data.data[i + 2];
          n++;
        }
      }
      return { r: r / n, g: g / n, b: b / n };
    },
    rect,
  );

const selectRect = (r, mode = 'replace') =>
  page.evaluate(
    ({ r, mode }) => {
      const e = window.__trace;
      e.beginSelectionDrag();
      e.applySelectionShape('rect', [{ x: r.x, y: r.y }, { x: r.x2, y: r.y2 }], mode);
    },
    { r, mode },
  );

/* ------------------------------------------------------------------ */

console.log('\n— Preparar: un bloque rojo sólido —');
const block = { x: 700, y: 300, x2: 1000, y2: 600 };
await selectRect(block);
await page.evaluate(() => window.__trace.fillSelection({ r: 1, g: 0, b: 0 }));
await page.waitForTimeout(150);
await page.evaluate(() => window.__trace.clearSelection());
await page.waitForTimeout(150);

const before = await avgColor(block);
check('el bloque es rojo antes de cualquier ajuste', before.r > 200 && before.g < 60 && before.b < 60, JSON.stringify(before));

console.log('\n— Crear una capa de ajuste desde el panel de Capas —');
await page.evaluate(() => window.__uiStore.getState().setPanel('layers'));
await page.waitForTimeout(200);
const layersBefore = await page.evaluate(() => window.__trace.doc.layers.length);
const adjBtn = page.locator('.panel__actions .action[aria-label="Añadir capa de ajuste"]');
check('aparece el botón de añadir capa de ajuste', (await adjBtn.count()) === 1);
await adjBtn.click();
await page.waitForTimeout(200);
const layersAfter = await page.evaluate(() => window.__trace.doc.layers.length);
check('se añade una capa nueva', layersAfter === layersBefore + 1, `${layersBefore} -> ${layersAfter}`);
const activeLayer = await page.evaluate(() => window.__trace.activeLayer);
check('la capa activa es de ajuste', activeLayer.kind === 'adjustment', JSON.stringify(activeLayer.adjustment));

const afterCreate = await avgColor(block);
check(
  'una capa de ajuste recién creada (valores en 0) no cambia nada',
  Math.abs(afterCreate.r - before.r) < 3 && Math.abs(afterCreate.g - before.g) < 3 && Math.abs(afterCreate.b - before.b) < 3,
  `${JSON.stringify(before)} -> ${JSON.stringify(afterCreate)}`,
);

console.log('\n— La casilla de alfa y de máscara no aparecen para una capa de ajuste —');
const alphaBtnCount = await page.locator('.layer.is-active .layer__toggle[aria-label="Bloquear alfa"]').count();
const maskBtnCount = await page.locator('.layer.is-active .layer__toggle[aria-label="Añadir máscara"]').count();
check('sin botón de bloqueo de alfa', alphaBtnCount === 0);
check('sin botón de máscara', maskBtnCount === 0);

console.log('\n— El panel de ajuste aparece con la capa activa —');
check('aparece el bloque de "Ajuste"', (await page.locator('h3.panel__subtitle', { hasText: 'Ajuste' }).count()) === 1);

console.log('\n— Saturación en -100% deja el bloque en gris —');
await page.evaluate(() => window.__trace.setLayerAdjustment(window.__trace.activeLayerId, { saturation: -1 }));
await page.waitForTimeout(150);
const gray = await avgColor(block);
const spread = Math.max(gray.r, gray.g, gray.b) - Math.min(gray.r, gray.g, gray.b);
check('los tres canales quedan casi iguales (gris)', spread < 15, JSON.stringify(gray));
await page.screenshot({ path: `${out}/adjustment-01-gris.png` });

console.log('\n— Tono desplaza el color (rojo -> otro color) —');
await page.evaluate(() =>
  window.__trace.setLayerAdjustment(window.__trace.activeLayerId, { saturation: 0, hue: Math.PI }),
);
await page.waitForTimeout(150);
const shifted = await avgColor(block);
check(
  'un giro de tono de 180° dado a rojo puro ya no es predominantemente rojo',
  shifted.r < before.r - 50,
  JSON.stringify(shifted),
);

console.log('\n— Brillo empuja el color hacia blanco —');
await page.evaluate(() =>
  window.__trace.setLayerAdjustment(window.__trace.activeLayerId, { hue: 0, saturation: 0, brightness: 1 }),
);
await page.waitForTimeout(150);
const bright = await avgColor(block);
check('con brillo al máximo el bloque se acerca a blanco', bright.g > 200 && bright.b > 200, JSON.stringify(bright));

console.log('\n— Volver todo a 0 restaura el rojo original —');
await page.evaluate(() =>
  window.__trace.setLayerAdjustment(window.__trace.activeLayerId, { hue: 0, saturation: 0, brightness: 0, contrast: 0 }),
);
await page.waitForTimeout(150);
const restored = await avgColor(block);
check(
  'con todos los valores en 0, vuelve a ser el rojo original',
  Math.abs(restored.r - before.r) < 5 && Math.abs(restored.g - before.g) < 5,
  JSON.stringify(restored),
);

console.log('\n— La opacidad de la capa de ajuste mezcla el efecto —');
// La desaturación en HSV de un rojo puro (S=1, V=1) da blanco, no un gris a
// medias — correcto matemáticamente, aunque el nombre "gris" del bloque de
// arriba fuera sólo una forma de hablar. Lo que importa aquí es que la
// opacidad quede a medio camino entre ROJO (spread alto) y ese blanco
// (spread ~0), no comparar contra un spread capturado en otro momento.
await page.evaluate(() => window.__trace.setLayerAdjustment(window.__trace.activeLayerId, { saturation: -1 }));
await page.evaluate(() => window.__trace.setLayerPropLive(window.__trace.activeLayerId, 'opacity', 1));
await page.waitForTimeout(150);
const fullyDesaturated = await avgColor(block);
const fullSpread = Math.max(fullyDesaturated.r, fullyDesaturated.g, fullyDesaturated.b) - Math.min(fullyDesaturated.r, fullyDesaturated.g, fullyDesaturated.b);
const redSpread = before.r - before.g;

await page.evaluate(() => window.__trace.setLayerPropLive(window.__trace.activeLayerId, 'opacity', 0.5));
await page.waitForTimeout(150);
const halfGray = await avgColor(block);
const halfSpread = Math.max(halfGray.r, halfGray.g, halfGray.b) - Math.min(halfGray.r, halfGray.g, halfGray.b);
check(
  'al 50% de opacidad el efecto queda a medio camino (ni tan rojo, ni tan blanco)',
  halfSpread > fullSpread + 15 && halfSpread < redSpread - 15,
  `${halfSpread} (rojo puro ~${redSpread}, ajuste al 100% ~${fullSpread})`,
);
await page.evaluate(() => window.__trace.setLayerPropLive(window.__trace.activeLayerId, 'opacity', 1));
await page.evaluate(() => window.__trace.setLayerAdjustment(window.__trace.activeLayerId, { saturation: 0 }));
await page.waitForTimeout(150);

console.log('\n— Deshacer quita la capa de ajuste —');
await page.evaluate(() => window.__uiStore.getState().setPanel(null));
await page.waitForTimeout(150);
await page.evaluate(() => window.__trace.history.undo());
await page.waitForTimeout(150);
const layersAfterUndo = await page.evaluate(() => window.__trace.doc.layers.length);
check('deshacer quita la capa de ajuste', layersAfterUndo === layersBefore, `${layersAfterUndo}`);
const afterUndo = await avgColor(block);
check('sin la capa de ajuste, el bloque vuelve a su rojo original', Math.abs(afterUndo.r - before.r) < 5, JSON.stringify(afterUndo));

console.log('\n— Rehacer trae la capa de ajuste de vuelta —');
await page.evaluate(() => window.__trace.history.redo());
await page.waitForTimeout(150);
const layersAfterRedo = await page.evaluate(() => window.__trace.doc.layers.length);
check('rehacer trae la capa de vuelta', layersAfterRedo === layersBefore + 1, `${layersAfterRedo}`);

console.log('\n— Guardar y reabrir conserva la capa de ajuste —');
const roundTrip = await page.evaluate(async () => {
  const e = window.__trace;
  const { serializeProject, deserializeProject } = await import('/src/core/io.ts');
  const bytes = await serializeProject(e);
  const doc = await deserializeProject(e, bytes);
  return doc.layers.filter((l) => l.kind === 'adjustment').map((l) => l.adjustment);
});
check('la capa de ajuste sobrevive guardar/reabrir', roundTrip.length === 1, JSON.stringify(roundTrip));

console.log('\n— Consola —');
check('sin errores en consola', errors.length === 0, errors.join(' | '));

console.log(`\n${failures === 0 ? 'TODO EN VERDE' : `${failures} FALLOS`}\n`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
