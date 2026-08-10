import { chromium } from 'playwright';

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
 * Escribe un anillo rectangular de píxeles negros opacos directo en el cel
 * activo (sin pasar por `StrokeBuilder`: el suavizado del trazo no
 * garantiza tocar exactamente la esquina, así que un rectángulo dibujado a
 * mano alzada no sirve para aislar `floodFill` de verdad) y mide cuánto
 * tarda rellenar su interior. `sizeLabel` sólo es para el log.
 */
const drawRingAndFill = ({ x0, y0, x1, y1, thickness }, fillPoint, sizeLabel) =>
  page.evaluate(
    async ({ x0, y0, x1, y1, thickness, fillPoint, sizeLabel }) => {
      const e = window.__trace;
      const layer = e.activeLayer;
      e.addCel(layer.id, e.currentFrame, false);
      const cel = [...layer.cels.values()][0];
      const w = x1 - x0;
      const h = y1 - y0;
      const rect = { x: x0, y: y0, x2: x1, y2: y1 };
      const px = new Uint8Array(w * h * 4);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const onRing =
            x < thickness || x >= w - thickness || y < thickness || y >= h - thickness;
          if (!onRing) continue;
          const o = (y * w + x) * 4;
          px[o] = 0;
          px[o + 1] = 0;
          px[o + 2] = 0;
          px[o + 3] = 255;
        }
      }
      e.renderer.writeRect(cel.surface, rect, px);
      e.touch();

      const median = async (fn) => {
        const times = [];
        for (let i = 0; i < 5; i++) {
          const t0 = performance.now();
          await fn();
          times.push(performance.now() - t0);
        }
        times.sort((a, b) => a - b);
        return times[Math.floor(times.length / 2)];
      };

      // `floodFill` empieza leyendo por GPU el lienzo entero como
      // referencia (`gl.readPixels`) — coste fijo, igual para un relleno
      // diminuto que para uno enorme, y en SwiftShader domina tanto que tapa
      // la señal que sí importa (el coste del resto, que ahora escala con
      // el área rellenada). Medir esa lectura por separado y restarla aísla
      // la parte que este cambio corrige.
      const full0 = { x: 0, y: 0, x2: e.doc.width, y2: e.doc.height };
      const baseline = await median(() => e.renderer.readRect(cel.surface, full0));

      // Deshacer entre repetición y repetición, no encadenarlas: el paso de
      // "crecimiento" no mira color, sólo adyacencia a lo ya lleno, así que
      // rellenar dos veces seguidas sobre el mismo punto se va comiendo el
      // anillo un par de píxeles cada vez — no es un caso real (nadie hace
      // clic cinco veces seguidas en el mismo sitio), pero sí falsea la
      // medición si no se limpia el estado entre una repetición y la
      // siguiente. `floodFill` es asíncrono (el barrido corre en un worker),
      // así que hay que esperarlo antes de deshacer.
      const elapsed = await median(async () => {
        await e.floodFill(fillPoint, { r: 0.9, g: 0.2, b: 0.2 });
        e.history.undo();
      });
      // El último deshecho ya limpió el estado; vuelve a rellenar una sola
      // vez para dejar el resultado que el resto del test espera leer.
      await e.floodFill(fillPoint, { r: 0.9, g: 0.2, b: 0.2 });

      const full = e.renderer.readRect(cel.surface, full0);
      let filledCount = 0;
      for (let i = 0; i < full.length; i += 4) {
        if (full[i] > 180 && full[i + 1] < 120 && full[i + 2] < 120) filledCount++;
      }
      return { elapsed, baseline, delta: Math.max(0, elapsed - baseline), filledCount, sizeLabel };
    },
    { x0, y0, x1, y1, thickness, fillPoint, sizeLabel },
  );

console.log('\n— Lienzo grande (4K) —');
await page.evaluate(() => window.__trace.newProject(3840, 2160, 12, 24));
await page.waitForTimeout(300);

