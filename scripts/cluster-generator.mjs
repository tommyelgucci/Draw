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

/* ------------------------------------------------------------------ *
 * Geometría en frío: lo que pide el usuario es que UNA textura ya
 * contenga VARIAS hebras separadas — no una sola marca. Se comprueba
 * contando, en una fila horizontal cerca de la base, cuántos tramos
 * de alfa alto hay separados por huecos de alfa bajo.
 * ------------------------------------------------------------------ */
console.log('\n— Geometría: una sola textura contiene varias hebras separadas —');
const clusterGeometry = await page.evaluate(() => {
  return import('/src/core/brushTexture.ts').then((mod) => {
    const size = 128;
    const params = {
      seed: 7, count: 10, bladeLength: 0.75, lengthVariation: 0.1, thickness: 0.03,
      taper: 0.7, roughness: 0, spread: 0.85, angleSpread: 0.05, opacity: 1,
    };
    const pixels = mod.generateClusterTexturePixels(params, size);
    // Fila cerca de la base (90% de la altura, donde nacen las hebras) pero
    // ya por encima del ensanche de arranque de cada una.
    const y = Math.round(size * 0.75);
    const row = [];
    for (let x = 0; x < size; x++) row.push(pixels[(y * size + x) * 4 + 3]);
    let segments = 0;
    let inSegment = false;
    for (const a of row) {
      const on = a > 120;
      if (on && !inSegment) segments++;
      inSegment = on;
    }
    return { segments, maxAlpha: Math.max(...row) };
  });
});
check(
  'aparecen varios tramos separados de tinta en una sola fila (no un solo bloque)',
  clusterGeometry.segments >= 4,
  `${clusterGeometry.segments} tramos, alfa máx ${clusterGeometry.maxAlpha}`,
);

/* ------------------------------------------------------------------ *
 * "Paralela" reparte las hebras en fila con ángulo casi idéntico, a
 * diferencia de "Dispersa" que las abre en abanico al azar — el pedido
 * explícito de que el pelo sea uniforme, no un manojo desordenado.
 * ------------------------------------------------------------------ */
console.log('\n— "Paralela" mantiene las hebras casi verticales; "Dispersa" las abre en abanico —');
const layoutGeometry = await page.evaluate(() => {
  return import('/src/core/brushTexture.ts').then((mod) => {
    const size = 128;
    // spread=0: todas las bases nacen del mismo punto en ambos modos, así
    // que el ancho de las puntas mide sólo el efecto del ÁNGULO, sin que la
    // dispersión de posición de base (idéntica en los dos) lo enmascare.
    const base = {
      seed: 11, count: 16, bladeLength: 0.85, lengthVariation: 0.1, thickness: 0.02,
      taper: 0.85, roughness: 0, curl: 0, spread: 0, angleSpread: 0.6, opacity: 1,
    };
    // Ancho de la franja con tinta cerca de la punta (85% del largo desde la
    // base, misma fórmula que usa el generador: base en 0.9·size, largo
    // 0.5·size·bladeLength): hebras verticales caen todas cerca del centro
    // ahí; hebras en abanico se separan mucho más según su ángulo.
    const y = Math.round(size * 0.9 - size * 0.5 * base.bladeLength * 0.85);
    // Percentil 10-90 en vez de min/max: con "Paralela" un puñado de
    // flyaways (12% de las hebras) sí toma el abanico completo a propósito
    // — igual que en "Dispersa" — así que min/max los deja pesar demasiado
    // y ahoga la diferencia real, que está en el GRUESO de las hebras.
    const tipSpread = (pixels) => {
      const xs = [];
      for (let x = 0; x < size; x++) {
        if (pixels[(y * size + x) * 4 + 3] > 60) xs.push(x);
      }
      if (xs.length === 0) return 0;
      xs.sort((a, b) => a - b);
      const p10 = xs[Math.floor(xs.length * 0.1)];
      const p90 = xs[Math.min(xs.length - 1, Math.floor(xs.length * 0.9))];
      return p90 - p10;
    };
    const parallelSpread = tipSpread(mod.generateClusterTexturePixels({ ...base, layout: 'parallel' }, size));
    const scatterSpread = tipSpread(mod.generateClusterTexturePixels({ ...base, layout: 'scatter' }, size));
    return { parallelSpread, scatterSpread };
  });
});
check(
  '"Paralela" junta las puntas más que "Dispersa" con el mismo abanico pedido',
  layoutGeometry.parallelSpread < layoutGeometry.scatterSpread * 0.85,
  `paralela=${layoutGeometry.parallelSpread}px, dispersa=${layoutGeometry.scatterSpread}px`,
);

