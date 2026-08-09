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

async function docToPage(p) {
  const s = await page.evaluate((pt) => window.__trace.docToScreen(pt), p);
  return { x: s.x + box.x, y: s.y + box.y };
}

async function state() {
  return page.evaluate(() => {
    const e = window.__trace;
    const skel = e.doc.skeletons[0];
    return {
      order: skel.bones.map((b) => b.id),
      byId: Object.fromEntries(skel.bones.map((b) => [b.id, { parentId: b.parentId, name: b.name }])),
      endpoints: Object.fromEntries(
        e.boneEndpoints(skel.id).map(({ bone, head, tail }) => [bone.id, { head, tail }]),
      ),
    };
  });
}

async function tap(at) {
  await page.mouse.move(at[0], at[1]);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(150);
}

/* ------------------------------------------------------------------ */

console.log('\n— Preparar 3 huesos: A→B encadenados, C aparte —');
const ids = await page.evaluate(() => {
  const e = window.__trace;
  const skel = e.createSkeleton('Esqueleto');
  const a = e.addBone(skel.id, 'A', null, { x: 300, y: 300, rotation: 0, length: 100 });
  const b = e.addBone(skel.id, 'B', a.id, { x: a.length, y: 0, rotation: 0, length: 100 });
  const c = e.addBone(skel.id, 'C', null, { x: 300, y: 500, rotation: 0, length: 80 });
  return { skeletonId: skel.id, aId: a.id, bId: b.id, cId: c.id };
});

await page.evaluate(() => window.__uiStore.getState().setTool('rig'));
await page.waitForTimeout(100);

const before = await state();
check('B empieza colgando de A', before.byId[ids.bId].parentId === ids.aId);
check('C empieza como raíz', before.byId[ids.cId].parentId === null);

console.log('\n— Reparentar B de A a C sin que salte de sitio —');
await page.evaluate((id) => window.__uiStore.getState().setSelectedBoneId(id), ids.bId);
await page.waitForTimeout(100);

const reparentBtn = page.locator('.sel-bar button', { hasText: 'Reparentar' });
check('aparece el botón "Reparentar"', (await reparentBtn.count()) === 1);
await reparentBtn.click();
await page.waitForTimeout(100);

const hint = await page.locator('.sel-bar').textContent();
check('la barra muestra el aviso de "elegir padre"', hint.includes('nuevo padre'), hint);

// Tocar el CUERPO de C (no su cola, para no confundirlo con "encadenar hijo"
// del flujo normal de creación — aquí no debería importar, el modo de
// reparentar intercepta el toque ANTES de esa lógica).
const cMidDoc = { x: 300 + 40, y: 500 };
const cMidPage = await docToPage(cMidDoc);
await tap([cMidPage.x, cMidPage.y]);

const afterReparent = await state();
check('B ahora cuelga de C', afterReparent.byId[ids.bId].parentId === ids.cId, JSON.stringify(afterReparent.byId[ids.bId]));

const headErr = Math.hypot(
  afterReparent.endpoints[ids.bId].head.x - before.endpoints[ids.bId].head.x,
  afterReparent.endpoints[ids.bId].head.y - before.endpoints[ids.bId].head.y,
);
const tailErr = Math.hypot(
  afterReparent.endpoints[ids.bId].tail.x - before.endpoints[ids.bId].tail.x,
  afterReparent.endpoints[ids.bId].tail.y - before.endpoints[ids.bId].tail.y,
);
check('la cabeza de B no se movió al reparentar', headErr < 1, `${headErr.toFixed(2)}px`);
check('la cola de B no se movió al reparentar', tailErr < 1, `${tailErr.toFixed(2)}px`);

const idxC = afterReparent.order.indexOf(ids.cId);
const idxB = afterReparent.order.indexOf(ids.bId);
check('el orden topológico pone a C antes que B', idxC < idxB, `C en ${idxC}, B en ${idxB}`);

await page.screenshot({ path: `${out}/bone-reparent-01-reparentado.png` });

