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

/** Trazo recto en espacio DOCUMENTO, por la API del motor directamente —
 *  igual que `scripts/taper.mjs`: el color y el tamaño no dependen de la
 *  UI, y las coordenadas no dependen de dónde cae el lienzo en pantalla. */
const drawLine = ([x0, y0], [x1, y1], color, size = 36, steps = 40) =>
  page.evaluate(
    ({ x0, y0, x1, y1, color, size, steps }) => {
      const e = window.__trace;
      const base = window.__uiStore.getState().brushes.find((b) => b.id === 'ink');
      const brush = {
        ...base,
        size,
        spacing: 0.08,
        hardness: 1,
        pressureSize: 0,
        pressureOpacity: 0,
        velocitySize: 0,
        jitterSize: 0,
        scatter: 0,
        followDirection: false,
        erase: false,
        taper: 0,
      };
      const ctx = { brush, color };
      const samples = [];
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        samples.push({
          x: x0 + (x1 - x0) * t,
          y: y0 + (y1 - y0) * t,
          pressure: 1,
          altitude: Math.PI / 2,
          azimuth: 0,
          time: i * 8,
        });
      }
      e.beginStroke(samples[0], ctx);
      e.moveStroke(samples.slice(1));
      e.endStroke();
    },
    { x0, y0, x1, y1, color, size, steps },
  );

const celInkCount = (rect, channel = 3, threshold = 10) =>
  page.evaluate(
    ({ rect, channel, threshold }) => {
      const e = window.__trace;
      const cel = [...e.activeLayer.cels.values()][0];
      if (!cel) return 0;
      const px = e.renderer.readRect(cel.surface, rect);
      let n = 0;
      for (let i = channel; i < px.length; i += 4) if (px[i] > threshold) n++;
      return n;
    },
    { rect, channel, threshold },
  );

const setAlphaLock = (value) =>
  page.evaluate((value) => {
    const e = window.__trace;
    e.setLayerProp(e.activeLayer.id, 'alphaLock', value, 'Bloqueo de alfa');
  }, value);

const selectRect = (r, mode = 'replace') =>
  page.evaluate(
    ({ r, mode }) => {
      const e = window.__trace;
      e.beginSelectionDrag();
      e.applySelectionShape('rect', [{ x: r.x, y: r.y }, { x: r.x2, y: r.y2 }], mode);
    },
    { r, mode },
  );

const fillBlock = async (r, color) => {
  await selectRect(r);
  await page.evaluate((c) => window.__trace.fillSelection(c), color);
  await page.waitForTimeout(100);
  await page.evaluate(() => window.__trace.clearSelection());
  await page.waitForTimeout(100);
};

/* ------------------------------------------------------------------ *
 * Tres bloques sólidos e independientes (doc 1920×1080 por defecto),
 * cada uno para una sub-prueba distinta — así ningún color de una prueba
 * contamina la lectura de la siguiente.
 * ------------------------------------------------------------------ */
const strokeBlock = { x: 150, y: 150, x2: 450, y2: 450 };
const fillToolBlock = { x: 700, y: 150, x2: 1000, y2: 450 };
const selectionBlock = { x: 1250, y: 150, x2: 1550, y2: 450 };

console.log('\n— Preparar tres bloques sólidos de tinta —');
await fillBlock(strokeBlock, { r: 0, g: 0, b: 0 });
await fillBlock(fillToolBlock, { r: 0, g: 0, b: 0 });
await fillBlock(selectionBlock, { r: 0, g: 0, b: 0 });
const inkStroke = await celInkCount(strokeBlock);
const inkFill = await celInkCount(fillToolBlock);
const inkSel = await celInkCount(selectionBlock);
check('bloque del trazo tiene tinta', inkStroke > 80000, `${inkStroke} px`);
check('bloque del bote tiene tinta', inkFill > 80000, `${inkFill} px`);
check('bloque de selección tiene tinta', inkSel > 80000, `${inkSel} px`);

console.log('\n— Activar el bloqueo de alfa desde el panel de Capas —');
await page.evaluate(() => window.__uiStore.getState().setPanel('layers'));
await page.waitForTimeout(200);
const alphaBtn = page.locator('.layer.is-active .layer__toggle[aria-label="Bloquear alfa"]');
check('aparece el botón de bloqueo de alfa', (await alphaBtn.count()) === 1);
await alphaBtn.click();
await page.waitForTimeout(100);
const locked = await page.evaluate(() => window.__trace.activeLayer.alphaLock);
check('la capa activa queda con alphaLock activado', locked === true);
const pressedCount = await page.locator('.layer.is-active .layer__toggle.is-on').count();
check('el botón se marca como activo', pressedCount >= 1, `${pressedCount}`);
await page.evaluate(() => window.__uiStore.getState().setPanel(null));
await page.waitForTimeout(150);

