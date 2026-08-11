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

log('\n— Cancelar una importación de vídeo a medias —');
const cancelResult = await page.evaluate(async () => {
  const e = window.__trace;
  const mod = await import('/src/core/io.ts');

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
  const colors = ['#ff0000', '#00ff00', '#0000ff', '#ffff00', '#ff00ff', '#00ffff', '#fff', '#000'];
  for (const col of colors) {
    ctx.fillStyle = col;
    ctx.fillRect(0, 0, c.width, c.height);
    await new Promise((r) => setTimeout(r, 150));
  }
  recorder.stop();
  await stopped;
  stream.getTracks().forEach((t) => t.stop());

  const blob = new Blob(chunks, { type: mimeType });
  const file = new File([blob], 'cancel.webm', { type: mimeType });

  const before = e.doc.layers.length;
  const controller = new AbortController();
  // Corta en cuanto llega el primer aviso de progreso: es lo más pronto que
  // se puede cancelar una importación real desde la interfaz.
  let firstProgress = false;
  const promise = mod.importReferenceVideo(
    e,
    file,
    () => {
      if (!firstProgress) {
        firstProgress = true;
        controller.abort();
      }
    },
    controller.signal,
  );

  let errName = null;
  try {
    await promise;
  } catch (err) {
    errName = err.name;
  }

  return { skipped: false, before, after: e.doc.layers.length, errName };
});
if (cancelResult.skipped) {
  log(`  (saltado: ${cancelResult.reason})`);
} else {
  check('rechaza con AbortError, no con un error genérico', cancelResult.errName === 'AbortError', cancelResult.errName);
  check(
    'no deja una capa de referencia a medio importar',
    cancelResult.after === cancelResult.before,
    `${cancelResult.before} -> ${cancelResult.after}`,
  );
}

log('\n— El botón "Cancelar" de la interfaz corta la importación de verdad —');
const dialogs = [];
page.on('dialog', (d) => {
  dialogs.push(d.message());
  d.dismiss();
});
const uiVideoBytes = await page.evaluate(async () => {
  // Más grande y más largo que el de arriba a propósito: necesita tardar de
  // verdad en extraerse (cada fotograma es un seek + subida a GPU de 720p)
  // para que el clic en "Cancelar" tenga tiempo real de llegar antes de que
  // termine sola — con el vídeo diminuto de la prueba anterior, la
  // importación completa antes de que Playwright alcance a hacer clic.
  const c = document.createElement('canvas');
  c.width = 1280;
  c.height = 720;
  const ctx = c.getContext('2d');
  const stream = c.captureStream(10);
  const mimeType = ['video/webm;codecs=vp8', 'video/webm'].find((t) =>
    MediaRecorder.isTypeSupported(t),
  );
  if (!mimeType) return null;
  const recorder = new MediaRecorder(stream, { mimeType });
  const chunks = [];
  recorder.ondataavailable = (ev) => ev.data.size > 0 && chunks.push(ev.data);
  const stopped = new Promise((resolve) => (recorder.onstop = resolve));
  recorder.start();
  const colors = Array.from({ length: 30 }, (_, i) => `hsl(${(i * 37) % 360}, 80%, 50%)`);
  for (const col of colors) {
    ctx.fillStyle = col;
    ctx.fillRect(0, 0, c.width, c.height);
    await new Promise((r) => setTimeout(r, 180));
  }
  recorder.stop();
  await stopped;
  stream.getTracks().forEach((t) => t.stop());
  const blob = new Blob(chunks, { type: mimeType });
  const buf = await blob.arrayBuffer();
  return Array.from(new Uint8Array(buf));
});
if (!uiVideoBytes) {
  log('  (saltado: sin códec webm en este navegador)');
} else {
  const layersBefore = await page.evaluate(() => window.__trace.doc.layers.length);
  await page.locator('.rail--top [aria-label="Capas"]').click();
  await page.waitForTimeout(300);
  await page
    .locator('input[accept="video/*"]')
    .setInputFiles({ name: 'cancel-ui.webm', mimeType: 'video/webm', buffer: Buffer.from(uiVideoBytes) });
  const cancelBtn = page.getByRole('button', { name: 'Cancelar', exact: true });
  await cancelBtn.waitFor({ state: 'visible', timeout: 10000 });
  check('aparece el botón Cancelar mientras importa', true);
  await cancelBtn.click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(300);

  // Nada de "sin capas de referencia" a secas: el escenario de vídeo de
  // arriba ya dejó la suya sin deshacer. Lo que prueba que cancelar limpió
  // bien es que el número de capas no cambió, no su tipo.
  const layersAfter = await page.evaluate(() => window.__trace.doc.layers.length);
  check(
    'cancelar desde el botón no deja una capa a medio importar',
    layersAfter === layersBefore,
    `${layersBefore} -> ${layersAfter}`,
  );
  check('el progreso desaparece del panel', (await page.getByText('Extrayendo fotogramas').count()) === 0);
  check('cancelar no dispara ningún alert()', dialogs.length === 0, dialogs.join(' | '));
}

