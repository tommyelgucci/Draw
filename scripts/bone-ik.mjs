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

async function docToPage(p) {
  const s = await page.evaluate((pt) => window.__trace.docToScreen(pt), p);
  return { x: s.x + box.x, y: s.y + box.y };
}

async function endpoints() {
  return page.evaluate(() => {
    const e = window.__trace;
    const skel = e.doc.skeletons[0];
    return e.boneEndpoints(skel.id).map(({ bone, head, tail }) => ({
      id: bone.id,
      name: bone.name,
      head,
      tail,
    }));
  });
}

/* ------------------------------------------------------------------ */

console.log('\n— Preparar una cadena de 2 huesos: brazo + antebrazo —');
const ids = await page.evaluate(() => {
  const e = window.__trace;
  const skel = e.createSkeleton('Esqueleto');
  const root = e.addBone(skel.id, 'Brazo', null, { x: 300, y: 300, rotation: 0, length: 100 });
  const mid = e.addBone(skel.id, 'Antebrazo', root.id, { x: root.length, y: 0, rotation: 0, length: 100 });
  return { skeletonId: skel.id, rootId: root.id, midId: mid.id };
});
check('el esqueleto tiene 2 huesos', await page.evaluate(() => window.__trace.doc.skeletons[0].bones.length) === 2);

await page.evaluate(() => window.__uiStore.getState().setTool('rig'));
await page.evaluate((id) => window.__uiStore.getState().setSelectedBoneId(id), ids.midId);
await page.waitForTimeout(150);

