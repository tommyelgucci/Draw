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

await page.evaluate(() => {
  const s = window.__uiStore.getState();
  s.setTool('brush');
  s.setPanel('brush');
});
await page.waitForTimeout(200);

/* ------------------------------------------------------------------ *
 * Corrección geométrica pura (sin UI): con irregularidad 0, el destello
 * de N rayos debe tener alfa alta exactamente en las direcciones de los
 * rayos y prácticamente nula justo entre dos rayos, al mismo radio.
 * ------------------------------------------------------------------ */
console.log('\n— Geometría del destello: rayos altos, huecos entre rayos bajos —');
const burstGeometry = await page.evaluate(() => {
  return import('/src/core/brushTexture.ts').then((mod) => {
    const size = 128;
    const spokeCount = 8;
    const params = {
      seed: 1,
      spokeCount,
      length: 0.9,
      thickness: 0.06,
      irregularity: 0, // sin temblor: los rayos caen justo en los ángulos exactos
      coreSize: 0,
      opacity: 1,
    };
    const pixels = mod.generateBurstTexturePixels(params, size);
    const cx = size / 2;
    const cy = size / 2;
    const r = size * 0.3;
    const alphaAt = (angle) => {
      const x = Math.round(cx + Math.cos(angle) * r);
      const y = Math.round(cy + Math.sin(angle) * r);
      if (x < 0 || y < 0 || x >= size || y >= size) return 0;
      return pixels[(y * size + x) * 4 + 3];
    };
    const angleStep = (Math.PI * 2) / spokeCount;
    const onSpoke = [];
    const betweenSpokes = [];
    for (let i = 0; i < spokeCount; i++) {
      onSpoke.push(alphaAt(i * angleStep));
      betweenSpokes.push(alphaAt(i * angleStep + angleStep / 2));
    }
    return { onSpoke, betweenSpokes };
  });
});
const avgOnSpoke = burstGeometry.onSpoke.reduce((a, b) => a + b, 0) / burstGeometry.onSpoke.length;
const avgBetween = burstGeometry.betweenSpokes.reduce((a, b) => a + b, 0) / burstGeometry.betweenSpokes.length;
check(
  'sobre cada rayo hay alfa alta',
  avgOnSpoke > 200,
  `promedio ${avgOnSpoke.toFixed(1)}/255`,
);
check(
  'justo entre dos rayos hay alfa baja (el hueco existe de verdad)',
  avgBetween < 30,
  `promedio ${avgBetween.toFixed(1)}/255`,
);

/* ------------------------------------------------------------------ *
 * Panel real: abrir, cambiar preset, aleatorizar, crear, persistir.
 * ------------------------------------------------------------------ */
console.log('\n— Generador de humo: abre, cambia con preset, crea —');
await page.getByRole('button', { name: /Generar humo/ }).click();
await page.waitForTimeout(200);
check('se abre con vista previa', (await page.locator('.texture-generator__preview canvas').count()) === 1);
const beforeWisp = await previewPixelSample();
await page.locator('.preset-row .chip', { hasText: 'Niebla' }).click();
await page.waitForTimeout(150);
const afterWisp = await previewPixelSample();
check('el preset "Niebla" cambia la vista previa', afterWisp !== beforeWisp, `${beforeWisp} → ${afterWisp}`);
await page.getByRole('button', { name: 'Crear textura' }).click();
await page.waitForTimeout(200);
const wispSelected = await page.evaluate(() => {
  const s = window.__uiStore.getState();
  return s.brushes[s.brushIndex].textureId;
});
check('crear textura deja el humo activo en el pincel', typeof wispSelected === 'string' && wispSelected.length > 0, String(wispSelected));

console.log('\n— Generador de destello: abre, cambia con preset, crea —');
await page.getByRole('button', { name: /Generar destello/ }).click();
await page.waitForTimeout(200);
check('se abre con vista previa', (await page.locator('.texture-generator__preview canvas').count()) === 1);
const beforeBurst = await previewPixelSample();
await page.locator('.preset-row .chip', { hasText: 'Chispa' }).click();
await page.waitForTimeout(150);
const afterBurst = await previewPixelSample();
check('el preset "Chispa" cambia la vista previa', afterBurst !== beforeBurst, `${beforeBurst} → ${afterBurst}`);
await page.getByRole('button', { name: 'Crear textura' }).click();
await page.waitForTimeout(200);
const burstSelected = await page.evaluate(() => {
  const s = window.__uiStore.getState();
  return s.brushes[s.brushIndex].textureId;
});
check('crear textura deja el destello activo en el pincel', typeof burstSelected === 'string' && burstSelected.length > 0, String(burstSelected));
check('humo y destello son texturas distintas', wispSelected !== burstSelected);

console.log('\n— Ambas sobreviven guardar y reabrir —');
const roundTrip = await page.evaluate(async ({ wispId, burstId }) => {
  const e = window.__trace;
  const mod = await import('/src/core/io.ts');
  const bytes = await mod.serializeProject(e);
  const { doc } = await mod.deserializeProject(e, bytes);
  return {
    wisp: doc.customTextures.find((t) => t.id === wispId)?.label,
    burst: doc.customTextures.find((t) => t.id === burstId)?.label,
  };
}, { wispId: wispSelected, burstId: burstSelected });
check('la textura de humo sobrevive con su etiqueta', roundTrip.wisp === 'Niebla', JSON.stringify(roundTrip));
check('la textura de destello sobrevive con su etiqueta', roundTrip.burst === 'Chispa', JSON.stringify(roundTrip));

console.log('\n— Consola —');
check('sin errores en consola', errors.length === 0, errors.join(' | '));

console.log(`\n${failures === 0 ? 'TODO EN VERDE' : `${failures} FALLOS`}\n`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
