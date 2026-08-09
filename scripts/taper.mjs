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

/**
 * Dibuja un trazo recto horizontal directo por la API del motor (sin pasar
 * por eventos de puntero: así el perfil de ancho resultante no depende de
 * temporización real) y mide, sin sacar el búfer entero del navegador, el
 * ancho en píxeles opacos de tres columnas: cerca del arranque, en medio y
 * cerca del cierre.
 */
const drawAndMeasure = (taper) =>
  page.evaluate((taper) => {
    const e = window.__trace;
    const base = window.__uiStore.getState().brushes.find((b) => b.id === 'ink');
    const brush = {
      ...base,
      size: 40,
      spacing: 0.05,
      hardness: 1,
      pressureSize: 0,
      velocitySize: 0,
      jitterSize: 0,
      scatter: 0,
      taper,
    };
    const ctx = { brush, color: { r: 0, g: 0, b: 0 } };
    const y = 300;
    const samples = [];
    for (let i = 0; i <= 120; i++) {
      samples.push({ x: 200 + i * 5, y, pressure: 1, altitude: Math.PI / 2, azimuth: 0, time: i * 8 });
    }
    e.beginStroke(samples[0], ctx);
    e.moveStroke(samples.slice(1));
    e.endStroke();

    const layer = e.activeLayer;
    const cel = [...layer.cels.values()][0];
    const px = e.renderer.readRect(cel.surface, { x: 0, y: 0, x2: e.doc.width, y2: e.doc.height });
    const docW = e.doc.width;

    let ink = 0;
    for (let i = 3; i < px.length; i += 4) if (px[i] > 40) ink++;

    const widthAt = (x) => {
      let n = 0;
      for (let dy = -60; dy <= 60; dy++) {
        const idx = ((y + dy) * docW + x) * 4;
        if (px[idx + 3] > 128) n++;
      }
      return n;
    };

    // El extremo geométrico real no siempre llega exacto al último punto de
    // muestreo (el suavizado OneEuroFilter va con inercia y a veces se queda
    // corto) — medir "cerca del cierre" contra el final que de verdad se
    // dibujó, no contra la coordenada de entrada, es lo único que no depende
    // de esa inercia.
    let inkMinX = Infinity;
    let inkMaxX = -Infinity;
    for (let x = 0; x < docW; x++) {
      const idx = (y * docW + x) * 4;
      if (px[idx + 3] > 40) {
        if (x < inkMinX) inkMinX = x;
        if (x > inkMaxX) inkMaxX = x;
      }
    }

    e.history.undo();
    return {
      ink,
      start: widthAt(inkMinX + 10),
      mid: widthAt(500),
      end: widthAt(inkMaxX - 10),
      inkMinX,
      inkMaxX,
    };
  }, taper);

console.log('\n— Trazo recto con afinado de extremos al máximo —');
const tapered = await drawAndMeasure(1);
console.log(
  `  ancho: inicio=${tapered.start}px  medio=${tapered.mid}px  fin=${tapered.end}px` +
    `  (tinta de x=${tapered.inkMinX} a x=${tapered.inkMaxX})`,
);
check('el trazo tapered deja tinta', tapered.ink > 500, `${tapered.ink} px`);
check(
  'el arranque es notablemente más fino que el medio',
  tapered.start < tapered.mid * 0.6,
  `${tapered.start} vs ${tapered.mid}`,
);
check(
  'el cierre es notablemente más fino que el medio',
  tapered.end < tapered.mid * 0.6,
  `${tapered.end} vs ${tapered.mid}`,
);
check('el medio conserva el grosor casi completo del pincel', tapered.mid > 30, `${tapered.mid}px de 40`);

console.log('\n— Mismo trazo sin afinado (taper: 0) — control —');
const flat = await drawAndMeasure(0);
console.log(
  `  ancho: inicio=${flat.start}px  medio=${flat.mid}px  fin=${flat.end}px` +
    `  (tinta de x=${flat.inkMinX} a x=${flat.inkMaxX})`,
);
// Ni siquiera sin afinado el ancho es idéntico hasta la punta exacta: la
// tapa redonda de un pincel circular ya estrecha un poco el perfil cerca del
// extremo (geometría de la tapa, no afinado — a 10px de la punta de una
// tapa de radio 20 el ancho real es ~35px, no 40). El umbral separa eso del
// afinado real, que a la misma distancia deja unos 6px, muy por debajo.
check(
  'sin afinado el arranque no se afina de verdad (sólo la tapa redonda)',
  flat.start > flat.mid * 0.7,
  `${flat.start} vs ${flat.mid}`,
);
check(
  'sin afinado el cierre no se afina de verdad (sólo la tapa redonda)',
  flat.end > flat.mid * 0.7,
  `${flat.end} vs ${flat.mid}`,
);

console.log('\n— Gesto real con pincel de mano alzada (varias llamadas, no un solo lote) —');
await page.evaluate(() => window.__uiStore.getState().updateBrush({ taper: 1 }));
const box = await page.locator('.canvas-surface').boundingBox();
await page.mouse.move(box.x + 300, box.y + 400);
await page.mouse.down();
for (let i = 1; i <= 20; i++) {
  await page.mouse.move(box.x + 300 + i * 15, box.y + 400 + Math.sin(i * 0.3) * 20, { steps: 3 });
}
await page.mouse.up();
await page.waitForTimeout(300);
const freehand = await page.evaluate(() => {
  const e = window.__trace;
  const layer = e.activeLayer;
  const cel = [...layer.cels.values()][0];
  if (!cel) return { count: 0 };
  const px = e.renderer.readRect(cel.surface, { x: 0, y: 0, x2: e.doc.width, y2: e.doc.height });
  let n = 0;
  for (let i = 3; i < px.length; i += 4) if (px[i] > 40) n++;
  return { count: n };
});
check('el trazo de mano alzada con afinado también deja tinta', freehand.count > 200, `${freehand.count} px`);
await page.screenshot({ path: `${out}/taper-freehand.png` });

console.log('\n— Consola —');
check('sin errores en consola', errors.length === 0, errors.join(' | '));

console.log(`\n${failures === 0 ? 'TODO EN VERDE' : `${failures} FALLOS`}\n`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