console.log('\n— Sin IK activada, el tirador rota sólo el hueso seleccionado —');
let handle = page.locator('.bone-handle--rotate');
let handleBox = await handle.boundingBox();
const startPage = { x: handleBox.x + handleBox.width / 2, y: handleBox.y + handleBox.height / 2 };
const targetDocFK = { x: 500, y: 500 };
const targetPageFK = await docToPage(targetDocFK);
await page.mouse.move(startPage.x, startPage.y);
await page.mouse.down();
await page.mouse.move(targetPageFK.x, targetPageFK.y, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(150);

let ep = await endpoints();
const rootAfterFK = ep.find((b) => b.id === ids.rootId);
check(
  'sin IK, el hueso raíz no se movió de su reposo',
  Math.abs(rootAfterFK.tail.x - 400) < 1 && Math.abs(rootAfterFK.tail.y - 300) < 1,
  JSON.stringify(rootAfterFK.tail),
);

console.log('\n— Activar IK y arrastrar la cola dobla la cadena entera —');
const ikBtn = page.locator('.sel-bar button', { hasText: 'IK' });
check('aparece el botón IK (el hueso tiene padre)', (await ikBtn.count()) === 1);
await ikBtn.click();
await page.waitForTimeout(100);
const ikOn = await page.evaluate(() => window.__uiStore.getState().ikEnabled);
check('IK queda activada', ikOn === true);

handle = page.locator('.bone-handle--rotate');
handleBox = await handle.boundingBox();
const start2 = { x: handleBox.x + handleBox.width / 2, y: handleBox.y + handleBox.height / 2 };
// Objetivo alcanzable (dist < len1+len2=200) pero que exige un doblez real
// (dist > 0, no está sobre la línea recta hombro→mano).
const targetDoc = { x: 300 + 120, y: 300 + 60 };
const targetPage = await docToPage(targetDoc);

await page.mouse.move(start2.x, start2.y);
await page.mouse.down();
// Varios pasos intermedios para comprobar que el codo no cambia de lado a
// mitad de arrastre (bendSign fijado al empezar, no recalculado cada frame).
const steps = 6;
const crossSigns = [];
for (let i = 1; i <= steps; i++) {
  const t = i / steps;
  const p = {
    x: start2.x + (targetPage.x - start2.x) * t,
    y: start2.y + (targetPage.y - start2.y) * t,
  };
  await page.mouse.move(p.x, p.y, { steps: 2 });
  const mid = await endpoints();
  const root = mid.find((b) => b.id === ids.rootId);
  const hand = mid.find((b) => b.id === ids.midId);
  const rootHead = root.head;
  const elbow = root.tail;
  const cross =
    (hand.tail.x - rootHead.x) * (elbow.y - rootHead.y) -
    (hand.tail.y - rootHead.y) * (elbow.x - rootHead.x);
  crossSigns.push(Math.sign(cross));
}
await page.mouse.up();
await page.waitForTimeout(150);

const distinctSigns = new Set(crossSigns.filter((s) => s !== 0));
check(
  'el codo se queda del mismo lado durante todo el arrastre',
  distinctSigns.size <= 1,
  JSON.stringify(crossSigns),
);

ep = await endpoints();
const root = ep.find((b) => b.id === ids.rootId);
const mid = ep.find((b) => b.id === ids.midId);

const handErr = Math.hypot(mid.tail.x - targetDoc.x, mid.tail.y - targetDoc.y);
check('la mano llega cerca del objetivo', handErr < 3, `${handErr.toFixed(2)}px de diferencia`);

const elbow = root.tail;
const straightLineErr = Math.abs(
  (elbow.y - root.head.y) * (targetDoc.x - root.head.x) -
    (elbow.x - root.head.x) * (targetDoc.y - root.head.y),
);
check('el codo se dobla (no queda en línea recta hombro→mano)', straightLineErr > 500, `${straightLineErr.toFixed(0)}`);

check(
  'ambos huesos tienen rotaciones numéricas válidas (sin NaN)',
  Number.isFinite(root.tail.x) && Number.isFinite(mid.tail.x),
);

await page.screenshot({ path: `${out}/bone-ik-01-doblado.png` });

console.log('\n— Un objetivo fuera de alcance no rompe la solución (se acota) —');
const farTargetDoc = { x: 300 + 5000, y: 300 };
const farTargetPage = await docToPage(farTargetDoc);
handle = page.locator('.bone-handle--rotate');
handleBox = await handle.boundingBox();
const start3 = { x: handleBox.x + handleBox.width / 2, y: handleBox.y + handleBox.height / 2 };
await page.mouse.move(start3.x, start3.y);
await page.mouse.down();
await page.mouse.move(farTargetPage.x, farTargetPage.y, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(150);
ep = await endpoints();
const midFar = ep.find((b) => b.id === ids.midId);
check(
  'con el objetivo lejísimos, la cadena se estira sin NaN',
  Number.isFinite(midFar.tail.x) && Number.isFinite(midFar.tail.y),
  JSON.stringify(midFar.tail),
);
const reach = Math.hypot(midFar.tail.x - root.head.x, midFar.tail.y - root.head.y);
check('la cadena no se estira más de lo que miden sus huesos', reach <= 201, `${reach.toFixed(1)}px`);

console.log('\n— Desactivar IK vuelve al arrastre normal de un solo hueso —');
await ikBtn.click();
await page.waitForTimeout(100);
const ikOff = await page.evaluate(() => window.__uiStore.getState().ikEnabled);
check('IK queda desactivada', ikOff === false);
const rootRotBefore = await page.evaluate(
  (id) => window.__trace.getBoneValue(window.__trace.doc.skeletons[0].bones.find((b) => b.id === id), 'rotation'),
  ids.rootId,
);
handle = page.locator('.bone-handle--rotate');
handleBox = await handle.boundingBox();
await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
await page.mouse.down();
await page.mouse.move(targetPageFK.x, targetPageFK.y, { steps: 6 });
await page.mouse.up();
await page.waitForTimeout(150);
const rootRotAfter = await page.evaluate(
  (id) => window.__trace.getBoneValue(window.__trace.doc.skeletons[0].bones.find((b) => b.id === id), 'rotation'),
  ids.rootId,
);
check('con IK apagada, el hueso raíz no se toca al rotar el hijo', Math.abs(rootRotAfter - rootRotBefore) < 1e-6);

console.log('\n— Consola —');
check('sin errores en consola', errors.length === 0, errors.join(' | '));

console.log(`\n${failures === 0 ? 'TODO EN VERDE' : `${failures} FALLOS`}\n`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
