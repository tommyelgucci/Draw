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

/** Trazo recto en espacio DOCUMENTO por la API del motor — mismo patrón
 *  que `scripts/alpha-lock.mjs`/`scripts/taper.mjs`. */
const drawLine = ([x0, y0], [x1, y1], color, { size = 36, erase = false, steps = 30 } = {}) =>
  page.evaluate(
    ({ x0, y0, x1, y1, color, size, erase, steps }) => {
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
        erase,
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
    { x0, y0, x1, y1, color, size, erase, steps },
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

/** Cuenta píxeles con color oscuro (tinta) en el fotograma COMPUESTO — el
 *  mismo camino determinista que usa exportar, no una captura de pantalla
 *  del lienzo interactivo (ver la nota de `preserveDrawingBuffer` en
 *  CLAUDE.md). Esto es lo que de verdad refleja el efecto de la máscara,
 *  al contrario que `celInkCount`, que lee la capa cruda sin máscara. */
const compositedInkCount = (rect, threshold = 200) =>
  page.evaluate(
    ({ rect, threshold }) => {
      const e = window.__trace;
      const data = e.renderFrameToImageData(e.currentFrame);
      let n = 0;
      for (let y = rect.y; y < rect.y2; y++) {
        for (let x = rect.x; x < rect.x2; x++) {
          const i = (y * data.width + x) * 4;
          // Papel blanco de fondo: cualquier canal claramente por debajo de
          // blanco es tinta, sea cual sea el color exacto.
          if (data.data[i] < threshold || data.data[i + 1] < threshold || data.data[i + 2] < threshold) n++;
        }
      }
      return n;
    },
    { rect, threshold },
  );

/* ------------------------------------------------------------------ */

console.log('\n— Preparar: un bloque sólido de tinta —');
const block = { x: 700, y: 300, x2: 1000, y2: 600 };
const selectRect = (r, mode = 'replace') =>
  page.evaluate(
    ({ r, mode }) => {
      const e = window.__trace;
      e.beginSelectionDrag();
      e.applySelectionShape('rect', [{ x: r.x, y: r.y }, { x: r.x2, y: r.y2 }], mode);
    },
    { r, mode },
  );
await selectRect(block);
await page.evaluate(() => window.__trace.fillSelection({ r: 0, g: 0, b: 0 }));
await page.waitForTimeout(150);
await page.evaluate(() => window.__trace.clearSelection());
await page.waitForTimeout(150);

const inkBefore = await celInkCount(block);
const compositedBefore = await compositedInkCount(block);
check('el bloque tiene tinta en el cel', inkBefore > 80000, `${inkBefore} px`);
check('el bloque se ve entero en el compuesto', compositedBefore > 80000, `${compositedBefore} px`);

console.log('\n— Añadir máscara desde el panel de Capas —');
await page.evaluate(() => window.__uiStore.getState().setPanel('layers'));
await page.waitForTimeout(200);
const maskBtn = page.locator('.layer.is-active .layer__toggle[aria-label="Añadir máscara"]');
check('aparece el botón de añadir máscara', (await maskBtn.count()) === 1);
await maskBtn.click();
await page.waitForTimeout(150);
const hasMask = await page.evaluate(() => !!window.__trace.activeLayer.mask);
check('la capa activa tiene máscara', hasMask === true);
const editingAfterAdd = await page.evaluate(() => window.__trace.editingMaskLayerId);
const activeId = await page.evaluate(() => window.__trace.activeLayerId);
check('añadir máscara entra directo en modo edición', editingAfterAdd === activeId);

const compositedWithBlankMask = await compositedInkCount(block);
check(
  'una máscara recién creada no cambia nada (blanco = revela todo)',
  compositedWithBlankMask === compositedBefore,
  `${compositedBefore} -> ${compositedWithBlankMask}`,
);

console.log('\n— El aviso de edición de máscara aparece —');
const banner = page.locator('.mask-edit-banner');
check('aparece el aviso flotante', (await banner.count()) === 1);
await page.evaluate(() => window.__uiStore.getState().setPanel(null));
await page.waitForTimeout(150);

console.log('\n— Borrar (erase) la mitad izquierda de la máscara la oculta —');
const midX = (block.x + block.x2) / 2;
// Varias pasadas horizontales con un pincel modesto en vez de una sola
// trazada con un pincel gigante: así la "tapa" redonda de cada extremo
// abulta unos pocos píxeles, no 160 — deja un corte casi recto en vez de
// morder media mitad derecha.
const eraseSize = 44;
let eraseStrokeCount = 0;
for (let y = block.y + eraseSize / 2; y < block.y2; y += eraseSize * 0.6) {
  await drawLine([block.x - 10, y], [midX + eraseSize / 2, y], { r: 0, g: 0, b: 0 }, {
    size: eraseSize,
    erase: true,
  });
  eraseStrokeCount++;
}
await page.waitForTimeout(150);

const bleed = eraseSize; // margen de seguridad a cada lado del corte
const leftHalf = { x: block.x, y: block.y, x2: midX - bleed, y2: block.y2 };
const rightHalf = { x: midX + bleed, y: block.y, x2: block.x2, y2: block.y2 };
const compositedLeftAfter = await compositedInkCount(leftHalf);
const compositedRightAfter = await compositedInkCount(rightHalf);
check(
  'la mitad borrada de la máscara desaparece en el compuesto',
  compositedLeftAfter < 500,
  `${compositedLeftAfter} px`,
);
check(
  'la mitad derecha, sin tocar, se sigue viendo',
  compositedRightAfter > 25000,
  `${compositedRightAfter} px`,
);

const celLeftAfter = await celInkCount(leftHalf);
check(
  'el cel real de la capa NO se tocó — la tinta sigue ahí debajo',
  celLeftAfter > 25000,
  `${celLeftAfter} px`,
);
await page.screenshot({ path: `${out}/layer-mask-01-oculto.png` });

console.log('\n— Terminar de editar la máscara —');
await page.evaluate(() => window.__trace.setEditingMaskLayer(null));
await page.waitForTimeout(150);
check('el aviso desaparece al terminar', (await page.locator('.mask-edit-banner').count()) === 0);
check(
  'sigue oculta la mitad izquierda aun sin estar editando la máscara',
  (await compositedInkCount(leftHalf)) < 500,
);

console.log('\n— Deshacer el trazo de la máscara revela otra vez —');
// Cada pasada del bucle de arriba es su propio trazo, con su propio paso
// de deshacer — hay que deshacerlos todos para volver al blanco original.
for (let i = 0; i < eraseStrokeCount; i++) {
  await page.evaluate(() => window.__trace.history.undo());
}
await page.waitForTimeout(150);
const compositedLeftUndo = await compositedInkCount(leftHalf);
check('deshacer el borrado de la máscara la restaura', compositedLeftUndo > 25000, `${compositedLeftUndo} px`);

console.log('\n— Guardar y reabrir conserva la máscara —');
await page.evaluate(() => window.__trace.setEditingMaskLayer(window.__trace.activeLayerId));
await drawLine([block.x - 10, (block.y + block.y2) / 2], [midX, (block.y + block.y2) / 2], { r: 0, g: 0, b: 0 }, {
  size: block.y2 - block.y + 20,
  erase: true,
});
await page.evaluate(() => window.__trace.setEditingMaskLayer(null));
await page.waitForTimeout(150);
const roundTrip = await page.evaluate(async () => {
  const e = window.__trace;
  const { serializeProject, deserializeProject } = await import('/src/core/io.ts');
  const bytes = await serializeProject(e);
  const doc = await deserializeProject(e, bytes);
  return doc.layers.map((l) => !!l.mask);
});
check('la máscara sobrevive guardar/reabrir', roundTrip.some(Boolean), JSON.stringify(roundTrip));

console.log('\n— Redimensionar el lienzo conserva el agujero de la máscara —');
// Regresión: `applyCanvasSize` rellenaba el área nueva de blanco y luego
// volcaba encima el recorte antiguo con `drawImage` normal — como un
// agujero borrado tiene alfa 0, el blending por defecto lo "revelaba" otra
// vez en vez de conservar el 0 tal cual (arreglado con `putImageData`, que
// no compone, sólo copia los píxeles).
const resizeCheck = await page.evaluate(() => {
  const e = window.__trace;
  const before = e.renderer.readRect(e.activeLayer.mask.surface, { x: 748, y: 448, x2: 752, y2: 452 })[3];
  e.resizeCanvas(2400, 1400, 0, 0);
  const holeStillThere = e.renderer.readRect(e.activeLayer.mask.surface, { x: 748, y: 448, x2: 752, y2: 452 })[3];
  const grownAreaIsWhite = e.renderer.readRect(e.activeLayer.mask.surface, { x: 2000, y: 1000, x2: 2004, y2: 1004 })[3];
  e.history.undo();
  const afterUndo = e.renderer.readRect(e.activeLayer.mask.surface, { x: 748, y: 448, x2: 752, y2: 452 })[3];
  return { before, holeStillThere, grownAreaIsWhite, afterUndo, w: e.doc.width };
});
check('había un agujero borrado antes de redimensionar', resizeCheck.before === 0, `alfa ${resizeCheck.before}`);
check(
  'el agujero sigue ahí después de agrandar el lienzo',
  resizeCheck.holeStillThere === 0,
  `alfa ${resizeCheck.holeStillThere}`,
);
check(
  'el área nueva del lienzo empieza en blanco (revela)',
  resizeCheck.grownAreaIsWhite === 255,
  `alfa ${resizeCheck.grownAreaIsWhite}`,
);
check('deshacer el redimensionado restaura tamaño y agujero', resizeCheck.w === 1920 && resizeCheck.afterUndo === 0);

console.log('\n— Quitar la máscara desde el panel —');
await page.evaluate(() => window.__uiStore.getState().setPanel('layers'));
await page.waitForTimeout(200);
const removeBtn = page.locator('.layer.is-active .layer__toggle[aria-label="Quitar máscara"]');
check('aparece el botón de quitar máscara', (await removeBtn.count()) === 1);
await removeBtn.click();
await page.waitForTimeout(150);
const hasMaskAfterRemove = await page.evaluate(() => !!window.__trace.activeLayer.mask);
check('la máscara se quita', hasMaskAfterRemove === false);
const compositedAfterRemove = await compositedInkCount(leftHalf);
check(
  'sin máscara, la mitad izquierda vuelve a verse entera',
  compositedAfterRemove > 25000,
  `${compositedAfterRemove} px`,
);
await page.evaluate(() => window.__uiStore.getState().setPanel(null));
await page.waitForTimeout(150);

console.log('\n— Deshacer restaura la máscara quitada —');
await page.evaluate(() => window.__trace.history.undo());
await page.waitForTimeout(150);
const hasMaskAfterUndoRemove = await page.evaluate(() => !!window.__trace.activeLayer.mask);
check('deshacer "quitar máscara" la trae de vuelta', hasMaskAfterUndoRemove === true);

console.log('\n— Consola —');
check('sin errores en consola', errors.length === 0, errors.join(' | '));

console.log(`\n${failures === 0 ? 'TODO EN VERDE' : `${failures} FALLOS`}\n`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