/* ------------------------------------------------------------------ *
 * "Curvatura" combado en arco: con curl=0 la hebra es recta (el punto
 * medio cae justo en el eje); con curl alto, el punto medio se desvía.
 * ------------------------------------------------------------------ */
console.log('\n— "Curvatura" combado en arco: recta en 0, desviada en el resto —');
const curlGeometry = await page.evaluate(() => {
  return import('/src/core/brushTexture.ts').then((mod) => {
    const size = 128;
    // Una sola hebra centrada y vertical (spread=0, angleSpread=0, count=1)
    // para medir el combado sin que otras hebras estorben la lectura.
    const base = {
      seed: 5, count: 1, bladeLength: 0.8, lengthVariation: 0, thickness: 0.04,
      taper: 0.3, roughness: 0, spread: 0, angleSpread: 0, opacity: 1,
    };
    // A mitad de la hebra (donde el combado es máximo), ¿dónde está el
    // centro de la tinta respecto al eje vertical x=size/2?
    const centerOffsetAtMidHeight = (pixels) => {
      const y = Math.round(size * 0.55);
      let sum = 0, count = 0;
      for (let x = 0; x < size; x++) {
        if (pixels[(y * size + x) * 4 + 3] > 120) {
          sum += x;
          count++;
        }
      }
      return count > 0 ? sum / count - size / 2 : 0;
    };
    const straight = centerOffsetAtMidHeight(mod.generateClusterTexturePixels({ ...base, curl: 0 }, size));
    const curled = centerOffsetAtMidHeight(mod.generateClusterTexturePixels({ ...base, curl: 0.8 }, size));
    return { straight, curled };
  });
});
check(
  'curl=0 deja la hebra recta (centrada en el eje)',
  Math.abs(curlGeometry.straight) < 1.5,
  `desvío ${curlGeometry.straight.toFixed(2)}px`,
);
check(
  'curl alto comba la hebra a un lado a mitad de camino',
  Math.abs(curlGeometry.curled) > 3,
  `desvío ${curlGeometry.curled.toFixed(2)}px`,
);

/* ------------------------------------------------------------------ *
 * Panel real: abrir, cambiar preset, crear textura.
 * ------------------------------------------------------------------ */
console.log('\n— Panel del generador de racimo: presets y creación —');
await page.evaluate(() => {
  const s = window.__uiStore.getState();
  s.setTool('brush');
  s.setPanel('brush');
});
await page.waitForTimeout(200);
await page.getByRole('button', { name: /Generar racimo/ }).click();
await page.waitForTimeout(200);

const previewPixelSample = () =>
  page.evaluate(() => {
    const canvases = document.querySelectorAll('.texture-generator__preview canvas');
    const canvas = canvases[canvases.length - 1];
    const ctx = canvas.getContext('2d');
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let sum = 0;
    for (let i = 3; i < data.length; i += 4) sum += data[i];
    return sum;
  });
const beforePreset = await previewPixelSample();
await page.locator('.preset-row .chip', { hasText: 'Hojas' }).click();
await page.waitForTimeout(150);
const afterPreset = await previewPixelSample();
check('el preset "Hojas" cambia la vista previa', afterPreset !== beforePreset, `${beforePreset} → ${afterPreset}`);

