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

/* ------------------------------------------------------------------ */

console.log('\n— Activar desde el panel de Pincel —');
await page.evaluate(() => window.__uiStore.getState().setPanel('brush'));
await page.waitForTimeout(150);
const enableCheck = page.locator('label.check', { hasText: 'Activar' }).locator('input');
check('aparece la casilla "Activar"', (await enableCheck.count()) === 1);
await enableCheck.check();
await page.waitForTimeout(150);
const enabled = await page.evaluate(() => window.__trace.perspectiveGuide.enabled);
check('queda activada', enabled === true);

console.log('\n— Un punto de fuga en modo 1 punto —');
let mode = await page.evaluate(() => window.__trace.perspectiveGuide.mode);
check('empieza en 1 punto', mode === '1pt', mode);
let vpCount = await page.locator('.perspective-overlay__vp').count();
check('un solo tirador de punto de fuga', vpCount === 1, `${vpCount}`);
let lineCount = await page.locator('.perspective-overlay__lines line').count();
check('se ven los radios guía', lineCount === 24, `${lineCount}`);

console.log('\n— Cambiar a 2 y 3 puntos —');
const segButtons = page.locator('.panel__section .segmented', { hasText: '2 puntos' }).locator('button');
await segButtons.filter({ hasText: '2 puntos' }).click();
await page.waitForTimeout(150);
mode = await page.evaluate(() => window.__trace.perspectiveGuide.mode);
check('pasa a 2 puntos', mode === '2pt', mode);
vpCount = await page.locator('.perspective-overlay__vp').count();
check('dos tiradores en 2 puntos', vpCount === 2, `${vpCount}`);

await segButtons.filter({ hasText: '3 puntos' }).click();
await page.waitForTimeout(150);
mode = await page.evaluate(() => window.__trace.perspectiveGuide.mode);
check('pasa a 3 puntos', mode === '3pt', mode);
vpCount = await page.locator('.perspective-overlay__vp').count();
check('tres tiradores en 3 puntos', vpCount === 3, `${vpCount}`);

await segButtons.filter({ hasText: '1 punto' }).click();
await page.waitForTimeout(150);
await page.screenshot({ path: `${out}/perspective-01-radios.png` });

console.log('\n— Arrastrar el punto de fuga lo mueve —');
const vpBefore = await page.evaluate(() => window.__trace.perspectiveGuide.vp1);
const vpHandle = page.locator('.perspective-overlay__vp').first();
const handleBox = await vpHandle.boundingBox();
const start = { x: handleBox.x + handleBox.width / 2, y: handleBox.y + handleBox.height / 2 };
await page.mouse.move(start.x, start.y);
await page.mouse.down();
await page.mouse.move(start.x + 80, start.y - 40, { steps: 6 });
await page.mouse.up();
await page.waitForTimeout(150);
const vpAfter = await page.evaluate(() => window.__trace.perspectiveGuide.vp1);
check(
  'el punto de fuga cambió de posición al arrastrarlo',
  Math.abs(vpAfter.x - vpBefore.x) > 20 || Math.abs(vpAfter.y - vpBefore.y) > 20,
  `${JSON.stringify(vpBefore)} -> ${JSON.stringify(vpAfter)}`,
);

console.log('\n— Encajar el trazo al punto de fuga —');
// Vuelve a poner el punto de fuga en un sitio conocido para razonar sobre
// el ángulo exacto de encaje.
const vp1 = { x: 960, y: 540 };
await page.evaluate((p) => window.__trace.setPerspectiveVanishingPoint('vp1', p), vp1);
await page.waitForTimeout(100);

const rawStart = { x: vp1.x + 300, y: vp1.y + 6 }; // unos grados fuera del radio horizontal
const rawEnd = { x: vp1.x + 200, y: vp1.y + 4 };
const snappedPoints = await page.evaluate(
  ({ rawStart, rawEnd }) => {
    const e = window.__trace;
    const base = window.__uiStore.getState().brushes.find((b) => b.id === 'ink');
    const brush = { ...base, size: 20, erase: false, taper: 0 };
    const ctx = { brush, color: { r: 0, g: 0, b: 0 } };
    const s0 = { x: rawStart.x, y: rawStart.y, pressure: 1, altitude: Math.PI / 2, azimuth: 0, time: 0 };
    const s1 = { x: rawEnd.x, y: rawEnd.y, pressure: 1, altitude: Math.PI / 2, azimuth: 0, time: 8 };
    e.beginStroke(s0, ctx);
    e.moveStroke([s1]);
    const points = [...e.strokeRawPoints];
    e.endStroke();
    return points;
  },
  { rawStart, rawEnd },
);
check(
  'el primer punto encaja al radio horizontal (y ~= punto de fuga)',
  Math.abs(snappedPoints[0].y - vp1.y) < 0.5,
  `y=${snappedPoints[0].y} (fuga y=${vp1.y}, crudo y=${rawStart.y})`,
);
check(
  'el segundo punto también encaja a la misma línea',
  Math.abs(snappedPoints[1].y - vp1.y) < 0.5,
  `y=${snappedPoints[1].y}`,
);
await page.waitForTimeout(150);
await page.screenshot({ path: `${out}/perspective-02-encajado.png` });

console.log('\n— Sin la guía activada, el trazo no se toca —');
await page.evaluate(() => window.__trace.setPerspectiveGuide({ enabled: false }));
await page.waitForTimeout(100);
const unsnapped = await page.evaluate(
  ({ rawStart, rawEnd }) => {
    const e = window.__trace;
    const base = window.__uiStore.getState().brushes.find((b) => b.id === 'ink');
    const brush = { ...base, size: 20, erase: false, taper: 0 };
    const ctx = { brush, color: { r: 0, g: 0, b: 0 } };
    const s0 = { x: rawStart.x, y: rawStart.y, pressure: 1, altitude: Math.PI / 2, azimuth: 0, time: 0 };
    const s1 = { x: rawEnd.x, y: rawEnd.y, pressure: 1, altitude: Math.PI / 2, azimuth: 0, time: 8 };
    e.beginStroke(s0, ctx);
    e.moveStroke([s1]);
    const points = [...e.strokeRawPoints];
    e.endStroke();
    return points;
  },
  { rawStart, rawEnd },
);
check(
  'con la guía apagada, el punto conserva su y original sin encajar',
  Math.abs(unsnapped[0].y - rawStart.y) < 0.001,
  `y=${unsnapped[0].y} (crudo y=${rawStart.y})`,
);

console.log('\n— Consola —');
check('sin errores en consola', errors.length === 0, errors.join(' | '));

console.log(`\n${failures === 0 ? 'TODO EN VERDE' : `${failures} FALLOS`}\n`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
