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

// Cada pincel del kit dibuja sobre el mismo cel (borrado entre pasadas) y
// comprueba que deja algo de tinta, o que borra lo que había. Va directo al
// motor con coordenadas de documento: no hace falta simular el ratón.
//
// El papel cebolla se apaga y el cel se reutiliza a propósito: crear un cel
// nuevo a resolución completa por cada uno de los 18 pinceles agota el
// presupuesto de texturas residentes de golpe, y bajo esa presión de
// evicción el renderer dispara "Feedback loop formed between Framebuffer
// and active Texture" (ver CHECKPOINT.md, deuda conocida) — un problema
// real del pipeline de composición bajo memoria ajustada, pero ajeno a si
// cada preset de pincel pinta o borra correctamente, que es lo que este
// test quiere aislar.
const results = await page.evaluate(async () => {
  const e = window.__trace;
  e.onion.enabled = false;
  const { DEFAULT_BRUSHES } = await import('/src/core/brush.ts');
  const docCx = e.doc.width / 2;
  const docCy = e.doc.height / 2;
  const marker = DEFAULT_BRUSHES.find((b) => b.id === 'marker');
  const full = { x: 0, y: 0, x2: e.doc.width, y2: e.doc.height };
  const out = [];

  for (const brush of DEFAULT_BRUSHES) {
    e.clearCel(e.activeLayer.id, e.currentFrame);

    // Los borradores necesitan algo debajo para poder demostrar que borran.
    if (brush.erase) {
      const fillCtx = { brush: marker, color: { r: 0, g: 0, b: 0 } };
      e.beginStroke(
        { x: docCx - 100, y: docCy, pressure: 1, altitude: 0, azimuth: 0, time: performance.now() },
        fillCtx,
      );
      e.moveStroke([
        { x: docCx + 100, y: docCy, pressure: 1, altitude: 0, azimuth: 0, time: performance.now() + 16 },
      ]);
      e.endStroke();
    }

    const cel = () => e.activeLayer.cels.get(e.currentFrame).surface;

    // Para pintar, lo que importa es el RGB del compuesto (el alfa es 255 en
    // todas partes por el papel opaco debajo). Para borrar, un pase suave
    // sólo reduce el alfa del cel sin necesariamente cruzar ese umbral de
    // RGB, así que se mide el alfa crudo del propio cel en vez del compuesto.
    let beforeInk;
    if (brush.erase) {
      const px = e.renderer.readRect(cel(), full);
      beforeInk = 0;
      for (let i = 3; i < px.length; i += 4) beforeInk += px[i];
    } else {
      const px = e.renderer.readRect(
        e.compositeGroups({ frame: e.currentFrame, ping: ['p0', 'p1'], includeWet: false }),
        full,
      );
      beforeInk = 0;
      for (let i = 0; i < px.length; i += 4) {
        if (px[i] < 230 || px[i + 1] < 230 || px[i + 2] < 230) beforeInk++;
      }
    }

    // Los borradores pasan por la misma línea que la tinta de relleno, para
    // poder demostrar que borran; los demás dibujan un arco cualquiera.
    const path = brush.erase
      ? [
          { x: docCx - 100, y: docCy },
          { x: docCx, y: docCy },
          { x: docCx + 100, y: docCy },
        ]
      : [
          { x: docCx - 100, y: docCy - 60 },
          { x: docCx, y: docCy - 90 },
          { x: docCx + 100, y: docCy - 60 },
        ];
    const ctx = { brush, color: { r: 0, g: 0, b: 0 } };
    const started = e.beginStroke(
      { x: path[0].x, y: path[0].y, pressure: 1, altitude: 0.3, azimuth: 0.7, time: performance.now() },
      ctx,
    );
    e.moveStroke([
      { x: path[1].x, y: path[1].y, pressure: 0.8, altitude: 0.3, azimuth: 0.7, time: performance.now() + 16 },
      { x: path[2].x, y: path[2].y, pressure: 1, altitude: 0.3, azimuth: 0.7, time: performance.now() + 32 },
    ]);
    e.endStroke();

    let afterInk;
    if (brush.erase) {
      const px = e.renderer.readRect(cel(), full);
      afterInk = 0;
      for (let i = 3; i < px.length; i += 4) afterInk += px[i];
    } else {
      const px = e.renderer.readRect(
        e.compositeGroups({ frame: e.currentFrame, ping: ['p0', 'p1'], includeWet: false }),
        full,
      );
      afterInk = 0;
      for (let i = 0; i < px.length; i += 4) {
        if (px[i] < 230 || px[i + 1] < 230 || px[i + 2] < 230) afterInk++;
      }
    }

    out.push({ id: brush.id, name: brush.name, erase: brush.erase, started, beforeInk, afterInk });
  }
  return out;
}).catch((err) => ({ error: String((err && err.stack) || err) }));

if (results.error) {
  check('el kit entero se evalúa sin excepción', false, results.error);
} else {
  for (const r of results) {
    check(`${r.name} (${r.id}) empieza el trazo`, r.started === true);
    if (r.erase) {
      check(
        `${r.name}: reduce el alfa del cel al pasar por encima`,
        r.afterInk < r.beforeInk,
        `alfa acumulado ${r.beforeInk} -> ${r.afterInk}`,
      );
    } else {
      check(
        `${r.name}: pinta algo medible`,
        Math.abs(r.afterInk - r.beforeInk) > 5,
        `${r.beforeInk} -> ${r.afterInk} px de tinta`,
      );
    }
  }
}

await page.screenshot({ path: `${out}/kit-sanity-01.png` });

log('\n— Consola —');
check('sin errores en consola', errors.length === 0, errors.join(' | '));

log(`\n${failures === 0 ? 'TODO EN VERDE' : `${failures} FALLOS`}\n`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
