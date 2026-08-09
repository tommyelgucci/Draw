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

async function drag(from, to, steps = 10) {
  await page.mouse.move(from[0], from[1]);
  await page.mouse.down();
  await page.mouse.move(to[0], to[1], { steps });
  await page.mouse.up();
  await page.waitForTimeout(150);
}

/* ------------------------------------------------------------------ */

console.log('\n— Abrir el panel de Pincel y arrastrarlo por la cabecera —');
await page.evaluate(() => window.__uiStore.getState().setPanel('brush'));
await page.waitForTimeout(200);

const panel = page.locator('.panel');
const before = await panel.boundingBox();
check('el panel de Pincel arranca en su posición por defecto', !!before);
const noDragYet = await panel.evaluate((el) => el.classList.contains('is-dragged'));
check('todavía no lleva la clase "is-dragged"', noDragYet === false);

// Un punto de la cabecera lejos del botón de cerrar (que vive a la derecha).
const headStart = [before.x + 40, before.y + 15];
const dx = -260;
const dy = 120;
await drag(headStart, [headStart[0] + dx, headStart[1] + dy]);

const after = await panel.boundingBox();
const movedX = after.x - before.x;
const movedY = after.y - before.y;
check('el panel se movió en X lo que se arrastró', Math.abs(movedX - dx) < 4, `${movedX.toFixed(1)} esperado ${dx}`);
check('el panel se movió en Y lo que se arrastró', Math.abs(movedY - dy) < 4, `${movedY.toFixed(1)} esperado ${dy}`);
const isDragged = await panel.evaluate((el) => el.classList.contains('is-dragged'));
check('lleva la clase "is-dragged" tras el primer arrastre', isDragged === true);

await page.screenshot({ path: `${out}/draggable-panels-01-arrastrado.png` });

console.log('\n— Cerrar y reabrir conserva la posición arrastrada —');
await page.evaluate(() => window.__uiStore.getState().setPanel(null));
await page.waitForTimeout(150);
check('el panel se cierra', (await panel.count()) === 0);
await page.evaluate(() => window.__uiStore.getState().setPanel('brush'));
await page.waitForTimeout(200);
const reopened = await panel.boundingBox();
check(
  'reabre en el mismo sitio donde se soltó',
  Math.abs(reopened.x - after.x) < 2 && Math.abs(reopened.y - after.y) < 2,
  `${JSON.stringify(reopened)} vs ${JSON.stringify(after)}`,
);

console.log('\n— El botón de cerrar sigue funcionando tras arrastrar —');
const closeBtn = panel.locator('button[title="Cerrar"]');
await closeBtn.click();
await page.waitForTimeout(150);
check('cerrar funciona con normalidad', (await panel.count()) === 0);

console.log('\n— Arrastrar muy lejos se queda acotado dentro de la pantalla —');
await page.evaluate(() => window.__uiStore.getState().setPanel('brush'));
await page.waitForTimeout(200);
let box = await panel.boundingBox();
await drag([box.x + 40, box.y + 15], [-500, -500]);
box = await panel.boundingBox();
check('no se pierde por la esquina superior izquierda', box.x > -300 && box.y >= -2, JSON.stringify(box));
check('sigue habiendo algo de panel visible', box.x + box.width > 40, JSON.stringify(box));

await drag([box.x + 40, box.y + 15], [3000, 3000]);
box = await panel.boundingBox();
check(
  'no se pierde por la esquina inferior derecha',
  box.x < 1280 && box.y < 900,
  JSON.stringify(box),
);
await page.evaluate(() => window.__uiStore.getState().setPanel(null));
await page.waitForTimeout(100);

console.log('\n— Cada panel guarda su propia posición, sin mezclarse —');
await page.evaluate(() => window.__uiStore.getState().setPanel('layers'));
await page.waitForTimeout(200);
const layersPanel = page.locator('.panel');
const layersBefore = await layersPanel.boundingBox();
await drag([layersBefore.x + 40, layersBefore.y + 15], [layersBefore.x + 40 - 150, layersBefore.y + 15 + 60]);
const layersAfter = await layersPanel.boundingBox();
await page.evaluate(() => window.__uiStore.getState().setPanel(null));
await page.waitForTimeout(100);

await page.evaluate(() => window.__uiStore.getState().setPanel('brush'));
await page.waitForTimeout(200);
const brushAgain = await panel.boundingBox();
check(
  'Pincel no adoptó la posición de Capas',
  Math.abs(brushAgain.x - layersAfter.x) > 20 || Math.abs(brushAgain.y - layersAfter.y) > 20,
  `pincel ${JSON.stringify(brushAgain)} vs capas ${JSON.stringify(layersAfter)}`,
);

console.log('\n— Consola —');
check('sin errores en consola', errors.length === 0, errors.join(' | '));

console.log(`\n${failures === 0 ? 'TODO EN VERDE' : `${failures} FALLOS`}\n`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
