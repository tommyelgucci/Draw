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

async function strokeLine(y) {
  await page.mouse.move(cx - 250, y);
  await page.mouse.down();
  await page.mouse.move(cx + 250, y, { steps: 20 });
  await page.mouse.up();
  await page.waitForTimeout(150);
}

/** Fracción de píxeles oscuros dentro de una franja horizontal, en coordenadas CSS del lienzo. */
async function inkRatio(centerY, halfHeight) {
  return page.evaluate(
    ({ cx, centerY, halfHeight }) => {
      const c = document.querySelector('canvas');
      const gl = c.getContext('webgl2');
      const dpr = c.width / c.clientWidth;
      const x0 = Math.max(0, Math.round((cx - 260) * dpr));
      const x1 = Math.min(c.width, Math.round((cx + 260) * dpr));
      const y0 = Math.max(0, Math.round((centerY - halfHeight) * dpr));
      const y1 = Math.min(c.height, Math.round((centerY + halfHeight) * dpr));
      const w = x1 - x0;
      const h = y1 - y0;
      if (w <= 0 || h <= 0) return -1;
      const px = new Uint8Array(w * h * 4);
      // readPixels cuenta filas desde abajo; convertimos y0/y1 en pantalla (arriba) a GL.
      const glY0 = c.height - y1;
      gl.readPixels(x0, glY0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
      let dark = 0;
      for (let i = 0; i < px.length; i += 4) {
        if (px[i] < 120 && px[i + 1] < 120 && px[i + 2] < 120) dark++;
      }
      return dark / (w * h);
    },
    { cx, centerY, halfHeight },
  );
}

log('\n— Selector de textura —');
await page.click('.rail--top [aria-label="Pincel"]');
await page.waitForTimeout(300);
const chipCount = await page.locator('.texture-grid .brush-chip').count();
check('cinco opciones (lisa + 4 integradas)', chipCount === 5, `${chipCount}`);
await page.screenshot({ path: `${out}/brush-tex-00-panel.png` });

// Pincel grande y de flujo alto: así el hueco de la textura se nota de sobra.
await page.click('.brush-chip:has-text("Pintura")');
await page.waitForTimeout(150);

log('\n— Punta lisa: cobertura casi completa —');
await page.click('.texture-grid .brush-chip:has-text("Lisa")');
await page.waitForTimeout(150);
await strokeLine(cy - 150);
const lisaRatio = await inkRatio(cy - 150, 24);
// El umbral es bajo a propósito: el pincel de pintura tiene dureza 0.35, así
// que buena parte del borde es semitransparente y no cuenta como "oscuro".
// Lo que importa es la comparación con las puntas texturizadas, más abajo.
check('la punta lisa deja tinta apreciable', lisaRatio > 0.15, `${(lisaRatio * 100).toFixed(1)}%`);

const textured = [
  ['Grano', cy - 60],
  ['Tiza', cy + 30],
  ['Salpicadura', cy + 120],
];

log('\n— Puntas con textura: dejan huecos —');
for (const [label, y] of textured) {
  await page.click(`.texture-grid .brush-chip:has-text("${label}")`);
  await page.waitForTimeout(150);
  const activeLabel = await page.locator('.texture-grid .brush-chip.is-active').innerText();
  check(`"${label}" queda marcada como activa`, activeLabel.trim() === label);
  await strokeLine(y);
  const ratio = await inkRatio(y, 24);
  check(
    `"${label}" cubre notablemente menos que la punta lisa`,
    ratio < lisaRatio * 0.85,
    `${(ratio * 100).toFixed(1)}% vs ${(lisaRatio * 100).toFixed(1)}% lisa`,
  );
}
await page.screenshot({ path: `${out}/brush-tex-01-trazos.png` });

log('\n— No afecta al pincel por defecto —');
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1000);
await strokeLine(cy);
const defaultRatio = await inkRatio(cy, 8);
check(
  'el lápiz por defecto sigue dejando tinta',
  defaultRatio > 0.08,
  `${(defaultRatio * 100).toFixed(1)}%`,
);

log('\n— Consola —');
check('sin errores en consola', errors.length === 0, errors.join(' | '));

log(`\n${failures === 0 ? 'TODO EN VERDE' : `${failures} FALLOS`}\n`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