console.log('\n— "Distribución": Dispersa/Paralela cambia la vista previa —');
const beforeLayout = await previewPixelSample();
await page.locator('.segmented button', { hasText: 'Paralela' }).click();
await page.waitForTimeout(150);
const afterLayout = await previewPixelSample();
check('cambiar a "Paralela" cambia la forma del racimo', afterLayout !== beforeLayout, `${beforeLayout} → ${afterLayout}`);
await page.locator('.segmented button', { hasText: 'Dispersa' }).click();
await page.waitForTimeout(150);

console.log('\n— "Colores del racimo": el selector aparece la cantidad de colores pedida —');
const colorInputsWhenNone = await page.locator('.preset-row input[type="color"]').count();
check('sin colores activados, no hay selectores de color', colorInputsWhenNone === 0, `${colorInputsWhenNone}`);

const rgbPreviewSample = () =>
  page.evaluate(() => {
    const canvases = document.querySelectorAll('.texture-generator__preview canvas');
    const canvas = canvases[canvases.length - 1];
    const ctx = canvas.getContext('2d');
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let r = 0, g = 0, b = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] === 0) continue;
      r += data[i];
      g += data[i + 1];
      b += data[i + 2];
    }
    return { r, g, b };
  });

// El propio Segmented de "Colores del racimo" también dice "3" en su chip
// (comparte texto con "Colores del racimo (hasta 3)"), así que se localiza
// por el grupo segmentado en vez de por texto suelto.
const colorSegmented = page.locator('.field', { hasText: 'Colores del racimo' }).locator('.segmented');
await colorSegmented.locator('button', { hasText: '3' }).click();
await page.waitForTimeout(150);
const colorInputsWithThree = await page.locator('.preset-row input[type="color"]').count();
check('con 3 colores activados, aparecen 3 selectores de color', colorInputsWithThree === 3, `${colorInputsWithThree}`);

const beforeColorChange = await rgbPreviewSample();
await page.locator('.preset-row input[type="color"]').first().fill('#ff00ff');
await page.waitForTimeout(150);
const afterColorChange = await rgbPreviewSample();
check(
  'cambiar un color activado cambia el RGB de la vista previa (no sólo la forma)',
  JSON.stringify(afterColorChange) !== JSON.stringify(beforeColorChange),
  `${JSON.stringify(beforeColorChange)} → ${JSON.stringify(afterColorChange)}`,
);
await colorSegmented.locator('button', { hasText: 'Ninguno' }).click();
await page.waitForTimeout(150);

await page.locator('.preset-row .chip', { hasText: 'Mata de césped' }).click();
await page.waitForTimeout(150);
await page.getByRole('button', { name: 'Crear textura' }).click();
await page.waitForTimeout(200);
const clusterTexId = await page.evaluate(() => {
  const s = window.__uiStore.getState();
  return s.brushes[s.brushIndex].textureId;
});
check('crear textura deja el racimo activo en el pincel', typeof clusterTexId === 'string' && clusterTexId.length > 0, String(clusterTexId));

/* ------------------------------------------------------------------ *
 * Un solo tap ya pinta el manojo entero: varias columnas de tinta
 * separadas por huecos dentro del mismo estampado, sin arrastrar.
 * ------------------------------------------------------------------ */
console.log('\n— Un solo tap ya pinta varias hebras separadas —');
await page.evaluate(() => {
  window.__uiStore.getState().updateBrush({
    size: 260, opacity: 1, flow: 1, hardness: 1, taper: 0, spacing: 0.5, scatter: 0,
    pressureSize: 0, pressureOpacity: 0, followDirection: false, angleJitter: 0,
  });
});
const box = await page.locator('.canvas-surface').boundingBox();
const tapScreen = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
await stroke([[tapScreen.x, tapScreen.y], [tapScreen.x + 1, tapScreen.y]]);

