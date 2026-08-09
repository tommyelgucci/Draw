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

async function drag(from, to, steps = 12) {
  await page.mouse.move(from[0], from[1]);
  await page.mouse.down();
  await page.mouse.move(to[0], to[1], { steps });
  await page.mouse.up();
  await page.waitForTimeout(200);
}

/**
 * Píxeles dibujados en el cel activo.
 *
 * Se mide sobre el cel y no sobre la pantalla a propósito: el contorno
 * animado de la selección son píxeles oscuros que falsearían el recuento.
 */
async function inkPixels() {
  return page.evaluate(() => {
    const e = window.__trace;
    const layer = e.activeLayer;
    const cel = layer && [...layer.cels.values()][0];
    if (!cel) return 0;
    const px = e.renderer.readRect(cel.surface, {
      x: 0,
      y: 0,
      x2: e.doc.width,
      y2: e.doc.height,
    });
    let n = 0;
    for (let i = 3; i < px.length; i += 4) if (px[i] > 40) n++;
    return n;
  });
}

const state = () =>
  page.evaluate(() => {
    const e = window.__trace;
    return {
      active: e.selection.active,
      bounds: e.selection.bounds,
      floating: e.floating
        ? { tx: e.floating.tx, ty: e.floating.ty, scale: e.floating.scale }
        : null,
    };
  });

/* ------------------------------------------------------------------ */

console.log('\n— Crear selección —');
// El papel cebolla teñiría los píxeles y falsearía el conteo de tinta.
await page.evaluate(() => {
  window.__trace.onion.enabled = false;
  window.__trace.touch();
});
// Una banda de trazos paralelos da material suficiente que seleccionar.
for (let i = -4; i <= 4; i++) {
  await drag([cx - 260, cy + i * 12], [cx + 260, cy + i * 12], 16);
}
const painted = await inkPixels();
check('hay pintura para seleccionar', painted > 5000, `${painted} px`);
await page.screenshot({ path: `${out}/sel-01-pintado.png` });

await page.keyboard.press('m');
await page.waitForTimeout(120);
await drag([cx - 120, cy - 90], [cx + 120, cy + 60]);
let s = await state();
check('la selección queda activa', s.active === true);
check(
  'los límites cubren el área arrastrada',
  s.bounds.x2 - s.bounds.x > 50 && s.bounds.y2 - s.bounds.y > 50,
  `${s.bounds.x2 - s.bounds.x}×${s.bounds.y2 - s.bounds.y} px`,
);
await page.screenshot({ path: `${out}/sel-02-seleccion.png` });

console.log('\n— El trazo respeta la selección —');
await page.keyboard.press('b');
await page.waitForTimeout(120);
const beforeClip = await inkPixels();
// Traza muy por fuera de la selección: no debe dejar nada.
await drag([cx - 400, cy + 200], [cx + 400, cy + 200], 20);
const afterClip = await inkPixels();
check(
  'un trazo fuera de la selección no pinta',
  Math.abs(afterClip - beforeClip) < 20,
  `${beforeClip} -> ${afterClip} px`,
);

console.log('\n— Transformar —');
await page.evaluate(() => window.__trace.liftSelection());
await page.waitForTimeout(250);
s = await state();
check('la selección se levanta a flotante', s.floating !== null);
const handles = await page.locator('.sel-handle').count();
check('aparecen los tiradores', handles === 6, `${handles} tiradores`);
await page.screenshot({ path: `${out}/sel-03-flotante.png` });

await page.evaluate(() => window.__trace.updateFloating({ tx: 220, ty: 120, scale: 1.35 }));
await page.waitForTimeout(250);
s = await state();
check('el flotante acepta mover y escalar', s.floating.tx === 220 && s.floating.scale === 1.35);
await page.screenshot({ path: `${out}/sel-04-transformado.png` });

console.log('\n— Confirmar y deshacer —');
const beforeCommit = await inkPixels();
await page.evaluate(() => window.__trace.commitFloating());
await page.waitForTimeout(300);
s = await state();
check('confirmar suelta el flotante', s.floating === null);
const afterCommit = await inkPixels();
check('la imagen cambia al confirmar', afterCommit !== beforeCommit, `${afterCommit} px`);

