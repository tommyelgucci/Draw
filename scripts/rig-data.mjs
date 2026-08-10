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

console.log('\n— Crear esqueleto y huesos —');
const created = await page.evaluate(() => {
  const e = window.__trace;
  const skel = e.createSkeleton('Brazo');
  const hombro = e.addBone(skel.id, 'Hombro', null, { x: 0, y: 0, length: 90 });
  const brazo = e.addBone(skel.id, 'Brazo', hombro.id, { x: 90, y: 0, length: 70 });
  const antebrazo = e.addBone(skel.id, 'Antebrazo', brazo.id, { x: 70, y: 0, length: 60 });
  return {
    skeletonCount: e.doc.skeletons.length,
    boneCount: skel.bones.length,
    order: skel.bones.map((b) => b.name),
    hierarchy: skel.bones.map((b) => b.parentId),
    ids: { skelId: skel.id, hombro: hombro.id, brazo: brazo.id, antebrazo: antebrazo.id },
  };
});
check('hay un esqueleto en el documento', created.skeletonCount === 1, String(created.skeletonCount));
check('el esqueleto tiene 3 huesos', created.boneCount === 3, String(created.boneCount));
check(
  'el orden es topológico (padre antes que hijo)',
  created.order.join(',') === 'Hombro,Brazo,Antebrazo',
  created.order.join(','),
);
check(
  'la jerarquía padre-hijo queda registrada',
  created.hierarchy[1] === created.ids.hombro && created.hierarchy[2] === created.ids.brazo,
  created.hierarchy.join(','),
);

console.log('\n— Pose de reposo: matrices identidad sin keyframes —');
const restCheck = await page.evaluate(async (ids) => {
  const e = window.__trace;
  const rig = await import('/src/core/rig.ts');
  const skel = e.doc.skeletons.find((s) => s.id === ids.skelId);
  const skin = rig.evaluateSkinMatrices(skel, e.currentFrame);
  const m = skin.get(ids.antebrazo);
  return { m: m ? [...m] : null };
}, created.ids);
const isIdentity =
  restCheck.m &&
  Math.abs(restCheck.m[0] - 1) < 1e-6 &&
  Math.abs(restCheck.m[4] - 1) < 1e-6 &&
  Math.abs(restCheck.m[6]) < 1e-6 &&
  Math.abs(restCheck.m[7]) < 1e-6;
check('sin animación, la matriz de piel es identidad', isIdentity, JSON.stringify(restCheck.m));

console.log('\n— Vincular capa a hueso —');
const attach = await page.evaluate((ids) => {
  const e = window.__trace;
  const layer = e.doc.layers[0];
  e.attachLayerToBone(layer.id, ids.skelId, ids.brazo);
  return { rig: layer.rig };
}, created.ids);
check(
  'la capa queda vinculada al hueso',
  attach.rig?.skeletonId === created.ids.skelId && attach.rig?.boneId === created.ids.brazo,
  JSON.stringify(attach.rig),
);

console.log('\n— Guardar y reabrir conserva el rig —');
const roundTrip = await page.evaluate(async (ids) => {
  const e = window.__trace;
  const mod = await import('/src/core/io.ts');
  const bytes = await mod.serializeProject(e);
  const { doc } = await mod.deserializeProject(e, bytes);
  const skel = doc.skeletons.find((s) => s.id === ids.skelId);
  const layer = doc.layers.find((l) => l.rig);
  return {
    size: bytes.length,
    skeletonCount: doc.skeletons.length,
    boneCount: skel ? skel.bones.length : -1,
    boneNames: skel ? skel.bones.map((b) => b.name) : [],
    antebrazoRestX: skel ? skel.bones.find((b) => b.id === ids.antebrazo)?.restX : null,
    layerRig: layer ? layer.rig : null,
  };
}, created.ids);
check('el archivo serializado tiene contenido', roundTrip.size > 0, `${roundTrip.size} bytes`);
check('el esqueleto sobrevive el ciclo', roundTrip.skeletonCount === 1, String(roundTrip.skeletonCount));
check('los 3 huesos sobreviven con su nombre', roundTrip.boneCount === 3, roundTrip.boneNames.join(','));
check('la posición de reposo sobrevive exacta', roundTrip.antebrazoRestX === 70, String(roundTrip.antebrazoRestX));
check(
  'el vínculo capa-hueso sobrevive',
  roundTrip.layerRig?.skeletonId === created.ids.skelId && roundTrip.layerRig?.boneId === created.ids.brazo,
  JSON.stringify(roundTrip.layerRig),
);

console.log('\n— Deshacer —');
const undoBone = await page.evaluate((ids) => {
  const e = window.__trace;
  const skel = e.doc.skeletons.find((s) => s.id === ids.skelId);
  const before = skel.bones.length;
  e.removeBone(ids.skelId, ids.brazo);
  const afterRemove = skel.bones.length;
  const antebrazoParentAfterRemove = skel.bones.find((b) => b.id === ids.antebrazo)?.parentId;
  e.history.undo();
  const afterUndo = skel.bones.length;
  const antebrazoParentAfterUndo = skel.bones.find((b) => b.id === ids.antebrazo)?.parentId;
  return { before, afterRemove, afterUndo, antebrazoParentAfterRemove, antebrazoParentAfterUndo };
}, created.ids);
check(
  'quitar un hueso reengancha a su hijo con el abuelo',
  undoBone.afterRemove === undoBone.before - 1 &&
    undoBone.antebrazoParentAfterRemove === created.ids.hombro,
  JSON.stringify(undoBone),
);
check(
  'deshacer restaura el hueso y su jerarquía original',
  undoBone.afterUndo === undoBone.before &&
    undoBone.antebrazoParentAfterUndo === created.ids.brazo,
  JSON.stringify(undoBone),
);

const undoSkeleton = await page.evaluate(() => {
  const e = window.__trace;
  // Deshace, en orden inverso: vincular capa, añadir antebrazo/brazo/hombro, crear esqueleto.
  for (let i = 0; i < 5; i++) e.history.undo();
  return {
    skeletonCount: e.doc.skeletons.length,
    layerRig: e.doc.layers.find((l) => l.id)?.rig ?? null,
  };
});
check(
  'deshacer todo el historial borra el esqueleto',
  undoSkeleton.skeletonCount === 0,
  String(undoSkeleton.skeletonCount),
);

console.log('\n— Consola —');
check('sin errores en consola', errors.length === 0, errors.join(' | '));

await page.screenshot({ path: `${out}/rig-data-01-final.png` });

console.log(`\n${failures === 0 ? 'TODO EN VERDE' : `${failures} FALLOS`}\n`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