const tapDoc = await page.evaluate((p) => window.__trace.screenToDoc(p), {
  x: tapScreen.x - box.x,
  y: tapScreen.y - box.y,
});
const tapResult = await page.evaluate(({ p }) => {
  const e = window.__trace;
  const layer = e.activeLayer;
  const cel = [...layer.cels.values()][0];
  const half = 130;
  const rect = { x: p.x - half, y: p.y - half, x2: p.x + half, y2: p.y + half };
  const px = e.renderer.readRect(cel.surface, rect);
  const w = Math.round(rect.x2 - rect.x);
  const h = Math.round(rect.y2 - rect.y);
  // Fila baja del estampado (cerca de la base de las hebras, análoga a la
  // geometría en frío) — cuenta tramos de alfa alto separados por huecos.
  const y = Math.round(h * 0.6);
  let segments = 0;
  let inSegment = false;
  for (let x = 0; x < w; x++) {
    const a = px[(y * w + x) * 4 + 3];
    const on = a > 40;
    if (on && !inSegment) segments++;
    inSegment = on;
  }
  return { segments };
}, { p: tapDoc });
check(
  'un solo tap deja varios tramos separados de tinta (el racimo, no una sola marca)',
  tapResult.segments >= 3,
  `${tapResult.segments} tramos`,
);

/* ------------------------------------------------------------------ *
 * Colores del racimo en el pincel real: la GPU debe usar el RGB de la
 * textura, no el color activo del pincel — y una textura SIN `hasColor`
 * debe seguir tiñéndose con el color del pincel como siempre (nada de
 * esto puede filtrar color por sorpresa en las texturas de toda la vida:
 * integradas, importadas, u otros generadores).
 * ------------------------------------------------------------------ */