log('\n— Referencia opcional de fondo en la exportación (includeInExport) —');
// Proyecto propio, self-contained: no depende del estado que dejaron las
// secciones anteriores (deshacer, cancelar...).
const includeExportSetup = await page.evaluate(async () => {
  const e = window.__trace;
  const mod = await import('/src/core/io.ts');
  const { DEFAULT_BRUSHES } = await import('/src/core/brush.ts');

  e.newProject(320, 240, 12, 1);

  const c = document.createElement('canvas');
  c.width = 320;
  c.height = 240;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#00ff00';
  ctx.fillRect(0, 0, 320, 240);
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
  await mod.importReferenceImage(e, new File([blob], 'ref.png', { type: 'image/png' }));
  const refLayer = e.activeLayer;
  // Opacidad reducida por defecto (0.6, ver sección "Imagen de referencia"
  // más arriba) a propósito para calcar mejor — pero eso mezcla el verde
  // puro con el papel blanco al componer, y el umbral de color de aquí
  // abajo asume verde puro. Full opacidad aísla la comprobación a lo que
  // importa: si la capa entra o no en la exportación, no cuánto se ve.
  e.setLayerProp(refLayer.id, 'opacity', 1, 'Opacidad');

  e.addLayer();
  const strokeCtx = { brush: DEFAULT_BRUSHES.find((b) => !b.erase), color: { r: 0, g: 0, b: 0 } };
  e.beginStroke({ x: 100, y: 100, pressure: 1, altitude: 0, azimuth: 0, time: performance.now() }, strokeCtx);
  e.moveStroke([{ x: 140, y: 140, pressure: 1, altitude: 0, azimuth: 0, time: performance.now() + 16 }]);
  e.endStroke();

  return { refLayerId: refLayer.id, includeInExportByDefault: !!refLayer.includeInExport };
});
check(
  'por defecto una referencia sigue sin marcar para exportar',
  includeExportSetup.includeInExportByDefault === false,
);

const countExportColors = () =>
  page.evaluate(() => {
    const e = window.__trace;
    const data = e.renderFrameToImageData(e.currentFrame).data;
    let green = 0;
    let black = 0;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      if (g > 200 && r < 60 && b < 60) green++;
      if (r < 60 && g < 60 && b < 60) black++;
    }
    return { green, black };
  });

const beforeColors = await countExportColors();
check('sin el interruptor, sigue sin verde en la exportación', beforeColors.green === 0, `${beforeColors.green} px`);
check('el trazo sí sale', beforeColors.black > 0, `${beforeColors.black} px`);

// Interruptor real desde el panel, no sólo la API del motor — abre el panel
// de Capas y toca el botón nuevo de la fila de la capa de referencia.
await page.evaluate(() => window.__uiStore.getState().setPanel('layers'));
await page.waitForTimeout(150);
const toggleBtn = page.locator(`li[data-layer-id="${includeExportSetup.refLayerId}"] button[title*="Incluir en la exportación"]`);
check('el botón de incluir en exportación aparece en el panel', (await toggleBtn.count()) === 1);
await toggleBtn.click();
await page.waitForTimeout(100);

const afterFlag = await page.evaluate(
  (id) => !!window.__trace.doc.layers.find((l) => l.id === id).includeInExport,
  includeExportSetup.refLayerId,
);
check('el clic en el botón activa includeInExport', afterFlag === true);
const afterColors = await countExportColors();
check('con el interruptor activo, el verde de la referencia sale de fondo', afterColors.green > 0, `${afterColors.green} px`);
check('el trazo sigue encima', afterColors.black > 0, `${afterColors.black} px`);

log('\n— El interruptor sobrevive guardar y reabrir —');
const persisted = await page.evaluate(async () => {
  const e = window.__trace;
  const { serializeProject, deserializeProject } = await import('/src/core/io.ts');
  const bytes = await serializeProject(e);
  const { doc } = await deserializeProject(e, bytes);
  const ref = doc.layers.find((l) => l.kind === 'reference');
  return { includeInExport: !!ref?.includeInExport };
});
check('includeInExport se guarda y se recupera en true', persisted.includeInExport === true);

log('\n— documentIsEmpty respeta el interruptor —');
const emptyCheck = await page.evaluate(async () => {
  const e = window.__trace;
  const mod = await import('/src/core/io.ts');

  e.newProject(200, 200, 12, 1);
  const c = document.createElement('canvas');
  c.width = 200;
  c.height = 200;
  c.getContext('2d').fillRect(0, 0, 200, 200);
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
  await mod.importReferenceImage(e, new File([blob], 'r.png', { type: 'image/png' }));
  const layer = e.activeLayer;

  const emptyBefore = mod.documentIsEmpty(e.doc);
  e.setLayerProp(layer.id, 'includeInExport', true, 'test');
  const emptyAfter = mod.documentIsEmpty(e.doc);
  return { emptyBefore, emptyAfter };
});
check(
  'sin marcar, un documento con sólo una referencia se considera vacío',
  emptyCheck.emptyBefore === true,
);
check(
  'marcado para exportar, ya no se considera vacío',
  emptyCheck.emptyAfter === false,
);

log('\n— Consola —');
check('sin errores en consola', errors.length === 0, errors.join(' | '));

log(`\n${failures === 0 ? 'TODO EN VERDE' : `${failures} FALLOS`}\n`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
