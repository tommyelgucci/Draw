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

async function drag(from, to, steps = 10) {
  await page.mouse.move(from[0], from[1]);
  await page.mouse.down();
  await page.mouse.move(to[0], to[1], { steps });
  await page.mouse.up();
  await page.waitForTimeout(150);
}

async function tap(at) {
  await page.mouse.move(at[0], at[1]);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(150);
}

await page.evaluate(() => window.__uiStore.getState().setTool('rig'));
await page.waitForTimeout(100);

/* ------------------------------------------------------------------ */

console.log('\n— Lienzo vacío, sin esqueleto: un toque suelto no crea nada —');
await tap([cx - 300, cy]);
let state = await page.evaluate(() => ({
  skeletons: window.__trace.doc.skeletons.length,
  selected: window.__uiStore.getState().selectedBoneId,
}));
check('un tap no crea esqueleto', state.skeletons === 0, `${state.skeletons} esqueletos`);
check('un tap en vacío deja sin selección', state.selected === null, String(state.selected));

console.log('\n— Arrastrar en lienzo vacío crea el primer hueso —');
await drag([cx - 250, cy], [cx - 100, cy]);
const first = await page.evaluate(() => {
  const e = window.__trace;
  const skel = e.doc.skeletons[0];
  const bone = skel?.bones[0];
  const ep = bone ? e.boneEndpoints(skel.id).find((x) => x.bone.id === bone.id) : null;
  return {
    skeletonCount: e.doc.skeletons.length,
    boneCount: skel?.bones.length ?? 0,
    // OJO: no usar `bone?.parentId ?? 'x'` — parentId legítimamente es
    // `null` para un hueso raíz, y `??` lo confundiría con "no hay hueso".
    parentId: bone ? bone.parentId : 'sin-hueso',
    selected: window.__uiStore.getState().selectedBoneId,
    boneId: bone?.id,
    head: ep?.head,
    tail: ep?.tail,
  };
});
check('crea un esqueleto nuevo', first.skeletonCount === 1, String(first.skeletonCount));
check('crea un hueso raíz (sin padre)', first.boneCount === 1 && first.parentId === null, JSON.stringify(first));
check('el hueso recién creado queda seleccionado', first.selected === first.boneId, String(first.selected));

const headDoc = await page.evaluate((p) => window.__trace.screenToDoc(p), { x: cx - 250 - box.x, y: cy - box.y });
const tailDoc = await page.evaluate((p) => window.__trace.screenToDoc(p), { x: cx - 100 - box.x, y: cy - box.y });
const headErr = Math.hypot(first.head.x - headDoc.x, first.head.y - headDoc.y);
const tailErr = Math.hypot(first.tail.x - tailDoc.x, first.tail.y - tailDoc.y);
check('la cabeza cae donde empezó el arrastre', headErr < 2, `${headErr.toFixed(2)}px de diferencia`);
check('la cola cae donde terminó el arrastre', tailErr < 2, `${tailErr.toFixed(2)}px de diferencia`);

await page.screenshot({ path: `${out}/rig-touch-01-primer-hueso.png` });

console.log('\n— Arrastrar desde la cola encadena un hijo —');
// La cola del primer hueso quedó en (cx-100, cy); seleccionarlo pone ahí
// el tirador de mover, así que primero se deselecciona tocando lejos.
await tap([cx + 400, cy + 300]);
await drag([cx - 100, cy], [cx - 100, cy - 150]);
const chained = await page.evaluate(() => {
  const e = window.__trace;
  const skel = e.doc.skeletons[0];
  const child = skel.bones[1];
  return {
    boneCount: skel.bones.length,
    childId: child?.id,
    childParentId: child?.parentId,
    firstBoneId: skel.bones[0].id,
    selected: window.__uiStore.getState().selectedBoneId,
  };
});
check('se añade un segundo hueso', chained.boneCount === 2, String(chained.boneCount));
check('el segundo hueso es hijo del primero', chained.childParentId === chained.firstBoneId, JSON.stringify(chained));
check('el hijo recién creado queda seleccionado', chained.selected === chained.childId, String(chained.selected));

await page.screenshot({ path: `${out}/rig-touch-02-cadena.png` });

console.log('\n— Un toque corto sobre lienzo vacío deshace y no dispara nada —');
const beforeTap = await page.evaluate(() => window.__trace.doc.skeletons[0].bones.length);
await tap([cx + 250, cy + 250]);
const afterTap = await page.evaluate(() => ({
  boneCount: window.__trace.doc.skeletons[0].bones.length,
  selected: window.__uiStore.getState().selectedBoneId,
}));
check('el toque no deja un hueso microscópico', afterTap.boneCount === beforeTap, `${beforeTap} -> ${afterTap.boneCount}`);
check('el toque en vacío deselecciona', afterTap.selected === null, String(afterTap.selected));

console.log('\n— Deshacer quita el último hueso creado —');
const beforeUndo = await page.evaluate(() => window.__trace.doc.skeletons[0].bones.length);
await page.evaluate(() => window.__trace.history.undo());
const afterUndo = await page.evaluate(() => window.__trace.doc.skeletons[0]?.bones.length ?? 0);
check('deshacer quita el hueso hijo', afterUndo === beforeUndo - 1, `${beforeUndo} -> ${afterUndo}`);

console.log('\n— Consola —');
check('sin errores en consola', errors.length === 0, errors.join(' | '));

console.log(`\n${failures === 0 ? 'TODO EN VERDE' : `${failures} FALLOS`}\n`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
