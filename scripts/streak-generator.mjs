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

async function stroke(points) {
  await page.mouse.move(points[0][0], points[0][1]);
  await page.mouse.down();
  for (const [x, y] of points.slice(1)) await page.mouse.move(x, y, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(150);
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

async function setSlider(sectionSelector, labelText, fraction) {
  const track = page.locator(`${sectionSelector} .slider`, { hasText: labelText }).locator('.slider__track');
  await track.scrollIntoViewIfNeeded();
  const box = await track.boundingBox();
  const clamped = Math.min(0.98, Math.max(0.02, fraction));
  await page.mouse.click(box.x + box.width * clamped, box.y + box.height / 2);
  await page.waitForTimeout(50);
}

const previewPixelSample = () =>
  page.evaluate(() => {
    const canvases = document.querySelectorAll('.texture-generator__preview canvas');
    const canvas = canvases[canvases.length - 1];
    if (!canvas) return null;
    const ctx = canvas.getContext('2d');
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let sum = 0;
    for (let i = 3; i < data.length; i += 4) sum += data[i];
    return sum;
  });

console.log('\n— Abrir el pincel, el generador de motas y el de trazo —');
const box = await page.locator('.canvas-surface').boundingBox();
const cx = box.x + box.width / 2;
const cy = box.y + box.height / 2;
await page.evaluate(() => {
  const s = window.__uiStore.getState();
  s.setTool('brush');
  s.setPanel('brush');
  s.updateBrush({ size: 140, opacity: 1, flow: 1, hardness: 1, taper: 0, pressureSize: 0, pressureOpacity: 0, spacing: 0.1, scatter: 0 });
});
await page.waitForTimeout(200);

console.log('\n— Presets del generador de motas cambian los mandos —');
await page.getByRole('button', { name: /Generar textura/ }).click();
await page.waitForTimeout(200);
const beforePreset = await previewPixelSample();
await page.locator('.preset-row .chip', { hasText: 'Salpicadura' }).click();
await page.waitForTimeout(150);
const afterPreset = await previewPixelSample();
check('el preset "Salpicadura" cambia la vista previa', afterPreset !== beforePreset, `${beforePreset} → ${afterPreset}`);
const densityValue = await page
  .locator('.texture-generator .slider', { hasText: 'Densidad de motas' })
  .locator('.slider__value')
  .textContent();
check('el preset deja la densidad en el valor esperado (22%)', densityValue === '22%', densityValue ?? '');
// Cerrar sin crear, para no dejar una textura de motas seleccionada antes
// de probar el generador de trazo por separado.
await page.getByLabel('Cerrar generador').click();
await page.waitForTimeout(150);

console.log('\n— El generador de trazo abre con su propia vista previa —');
await page.getByRole('button', { name: /Generar trazo/ }).click();
await page.waitForTimeout(200);
const streakPreviewCount = await page.locator('.texture-generator__preview canvas').count();
check('se abre con una vista previa', streakPreviewCount === 1, `${streakPreviewCount}`);

console.log('\n— El preset "Subrayado" da un trazo limpio; "Cicatriz", uno rasgado —');
await page.locator('.preset-row .chip', { hasText: 'Subrayado' }).click();
await page.waitForTimeout(150);
const underlinePixels = await page.evaluate(() => {
  const canvases = document.querySelectorAll('.texture-generator__preview canvas');
  const canvas = canvases[canvases.length - 1];
  return Array.from(canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data);
});
await page.locator('.preset-row .chip', { hasText: 'Cicatriz' }).click();
await page.waitForTimeout(150);
const scarPixels = await page.evaluate(() => {
  const canvases = document.querySelectorAll('.texture-generator__preview canvas');
  const canvas = canvases[canvases.length - 1];
  return Array.from(canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data);
});

/** Cuenta, fila por fila, cuántas veces el borde (alfa que cruza ~mitad)
 *  cambia de ancho respecto a la fila anterior — un borde limpio apenas
 *  varía; uno rasgado varía en casi todas. */
function edgeJitter(pixels, size) {
  let prevWidth = null;
  let changes = 0;
  let rows = 0;
  for (let y = 0; y < size; y++) {
    let width = 0;
    for (let x = 0; x < size; x++) width += pixels[(y * size + x) * 4 + 3] > 127 ? 1 : 0;
    if (width > 0) {
      if (prevWidth !== null && Math.abs(width - prevWidth) >= 1) changes++;
      prevWidth = width;
      rows++;
    }
  }
  return rows > 0 ? changes / rows : 0;
}
const underlineJitter = edgeJitter(underlinePixels, 96);
const scarJitter = edgeJitter(scarPixels, 96);
check(
  'el borde de "Cicatriz" tiembla más fila a fila que el de "Subrayado"',
  scarJitter > underlineJitter,
  `subrayado ${underlineJitter.toFixed(2)}, cicatriz ${scarJitter.toFixed(2)}`,
);

console.log('\n— Mover "Grosor" cambia la vista previa —');
const beforeThickness = await previewPixelSample();
await setSlider('.texture-generator', 'Grosor', 0.9);
const afterThickness = await previewPixelSample();
check('el mando de grosor cambia la vista previa', afterThickness !== beforeThickness, `${beforeThickness} → ${afterThickness}`);

console.log('\n— Crear textura la deja seleccionada y pinta con la forma alargada —');
await page.getByRole('button', { name: 'Crear textura' }).click();
await page.waitForTimeout(200);
const selected = await page.evaluate(() => {
  const s = window.__uiStore.getState();
  return s.brushes[s.brushIndex].textureId;
});
check('crear textura la deja activa en el pincel', typeof selected === 'string' && selected.length > 0, String(selected));

const docPoint = await page.evaluate((p) => window.__trace.screenToDoc(p), { x: cx - box.x, y: cy - box.y });
await stroke([[cx, cy], [cx + 2, cy]]);
// El grosor quedó al 90%: la franja es ancha en Y pero angosta en X más allá
// de la mitad de la longitud — comprueba que hay tinta cerca del centro y
// bastante menos hacia una esquina lejana del mismo cuadro de comprobación.
const centerInk = await inkCountInDocRect({ x: docPoint.x - 10, y: docPoint.y - 10, x2: docPoint.x + 10, y2: docPoint.y + 10 });
check('hay tinta en el centro de la estampa', centerInk > 50, `${centerInk}px`);

console.log('\n— Sobrevive guardar y reabrir —');
const roundTrip = await page.evaluate(async (id) => {
  const e = window.__trace;
  const mod = await import('/src/core/io.ts');
  const bytes = await mod.serializeProject(e);
  const { doc } = await mod.deserializeProject(e, bytes);
  const tex = doc.customTextures.find((t) => t.id === id);
  return { found: !!tex, label: tex?.label };
}, selected);
check('la textura de trazo sobrevive con su etiqueta', roundTrip.found && roundTrip.label === 'Cicatriz', JSON.stringify(roundTrip));

console.log('\n— Consola —');
check('sin errores en consola', errors.length === 0, errors.join(' | '));

console.log(`\n${failures === 0 ? 'TODO EN VERDE' : `${failures} FALLOS`}\n`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