console.log('\n— Relleno pequeño dentro de un rectángulo diminuto —');
const small = await drawRingAndFill(
  { x0: 100, y0: 100, x1: 140, y1: 140, thickness: 4 },
  { x: 120, y: 120 },
  'pequeño',
);
console.log(
  `  ${small.elapsed.toFixed(1)} ms (lectura de referencia ${small.baseline.toFixed(1)} ms, resto ${small.delta.toFixed(1)} ms) — ${small.filledCount} px rellenados`,
);
// Interior de 32×32 tras descontar el grosor del anillo (4px por lado).
check('el relleno pequeño cubre el área esperada', small.filledCount > 800 && small.filledCount < 1400, `${small.filledCount} px`);

console.log('\n— Deshacer el relleno pequeño —');
await page.evaluate(() => window.__trace.history.undo());
await page.waitForTimeout(150);
const afterUndo = await page.evaluate(() => {
  const e = window.__trace;
  const px = e.renderer.readRect(e.activeLayer.cels.values().next().value.surface, {
    x: 0,
    y: 0,
    x2: e.doc.width,
    y2: e.doc.height,
  });
  let n = 0;
  for (let i = 0; i < px.length; i += 4) if (px[i] > 180 && px[i + 1] < 120 && px[i + 2] < 120) n++;
  return n;
});
check('deshacer quita el relleno (el anillo se conserva)', afterUndo === 0, `${afterUndo} px rojizos`);

console.log('\n— Relleno grande, casi todo el lienzo —');
await page.evaluate(() => window.__trace.newProject(3840, 2160, 12, 24));
await page.waitForTimeout(300);
const large = await drawRingAndFill(
  { x0: 60, y0: 60, x1: 3780, y1: 2100, thickness: 6 },
  { x: 1920, y: 1080 },
  'grande',
);
console.log(
  `  ${large.elapsed.toFixed(1)} ms (lectura de referencia ${large.baseline.toFixed(1)} ms, resto ${large.delta.toFixed(1)} ms) — ${large.filledCount} px rellenados`,
);
const expectedLarge = (3780 - 60 - 12) * (2100 - 60 - 12);
check(
  'el relleno grande cubre el interior esperado',
  Math.abs(large.filledCount - expectedLarge) < expectedLarge * 0.01,
  `${large.filledCount} px de ${expectedLarge} esperados`,
);

// Informativo, no una condición de paso: acotar los bucles de crecimiento y
// de aplicar color a la caja del relleno (antes recorrían el lienzo entero,
// aunque el área rellenada fuera diminuta) es correcto por inspección del
// código y está cubierto por las comprobaciones de arriba (el resultado no
// cambia). `elapsed`/`delta` miden desde que se llama a `floodFill` hasta
// que su promesa resuelve — incluyen el viaje de ida y vuelta al worker,
// que corre el barrido/crecimiento/color fuera del hilo principal (ver
// core/flood.ts y workers/floodFill.worker.ts), pero `floodFill` hace
// además dos lecturas de GPU del lienzo completo (la referencia compuesta
// y el cel) ANTES de mandar nada al worker — ésas no se pueden mover: hace
// falta el contexto WebGL vivo, que sólo existe en el hilo principal. Ese
// coste fijo, ajeno al tamaño del relleno, domina tanto el tiempo total en
// SwiftShader que ni con ~5900x más área rellenada se ve una diferencia
// limpia. Ver CLAUDE.md: "no midas rendimiento absoluto ahí, sólo
// comparativas" — y aquí ni así alcanza. Lo que sí importa de este cambio
// —que el hilo principal no se quede bloqueado durante el barrido— no se
// puede medir con un cronómetro sincrónico como éste; se comprueba en el
// navegador, no aquí.
console.log('\n— Coste del resto (informativo, no se falla por esto) —');
console.log(
  `  pequeño ${small.delta.toFixed(1)} ms vs grande ${large.delta.toFixed(1)} ms — ` +
    `${small.delta < large.delta ? 'en la dirección esperada' : 'ruido del entorno de pruebas'}`,
);

