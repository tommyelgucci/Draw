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
 *  patrón que pigment-mix.mjs y otros scripts de este repo. */
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

/** Arrastra un pincel de prueba en línea recta de (x0,y) a (x1,y), con
 *  varios puntos intermedios — directo por el motor, sin ratón, para tener
 *  control exacto de las coordenadas de documento. */
async function dragStroke(brushPatch, color, x0, x1, y, steps = 12) {
  await page.evaluate(
    ({ brushPatch, color, x0, x1, y, steps }) => {
      const e = window.__trace;
      const brush = {
        id: 'test', name: 'test', category: 'paint', size: 40, opacity: 1, flow: 1, hardness: 1,
        spacing: 0.1, pressureSize: 0, pressureOpacity: 0, tiltAspect: 0, velocitySize: 0,
        smoothing: 0, jitterSize: 0, scatter: 0, followDirection: false, angleJitter: 0,
        taper: 0, aspect: 1, erase: false, textureId: null, pigmentMix: 0, smudge: 0, smudgeLength: 0.5,
        ...brushPatch,
      };
      const ctx = { brush, color };
      const t0 = performance.now();
      e.beginStroke({ x: x0, y, pressure: 1, altitude: 0, azimuth: 0, time: t0 }, ctx);
      const samples = [];
      for (let i = 1; i <= steps; i++) {
        const x = x0 + ((x1 - x0) * i) / steps;
        samples.push({ x, y, pressure: 1, altitude: 0, azimuth: 0, time: t0 + i * 16 });
      }
      e.moveStroke(samples);
      e.endStroke();
    },
    { brushPatch, color, x0, x1, y, steps },
  );
}

const RED = { r: 0.8, g: 0.05, b: 0.05 };
const BLUE = { r: 0.05, g: 0.05, b: 0.8 };
const GREEN = { r: 0.05, g: 0.8, b: 0.05 };
const cx = 300;
const cy = 300;

console.log('\n— Sin smudge (0), el trazo pinta el color activo del pincel de siempre —');
await writeRect(cx - 200, cy - 100, cx, cy + 100, 220, 20, 20); // izquierda roja
await writeRect(cx, cy - 100, cx + 200, cy + 100, 20, 20, 220); // derecha azul
await dragStroke({ smudge: 0 }, GREEN, cx - 150, cx + 150, cy);
const noSmudgeStart = await pixelAt(cx - 140, cy);
const noSmudgeEnd = await pixelAt(cx + 140, cy);
check(
  'smudge=0: pinta verde al principio del trazo (comportamiento de siempre)',
  noSmudgeStart[1] > 150 && noSmudgeStart[0] < 80 && noSmudgeStart[2] < 80,
  JSON.stringify(noSmudgeStart),
);
check(
  'smudge=0: pinta verde también al final (no recoge nada del lienzo)',
  noSmudgeEnd[1] > 150 && noSmudgeEnd[0] < 80 && noSmudgeEnd[2] < 80,
  JSON.stringify(noSmudgeEnd),
);

console.log('\n— Con smudge=1, el trazo arrastra el color que ya había debajo —');
await writeRect(cx - 200, cy - 100, cx, cy + 100, 220, 20, 20); // reset: izquierda roja
await writeRect(cx, cy - 100, cx + 200, cy + 100, 20, 20, 220); // reset: derecha azul
await dragStroke({ smudge: 1, smudgeLength: 0.3 }, GREEN, cx - 150, cx + 150, cy);
const smudgeStart = await pixelAt(cx - 140, cy);
const smudgeEnd = await pixelAt(cx + 140, cy);
check(
  'smudge=1: cerca del inicio (zona roja) el resultado es rojizo, no verde',
  smudgeStart[0] > smudgeStart[1] && smudgeStart[0] > 80,
  JSON.stringify(smudgeStart),
);
check(
  'smudge=1: cerca del final (zona azul) el resultado es azulado, no rojo ni verde — recogió lo de debajo al cruzar',
  smudgeEnd[2] > smudgeEnd[0] && smudgeEnd[2] > smudgeEnd[1] && smudgeEnd[2] > 80,
  JSON.stringify(smudgeEnd),
);
check(
  'smudge=1: en ningún punto queda el verde del pincel activo sin mezclar',
  smudgeStart[1] < 100 && smudgeEnd[1] < 100,
  `inicio=${JSON.stringify(smudgeStart)}, final=${JSON.stringify(smudgeEnd)}`,
);

console.log('\n— Arrancar "Difuminar" sobre lienzo vacío pinta el color del pincel (nada que recoger todavía) —');
await page.evaluate(() => {
  const e = window.__trace;
  const cel = [...e.activeLayer.cels.values()][0];
  e.renderer.clear(cel.surface);
});
await dragStroke({ smudge: 1, smudgeLength: 0.3 }, GREEN, cx - 150, cx - 60, cy);
const onBlank = await pixelAt(cx - 148, cy);
check(
  'sobre lienzo vacío, "Difuminar" pinta el color activo (verde) al no encontrar nada que arrastrar',
  onBlank[1] > 150 && onBlank[0] < 80 && onBlank[2] < 80,
  JSON.stringify(onBlank),
);

console.log('\n— Borrar ignora smudge por completo —');
await writeRect(cx - 200, cy - 100, cx + 200, cy + 100, 200, 30, 30);
await page.evaluate(
  ({ cx, cy }) => {
    const e = window.__trace;
    const brush = {
      id: 'test-erase', name: 'test', category: 'eraser', size: 60, opacity: 1, flow: 1, hardness: 1,
      spacing: 0.5, pressureSize: 0, pressureOpacity: 0, tiltAspect: 0, velocitySize: 0,
      smoothing: 0, jitterSize: 0, scatter: 0, followDirection: false, angleJitter: 0,
      taper: 0, aspect: 1, erase: true, textureId: null, pigmentMix: 0, smudge: 1, smudgeLength: 0.5,
    };
    const ctx = { brush, color: { r: 0, g: 0, b: 0 } };
    e.beginStroke({ x: cx, y: cy, pressure: 1, altitude: 0, azimuth: 0, time: performance.now() }, ctx);
    e.endStroke();
  },
  { cx, cy },
);
const erased = await pixelAt(cx, cy);
check('borrar con smudge=1 en el pincel sigue reduciendo el alfa a 0, no arrastra color', erased[3] < 10, JSON.stringify(erased));

console.log('\n— El kit por defecto: sólo "Difuminar" trae smudge activado —');
const kitCheck = await page.evaluate(async () => {
  const { DEFAULT_BRUSHES } = await import('/src/core/brush.ts');
  const withSmudge = DEFAULT_BRUSHES.filter((b) => b.smudge > 0).map((b) => b.id);
  return withSmudge;
});
check('sólo el preset "smudge" trae smudge > 0', kitCheck.length === 1 && kitCheck[0] === 'smudge', JSON.stringify(kitCheck));

console.log('\n— Consola —');
check('sin errores en consola', errors.length === 0, errors.join(' | '));

console.log(`\n${failures === 0 ? 'TODO EN VERDE' : `${failures} FALLOS`}\n`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