console.log('\n— Deshacer restaura el padre y la posición —');
await page.keyboard.press('Control+z');
await page.waitForTimeout(200);
const afterUndo = await state();
check('deshacer devuelve B a A', afterUndo.byId[ids.bId].parentId === ids.aId);
const undoErr = Math.hypot(
  afterUndo.endpoints[ids.bId].head.x - before.endpoints[ids.bId].head.x,
  afterUndo.endpoints[ids.bId].head.y - before.endpoints[ids.bId].head.y,
);
check('deshacer también restaura la posición exacta', undoErr < 1, `${undoErr.toFixed(2)}px`);

console.log('\n— No se puede crear un ciclo —');
const historyBeforeCycle = await page.evaluate(() => window.__trace.history.past.length);
const cycleRejected = await page.evaluate(
  (p) => {
    const e = window.__trace;
    e.reparentBone(p.skeletonId, p.aId, p.bId); // A cuelga de su propio hijo B: ciclo
    return e.doc.skeletons[0].bones.find((b) => b.id === p.aId).parentId;
  },
  { skeletonId: ids.skeletonId, aId: ids.aId, bId: ids.bId },
);
check('reparentar A bajo su propio hijo B se rechaza', cycleRejected === null, String(cycleRejected));
const historyAfterCycle = await page.evaluate(() => window.__trace.history.past.length);
check('el intento de ciclo no toca el historial', historyAfterCycle === historyBeforeCycle, `${historyBeforeCycle} -> ${historyAfterCycle}`);

console.log('\n— No se puede reparentar un hueso bajo sí mismo —');
const selfRejected = await page.evaluate(
  (p) => {
    const e = window.__trace;
    e.reparentBone(p.skeletonId, p.bId, p.bId);
    return e.doc.skeletons[0].bones.find((b) => b.id === p.bId).parentId;
  },
  { skeletonId: ids.skeletonId, bId: ids.bId },
);
check('reparentar B bajo sí mismo se rechaza', selfRejected === ids.aId, String(selfRejected));

console.log('\n— Desenganchar a raíz tocando lienzo vacío —');
await page.evaluate((id) => window.__uiStore.getState().setSelectedBoneId(id), ids.bId);
await page.waitForTimeout(100);
await reparentBtn.click();
await page.waitForTimeout(100);
const beforeDetach = await state();
// Lejos del centro (donde están A/B/C) pero dentro del lienzo, evitando las
// barras flotantes de las esquinas (deshacer/rehacer arriba, etc.).
await tap([cx + 300, cy + 250]);
const afterDetach = await state();
check('B queda como hueso raíz', afterDetach.byId[ids.bId].parentId === null);
const detachErr = Math.hypot(
  afterDetach.endpoints[ids.bId].head.x - beforeDetach.endpoints[ids.bId].head.x,
  afterDetach.endpoints[ids.bId].head.y - beforeDetach.endpoints[ids.bId].head.y,
);
check('desenganchar a raíz tampoco lo mueve de sitio', detachErr < 1, `${detachErr.toFixed(2)}px`);
await page.keyboard.press('Control+z');
await page.waitForTimeout(150);

console.log('\n— Escape cancela el modo sin tocar nada —');
await page.evaluate((id) => window.__uiStore.getState().setSelectedBoneId(id), ids.bId);
await page.waitForTimeout(100);
await reparentBtn.click();
await page.waitForTimeout(100);
let reparenting = await page.evaluate(() => window.__uiStore.getState().reparentingBoneId);
check('el modo de reparentar queda armado', reparenting === ids.bId);
await page.keyboard.press('Escape');
await page.waitForTimeout(100);
reparenting = await page.evaluate(() => window.__uiStore.getState().reparentingBoneId);
check('Escape lo desarma', reparenting === null);
const afterEscape = await state();
check('Escape no cambió ningún padre', afterEscape.byId[ids.bId].parentId === afterUndo.byId[ids.bId].parentId);

console.log('\n— Consola —');
check('sin errores en consola', errors.length === 0, errors.join(' | '));

console.log(`\n${failures === 0 ? 'TODO EN VERDE' : `${failures} FALLOS`}\n`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
