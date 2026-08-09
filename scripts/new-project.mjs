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
  await page.waitForTimeout(150);
}

const inkPixels = () =>
  page.evaluate(() => {
    const e = window.__trace;
    const layer = e.activeLayer;
    const cel = layer && [...layer.cels.values()][0];
    if (!cel) return 0;
    const px = e.renderer.readRect(cel.surface, { x: 0, y: 0, x2: e.doc.width, y2: e.doc.height });
    let n = 0;
    for (let i = 3; i < px.length; i += 4) if (px[i] > 40) n++;
    return n;
  });

console.log('\n— Dibujar en el proyecto original —');
await drag([cx - 150, cy - 80], [cx + 150, cy + 120]);
const painted = await inkPixels();
check('hay tinta antes de empezar de cero', painted > 500, `${painted} px`);

console.log('\n— Abrir el panel de Proyecto —');
await page.getByTitle('Proyecto').click();
await page.waitForTimeout(200);
const sectionVisible = await page.getByText('Proyecto nuevo').count();
check('aparece la sección "Proyecto nuevo"', sectionVisible > 0);
await page.screenshot({ path: `${out}/np-01-panel.png` });

console.log('\n— Elegir Pintura + Cuadrado, confirmar —');
await page.getByRole('button', { name: 'Pintura' }).click();
await page.getByRole('button', { name: /Cuadrado/ }).last().click();
await page.getByRole('button', { name: 'Nuevo proyecto' }).click();
await page.waitForTimeout(150);
const confirmVisible = await page.getByText('Sí, empezar de cero').count();
check('pide confirmación antes de descartar', confirmVisible > 0);
await page.screenshot({ path: `${out}/np-02-confirmar.png` });

await page.getByRole('button', { name: 'Sí, empezar de cero' }).click();
await page.waitForTimeout(300);

const state = await page.evaluate(() => {
  const e = window.__trace;
  return {
    w: e.doc.width,
    h: e.doc.height,
    frameCount: e.doc.frameCount,
    layers: e.doc.layers.length,
    showTimeline: window.__uiStore.getState().showTimeline,
  };
});
console.log('estado tras crear:', JSON.stringify(state));
check('el lienzo mide 1500×1500 (preset Cuadrado)', state.w === 1500 && state.h === 1500, JSON.stringify(state));
check('Pintura arranca con 1 fotograma', state.frameCount === 1, `${state.frameCount}`);
check('tiene una capa nueva ("Capa 1")', state.layers === 1, `${state.layers}`);
check('la línea de tiempo se oculta en modo Pintura', state.showTimeline === false);

const afterNew = await inkPixels();
check('el lienzo nuevo está en blanco', afterNew === 0, `${afterNew} px`);
await page.screenshot({ path: `${out}/np-03-nuevo-en-blanco.png` });

console.log('\n— Animación + HD, sin confirmar bien —');
await page.getByRole('button', { name: 'Animación', exact: true }).click();
await page.getByRole('button', { name: /HD 16:9/ }).last().click();
await page.getByRole('button', { name: 'Nuevo proyecto' }).click();
await page.getByRole('button', { name: 'Cancelar' }).click();
await page.waitForTimeout(150);
const stillSquare = await page.evaluate(() => ({ w: window.__trace.doc.width, h: window.__trace.doc.height }));
check('Cancelar no toca el documento actual', stillSquare.w === 1500 && stillSquare.h === 1500, JSON.stringify(stillSquare));

await page.getByRole('button', { name: 'Nuevo proyecto' }).click();
await page.getByRole('button', { name: 'Sí, empezar de cero' }).click();
await page.waitForTimeout(300);
const animState = await page.evaluate(() => ({
  w: window.__trace.doc.width,
  h: window.__trace.doc.height,
  frameCount: window.__trace.doc.frameCount,
  showTimeline: window.__uiStore.getState().showTimeline,
}));
check('HD 16:9 + Animación crea 1920×1080, 24 cuadros, timeline visible',
  animState.w === 1920 && animState.h === 1080 && animState.frameCount === 24 && animState.showTimeline === true,
  JSON.stringify(animState));

console.log('\n— Consola —');
check('sin errores en consola', errors.length === 0, errors.join(' | '));

console.log(`\n${failures === 0 ? 'TODO EN VERDE' : `${failures} FALLOS`}\n`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
