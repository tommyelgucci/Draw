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

const box = await page.locator('.canvas-surface').boundingBox();
const cx = box.x + box.width / 2;
const cy = box.y + box.height / 2;

async function stroke(points) {
  await page.mouse.move(points[0][0], points[0][1]);
  await page.mouse.down();
  for (const [x, y] of points.slice(1)) await page.mouse.move(x, y, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(120);
}

/* ------------------------------------------------------------------ */

console.log('\n— Sin grabar, no hay fotogramas —');
let count = await page.evaluate(() => window.__trace.timelapseFrameCount);
check('empieza en 0', count === 0, `${count}`);

console.log('\n— Empezar a grabar desde el panel de Proyecto —');
await page.evaluate(() => window.__uiStore.getState().setPanel('export'));
await page.waitForTimeout(200);
const startBtn = page.locator('.btn--ghost', { hasText: 'Empezar a grabar' });
check('aparece el botón de empezar a grabar', (await startBtn.count()) === 1);
await startBtn.click();
await page.waitForTimeout(100);
const recording = await page.evaluate(() => window.__trace.timelapseRecording);
check('queda grabando', recording === true);

console.log('\n— Dibujar deja una captura —');
await stroke([[cx - 100, cy], [cx + 100, cy]]);
await page.waitForTimeout(150);
count = await page.evaluate(() => window.__trace.timelapseFrameCount);
check('el primer trazo deja al menos 1 fotograma', count >= 1, `${count}`);
const stopBtnLabel = page.locator('.btn', { hasText: /^Detener/ });
check('el botón muestra el contador de fotogramas', (await stopBtnLabel.count()) === 1);

console.log('\n— Un solo trazo (varios `touch()` internos) sólo deja UN fotograma —');
// No se mide el límite de 1/s contra el reloj de pared: en este Chromium con
// SwiftShader el render es correcto pero lento (ver CLAUDE.md), así que dos
// trazos separados por un `waitForTimeout` corto pueden acabar distando más
// de un segundo real sin que eso signifique nada sobre el límite en sí. La
// comprobación que sí es determinista: un trazo de varios pasos dispara
// `touch()` (y por tanto `onAfterRender`) muchas veces seguidas, y aun así
// sólo debe dejar UNA captura, no una por cada paso del arrastre.
const countBeforeQuick = await page.evaluate(() => window.__trace.timelapseFrameCount);
await stroke([
  [cx - 100, cy + 60],
  [cx - 50, cy + 62],
  [cx, cy + 58],
  [cx + 50, cy + 61],
  [cx + 100, cy + 60],
]);
await page.waitForTimeout(100);
const countAfterQuick = await page.evaluate(() => window.__trace.timelapseFrameCount);
check(
  'un trazo con varios pasos internos añade como mucho un fotograma nuevo',
  countAfterQuick - countBeforeQuick <= 1,
  `${countBeforeQuick} -> ${countAfterQuick}`,
);

console.log('\n— Esperar y volver a dibujar sí añade otro fotograma —');
await page.waitForTimeout(1100);
await stroke([[cx - 100, cy - 60], [cx + 100, cy - 60]]);
await page.waitForTimeout(150);
const countAfterWait = await page.evaluate(() => window.__trace.timelapseFrameCount);
check('pasado el segundo, el siguiente trazo sí deja fotograma nuevo', countAfterWait > countAfterQuick, `${countAfterQuick} -> ${countAfterWait}`);

console.log('\n— Detener la grabación conserva lo grabado —');
await page.locator('.btn', { hasText: /^Detener/ }).click();
await page.waitForTimeout(100);
const recordingAfterStop = await page.evaluate(() => window.__trace.timelapseRecording);
check('deja de grabar', recordingAfterStop === false);
const countAfterStop = await page.evaluate(() => window.__trace.timelapseFrameCount);
check('conserva los fotogramas grabados', countAfterStop === countAfterWait, `${countAfterStop}`);
check(
  'aparece el botón de exportar time-lapse',
  (await page.locator('.btn', { hasText: 'Exportar time-lapse' }).count()) === 1,
);
await page.screenshot({ path: `${out}/timelapse-01-grabado.png` });

console.log('\n— Exportar produce un vídeo real —');
const exportResult = await page.evaluate(async () => {
  const { exportImageSequenceAsVideo } = await import('/src/core/video.ts');
  const e = window.__trace;
  const result = await exportImageSequenceAsVideo([...e.timelapseFramesSnapshot], 24, 0.5);
  return { size: result.blob.size, type: result.blob.type, extension: result.extension, method: result.method };
});
check('el vídeo exportado tiene contenido', exportResult.size > 1000, JSON.stringify(exportResult));
check(
  'el tipo MIME es de vídeo',
  exportResult.type.startsWith('video/'),
  exportResult.type,
);

console.log('\n— Descartar borra la grabación —');
await page.locator('.btn--ghost', { hasText: 'Descartar' }).click();
await page.waitForTimeout(100);
const countAfterDiscard = await page.evaluate(() => window.__trace.timelapseFrameCount);
check('la grabación queda vacía', countAfterDiscard === 0, `${countAfterDiscard}`);
check(
  'vuelve a aparecer el botón de "Empezar a grabar"',
  (await page.locator('.btn--ghost', { hasText: 'Empezar a grabar' }).count()) === 1,
);

console.log('\n— Consola —');
check('sin errores en consola', errors.length === 0, errors.join(' | '));

console.log(`\n${failures === 0 ? 'TODO EN VERDE' : `${failures} FALLOS`}\n`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