console.log('\n— El relleno no se sale del borde —');
const outside = await page.evaluate(() => {
  const e = window.__trace;
  const px = e.renderer.readRect(e.activeLayer.cels.values().next().value.surface, {
    x: 0,
    y: 0,
    x2: e.doc.width,
    y2: e.doc.height,
  });
  // Justo fuera del rectángulo grande, cerca de una esquina del lienzo.
  const idx = (10 * e.doc.width + 10) * 4;
  return { r: px[idx], g: px[idx + 1], b: px[idx + 2], a: px[idx + 3] };
});
check('fuera del rectángulo sigue sin tocar', outside.a === 0, JSON.stringify(outside));

console.log('\n— Dos rellenos a la vez no se cruzan (worker compartido) —');
// El worker de floodFill es uno solo para toda la vida del Engine; nada en
// la UI bloquea el lienzo mientras la promesa está en vuelo (sólo hay un
// indicador visual), así que un doble toque rápido en dos sitios distintos
// manda dos peticiones al mismo worker antes de que la primera responda.
// Bug real y ya corregido: antes cada llamada registraba su propio listener
// `once:true` en el worker, y CUALQUIERA de esos listeners se disparaba con
// el PRIMER mensaje que llegara — la segunda promesa resolvía con los datos
// del primer relleno (rect/color equivocados) y la respuesta de verdad se
// perdía sin que nadie la recogiera. La corrección correlaciona cada
// petición por id con un único handler fijo.
const concurrent = await page.evaluate(async () => {
  const e = window.__trace;
  e.newProject(400, 400, 12, 1);
  await new Promise((r) => setTimeout(r, 50));
  const layer = e.activeLayer;
  e.addCel(layer.id, e.currentFrame, false);
  const cel = [...layer.cels.values()][0];
  // Dos anillos separados, cada uno con su propio interior a rellenar.
  const drawRing = (x0, y0, x1, y1) => {
    const w = x1 - x0;
    const h = y1 - y0;
    const rect = { x: x0, y: y0, x2: x1, y2: y1 };
    const px = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const onRing = x < 3 || x >= w - 3 || y < 3 || y >= h - 3;
        if (!onRing) continue;
        const o = (y * w + x) * 4;
        px[o] = 0;
        px[o + 1] = 0;
        px[o + 2] = 0;
        px[o + 3] = 255;
      }
    }
    e.renderer.writeRect(cel.surface, rect, px);
  };
  drawRing(20, 20, 100, 100);
  drawRing(200, 200, 320, 320);
  e.touch();

  // Sin `await` entre una y otra: las dos peticiones llegan al worker antes
  // de que la primera responda.
  const pA = e.floodFill({ x: 60, y: 60 }, { r: 0.9, g: 0.1, b: 0.1 }); // rojo
  const pB = e.floodFill({ x: 260, y: 260 }, { r: 0.1, g: 0.2, b: 0.9 }); // azul
  await Promise.all([pA, pB]);

  const full = e.renderer.readRect(cel.surface, { x: 0, y: 0, x2: 400, y2: 400 });
  const at = (x, y) => {
    const o = (y * 400 + x) * 4;
    return { r: full[o], g: full[o + 1], b: full[o + 2], a: full[o + 3] };
  };
  return { insideA: at(60, 60), insideB: at(260, 260) };
});
check(
  'el relleno A quedó rojo en su propia región',
  concurrent.insideA.r > 180 && concurrent.insideA.b < 100,
  JSON.stringify(concurrent.insideA),
);
check(
  'el relleno B quedó azul en su propia región, no rojo',
  concurrent.insideB.b > 180 && concurrent.insideB.r < 100,
  JSON.stringify(concurrent.insideB),
);

console.log('\n— Consola —');
check('sin errores en consola', errors.length === 0, errors.join(' | '));

console.log(`\n${failures === 0 ? 'TODO EN VERDE' : `${failures} FALLOS`}\n`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
