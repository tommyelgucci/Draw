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

const log = (...a) => console.log(...a);
let failures = 0;
const check = (name, ok, extra = '') => {
  log(`${ok ? '  ok  ' : ' FALLA'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
};

await page.goto('http://127.0.0.1:5173/', { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);

log('\n— Imagen de referencia —');
const imgResult = await page.evaluate(async () => {
  const e = window.__trace;
  const mod = await import('/src/core/io.ts');

  // Imagen sintética: un cuadrado verde puro, fácil de distinguir de la
  // tinta negra del pincel y del papel blanco.
  const c = document.createElement('canvas');
  c.width = 200;
  c.height = 200;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#00ff00';
  ctx.fillRect(0, 0, 200, 200);
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
  const file = new File([blob], 'ref.png', { type: 'image/png' });

  const before = e.doc.layers.length;
  await mod.importReferenceImage(e, file);
  const layer = e.activeLayer;
  return {
    before,
    after: e.doc.layers.length,
    kind: layer?.kind,
    opacity: layer?.opacity,
    animated: layer?.animated,
    celCount: layer?.cels.size,
  };
});
check('se añade una capa', imgResult.after === imgResult.before + 1, `${imgResult.before} -> ${imgResult.after}`);
check('la capa nueva es de referencia', imgResult.kind === 'reference', imgResult.kind);
check('queda como capa activa con un cel', imgResult.celCount === 1, String(imgResult.celCount));
check('no es animada (imagen suelta)', imgResult.animated === false);
check('opacidad reducida por defecto', imgResult.opacity < 1, String(imgResult.opacity));
await page.screenshot({ path: `${out}/ref-01-imagen.png` });

log('\n— No se puede dibujar sobre la referencia —');
const drawBlocked = await page.evaluate(async () => {
  const e = window.__trace;
  const { DEFAULT_BRUSHES } = await import('/src/core/brush.ts');
  const layer = e.activeLayer; // la capa de referencia recién importada
  const started = e.beginStroke(
    { x: 20, y: 20, pressure: 1, altitude: 0, azimuth: 0, time: performance.now() },
    { brush: DEFAULT_BRUSHES[0], color: { r: 0, g: 0, b: 0 } },
  );
  return { started, isReference: layer.kind === 'reference' };
});
check('la capa activa es la de referencia', drawBlocked.isReference);
check('beginStroke se niega sobre una capa de referencia', drawBlocked.started === false);

log('\n— La referencia se ve en pantalla pero no en la exportación —');
const exportCheck = await page.evaluate(async () => {
  const e = window.__trace;
  const { DEFAULT_BRUSHES } = await import('/src/core/brush.ts');

  // Capa de dibujo normal encima, con un trazo negro real.
  e.addLayer();
  const strokeCtx = { brush: DEFAULT_BRUSHES.find((b) => !b.erase), color: { r: 0, g: 0, b: 0 } };
  const started = e.beginStroke(
    { x: 100, y: 100, pressure: 1, altitude: 0, azimuth: 0, time: performance.now() },
    strokeCtx,
  );
  e.moveStroke([{ x: 140, y: 140, pressure: 1, altitude: 0, azimuth: 0, time: performance.now() + 16 }]);
  e.endStroke();

  const data = e.renderFrameToImageData(e.currentFrame);
  let green = 0;
  let black = 0;
  for (let i = 0; i < data.data.length; i += 4) {
    const [r, g, b] = data.data.subarray(i, i + 3);
    if (g > 200 && r < 60 && b < 60) green++;
    if (r < 60 && g < 60 && b < 60) black++;
  }
  return { started, green, black };
});
check(
  'la exportación no lleva verde de la referencia',
  exportCheck.green === 0,
  `${exportCheck.green} px verdes`,
);
check('el trazo de prueba empezó', exportCheck.started === true);
check('la exportación sí lleva el trazo negro', exportCheck.black > 0, `${exportCheck.black} px`);

log('\n— Deshacer la importación —');
const undone = await page.evaluate(() => {
  const e = window.__trace;
  const before = e.doc.layers.length;
  // Tres pasos hacia atrás: el trazo, la nueva capa de dibujo y la
  // importación de la imagen de referencia.
  e.history.undo();
  e.history.undo();
  e.history.undo();
  return { before, after: e.doc.layers.length, kinds: e.doc.layers.map((l) => l.kind) };
});
check(
  'deshacer quita la capa de referencia',
  !undone.kinds.includes('reference'),
  `${undone.before} -> ${undone.after}: ${undone.kinds.join(',')}`,
);

log('\n— Vídeo de referencia —');
const videoResult = await page.evaluate(async () => {
  const e = window.__trace;
  const mod = await import('/src/core/io.ts');

  // Vídeo sintético: un canvas que cambia de color grabado con MediaRecorder.
  const c = document.createElement('canvas');
  c.width = 160;
  c.height = 120;
  const ctx = c.getContext('2d');
  const stream = c.captureStream(10);
  const mimeType = ['video/webm;codecs=vp8', 'video/webm'].find((t) =>
    MediaRecorder.isTypeSupported(t),
  );
  if (!mimeType) return { skipped: true, reason: 'sin códec webm en este navegador' };

  const recorder = new MediaRecorder(stream, { mimeType });
  const chunks = [];
  recorder.ondataavailable = (ev) => ev.data.size > 0 && chunks.push(ev.data);
  const stopped = new Promise((resolve) => (recorder.onstop = resolve));

  recorder.start();
  const colors = ['#ff0000', '#0000ff', '#ffff00', '#ff00ff'];
  for (let i = 0; i < colors.length; i++) {
    ctx.fillStyle = colors[i];
    ctx.fillRect(0, 0, c.width, c.height);
    await new Promise((r) => setTimeout(r, 300));
  }
  recorder.stop();
  await stopped;
  stream.getTracks().forEach((t) => t.stop());

  const blob = new Blob(chunks, { type: mimeType });
  const file = new File([blob], 'ref.webm', { type: mimeType });

  const before = e.doc.layers.length;
  const beforeFrames = e.doc.frameCount;
  const progressCalls = [];
  await mod.importReferenceVideo(e, file, (d, t) => progressCalls.push([d, t]));
  const layer = e.activeLayer;
  return {
    skipped: false,
    before,
    after: e.doc.layers.length,
    kind: layer?.kind,
    animated: layer?.animated,
    celCount: layer?.cels.size,
    frameCount: e.doc.frameCount,
    beforeFrames,
    progressCalls: progressCalls.length,
  };
});

if (videoResult.skipped) {
  log(`  (saltado: ${videoResult.reason})`);
} else {
  check(
    'se añade una capa de vídeo',
    videoResult.after === videoResult.before + 1,
    `${videoResult.before} -> ${videoResult.after}`,
  );
  check('la capa de vídeo es de referencia y animada', videoResult.kind === 'reference' && videoResult.animated);
  check('lleva varios fotogramas', videoResult.celCount > 1, `${videoResult.celCount} cels`);
  check(
    'la duración del documento creció si hacía falta',
    videoResult.frameCount >= videoResult.beforeFrames,
    `${videoResult.beforeFrames} -> ${videoResult.frameCount}`,
  );
  check('se reportó progreso', videoResult.progressCalls > 0, `${videoResult.progressCalls} llamadas`);
  await page.screenshot({ path: `${out}/ref-02-video.png` });
}

log('\n— Consola —');
check('sin errores en consola', errors.length === 0, errors.join(' | '));

log(`\n${failures === 0 ? 'TODO EN VERDE' : `${failures} FALLOS`}\n`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
