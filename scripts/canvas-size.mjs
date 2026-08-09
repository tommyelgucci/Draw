import { chromium } from 'playwright';

const out = process.env.SHOT_DIR || 'shots';

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || undefined,
  args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
});
// Un iPad de verdad: táctil y sin puntero, que es donde falló la primera vez.
const ctx = await browser.newContext({
  viewport: { width: 1180, height: 820 },
  deviceScaleFactor: 2,
  hasTouch: true,
});
const page = await ctx.newPage();

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

/** Píxeles con tinta en el cel activo, y su rectángulo envolvente. */
const inkInfo = () =>
  page.evaluate(() => {
    const e = window.__trace;
    const layer = e.activeLayer;
    const cel = layer && [...layer.cels.values()][0];
    if (!cel) return { count: 0 };
    const px = e.renderer.readRect(cel.surface, {
      x: 0,
      y: 0,
      x2: e.doc.width,
      y2: e.doc.height,
    });
    let count = 0;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let y = 0; y < e.doc.height; y++) {
      for (let x = 0; x < e.doc.width; x++) {
        if (px[(y * e.doc.width + x) * 4 + 3] > 40) {
          count++;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    return { count, minX, minY, maxX, maxY, w: e.doc.width, h: e.doc.height };
  });

console.log('\n— Controles visibles en tablet —');
await page.locator('.rail--top [aria-label="Capas"]').click();
await page.waitForTimeout(400);
for (const label of ['Nueva', 'Duplicar', 'Combinar', 'Eliminar']) {
  const n = await page.locator('.panel__actions .action', { hasText: label }).count();
  check(`la acción "${label}" muestra su nombre`, n === 1);
}
const toggles = await page.locator('.layer__toggle').count();
check('cada capa tiene ojo y candado visibles', toggles === 2, `${toggles} controles`);

console.log('\n— Duplicar, ocultar y bloquear funcionan —');
await page.locator('.panel__actions .action', { hasText: 'Duplicar' }).click();
await page.waitForTimeout(300);
const nLayers = await page.evaluate(() => window.__trace.doc.layers.length);
check('duplicar añade una capa', nLayers === 2, `${nLayers} capas`);

await page.locator('.layer__toggle').first().click();
await page.waitForTimeout(250);
const hidden = await page.evaluate(() => window.__trace.doc.layers.at(-1).visible === false);
check('el ojo oculta la capa', hidden);
const offMark = await page.locator('.layer__toggle.is-off').count();
check('la capa oculta se marca a la vista', offMark === 1);
await page.locator('.layer__toggle').first().click();
await page.waitForTimeout(250);

await page.locator('.layer__toggle').nth(1).click();
await page.waitForTimeout(250);
const locked = await page.evaluate(() => window.__trace.doc.layers.at(-1).locked === true);
check('el candado bloquea la capa', locked);
const onMark = await page.locator('.layer__toggle.is-on').count();
check('la capa bloqueada se marca a la vista', onMark === 1);
await page.locator('.layer__toggle').nth(1).click();
await page.waitForTimeout(250);
await page.screenshot({ path: `${out}/capas-despues.png` });
await page.locator('.panel [aria-label="Cerrar"]').click();

console.log('\n— Redimensionar el lienzo —');
// Deja un trazo reconocible y bórrale la capa duplicada para medir limpio.
await page.evaluate(() => {
  const e = window.__trace;
  e.deleteLayer(e.doc.layers[1].id);
  e.onion.enabled = false;
  e.touch();
});
await page.waitForTimeout(300);
const box = await page.locator('.canvas-surface').boundingBox();
await page.mouse.move(box.x + 400, box.y + 300);
await page.mouse.down();
await page.mouse.move(box.x + 700, box.y + 460, { steps: 14 });
await page.mouse.up();
await page.waitForTimeout(400);

const before = await inkInfo();
check('hay un trazo que conservar', before.count > 500, `${before.count} px`);
check('el documento empieza en 1920×1080', before.w === 1920 && before.h === 1080);

// Ampliar centrado: la tinta debe conservarse y desplazarse media diferencia.
await page.evaluate(() => window.__trace.resizeCanvas(2400, 1400, 0.5, 0.5));
await page.waitForTimeout(600);
const grown = await inkInfo();
check('el lienzo crece a 2400×1400', grown.w === 2400 && grown.h === 1400);
check(
  'no se pierde ni un píxel al ampliar',
  Math.abs(grown.count - before.count) < before.count * 0.02,
  `${before.count} -> ${grown.count} px`,
);
check(
  'el dibujo se recoloca según el anclaje centrado',
  Math.abs(grown.minX - (before.minX + 240)) <= 2 &&
    Math.abs(grown.minY - (before.minY + 160)) <= 2,
  `origen ${before.minX},${before.minY} -> ${grown.minX},${grown.minY} (esperado +240,+160)`,
);
await page.screenshot({ path: `${out}/lienzo-ampliado.png` });

// Deshacer devuelve el tamaño y el contenido.
await page.keyboard.press('Control+z');
await page.waitForTimeout(600);
const undone = await inkInfo();
check('deshacer devuelve el tamaño', undone.w === 1920 && undone.h === 1080);
check(
  'deshacer devuelve el dibujo a su sitio',
  undone.minX === before.minX && undone.minY === before.minY,
  `${undone.minX},${undone.minY}`,
);
check(
  'deshacer conserva la cantidad de tinta',
  Math.abs(undone.count - before.count) < before.count * 0.02,
  `${undone.count} px`,
);

// Encoger recorta, y deshacer lo recupera.
await page.evaluate(() => window.__trace.resizeCanvas(600, 400, 0, 0));
await page.waitForTimeout(600);
const cropped = await inkInfo();
check('el lienzo encoge a 600×400', cropped.w === 600 && cropped.h === 400);
check('al encoger se recorta lo que sobresale', cropped.count < before.count, `${cropped.count} px`);
await page.keyboard.press('Control+z');
await page.waitForTimeout(600);
const restored = await inkInfo();
check(
  'deshacer recupera los píxeles recortados',
  Math.abs(restored.count - before.count) < before.count * 0.02,
  `${restored.count} px de ${before.count}`,
);

console.log('\n— La interfaz de tamaño está en el panel —');
await page.locator('.rail--top [aria-label="Proyecto"]').click();
await page.waitForTimeout(400);
const presets = await page.locator('.preset-grid button').count();
check('hay tamaños predefinidos', presets === 6, `${presets}`);
const anchors = await page.locator('.anchor-grid button').count();
check('hay selector de anclaje de 9 posiciones', anchors === 9, `${anchors}`);
await page.screenshot({ path: `${out}/panel-tamano.png` });

console.log('\n— Consola —');
check('sin errores en consola', errors.length === 0, errors.join(' | '));

console.log(`\n${failures === 0 ? 'TODO EN VERDE' : `${failures} FALLOS`}\n`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
