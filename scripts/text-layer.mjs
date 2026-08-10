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

/** Cuenta píxeles oscuros en el fotograma COMPUESTO — mismo camino
 *  determinista que exportar (ver la nota de `preserveDrawingBuffer` en
 *  CLAUDE.md), no una captura del lienzo interactivo. */
const compositedDarkCount = (rect, threshold = 200) =>
  page.evaluate(
    ({ rect, threshold }) => {
      const e = window.__trace;
      const data = e.renderFrameToImageData(e.currentFrame);
      let n = 0;
      for (let y = rect.y; y < rect.y2; y++) {
        for (let x = rect.x; x < rect.x2; x++) {
          const i = (y * data.width + x) * 4;
          if (data.data[i] < threshold || data.data[i + 1] < threshold || data.data[i + 2] < threshold) n++;
        }
      }
      return n;
    },
    { rect, threshold },
  );

/* ------------------------------------------------------------------ */

console.log('\n— Crear una capa de texto desde el panel de Capas —');
await page.evaluate(() => window.__uiStore.getState().setPanel('layers'));
await page.waitForTimeout(200);
const layersBefore = await page.evaluate(() => window.__trace.doc.layers.length);
const textBtn = page.locator('.panel__actions .action[aria-label="Añadir texto"]');
check('aparece el botón de añadir texto', (await textBtn.count()) === 1);
await textBtn.click();
await page.waitForTimeout(200);
const layersAfter = await page.evaluate(() => window.__trace.doc.layers.length);
check('se añade una capa nueva', layersAfter === layersBefore + 1, `${layersBefore} -> ${layersAfter}`);

const activeLayer = await page.evaluate(() => window.__trace.activeLayer);
check('la capa activa es de texto', !!activeLayer.text, JSON.stringify(activeLayer.text));
check('el texto por defecto dice "Texto"', activeLayer.text?.text === 'Texto');

const docCenter = await page.evaluate(() => ({
  x: window.__trace.doc.width / 2,
  y: window.__trace.doc.height / 2,
}));
const around = (p, half) => ({ x: p.x - half, y: p.y - half, x2: p.x + half, y2: p.y + half });
const inkAtCenter = await compositedDarkCount(around(docCenter, 120));
check('el texto por defecto deja tinta oscura en el centro del documento', inkAtCenter > 200, `${inkAtCenter} px`);
await page.screenshot({ path: `${out}/text-layer-01-creada.png` });

console.log('\n— El panel de edición de texto aparece con la capa activa —');
const contentField = page.locator('.text-layer__content');
check('aparece el campo de contenido', (await contentField.count()) === 1);
check('el campo muestra el texto actual', (await contentField.inputValue()) === 'Texto');

console.log('\n— Editar el contenido cambia lo que se ve —');
await contentField.fill('Hola');
await page.waitForTimeout(200);
const textAfterEdit = await page.evaluate(() => window.__trace.activeLayer.text.text);
check('el texto de la capa cambia al escribir', textAfterEdit === 'Hola', textAfterEdit);
const inkAfterEdit = await compositedDarkCount(around(docCenter, 120));
check('el compuesto refleja el nuevo texto (algo de tinta sigue)', inkAfterEdit > 100, `${inkAfterEdit} px`);

console.log('\n— Vaciar el texto no deja tinta —');
await contentField.fill('');
await page.waitForTimeout(200);
const inkEmpty = await compositedDarkCount(around(docCenter, 120));
check('sin texto, no hay tinta', inkEmpty === 0, `${inkEmpty} px`);
await contentField.fill('Trace');
await page.waitForTimeout(200);

console.log('\n— Tamaño, alineación, negrita/cursiva y color funcionan —');
await page.evaluate(() => window.__trace.setTextLayerProps(window.__trace.activeLayerId, { fontSize: 30 }));
await page.waitForTimeout(150);
const inkSmall = await compositedDarkCount(around(docCenter, 120));
await page.evaluate(() => window.__trace.setTextLayerProps(window.__trace.activeLayerId, { fontSize: 140 }));
await page.waitForTimeout(150);
const inkLarge = await compositedDarkCount(around(docCenter, 120));
check('un tamaño de letra mayor dentro de la misma zona deja más tinta', inkLarge > inkSmall, `${inkSmall} -> ${inkLarge}`);

