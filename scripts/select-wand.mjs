import { chromium } from 'playwright';

const out = process.env.SHOT_DIR || 'shots';

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || undefined,
  args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });

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

/** Escribe un rectángulo de color sólido directo en el cel activo. */
const writeRect = ({ x0, y0, x1, y1, r, g, b }) =>
  page.evaluate(
    ({ x0, y0, x1, y1, r, g, b }) => {
      const e = window.__trace;
      const layer = e.activeLayer;
      if (layer.cels.size === 0) e.addCel(layer.id, e.currentFrame, false);
      const cel = [...layer.cels.values()][0];
      const w = x1 - x0;
      const h = y1 - y0;
      const rect = { x: x0, y: y0, x2: x1, y2: y1 };
      const px = new Uint8Array(w * h * 4);
      for (let i = 0; i < w * h; i++) {
        px[i * 4] = r;
        px[i * 4 + 1] = g;
        px[i * 4 + 2] = b;
        px[i * 4 + 3] = 255;
      }
      e.renderer.writeRect(cel.surface, rect, px);
      e.touch();
    },
    { x0, y0, x1, y1, r, g, b },
  );

const screenPointFor = (docPoint) => page.evaluate((p) => window.__trace.docToScreen(p), docPoint);

console.log('\n— Dos cuadrados de rojos parecidos, uno lejos —');
// Rojo puro (100,100)-(300,300), rojo-naranja apenas distinto pegado a la
// derecha (300,100)-(500,300), y un cuadrado verde bien lejos, sin tocar
// ninguno de los dos — para probar "añadir" a una selección sin conectar.
await writeRect({ x0: 100, y0: 100, x1: 300, y1: 300, r: 220, g: 60, b: 60 });
await writeRect({ x0: 300, y0: 100, x1: 500, y1: 300, r: 220, g: 120, b: 60 });
await writeRect({ x0: 700, y0: 500, x1: 850, y1: 650, r: 60, g: 180, b: 90 });
await page.waitForTimeout(150);

await page.getByTitle('Varita mágica').click();
await page.waitForTimeout(200);

const box = await page.locator('.canvas-surface').boundingBox();
const p1 = await screenPointFor({ x: 200, y: 200 });

console.log('\n— Tocar selecciona sólo el rojo puro, con la tolerancia por defecto —');
await page.mouse.move(box.x + p1.x, box.y + p1.y);
await page.mouse.down();
await page.waitForTimeout(150);
await page.mouse.up();
await page.waitForTimeout(150);
const tapOnly = await page.evaluate(() => ({
  active: window.__trace.selection.active,
  bounds: window.__trace.selection.bounds,
}));
check(
  'selecciona exactamente el cuadrado rojo puro',
  tapOnly.active &&
    tapOnly.bounds.x === 100 &&
    tapOnly.bounds.y === 100 &&
    tapOnly.bounds.x2 === 300 &&
    tapOnly.bounds.y2 === 300,
  JSON.stringify(tapOnly.bounds),
);
await page.screenshot({ path: `${out}/wand-01-tap.png` });

console.log('\n— Arrastrar a la derecha sube la tolerancia y crece la selección —');
await page.mouse.move(box.x + p1.x, box.y + p1.y);
await page.mouse.down();
await page.waitForTimeout(100);
await page.mouse.move(box.x + p1.x + 90, box.y + p1.y, { steps: 6 });
await page.waitForTimeout(150);
const toleranceMidDrag = await page.evaluate(() => window.__trace.pendingWand?.tolerance ?? null);
check('la tolerancia sube arrastrando a la derecha', toleranceMidDrag !== null && toleranceMidDrag > 0.15, `${toleranceMidDrag}`);
const busyText = await page.locator('.busy').innerText().catch(() => '');
check('el HUD muestra el porcentaje mientras se arrastra', /Tolerancia/.test(busyText), busyText);

await page.mouse.up();
await page.waitForTimeout(150);
const afterDrag = await page.evaluate(() => window.__trace.selection.bounds);
check(
  'con más tolerancia la selección crece hasta cubrir también el rojo-naranja',
  afterDrag.x === 100 && afterDrag.x2 === 500,
  JSON.stringify(afterDrag),
);
check('el HUD se apaga al soltar', (await page.locator('.busy').count()) === 0);
await page.screenshot({ path: `${out}/wand-02-tolerancia.png` });

console.log('\n— La tolerancia se recuerda para el próximo toque —');
const rememberedTolerance = await page.evaluate(() => window.__uiStore.getState().wandTolerance);
check('el store guarda la tolerancia con la que se soltó', rememberedTolerance > 0.15, `${rememberedTolerance}`);

console.log('\n— "Añadir a la selección" con un toque en una zona sin conectar —');
await page.getByTitle('Añadir a la selección').click();
await page.waitForTimeout(150);
const p2 = await screenPointFor({ x: 775, y: 575 });
await page.mouse.move(box.x + p2.x, box.y + p2.y);
await page.mouse.down();
await page.waitForTimeout(150);
await page.mouse.up();
await page.waitForTimeout(150);
const afterAdd = await page.evaluate(() => window.__trace.selection.bounds);
check(
  'la selección ahora envuelve las dos zonas (unión de límites)',
  afterAdd.x === 100 && afterAdd.y === 100 && afterAdd.x2 === 850 && afterAdd.y2 === 650,
  JSON.stringify(afterAdd),
);
await page.screenshot({ path: `${out}/wand-03-anadir.png` });

console.log('\n— "Restar de la selección" quita el trozo verde —');
await page.getByTitle('Restar de la selección').click();
await page.waitForTimeout(150);
await page.mouse.move(box.x + p2.x, box.y + p2.y);
await page.mouse.down();
await page.waitForTimeout(150);
await page.mouse.up();
await page.waitForTimeout(150);
const afterSubtract = await page.evaluate(() => {
  const e = window.__trace;
  // Comprueba directamente si el punto que era verde sigue dentro de la
  // máscara, no sólo el rectángulo envolvente (que no se encoge solo).
  const px = e.renderer.readRect(e.selectionMask, { x: 775, y: 575, x2: 776, y2: 576 });
  return { greenStillSelected: px[3] > 40, active: e.selection.active };
});
check('el verde ya no está en la máscara de selección', !afterSubtract.greenStillSelected);

console.log('\n— Un toque suelto sobre el papel en blanco selecciona esa región —');
await page.getByTitle('Selección nueva').click();
await page.waitForTimeout(150);
const p3 = await screenPointFor({ x: 900, y: 900 });
await page.mouse.move(box.x + p3.x, box.y + p3.y);
await page.mouse.down();
await page.waitForTimeout(150);
await page.mouse.up();
await page.waitForTimeout(150);
const paperSelection = await page.evaluate(() => ({
  active: window.__trace.selection.active,
  count: (() => {
    const e = window.__trace;
    const px = e.renderer.readRect(e.selectionMask, { x: 0, y: 0, x2: e.doc.width, y2: e.doc.height });
    let n = 0;
    for (let i = 3; i < px.length; i += 4) if (px[i] > 40) n++;
    return n;
  })(),
}));
check(
  'seleccionar el papel en blanco cubre una región grande',
  paperSelection.active && paperSelection.count > 500000,
  `${paperSelection.count} px`,
);

console.log('\n— Consola —');
check('sin errores en consola', errors.length === 0, errors.join(' | '));

console.log(`\n${failures === 0 ? 'TODO EN VERDE' : `${failures} FALLOS`}\n`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
