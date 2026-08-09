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

/** Ver CLAUDE.md "Trampas conocidas": page.screenshot()/toDataURL() del
 *  lienzo interactivo se quedan con el fotograma anterior tras un solo
 *  render puntual. Para verificar o capturar un cambio de pose se usa
 *  gl.readPixels() (in-frame) o renderFrameToImageData() (el mismo camino
 *  que la exportación real), nunca una captura de pantalla en vivo. */
async function inkCountAtFrame(frame, docRect) {
  return page.evaluate(({ frame, r }) => {
    const e = window.__trace;
    const data = e.renderFrameToImageData(frame);
    let n = 0;
    const x0 = Math.max(0, Math.floor(r.x));
    const x1 = Math.min(data.width, Math.ceil(r.x2));
    const y0 = Math.max(0, Math.floor(r.y));
    const y1 = Math.min(data.height, Math.ceil(r.y2));
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * data.width + x) * 4;
        if (data.data[i] < 200 || data.data[i + 1] < 200 || data.data[i + 2] < 200) n++;
      }
    }
    return n;
  }, { frame, r: docRect });
}

async function documentSnapshot(frame, path) {
  const dataUrl = await page.evaluate((frame) => {
    const e = window.__trace;
    const data = e.renderFrameToImageData(frame);
    const c = document.createElement('canvas');
    c.width = data.width;
    c.height = data.height;
    c.getContext('2d').putImageData(data, 0, 0);
    return c.toDataURL('image/png');
  }, frame);
  writeFileSync(path, Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64'));
}

async function tailAt(skelId, boneId, frame) {
  return page.evaluate(({ skelId, boneId, frame }) => {
    const e = window.__trace;
    e.setFrame(frame);
    return e.boneEndpoints(skelId).find((x) => x.bone.id === boneId).tail;
  }, { skelId, boneId, frame });
}

const rect = (center, half = 40) => ({ x: center.x - half, y: center.y - half, x2: center.x + half, y2: center.y + half });

/* ------------------------------------------------------------------ */

console.log('\n— Preparar: tinta y esqueleto de dos huesos —');
// El trazo sobrepasa los puntos que de verdad nos interesan (±200, donde
// van a caer los huesos) porque el filtro One Euro suaviza y por tanto
// retrasa los extremos de cualquier trazo: sin este margen, la tinta justo
// en el punto de partida/llegada del ratón queda floja o ausente, y eso no
// tiene nada que ver con la deformación de malla que se quiere probar aquí.
await stroke([
  [cx - 250, cy],
  [cx - 150, cy - 8],
  [cx, cy],
  [cx + 150, cy + 8],
  [cx + 250, cy],
]);

const setup = await page.evaluate(({ p0, p1 }) => {
  const e = window.__trace;
  const start = e.screenToDoc(p0);
  const end = e.screenToDoc(p1);
  const length = Math.hypot(end.x - start.x, end.y - start.y) / 2;
  const mid = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };

  const skel = e.createSkeleton('Prueba');
  const hombro = e.addBone(skel.id, 'Hombro', null, { x: start.x, y: start.y, length });
  const antebrazo = e.addBone(skel.id, 'Antebrazo', hombro.id, { x: length, y: 0, length });
  const layer = e.doc.layers[0];
  const mesh = e.createMesh(skel.id, 10, 4);
  e.attachLayerToMesh(layer.id, skel.id, mesh.id);

  return {
    skelId: skel.id,
    hombroId: hombro.id,
    antebrazoId: antebrazo.id,
    meshId: mesh.id,
    start,
    end,
    mid,
    length,
  };
}, { p0: { x: cx - 200 - box.x, y: cy - box.y }, p1: { x: cx + 200 - box.x, y: cy - box.y } });
check('la malla queda vinculada a la capa', !!setup.meshId, setup.meshId);

const startInkBefore = await inkCountAtFrame(0, rect(setup.start));
const endInkBefore = await inkCountAtFrame(0, rect(setup.end));
check(
  'hay tinta en ambos extremos antes de posar',
  startInkBefore > 15 && endInkBefore > 15,
  `${startInkBefore}, ${endInkBefore} px`,
);

