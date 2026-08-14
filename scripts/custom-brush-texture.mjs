import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

let failures = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? '  ok  ' : ' FALLA'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
};

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || undefined,
  args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });

const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

await page.goto('http://127.0.0.1:5173/', { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);

const box = await page.locator('.canvas-surface').boundingBox();
const cx = box.x + box.width / 2;
const cy = box.y + box.height / 2;

async function stroke(points) {
  await page.mouse.move(points[0][0], points[0][1]);
  await page.mouse.down();
  for (const [x, y] of points.slice(1)) await page.mouse.move(x, y, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(150);
}

/** Cuenta de píxeles con alfa > umbral dentro de un rectángulo del cel activo
 *  — ver CLAUDE.md "Trampas conocidas": lee del cel, no de una captura del
 *  lienzo interactivo. */
async function inkCountInDocRect(rectDoc) {
  return page.evaluate(({ r }) => {
    const e = window.__trace;
    const layer = e.activeLayer;
    const cel = [...layer.cels.values()][0];
    if (!cel) return 0;
    const px = e.renderer.readRect(cel.surface, r);
    let n = 0;
    for (let i = 3; i < px.length; i += 4) if (px[i] > 40) n++;
    return n;
  }, { r: rectDoc });
}

console.log('\n— Selecciona el pincel y abre el panel —');
await page.evaluate(() => {
  const s = window.__uiStore.getState();
  s.setTool('brush');
  s.setPanel('brush');
  // Punta lisa, tamaño grande y fijo, sin afinado de extremos: con `taper`
  // por defecto (0.3 en el preset inicial) un trazo casi puntual cae entero
  // en la zona de afinado y la estampa sale mucho más pequeña que `size`
  // (ver `taperScale` en brush.ts) — sin dinámicas que compliquen leer el
  // resultado, el trazo entero cae dentro del cuadro de la textura.
  s.updateBrush({
    textureId: null,
    size: 120,
    opacity: 1,
    flow: 1,
    hardness: 1,
    taper: 0,
    pressureSize: 0,
    pressureOpacity: 0,
    spacing: 0.1,
    scatter: 0,
  });
});

console.log('\n— Importa la textura de tablero de ajedrez —');
const checkerBuffer = readFileSync('/tmp/test-checker.png');
const fileInput = page.locator('.panel input[type="file"]');
await fileInput.setInputFiles({ name: 'checker.png', mimeType: 'image/png', buffer: checkerBuffer });
await page.waitForTimeout(300);

const swatchCount = await page.locator('.texture-grid .pose-cell').count();
check('aparece una miniatura de textura personalizada', swatchCount === 1, `${swatchCount}`);
const label = await page.locator('.texture-grid .pose-cell .brush-chip span').last().textContent();
check('la etiqueta viene del nombre de archivo sin extensión', label === 'checker', label ?? '');

const selectedAfterImport = await page.evaluate(() => {
  const s = window.__uiStore.getState();
  return s.brushes[s.brushIndex].textureId;
});
const customId = selectedAfterImport;
check('importar deja la textura seleccionada en el pincel activo', typeof customId === 'string' && customId.length > 0, String(customId));

console.log('\n— Un trazo con la textura deja huecos de tablero; uno liso, no —');
// Dos puntos separados en vez de deshacer entre medias: así la comparación
// no depende de qué borre exactamente `history.undo()` sobre el cel recién
// creado, que no es lo que este test quiere verificar.
const smoothScreen = { x: cx - 220, y: cy };
const texturedScreen = { x: cx + 220, y: cy };
const totalPx = 90 * 90;
const rectAround = async (screenPoint) => {
  const p = await page.evaluate((sp) => window.__trace.screenToDoc(sp), {
    x: screenPoint.x - box.x,
    y: screenPoint.y - box.y,
  });
  return { x: p.x - 45, y: p.y - 45, x2: p.x + 45, y2: p.y + 45 };
};

await page.evaluate(() => window.__uiStore.getState().updateBrush({ textureId: null }));
await stroke([[smoothScreen.x, smoothScreen.y], [smoothScreen.x + 2, smoothScreen.y]]);
const inkSmooth = await inkCountInDocRect(await rectAround(smoothScreen));
check(
  'una estampa lisa cubre casi todo el cuadro (sin huecos)',
  inkSmooth > totalPx * 0.85,
  `${inkSmooth}/${totalPx}px con tinta`,
);

await page.evaluate((id) => window.__uiStore.getState().updateBrush({ textureId: id }), customId);
await stroke([[texturedScreen.x, texturedScreen.y], [texturedScreen.x + 2, texturedScreen.y]]);
const inkTextured = await inkCountInDocRect(await rectAround(texturedScreen));
check(
  'la misma estampa con la textura importada deja bastante del cuadro sin tinta (huecos del tablero)',
  inkTextured > 0 && inkTextured < totalPx * 0.7,
  `${inkTextured}/${totalPx}px con tinta`,
);

console.log('\n— Guardar y reabrir conserva la textura importada —');
const roundTrip = await page.evaluate(async (id) => {
  const e = window.__trace;
  const mod = await import('/src/core/io.ts');
  const bytes = await mod.serializeProject(e);
  const { doc } = await mod.deserializeProject(e, bytes);
  const tex = doc.customTextures.find((t) => t.id === id);
  const alphas = new Set();
  if (tex) for (let i = 3; i < tex.pixels.length; i += 4 * 37) alphas.add(tex.pixels[i]);
  return { size: bytes.length, found: !!tex, label: tex?.label, distinctAlphas: alphas.size };
}, customId);
check('el proyecto serializado tiene contenido', roundTrip.size > 0, `${roundTrip.size} bytes`);
check('la textura personalizada sobrevive con su id y etiqueta', roundTrip.found && roundTrip.label === 'checker', JSON.stringify(roundTrip));
check('el patrón de alfa (no plano) sobrevive el viaje de ida y vuelta', roundTrip.distinctAlphas > 1, `${roundTrip.distinctAlphas} valores distintos`);

console.log('\n— Quitar la textura no rompe el siguiente trazo —');
await page.locator('.texture-grid .pose-cell .pose-cell__remove').click();
await page.waitForTimeout(200);
const swatchCountAfterRemove = await page.locator('.texture-grid .pose-cell').count();
check('la miniatura desaparece del selector', swatchCountAfterRemove === 0, `${swatchCountAfterRemove}`);
const textureIdAfterRemove = await page.evaluate(() => {
  const s = window.__uiStore.getState();
  return s.brushes[s.brushIndex].textureId;
});
check('el pincel activo vuelve a "Lisa" al quitar su textura', textureIdAfterRemove === null, String(textureIdAfterRemove));

const farScreen = { x: cx - 200, y: cy - 200 };
const farDoc = await page.evaluate((p) => window.__trace.screenToDoc(p), { x: farScreen.x - box.x, y: farScreen.y - box.y });
await stroke([[farScreen.x, farScreen.y], [farScreen.x + 5, farScreen.y]]);
const inkAfterRemove = await inkCountInDocRect({ x: farDoc.x - 45, y: farDoc.y - 45, x2: farDoc.x + 45, y2: farDoc.y + 45 });
check('sigue pudiendo dibujarse después de quitar la textura', inkAfterRemove > 0, `${inkAfterRemove}px`);

console.log('\n— Consola —');
check('sin errores en consola', errors.length === 0, errors.join(' | '));

console.log(`\n${failures === 0 ? 'TODO EN VERDE' : `${failures} FALLOS`}\n`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
