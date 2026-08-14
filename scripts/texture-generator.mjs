import { chromium } from 'playwright';

let failures = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? '  ok  ' : ' FALLA'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
};

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || undefined,
  args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });

const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

await page.goto('http://127.0.0.1:5173/', { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);

const box = await page.locator('.canvas-surface').boundingBox();
const cx = box.x + box.width / 2;
const cy = box.y + box.height / 2;

async function stroke(points) {
  await page.mouse.move(points[0][0], points[0][1]);
  await page.mouse.down();
  for (const [x, y] of points.slice(1)) await page.mouse.move(x, y, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(150);
}

/** El slider de Trace no es un `<input type="range">` nativo: es un `div`
 *  arrastrable que calcula el valor desde la posición del puntero (ver
 *  `Slider` en controls.tsx) — un click en la fracción deseada de la pista
 *  basta, `onPointerDown` ya llama a `handle()` sin necesitar arrastre. */
async function setSlider(labelText, fraction) {
  const track = page.locator('.texture-generator .slider', { hasText: labelText }).locator('.slider__track');
  // `boundingBox()` no desplaza el panel con scroll para dejarlo a la vista
  // — a diferencia de `.click()` de Playwright, que sí lo hace solo. Sin
  // esto, un mando fuera del recorte visible de `.panel__body` da una caja
  // que ya no corresponde a lo que hay pintado ahí de verdad.
  await track.scrollIntoViewIfNeeded();
  const box = await track.boundingBox();
  // El borde exacto (fracción 0 o 1) puede caer un sub-píxel fuera del área
  // clicable de verdad; recortar un poco hacia dentro evita ese fallo del
  // arnés de prueba sin cambiar qué valor se está pidiendo en la práctica.
  const clamped = Math.min(0.98, Math.max(0.02, fraction));
  await page.mouse.click(box.x + box.width * clamped, box.y + box.height / 2);
  await page.waitForTimeout(50);
}

async function inkCountInDocRect(rectDoc) {
  return page.evaluate(({ r }) => {
    const e = window.__trace;
    const layer = e.activeLayer;
    const cel = [...layer.cels.values()][0];
    if (!cel) return 0;
    const px = e.renderer.readRect(cel.surface, r);
    let n = 0;
    for (let i = 3; i < px.length; i += 4) if (px[i] > 40) n++;
    return n;
  }, { r: rectDoc });
}

const previewPixelSample = () =>
  page.evaluate(() => {
    const canvas = document.querySelector('.texture-generator__preview canvas');
    if (!canvas) return null;
    const ctx = canvas.getContext('2d');
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let sum = 0;
    for (let i = 3; i < data.length; i += 4) sum += data[i];
    return sum;
  });

console.log('\n— Abrir el pincel y el generador —');
await page.evaluate(() => {
  const s = window.__uiStore.getState();
  s.setTool('brush');
  s.setPanel('brush');
  s.updateBrush({ size: 120, opacity: 1, flow: 1, hardness: 1, taper: 0, pressureSize: 0, pressureOpacity: 0, spacing: 0.1, scatter: 0 });
});
await page.waitForTimeout(200);
await page.getByRole('button', { name: /Generar textura/ }).click();
await page.waitForTimeout(200);
const previewVisible = await page.locator('.texture-generator__preview canvas').count();
check('se abre con una vista previa', previewVisible === 1, `${previewVisible}`);

console.log('\n— Mover un mando cambia la vista previa —');
const before = await previewPixelSample();
const sliderCount = await page.locator('.texture-generator .slider', { hasText: 'Densidad de motas' }).count();
check('el mando de densidad existe', sliderCount === 1, `${sliderCount}`);
await setSlider('Densidad de motas', 1);
const afterDensity = await previewPixelSample();
check('subir la densidad cambia de verdad la vista previa', afterDensity !== before, `${before} → ${afterDensity}`);

console.log('\n— Aleatorizar cambia la semilla (y por tanto la vista previa) —');
await page.getByRole('button', { name: 'Aleatorizar' }).click();
await page.waitForTimeout(150);
const afterRandomize = await previewPixelSample();
check('aleatorizar produce otra textura', afterRandomize !== afterDensity, `${afterDensity} → ${afterRandomize}`);

console.log('\n— Crear textura la deja seleccionada y pinta con huecos —');
// Densidad baja a propósito: con "Aleatorizar" pudo quedar en cualquier
// valor, y con densidad alta casi no quedan huecos que medir (ver la
// lección de scripts/custom-brush-texture.mjs sobre estampas solapadas).
await setSlider('Densidad de motas', 0.35);
await setSlider('Opacidad de mota', 1);
await page.getByRole('button', { name: 'Crear textura' }).click();
await page.waitForTimeout(200);

const selected = await page.evaluate(() => {
  const s = window.__uiStore.getState();
  return s.brushes[s.brushIndex].textureId;
});
check('crear textura la deja activa en el pincel', typeof selected === 'string' && selected.length > 0, String(selected));
check('el generador se cierra tras crear', (await page.locator('.texture-generator').count()) === 0);

const docPoint = await page.evaluate((p) => window.__trace.screenToDoc(p), { x: cx - box.x, y: cy - box.y });
const rect = { x: docPoint.x - 45, y: docPoint.y - 45, x2: docPoint.x + 45, y2: docPoint.y + 45 };
await stroke([[cx, cy], [cx + 2, cy]]);
const ink = await inkCountInDocRect(rect);
const totalPx = 90 * 90;
check(
  'la estampa generada deja huecos reales (no es un círculo liso)',
  ink > 0 && ink < totalPx * 0.85,
  `${ink}/${totalPx}px con tinta`,
);

console.log('\n— Sobrevive guardar y reabrir —');
const roundTrip = await page.evaluate(async (id) => {
  const e = window.__trace;
  const mod = await import('/src/core/io.ts');
  const bytes = await mod.serializeProject(e);
  const { doc } = await mod.deserializeProject(e, bytes);
  const tex = doc.customTextures.find((t) => t.id === id);
  return { found: !!tex, label: tex?.label };
}, selected);
check('la textura generada sobrevive con su etiqueta', roundTrip.found && roundTrip.label === 'Generada', JSON.stringify(roundTrip));

console.log('\n— Consola —');
check('sin errores en consola', errors.length === 0, errors.join(' | '));

console.log(`\n${failures === 0 ? 'TODO EN VERDE' : `${failures} FALLOS`}\n`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