console.log('\n— Keyframes: reposo en el cuadro 0, giro de 90° en el cuadro 10 —');
await page.evaluate(({ skelId, antebrazoId }) => {
  const e = window.__trace;
  e.setFrame(0);
  e.toggleBoneKeyframe(skelId, antebrazoId, 'rotation'); // fija 0 en el cuadro 0
  e.setFrame(10);
  e.setBonePose(skelId, antebrazoId, { rotation: Math.PI / 2 }); // auto-key en el 10
  e.setFrame(0);
}, { skelId: setup.skelId, antebrazoId: setup.antebrazoId });
await page.waitForTimeout(200);

console.log('\n— Sólo se dobla la mitad unida al hueso posado —');
const startInkAt10 = await inkCountAtFrame(10, rect(setup.start));
const endInkAt10 = await inkCountAtFrame(10, rect(setup.end));
check(
  'el extremo junto al hombro (sin posar) sigue con tinta en su sitio',
  startInkAt10 > startInkBefore * 0.5,
  `${startInkBefore} -> ${startInkAt10} px`,
);
check(
  'el extremo junto al antebrazo (girado 90°) se queda sin tinta en su lugar original',
  endInkAt10 < endInkBefore * 0.4,
  `${endInkBefore} -> ${endInkAt10} px`,
);

console.log('\n— El cuadro intermedio interpola, no salta —');
const tail0 = await tailAt(setup.skelId, setup.antebrazoId, 0);
const tail5 = await tailAt(setup.skelId, setup.antebrazoId, 5);
const tail10 = await tailAt(setup.skelId, setup.antebrazoId, 10);
const distFromRest = Math.hypot(tail5.x - tail0.x, tail5.y - tail0.y);
const distFromTarget = Math.hypot(tail5.x - tail10.x, tail5.y - tail10.y);
check(
  'la cola del hueso en el cuadro 5 no está ni en el reposo ni en el destino',
  distFromRest > 20 && distFromTarget > 20,
  `reposo: ${distFromRest.toFixed(0)}px, destino: ${distFromTarget.toFixed(0)}px`,
);

const inkAtTail5_frame0 = await inkCountAtFrame(0, rect(tail5));
const inkAtTail5_frame5 = await inkCountAtFrame(5, rect(tail5));
check(
  'la tinta deformada por la malla sigue la posición interpolada de la cola',
  inkAtTail5_frame5 > 15 && inkAtTail5_frame5 > inkAtTail5_frame0,
  `cuadro0=${inkAtTail5_frame0}px cuadro5=${inkAtTail5_frame5}px en (${tail5.x.toFixed(0)},${tail5.y.toFixed(0)})`,
);

await documentSnapshot(0, `${out}/rig-mesh-01-reposo.png`);
await documentSnapshot(5, `${out}/rig-mesh-02-intermedio.png`);
await documentSnapshot(10, `${out}/rig-mesh-03-final.png`);

console.log('\n— Deshacer/rehacer de la malla —');
const meshUndo = await page.evaluate(() => {
  const e = window.__trace;
  const before = e.doc.meshes.length;
  // `setBonePose` (el giro de 90° en el cuadro 10) no pasa por el
  // historial a propósito — igual que `setTransformValue` — así que sólo
  // hay tres pasos que deshacer hasta llegar a antes de `createMesh`:
  // el keyframe del cuadro 0, vincular la capa y crear la malla.
  e.history.undo(); // deshace el keyframe del cuadro 0
  e.history.undo(); // deshace attachLayerToMesh
  e.history.undo(); // deshace createMesh
  const afterUndo = e.doc.meshes.length;
  e.history.redo();
  const afterRedo = e.doc.meshes.length;
  return { before, afterUndo, afterRedo };
});
check('deshacer quita la malla del documento', meshUndo.afterUndo === meshUndo.before - 1, JSON.stringify(meshUndo));
check('rehacer la trae de vuelta', meshUndo.afterRedo === meshUndo.before, JSON.stringify(meshUndo));

console.log('\n— Consola —');
check('sin errores en consola', errors.length === 0, errors.join(' | '));

console.log(`\n${failures === 0 ? 'TODO EN VERDE' : `${failures} FALLOS`}\n`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
