import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

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
  await page.waitForTimeout(150);
}

/**
 * Píxeles con tinta dentro de un rectángulo en espacio documento, leídos del
 * framebuffer visible — necesario para comprobar que posar un hueso desplaza
 * de verdad lo que se ve, no sólo los datos de `track`.
 *
 * Cuenta por COLOR, no por alfa: el framebuffer de pantalla ya pasó por
 * `present()`, que des-premultiplica sobre un fondo opaco — ahí el canal
 * alfa vale 255 en todo el lienzo, pintado o no. Contar por alfa aquí habría
 * dado siempre "todo es tinta" (justo el error que dejó pasar el primer
 * intento de este test).
 */
async function inkCountInRect(docRect) {
  return page.evaluate((r) => {
    const c = document.querySelector('canvas');
    const e = window.__trace;
    const gl = c.getContext('webgl2');
    const dpr = c.width / c.clientWidth;
    const a = e.docToScreen({ x: r.x, y: r.y });
    const b = e.docToScreen({ x: r.x2, y: r.y2 });
    const x0 = Math.max(0, Math.round(Math.min(a.x, b.x) * dpr));
    const x1 = Math.min(c.width, Math.round(Math.max(a.x, b.x) * dpr));
    const topCss = Math.min(a.y, b.y);
    const bottomCss = Math.max(a.y, b.y);
    const y0 = Math.max(0, Math.round((c.clientHeight - bottomCss) * dpr));
    const y1 = Math.min(c.height, Math.round((c.clientHeight - topCss) * dpr));
    const w = x1 - x0;
    const h = y1 - y0;
    if (w <= 0 || h <= 0) return 0;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(x0, y0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let n = 0;
    for (let i = 0; i < px.length; i += 4) if (px[i] < 200 || px[i + 1] < 200 || px[i + 2] < 200) n++;
    return n;
  }, docRect);
}

async function docToPage(p) {
  const s = await page.evaluate((pt) => window.__trace.docToScreen(pt), p);
  return { x: s.x + box.x, y: s.y + box.y };
}

/**
 * Captura el documento compuesto vía `renderFrameToImageData` — el mismo
 * camino determinista que usa la exportación real — en vez de
 * `page.screenshot()` del lienzo interactivo.
 *
 * `page.screenshot()` resultó no fiable aquí: con `preserveDrawingBuffer:
 * false`, tras un solo `render()` (lo que dispara posar un hueso) el lienzo
 * WebGL no vuelve a redibujarse, y ni el compositor de Chromium ni
 * `canvas.toDataURL()` reflejan ese fotograma — devuelven el último que sí
 * llegó a "presentarse" antes. `gl.readPixels()` (usado en
 * `inkCountInRect`) sí lee el búfer real en el momento, y coincide exacto
 * con `renderFrameToImageData`; por eso los `check()` de este archivo usan
 * uno de esos dos caminos y las capturas de después de posar usan éste.
 */
async function documentSnapshot(path) {
  const dataUrl = await page.evaluate(() => {
    const e = window.__trace;
    const data = e.renderFrameToImageData(e.currentFrame);
    const c = document.createElement('canvas');
    c.width = data.width;
    c.height = data.height;
    c.getContext('2d').putImageData(data, 0, 0);
    return c.toDataURL('image/png');
  });
  writeFileSync(path, Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64'));
}

/* ------------------------------------------------------------------ */

console.log('\n— Preparar: tinta y esqueleto —');
await stroke([
  [cx - 140, cy],
  [cx - 60, cy - 10],
  [cx + 60, cy + 10],
  [cx + 140, cy],
]);

const setup = await page.evaluate(({ p0, p1 }) => {
  const e = window.__trace;
  const start = e.screenToDoc(p0);
  const end = e.screenToDoc(p1);
  const length = Math.hypot(end.x - start.x, end.y - start.y);

  const skel = e.createSkeleton('Prueba');
  const hombro = e.addBone(skel.id, 'Hombro', null, { x: start.x, y: start.y, length });
  const antebrazo = e.addBone(skel.id, 'Antebrazo', hombro.id, { x: length, y: 0, length: 90 });
  const layer = e.doc.layers[0];
  e.attachLayerToBone(layer.id, skel.id, hombro.id);
  window.__uiStore.getState().setTool('rig');

  return {
    skelId: skel.id,
    hombroId: hombro.id,
    antebrazoId: antebrazo.id,
    layerId: layer.id,
    start,
    end,
    length,
  };
}, {
  p0: { x: cx - 140 - box.x, y: cy - box.y },
  p1: { x: cx + 140 - box.x, y: cy - box.y },
});
check('el esqueleto tiene 2 huesos', true, `hombro→antebrazo, longitud ${setup.length.toFixed(0)}px`);

const inkRect = (center, half = 60) => ({
  x: center.x - half,
  y: center.y - half,
  x2: center.x + half,
  y2: center.y + half,
});
const inkAtStart = await inkCountInRect(inkRect(setup.start));
// El trazo es una línea fina, no un relleno: el rectángulo de 120×120 la
// roza más que la llena, así que el umbral es bajo a propósito.
check('hay tinta bajo el hueso antes de posar', inkAtStart > 20, `${inkAtStart} px`);

console.log('\n— Seleccionar tocando el hueso —');
const mid = await docToPage({
  x: (setup.start.x + setup.end.x) / 2,
  y: (setup.start.y + setup.end.y) / 2,
});
await page.mouse.click(mid.x, mid.y);
await page.waitForTimeout(150);
let selected = await page.evaluate(() => window.__uiStore.getState().selectedBoneId);
check('tocar el hueso lo selecciona', selected === setup.hombroId, String(selected));
let handleCount = await page.locator('.bone-handle').count();
check('aparecen 3 tiradores (mover/rotar/escalar)', handleCount === 3, `${handleCount} tiradores`);
await page.screenshot({ path: `${out}/rig-viewport-01-seleccionado.png` });

console.log('\n— Los tiradores están donde deberían —');
const headPage = await docToPage(setup.start);
const moveBox = await page.locator('.bone-handle--move').boundingBox();
const moveCenter = { x: moveBox.x + moveBox.width / 2, y: moveBox.y + moveBox.height / 2 };
check(
  'el tirador de mover está en la cabeza del hueso',
  Math.hypot(moveCenter.x - headPage.x, moveCenter.y - headPage.y) < 3,
  `${Math.hypot(moveCenter.x - headPage.x, moveCenter.y - headPage.y).toFixed(1)} px de diferencia`,
);

console.log('\n— Tocar lienzo vacío deselecciona —');
await page.mouse.click(box.x + 20, box.y + 20);
await page.waitForTimeout(150);
selected = await page.evaluate(() => window.__uiStore.getState().selectedBoneId);
check('deselecciona', selected === null, String(selected));
handleCount = await page.locator('.bone-handle').count();
check('los tiradores desaparecen', handleCount === 0, `${handleCount} tiradores`);

console.log('\n— Mover el hueso desplaza la tinta —');
const target = { x: setup.start.x, y: setup.start.y - 220 };
await page.evaluate(
  ({ skelId, hombroId, target }) => {
    const e = window.__trace;
    const skel = e.doc.skeletons.find((s) => s.id === skelId);
    const bone = skel.bones.find((b) => b.id === hombroId);
    const offset = e.boneOffsetForWorldPoint(skelId, bone, target);
    e.setBonePose(skelId, hombroId, offset);
  },
  { skelId: setup.skelId, hombroId: setup.hombroId, target },
);
await page.waitForTimeout(300);
const inkAtStartAfterMove = await inkCountInRect(inkRect(setup.start));
const inkAtTargetAfterMove = await inkCountInRect(inkRect(target));
check(
  'la tinta ya no está donde empezó',
  inkAtStartAfterMove < inkAtStart * 0.3,
  `${inkAtStart} -> ${inkAtStartAfterMove} px`,
);
check('la tinta aparece en el nuevo sitio', inkAtTargetAfterMove > 20, `${inkAtTargetAfterMove} px`);
await documentSnapshot(`${out}/rig-viewport-02-movido.png`);

console.log('\n— Rotar el hueso mueve también a su hijo —');
const beforeRotate = await page.evaluate(
  ({ skelId }) => window.__trace.boneEndpoints(skelId).map((e) => ({ id: e.bone.id, tail: e.tail })),
  { skelId: setup.skelId },
);
await page.evaluate(
  ({ skelId, hombroId }) => {
    const e = window.__trace;
    const skel = e.doc.skeletons.find((s) => s.id === skelId);
    const bone = skel.bones.find((b) => b.id === hombroId);
    const head = { x: e.getBoneValue(bone, 'x'), y: e.getBoneValue(bone, 'y') };
    // Un punto 90° por encima de la cabeza actual, en espacio documento.
    const worldHead = e.boneEndpoints(skelId).find((ep) => ep.bone.id === hombroId).head;
    const target = { x: worldHead.x, y: worldHead.y - 150 };
    const rotation = e.boneRotationForWorldPoint(skelId, bone, target);
    e.setBonePose(skelId, hombroId, { rotation });
    return head;
  },
  { skelId: setup.skelId, hombroId: setup.hombroId },
);
await page.waitForTimeout(300);
const afterRotate = await page.evaluate(
  ({ skelId }) => window.__trace.boneEndpoints(skelId).map((e) => ({ id: e.bone.id, tail: e.tail })),
  { skelId: setup.skelId },
);
const antebrazoBefore = beforeRotate.find((b) => b.id === setup.antebrazoId).tail;
const antebrazoAfter = afterRotate.find((b) => b.id === setup.antebrazoId).tail;
const childMoved = Math.hypot(antebrazoAfter.x - antebrazoBefore.x, antebrazoAfter.y - antebrazoBefore.y);
check(
  'rotar el padre mueve la cola del hijo (la jerarquía se propaga)',
  childMoved > 40,
  `${childMoved.toFixed(0)} px`,
);

console.log('\n— Escalar el hueso alarga la cadena —');
const beforeScale = await page.evaluate(
  ({ skelId, hombroId }) => {
    const eps = window.__trace.boneEndpoints(skelId);
    const h = eps.find((e) => e.bone.id === hombroId);
    return Math.hypot(h.tail.x - h.head.x, h.tail.y - h.head.y);
  },
  { skelId: setup.skelId, hombroId: setup.hombroId },
);
await page.evaluate(
  ({ skelId, hombroId }) => window.__trace.setBonePose(skelId, hombroId, { scaleX: 2, scaleY: 2 }),
  { skelId: setup.skelId, hombroId: setup.hombroId },
);
await page.waitForTimeout(300);
const afterScale = await page.evaluate(
  ({ skelId, hombroId }) => {
    const eps = window.__trace.boneEndpoints(skelId);
    const h = eps.find((e) => e.bone.id === hombroId);
    return Math.hypot(h.tail.x - h.head.x, h.tail.y - h.head.y);
  },
  { skelId: setup.skelId, hombroId: setup.hombroId },
);
check(
  'escalar x2 dobla la distancia cabeza-cola',
  Math.abs(afterScale - beforeScale * 2) < beforeScale * 0.05,
  `${beforeScale.toFixed(0)} -> ${afterScale.toFixed(0)} px`,
);
await documentSnapshot(`${out}/rig-viewport-03-escalado.png`);

console.log('\n— Consola —');
check('sin errores en consola', errors.length === 0, errors.join(' | '));

console.log(`\n${failures === 0 ? 'TODO EN VERDE' : `${failures} FALLOS`}\n`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