console.log('\n— Colores del racimo: la GPU usa el RGB de la textura, no el del pincel —');
const colorStampResult = await page.evaluate(() => {
  const e = window.__trace;
  const size = 128;
  return import('/src/core/brushTexture.ts').then((mod) => {
    const params = {
      seed: 3, count: 12, bladeLength: 0.8, lengthVariation: 0.2, thickness: 0.08,
      taper: 0.7, roughness: 0.2, curl: 0.2, spread: 0.8, angleSpread: 0.3, opacity: 1,
      layout: 'scatter',
      colors: [{ r: 255, g: 0, b: 0 }, { r: 0, g: 255, b: 0 }, { r: 0, g: 0, b: 255 }],
    };
    const pixels = mod.generateClusterTexturePixels(params, size);
    const coloredTex = { id: 'test-cluster-color', label: 'test-color', pixels, hasColor: true };
    e.addCustomTexture(coloredTex);

    const shapeOnlyPixels = mod.generateClusterTexturePixels({ ...params, colors: undefined }, size);
    const shapeOnlyTex = { id: 'test-cluster-noColor', label: 'test-shape', pixels: shapeOnlyPixels };
    e.addCustomTexture(shapeOnlyTex);

    const stampWith = (textureId, brushColor, cx, cy) => {
      const brush = {
        id: 'test', name: 'test', category: 'paint', size: 250, opacity: 1, flow: 1, hardness: 1,
        spacing: 0.5, pressureSize: 0, pressureOpacity: 0, tiltAspect: 0, velocitySize: 0,
        smoothing: 0, jitterSize: 0, scatter: 0, followDirection: false, angleJitter: 0,
        taper: 0, aspect: 1, erase: false, textureId, pigmentMix: 0,
      };
      e.beginStroke({ x: cx, y: cy, pressure: 1, altitude: 0, azimuth: 0, time: performance.now() }, { brush, color: brushColor });
      e.endStroke();
    };
    const readAround = (cx, cy) => {
      const layer = e.activeLayer;
      const cel = [...layer.cels.values()][0];
      const rect = { x: cx - 125, y: cy - 125, x2: cx + 125, y2: cy + 125 };
      const px = e.renderer.readRect(cel.surface, rect);
      const w = rect.x2 - rect.x, h = rect.y2 - rect.y;
      let inkPx = 0, magentaPx = 0, redPx = 0, greenPx = 0, bluePx = 0;
      for (let i = 0; i < w * h; i++) {
        const r = px[i * 4], g = px[i * 4 + 1], b = px[i * 4 + 2], a = px[i * 4 + 3];
        if (a < 40) continue;
        inkPx++;
        if (r > 180 && b > 180 && g < 100) magentaPx++;
        if (r > g + 40 && r > b + 40) redPx++;
        else if (g > r + 40 && g > b + 40) greenPx++;
        else if (b > r + 40 && b > g + 40) bluePx++;
      }
      return { inkPx, magentaPx, redPx, greenPx, bluePx };
    };

    const magenta = { r: 1, g: 0, b: 1 };
    stampWith('test-cluster-color', magenta, 300, 300);
    const withColor = readAround(300, 300);

    stampWith('test-cluster-noColor', magenta, 700, 300);
    const withoutColor = readAround(700, 300);

    return { withColor, withoutColor };
  });
});
check(
  'con hasColor, la textura pinta rojo/verde/azul propios, no el magenta del pincel',
  colorStampResult.withColor.inkPx > 200 &&
    colorStampResult.withColor.redPx > 5 &&
    colorStampResult.withColor.greenPx > 5 &&
    colorStampResult.withColor.bluePx > 5 &&
    colorStampResult.withColor.magentaPx < colorStampResult.withColor.inkPx * 0.3,
  JSON.stringify(colorStampResult.withColor),
);
check(
  'sin hasColor, la misma forma sale del color del pincel (magenta), no de su propio RGB',
  colorStampResult.withoutColor.inkPx > 200 &&
    colorStampResult.withoutColor.magentaPx > colorStampResult.withoutColor.inkPx * 0.7,
  JSON.stringify(colorStampResult.withoutColor),
);

/* ------------------------------------------------------------------ *
 * Guardar y reabrir conserva la textura del racimo, colores incluidos.
 * ------------------------------------------------------------------ */
console.log('\n— Guardar y reabrir conserva la textura del racimo —');
const roundTrip = await page.evaluate(async (id) => {
  const e = window.__trace;
  const mod = await import('/src/core/io.ts');
  const bytes = await mod.serializeProject(e);
  const { doc } = await mod.deserializeProject(e, bytes);
  const tex = doc.customTextures.find((t) => t.id === id);
  const alphas = new Set();
  if (tex) for (let i = 3; i < tex.pixels.length; i += 4 * 37) alphas.add(tex.pixels[i]);
  const colorTex = doc.customTextures.find((t) => t.id === 'test-cluster-color');
  return {
    size: bytes.length,
    found: !!tex,
    distinctAlphas: alphas.size,
    coloredHasColor: colorTex?.hasColor === true,
  };
}, clusterTexId);
check('el proyecto serializado tiene contenido', roundTrip.size > 0, `${roundTrip.size} bytes`);
check('la textura del racimo sobrevive con su id', roundTrip.found, JSON.stringify(roundTrip));
check('el patrón de alfa (varias hebras, no plano) sobrevive el viaje de ida y vuelta', roundTrip.distinctAlphas > 1, `${roundTrip.distinctAlphas} valores distintos`);
check('el aviso hasColor sobrevive el viaje de ida y vuelta', roundTrip.coloredHasColor, JSON.stringify(roundTrip));

console.log('\n— Consola —');
check('sin errores en consola', errors.length === 0, errors.join(' | '));

console.log(`\n${failures === 0 ? 'TODO EN VERDE' : `${failures} FALLOS`}\n`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
