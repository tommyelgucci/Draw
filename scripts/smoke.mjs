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
 * Cuenta píxeles por predicado sobre [r,g,b], pero SÓLO dentro del rectángulo
 * del documento: el resto del canvas es el fondo oscuro de la app y ahogaría
 * cualquier medición de tinta.
 */
async function countPixels(predicateSource) {
  return page.evaluate((src) => {
    const fn = new Function('r', 'g', 'b', `return (${src});`);
    const c = document.querySelector('canvas');
    const e = window.__trace;
    const gl = c.getContext('webgl2');
    const dpr = c.width / c.clientWidth;

    const a = e.docToScreen({ x: 0, y: 0 });
    const b = e.docToScreen({ x: e.doc.width, y: e.doc.height });
    const x0 = Math.max(0, Math.round(Math.min(a.x, b.x) * dpr) + 2);
    const x1 = Math.min(c.width, Math.round(Math.max(a.x, b.x) * dpr) - 2);
    // readPixels devuelve la fila 0 abajo; el documento va en coordenadas CSS
    // con la Y hacia abajo, así que hay que voltear el rango vertical.
    const topCss = Math.min(a.y, b.y);
    const bottomCss = Math.max(a.y, b.y);
    const y0 = Math.max(0, Math.round((c.clientHeight - bottomCss) * dpr) + 2);
    const y1 = Math.min(c.height, Math.round((c.clientHeight - topCss) * dpr) - 2);

    const w = x1 - x0;
    const h = y1 - y0;
    if (w <= 0 || h <= 0) return -1;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(x0, y0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let n = 0;
    for (let i = 0; i < px.length; i += 4) if (fn(px[i], px[i + 1], px[i + 2])) n++;
    return n;
  }, predicateSource);
}

log('\n— Arranque —');
check('el motor arranca', !(await page.locator('.fatal').count()));
const white = await countPixels('r > 240 && g > 240 && b > 240');
check('el papel es blanco, no teñido', white > 100000, `${white} px blancos`);

log('\n— Dibujo —');
await stroke([
  [cx - 220, cy - 60],
  [cx - 120, cy - 150],
  [cx, cy - 40],
  [cx + 120, cy - 150],
  [cx + 220, cy - 60],
]);
const ink = await countPixels('r < 100 && g < 100 && b < 100');
check('el trazo deja tinta', ink > 200, `${ink} px`);
await page.screenshot({ path: `${out}/01-trazo.png` });

log('\n— Deshacer / rehacer —');
await page.keyboard.press('Control+z');
await page.waitForTimeout(250);
const afterUndo = await countPixels('r < 100 && g < 100 && b < 100');
check('deshacer borra el trazo', afterUndo < ink * 0.1, `${afterUndo} px`);
await page.keyboard.press('Control+Shift+z');
await page.waitForTimeout(250);
const afterRedo = await countPixels('r < 100 && g < 100 && b < 100');
check('rehacer lo restaura', Math.abs(afterRedo - ink) < ink * 0.05, `${afterRedo} px`);

log('\n— Sostenido de fotograma —');
await page.keyboard.press('ArrowRight');
await page.waitForTimeout(200);
const heldInk = await countPixels('r < 100 && g < 100 && b < 100');
check(
  'el dibujo se sostiene en los cuadros siguientes',
  Math.abs(heldInk - ink) < ink * 0.2,
  `${heldInk} px en el cuadro 1`,
);

log('\n— Papel cebolla —');
// Sin cel propio, dibujar editaría el dibujo sostenido: creamos uno nuevo.
await page.click('[aria-label="Nuevo fotograma vacío"]');
await page.waitForTimeout(250);
const emptied = await countPixels('r < 100 && g < 100 && b < 100');
check('el cuadro nuevo empieza vacío', emptied < ink * 0.1, `${emptied} px`);
await stroke([
  [cx - 150, cy + 100],
  [cx + 150, cy + 60],
]);
await page.waitForTimeout(300);
// El cuadro anterior se tiñe de rojo.
// Un tinte rojo al 35% sobre papel blanco es un rosa claro, no rojo puro.
const red = await countPixels('r > 200 && (r - g) > 25 && (r - b) > 20');
check('el cuadro anterior aparece teñido en rojo', red > 200, `${red} px rojizos`);
const stillWhite = await countPixels('r > 240 && g > 240 && b > 240');
check('el papel sigue blanco con onion activo', stillWhite > 100000, `${stillWhite} px`);
await page.screenshot({ path: `${out}/02-onion.png` });

log('\n— Reproducción —');
await page.click('[aria-label="Reproducir"]');
await page.waitForTimeout(900);
const playing = await page.locator('[aria-label="Pausar"]').count();
check('la reproducción avanza', playing === 1);
await page.click('[aria-label="Pausar"]');

log('\n— Capas y keyframes —');
await page.click('[aria-label="Capas"]');
await page.waitForTimeout(300);
await page.click('[aria-label="Nueva capa"]');
await page.waitForTimeout(250);
const layerCount = await page.locator('.layer').count();
check('se añade una capa', layerCount === 2, `${layerCount} capas`);

// Un keyframe en Posición X.
await page.locator('.transform-row').first().locator('button').click();
await page.waitForTimeout(200);
const keyed = await page.locator('.key-btn.is-key').count();
check('se crea un keyframe', keyed >= 1);
const keyDots = await page.locator('.key-dot').count();
check('el keyframe aparece en la línea de tiempo', keyDots >= 1, `${keyDots} rombos`);
await page.screenshot({ path: `${out}/03-capas.png` });
await page.click('.panel [aria-label="Cerrar"]');

log('\n— Modos de fusión —');
const blendOk = await page.evaluate(() => {
  const e = window.__trace;
  if (!e) return 'sin acceso al motor';
  const modes = [
    'normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten',
    'colorDodge', 'colorBurn', 'hardLight', 'softLight', 'difference',
    'exclusion', 'add',
  ];
  for (const m of modes) {
    e.doc.layers[0].blend = m;
    e.touch();
    e.render();
  }
  e.doc.layers[0].blend = 'normal';
  e.touch();
  e.render();
  return true;
});
check('los 13 modos de fusión renderizan', blendOk === true, String(blendOk));

log('\n— Exportar —');
await page.click('[aria-label="Proyecto"]');
await page.waitForTimeout(300);
const apng = await page.evaluate(async () => {
  const e = window.__trace;
  const mod = await import('/src/core/io.ts');
  const blob = await mod.exportAPNG(e);
  const head = new Uint8Array(await blob.slice(0, 8).arrayBuffer());
  const bytes = new Uint8Array(await blob.arrayBuffer());
  // Busca la firma del chunk acTL, que es lo que hace animado a un PNG.
  let hasActl = false;
  for (let i = 0; i < bytes.length - 4; i++) {
    if (bytes[i] === 97 && bytes[i + 1] === 99 && bytes[i + 2] === 84 && bytes[i + 3] === 76) {
      hasActl = true;
      break;
    }
  }
  return { size: blob.size, png: [...head].join(','), hasActl };
});
check(
  'el APNG tiene firma PNG válida',
  apng.png === '137,80,78,71,13,10,26,10',
  apng.png,
);
check('el APNG lleva chunk acTL (está animado)', apng.hasActl);
check('el APNG tiene contenido', apng.size > 5000, `${apng.size} bytes`);

const roundTrip = await page.evaluate(async () => {
  const e = window.__trace;
  const mod = await import('/src/core/io.ts');
  const before = e.doc.layers.length;
  const bytes = await mod.serializeProject(e);
  const { doc } = await mod.deserializeProject(e, bytes);
  return { before, after: doc.layers.length, name: doc.name, size: bytes.length };
});
check(
  'guardar y abrir conserva las capas',
  roundTrip.before === roundTrip.after,
  `${roundTrip.before} -> ${roundTrip.after}, ${roundTrip.size} bytes`,
);

await page.screenshot({ path: `${out}/04-final.png` });

log('\n— Consola —');
check('sin errores en consola', errors.length === 0, errors.join(' | '));

log(`\n${failures === 0 ? 'TODO EN VERDE' : `${failures} FALLOS`}\n`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
