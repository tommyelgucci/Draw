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
const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });

const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

await page.goto('http://127.0.0.1:5173/', { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);

/** Rellena un rectángulo de color sólido directo en el cel activo — mismo
 *  patrón que otros scripts (select-wand.mjs, fill.mjs). */
async function writeRect(x0, y0, x1, y1, r, g, b) {
  await page.evaluate(
    ({ x0, y0, x1, y1, r, g, b }) => {
      const e = window.__trace;
      const layer = e.activeLayer;
      if (layer.cels.size === 0) e.addCel(layer.id, e.currentFrame, false);
      const cel = [...layer.cels.values()][0];
      const w = x1 - x0;
      const h = y1 - y0;
      const rect = { x: x0, y: y0, x2: x1, y2: y1 };
      const px = new Uint8Array(w * h * 4);
      for (let i = 0; i < w * h; i++) {
        px[i * 4] = r;
        px[i * 4 + 1] = g;
        px[i * 4 + 2] = b;
        px[i * 4 + 3] = 255;
      }
      e.renderer.writeRect(cel.surface, rect, px);
      e.touch();
    },
    { x0, y0, x1, y1, r, g, b },
  );
}

/** Pinta un solo estampado opaco de `color` con `opacity`/`pigmentMix` dados,
 *  vía el motor directamente (sin ratón): un solo tap, tamaño grande, punta
 *  lisa y dura, sin dinámicas que compliquen leer el resultado. */
async function stampOnce(cx, cy, size, color, opacity, pigmentMix) {
  await page.evaluate(
    ({ cx, cy, size, color, opacity, pigmentMix }) => {
      const e = window.__trace;
      const brush = {
        id: 'test', name: 'test', category: 'paint', size, opacity, flow: 1, hardness: 1,
        spacing: 0.5, pressureSize: 0, pressureOpacity: 0, tiltAspect: 0, velocitySize: 0,
        smoothing: 0, jitterSize: 0, scatter: 0, followDirection: false, angleJitter: 0,
        taper: 0, aspect: 1, erase: false, textureId: null, pigmentMix,
      };
      const ctx = { brush, color };
      e.beginStroke({ x: cx, y: cy, pressure: 1, altitude: 0, azimuth: 0, time: performance.now() }, ctx);
      e.endStroke();
    },
    { cx, cy, size, color, opacity, pigmentMix },
  );
}

async function pixelAt(x, y) {
  return page.evaluate(
    ({ x, y }) => {
      const e = window.__trace;
      const layer = e.activeLayer;
      const cel = [...layer.cels.values()][0];
      const px = e.renderer.readRect(cel.surface, { x, y, x2: x + 1, y2: y + 1 });
      return [px[0], px[1], px[2], px[3]];
    },
    { x, y },
  );
}

const YELLOW = { r: 1, g: 1, b: 0 };
const cx = 300;
const cy = 300;

console.log('\n— pigmentMix=0 se comporta exactamente como antes (gris plano ~127) —');
await writeRect(cx - 150, cy - 150, cx + 150, cy + 150, 0, 0, 255); // fondo azul
await stampOnce(cx, cy, 200, YELLOW, 0.5, 0);
const flat = await pixelAt(cx, cy);
check(
  'mezcla plana en sRGB: ~127 en los tres canales',
  Math.abs(flat[0] - 127) < 6 && Math.abs(flat[1] - 127) < 6 && Math.abs(flat[2] - 127) < 6,
  JSON.stringify(flat),
);

console.log('\n— pigmentMix=1 oscurece notablemente el mismo cruce de colores —');
await writeRect(cx - 150, cy - 150, cx + 150, cy + 150, 0, 0, 255); // resetear a azul
await stampOnce(cx, cy, 200, YELLOW, 0.5, 1);
const mixed = await pixelAt(cx, cy);
check(
  'con mezcla de pigmento al máximo, el resultado es mucho más oscuro que el gris plano',
  mixed[0] < 70 && mixed[1] < 70 && mixed[2] < 70,
  JSON.stringify(mixed),
);
check(
  'no es un simple canal a 0: sigue habiendo algo de color en los tres canales',
  mixed[0] > 5 && mixed[1] > 5 && mixed[2] > 5,
  JSON.stringify(mixed),
);

console.log('\n— A medio camino (50%), el oscurecimiento es intermedio —');
await writeRect(cx - 150, cy - 150, cx + 150, cy + 150, 0, 0, 255);
await stampOnce(cx, cy, 200, YELLOW, 0.5, 0.5);
const half = await pixelAt(cx, cy);
check(
  'pigmentMix=0.5 cae entre el gris plano y el oscurecido al máximo',
  half[0] < flat[0] && half[0] > mixed[0],
  `plano=${flat[0]}, mitad=${half[0]}, máximo=${mixed[0]}`,
);

console.log('\n— Sin tinta debajo (lienzo en blanco), pigmentMix no tiene nada que mezclar —');
await page.evaluate(() => {
  const e = window.__trace;
  const cel = [...e.activeLayer.cels.values()][0];
  e.renderer.clear(cel.surface);
});
await stampOnce(cx, cy, 200, YELLOW, 1, 1);
const onBlank = await pixelAt(cx, cy);
check(
  'sobre lienzo vacío, pigmentMix=1 pinta el amarillo tal cual (nada que mezclar)',
  onBlank[0] > 240 && onBlank[1] > 240 && onBlank[2] < 15,
  JSON.stringify(onBlank),
);

console.log('\n— Borrar ignora pigmentMix por completo —');
await writeRect(cx - 150, cy - 150, cx + 150, cy + 150, 200, 30, 30);
await page.evaluate(
  ({ cx, cy }) => {
    const e = window.__trace;
    const brush = {
      id: 'test-erase', name: 'test', category: 'eraser', size: 200, opacity: 1, flow: 1, hardness: 1,
      spacing: 0.5, pressureSize: 0, pressureOpacity: 0, tiltAspect: 0, velocitySize: 0,
      smoothing: 0, jitterSize: 0, scatter: 0, followDirection: false, angleJitter: 0,
      taper: 0, aspect: 1, erase: true, textureId: null, pigmentMix: 1,
    };
    const ctx = { brush, color: { r: 0, g: 0, b: 0 } };
    e.beginStroke({ x: cx, y: cy, pressure: 1, altitude: 0, azimuth: 0, time: performance.now() }, ctx);
    e.endStroke();
  },
  { cx, cy },
);
const erased = await pixelAt(cx, cy);
check('borrar con pigmentMix=1 en el pincel sigue reduciendo el alfa a 0, no mezcla color', erased[3] < 10, JSON.stringify(erased));

console.log('\n— El kit por defecto: sólo "Brocha ancha" trae mezcla de pigmento —');
const kitCheck = await page.evaluate(async () => {
  const { DEFAULT_BRUSHES } = await import('/src/core/brush.ts');
  return DEFAULT_BRUSHES.filter((b) => b.pigmentMix > 0).map((b) => b.id);
});
// "wide-wash" la usa a propósito (cubrir mucha área de una pasada pide que
// se note dónde se solapa) — ver su comentario en brush.ts.
check('sólo el preset "wide-wash" trae la mezcla activada', kitCheck.length === 1 && kitCheck[0] === 'wide-wash', JSON.stringify(kitCheck));

console.log('\n— Consola —');
check('sin errores en consola', errors.length === 0, errors.join(' | '));

console.log(`\n${failures === 0 ? 'TODO EN VERDE' : `${failures} FALLOS`}\n`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