const alignBtns = page.locator('.panel__section .segmented button');
check('aparecen los 3 botones de alineación', (await alignBtns.count()) === 3);
await alignBtns.nth(0).click();
await page.waitForTimeout(150);
const alignAfter = await page.evaluate(() => window.__trace.activeLayer.text.align);
check('el botón "Izq." pone align=left', alignAfter === 'left', alignAfter);

const boldCheck = page.locator('.panel__section label.check', { hasText: 'Negrita' }).locator('input');
await boldCheck.check();
await page.waitForTimeout(150);
const boldAfter = await page.evaluate(() => window.__trace.activeLayer.text.bold);
check('la casilla de negrita activa bold', boldAfter === true);

const italicCheck = page.locator('.panel__section label.check', { hasText: 'Cursiva' }).locator('input');
await italicCheck.check();
await page.waitForTimeout(150);
const italicAfter = await page.evaluate(() => window.__trace.activeLayer.text.italic);
check('la casilla de cursiva activa italic', italicAfter === true);

const colorInput = page.locator('.panel__section input[type="color"]');
await colorInput.fill('#ff0000');
await page.waitForTimeout(150);
const colorAfter = await page.evaluate(() => window.__trace.activeLayer.text.color);
check('el selector de color cambia el color del texto', colorAfter.r > 0.9 && colorAfter.g < 0.1, JSON.stringify(colorAfter));
await page.screenshot({ path: `${out}/text-layer-02-editado.png` });

console.log('\n— Mover la capa con Transformar la mueve como a cualquier otra —');
await page.evaluate(() => window.__uiStore.getState().setPanel(null));
await page.waitForTimeout(150);
const layerId = await page.evaluate(() => window.__trace.activeLayerId);
await page.evaluate((id) => window.__trace.setTransformValue(id, 'x', 300), layerId);
await page.waitForTimeout(150);
const movedTx = await page.evaluate(() => window.__trace.activeLayer.transform.x.keys.at(-1)?.value ?? window.__trace.activeLayer.transform.x.base);
check('la posición X de la capa cambió con el transform normal', movedTx === 300, movedTx);

console.log('\n— Deshacer quita la capa de texto —');
for (let i = 0; i < 20; i++) {
  const layers = await page.evaluate(() => window.__trace.doc.layers.length);
  if (layers <= layersBefore) break;
  await page.evaluate(() => window.__trace.history.undo());
  await page.waitForTimeout(80);
}
const layersAfterUndo = await page.evaluate(() => window.__trace.doc.layers.length);
check('deshacer todo vuelve al número de capas original', layersAfterUndo === layersBefore, `${layersAfterUndo}`);

console.log('\n— Rehacer trae la capa de texto de vuelta —');
await page.evaluate(() => window.__trace.history.redo());
await page.waitForTimeout(150);
const backAfterRedo = await page.evaluate(() => window.__trace.doc.layers.length);
check('rehacer trae la capa de vuelta', backAfterRedo === layersBefore + 1, `${backAfterRedo}`);

console.log('\n— Guardar y reabrir conserva el texto —');
const roundTrip = await page.evaluate(async () => {
  const e = window.__trace;
  const { serializeProject, deserializeProject } = await import('/src/core/io.ts');
  const bytes = await serializeProject(e);
  const doc = await deserializeProject(e, bytes);
  return doc.layers.map((l) => l.text ?? null).filter(Boolean);
});
check('la capa de texto sobrevive guardar/reabrir', roundTrip.length === 1, JSON.stringify(roundTrip));
check('conserva sus propiedades', roundTrip[0]?.bold === true && roundTrip[0]?.italic === true);

console.log('\n— Consola —');
check('sin errores en consola', errors.length === 0, errors.join(' | '));

console.log(`\n${failures === 0 ? 'TODO EN VERDE' : `${failures} FALLOS`}\n`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