console.log('\n— Un trazo que cruza el borde del bloque sólo pinta dentro —');
const midY = (strokeBlock.y + strokeBlock.y2) / 2;
await drawLine([strokeBlock.x - 250, midY], [strokeBlock.x2 + 250, midY], { r: 1, g: 0, b: 0 });
const outsideStrokeRect = { x: 500, y: 700, x2: 900, y2: 900 };
const inkOutsideAfter = await celInkCount(outsideStrokeRect);
check(
  'con bloqueo de alfa, el trazo no deja tinta fuera del contorno existente',
  inkOutsideAfter === 0,
  `${inkOutsideAfter} px`,
);
const redInside = await celInkCount(strokeBlock, 0, 150);
check('pero sí repintó de rojo dentro del contorno', redInside > 5000, `${redInside} px`);
await page.screenshot({ path: `${out}/alpha-lock-01-trazo.png` });

console.log('\n— Desactivar el bloqueo deja pintar fuera otra vez —');
await setAlphaLock(false);
const farRect = { x: 100, y: 700, x2: 300, y2: 900 };
await drawLine([150, 800], [250, 850], { r: 0, g: 0.6, b: 1 });
const inkFar = await celInkCount(farRect);
check('sin bloqueo, el trazo sí pinta lejos del bloque', inkFar > 100, `${inkFar} px`);

console.log('\n— El bote de pintura respeta el bloqueo de alfa —');
await setAlphaLock(true);
const blankPoint = { x: 1700, y: 150 };
await page.evaluate((p) => window.__trace.floodFill(p, { r: 0, g: 1, b: 0 }, 0.15, 2), blankPoint);
await page.waitForTimeout(150);
const blankRect = { x: blankPoint.x - 40, y: blankPoint.y - 40, x2: blankPoint.x + 40, y2: blankPoint.y + 40 };
const inkAtBlankFill = await celInkCount(blankRect);
check('con bloqueo de alfa, el bote no rellena un área sin tinta', inkAtBlankFill === 0, `${inkAtBlankFill} px`);

const fillToolCenter = {
  x: (fillToolBlock.x + fillToolBlock.x2) / 2,
  y: (fillToolBlock.y + fillToolBlock.y2) / 2,
};
await page.evaluate((p) => window.__trace.floodFill(p, { r: 0, g: 1, b: 0 }, 0.5, 2), fillToolCenter);
await page.waitForTimeout(150);
const greenInside = await celInkCount(fillToolBlock, 1, 150);
check('pero sí recolorea de verde la tinta existente', greenInside > 50000, `${greenInside} px`);
await page.screenshot({ path: `${out}/alpha-lock-02-bote.png` });

console.log('\n— Combinado con una selección activa —');
// Selección que cubre la mitad derecha del bloque más una franja vacía a
// su derecha — rellenar con bloqueo de alfa sólo debe teñir la mitad de
// DENTRO del bloque, nunca la franja vacía de la selección.
const selRect = {
  x: (selectionBlock.x + selectionBlock.x2) / 2,
  y: selectionBlock.y - 30,
  x2: selectionBlock.x2 + 200,
  y2: selectionBlock.y2 + 30,
};
await selectRect(selRect);
await page.evaluate(() => window.__trace.fillSelection({ r: 1, g: 1, b: 0 }));
await page.waitForTimeout(150);
const yellowInBlockHalf = await celInkCount(
  { x: selRect.x, y: selectionBlock.y, x2: selectionBlock.x2, y2: selectionBlock.y2 },
  0,
  150,
);
const inkPastBlock = await celInkCount(
  { x: selectionBlock.x2 + 10, y: selectionBlock.y, x2: selRect.x2, y2: selectionBlock.y2 },
  3,
  10,
);
check(
  'el relleno con selección + bloqueo tiñe la tinta ya existente',
  yellowInBlockHalf > 40000,
  `${yellowInBlockHalf} px`,
);
check(
  'pero no se sale del bloque hacia la franja vacía de la selección',
  inkPastBlock === 0,
  `${inkPastBlock} px`,
);
await page.evaluate(() => window.__trace.clearSelection());

console.log('\n— Deshacer no deja la app en un estado roto —');
for (let i = 0; i < 3; i++) await page.evaluate(() => window.__trace.history.undo());
await page.waitForTimeout(150);

console.log('\n— Consola —');
check('sin errores en consola', errors.length === 0, errors.join(' | '));

console.log(`\n${failures === 0 ? 'TODO EN VERDE' : `${failures} FALLOS`}\n`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