await page.keyboard.press('Control+z');
await page.waitForTimeout(350);
const afterUndo = await inkPixels();
check(
  'deshacer restaura el estado previo al levantado',
  Math.abs(afterUndo - painted) < painted * 0.02,
  `${painted} original -> ${afterUndo} tras deshacer`,
);
await page.screenshot({ path: `${out}/sel-05-deshecho.png` });

console.log('\n— Atajos —');
await page.keyboard.press('Control+a');
await page.waitForTimeout(200);
s = await state();
check('Ctrl+A selecciona todo', s.active && s.bounds.x === 0 && s.bounds.y === 0);
await page.keyboard.press('Control+d');
await page.waitForTimeout(200);
s = await state();
check('Ctrl+D deselecciona', s.active === false);

console.log('\n— Límites en un lienzo grande, con regiones sin conectar —');
// `commitSelectionCanvas` acota el escaneo a la zona realmente tocada en
// vez de recorrer el documento entero (antes lo hacía siempre, en cada
// gesto) — en un lienzo 4K con selecciones pequeñas y separadas es donde
// más se nota, y es donde una unión de límites mal calculada se notaría.
await page.evaluate(() => window.__trace.newProject(3840, 2160, 12, 24));
await page.waitForTimeout(300);
const largeCanvas = await page.evaluate(() => {
  const e = window.__trace;
  e.beginSelectionDrag();
  e.applySelectionShape('rect', [{ x: 100, y: 100 }, { x: 300, y: 300 }], 'replace');
  const afterReplace = { ...e.selection.bounds };

  e.beginSelectionDrag();
  e.applySelectionShape('rect', [{ x: 3000, y: 1800 }, { x: 3200, y: 2000 }], 'add');
  const afterAdd = { ...e.selection.bounds };

  e.beginSelectionDrag();
  e.applySelectionShape('rect', [{ x: 3050, y: 1850 }, { x: 3150, y: 1950 }], 'subtract');
  const afterSubtract = { ...e.selection.bounds };
  // El punto que se restó no debe seguir en la máscara real, no sólo fuera
  // del rectángulo envolvente.
  const px = e.renderer.readRect(e.selectionMask, { x: 3090, y: 1890, x2: 3091, y2: 1891 });
  const stillInMask = px[3] > 40;
  // El primer rectángulo, intacto, sigue en la máscara.
  const px2 = e.renderer.readRect(e.selectionMask, { x: 150, y: 150, x2: 151, y2: 151 });
  const firstStillThere = px2[3] > 40;

  return { afterReplace, afterAdd, afterSubtract, stillInMask, firstStillThere };
});
check(
  '"replace" da los límites exactos del rectángulo',
  largeCanvas.afterReplace.x === 100 &&
    largeCanvas.afterReplace.y === 100 &&
    largeCanvas.afterReplace.x2 === 300 &&
    largeCanvas.afterReplace.y2 === 300,
  JSON.stringify(largeCanvas.afterReplace),
);
check(
  '"add" con una región sin conectar da la unión exacta',
  largeCanvas.afterAdd.x === 100 &&
    largeCanvas.afterAdd.y === 100 &&
    largeCanvas.afterAdd.x2 === 3200 &&
    largeCanvas.afterAdd.y2 === 2000,
  JSON.stringify(largeCanvas.afterAdd),
);
check(
  '"subtract" quita el punto de la máscara real',
  !largeCanvas.stillInMask,
);
check('el primer rectángulo no se ve afectado por el subtract lejano', largeCanvas.firstStillThere);
// El rectángulo envolvente tras restar un mordisco del medio no se encoge
// (sigue siendo la unión de las dos piezas que sobreviven) — es la misma
// aproximación que ya usaba el código antes de este cambio, documentada
// en el propio comentario de `commitSelectionCanvas`.
check(
  'el rectángulo envolvente tras el subtract sigue cubriendo ambas piezas',
  largeCanvas.afterSubtract.x === 100 && largeCanvas.afterSubtract.x2 === 3200,
  JSON.stringify(largeCanvas.afterSubtract),
);

console.log('\n— Consola —');
check('sin errores en consola', errors.length === 0, errors.join(' | '));

console.log(`\n${failures === 0 ? 'TODO EN VERDE' : `${failures} FALLOS`}\n`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
