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

/** Cola del hueso en `frame`, sin dejar el motor en ese fotograma:
 *  cambia `currentFrame`, lee, y lo devuelve a donde estaba. */
async function tailAtFrame(boneId, frame) {
  return page.evaluate(
    (p) => {
      const e = window.__trace;
      const skel = e.doc.skeletons[0];
      const back = e.currentFrame;
      e.currentFrame = p.frame;
      const ep = e.boneEndpoints(skel.id).find((x) => x.bone.id === p.boneId);
      e.currentFrame = back;
      return ep.tail;
    },
    { boneId, frame },
  );
}

async function lineDocTail(selector) {
  const attrs = await page.locator(selector).evaluate((el) => ({
    x: Number(el.getAttribute('x2')),
    y: Number(el.getAttribute('y2')),
  }));
  return page.evaluate((p) => window.__trace.screenToDoc(p), attrs);
}

/* ------------------------------------------------------------------ */

console.log('\n— Preparar un hueso animado: reposo en el cuadro 0, girado en el 10 —');
const ids = await page.evaluate(() => {
  const e = window.__trace;
  const skel = e.createSkeleton('Esqueleto');
  const bone = e.addBone(skel.id, 'Brazo', null, { x: 300, y: 300, rotation: 0, length: 120 });
  e.currentFrame = 0;
  e.toggleBoneKeyframe(skel.id, bone.id, 'rotation');
  e.currentFrame = 10;
  // El canal ya tiene un keyframe (el del cuadro 0): a partir de ahí,
  // `setBonePose` escribe directamente un keyframe en el cuadro actual en
  // vez de tocar `base` — un `toggleBoneKeyframe` después de esto lo
  // QUITARÍA en vez de confirmarlo, porque ya existe.
  e.setBonePose(skel.id, bone.id, { rotation: 1.1 });
  e.currentFrame = 5;
  e.touch();
  return { skeletonId: skel.id, boneId: bone.id };
});

await page.evaluate(() => window.__uiStore.getState().setTool('rig'));
await page.evaluate((id) => window.__uiStore.getState().setSelectedBoneId(id), ids.boneId);
await page.waitForTimeout(150);

console.log('\n— Con papel cebolla activado (por defecto), se ven los fantasmas del hueso —');
const onionState = await page.evaluate(() => window.__trace.onion);
check('el papel cebolla está activo por defecto', onionState.enabled === true, JSON.stringify(onionState));

const beforeCount = await page.locator('.bone-onion line.is-before').count();
const afterCount = await page.locator('.bone-onion line.is-after').count();
check('un fantasma "antes" (onion.before=1, un hueso)', beforeCount === 1, `${beforeCount}`);
check('un fantasma "después" (onion.after=1, un hueso)', afterCount === 1, `${afterCount}`);

const tail4 = await tailAtFrame(ids.boneId, 4);
const tail5 = await tailAtFrame(ids.boneId, 5);
const tail6 = await tailAtFrame(ids.boneId, 6);

const ghostBeforeDoc = await lineDocTail('.bone-onion line.is-before');
const ghostAfterDoc = await lineDocTail('.bone-onion line.is-after');
const currentDoc = await lineDocTail('.bone-outline line');

const errBefore = Math.hypot(ghostBeforeDoc.x - tail4.x, ghostBeforeDoc.y - tail4.y);
const errAfter = Math.hypot(ghostAfterDoc.x - tail6.x, ghostAfterDoc.y - tail6.y);
const errCurrent = Math.hypot(currentDoc.x - tail5.x, currentDoc.y - tail5.y);
check('el fantasma "antes" dibuja la pose del cuadro 4', errBefore < 2, `${errBefore.toFixed(2)}px`);
check('el fantasma "después" dibuja la pose del cuadro 6', errAfter < 2, `${errAfter.toFixed(2)}px`);
check('el hueso actual sigue dibujando el cuadro 5', errCurrent < 2, `${errCurrent.toFixed(2)}px`);

const distFromCurrent = Math.hypot(ghostBeforeDoc.x - currentDoc.x, ghostBeforeDoc.y - currentDoc.y);
check(
  'el fantasma "antes" no coincide con la pose actual (hay animación de por medio)',
  distFromCurrent > 3,
  `${distFromCurrent.toFixed(2)}px`,
);

await page.screenshot({ path: `${out}/bone-onion-01-fantasmas.png` });

console.log('\n— Los colores distinguen antes de después —');
const colorBefore = await page.locator('.bone-onion line.is-before').evaluate((el) => getComputedStyle(el).stroke);
const colorAfter = await page.locator('.bone-onion line.is-after').evaluate((el) => getComputedStyle(el).stroke);
check('"antes" y "después" usan colores distintos', colorBefore !== colorAfter, `${colorBefore} vs ${colorAfter}`);

console.log('\n— Apagar el papel cebolla quita los fantasmas del hueso —');
await page.evaluate(() => {
  window.__trace.onion.enabled = false;
  window.__trace.touch();
});
await page.waitForTimeout(100);
check('sin papel cebolla, no hay fantasmas de hueso', (await page.locator('.bone-onion').count()) === 0);

console.log('\n— Con before=0 y after=0, tampoco hay fantasmas aunque esté activo —');
await page.evaluate(() => {
  window.__trace.onion.enabled = true;
  window.__trace.onion.before = 0;
  window.__trace.onion.after = 0;
  window.__trace.touch();
});
await page.waitForTimeout(100);
check('sin rango de cuadros, no hay fantasmas', (await page.locator('.bone-onion').count()) === 0);

console.log('\n— Consola —');
check('sin errores en consola', errors.length === 0, errors.join(' | '));

console.log(`\n${failures === 0 ? 'TODO EN VERDE' : `${failures} FALLOS`}\n`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
