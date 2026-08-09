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

console.log('\n— Soporte —');
const support = await page.evaluate(async () => {
  const mod = await import('/src/core/video.ts');
  return mod.describeVideoSupport(320, 240, 10);
});
check('el navegador puede exportar vídeo', support.available === true, support.label);
check(
  'usa la ruta rápida (WebCodecs), no la grabación en tiempo real',
  support.realtime === false,
  support.realtime ? 'grabación en tiempo real' : 'WebCodecs',
);

console.log('\n— Preparar animación —');
// Documento pequeño y corto para que la prueba no tarde una eternidad.
await page.evaluate(() => {
  const e = window.__trace;
  e.doc.width = 320;
  e.doc.height = 240;
  e.doc.fps = 10;
  e.doc.frameCount = 10;
  e.renderer.setDocumentSize(320, 240);
  e.onion.enabled = false;
  e.resetView();
  e.touch();
});
await page.waitForTimeout(400);

// Un cuadrado que cruza la pantalla: si los fotogramas no se codifican en
// orden o se repiten, se nota al inspeccionar el vídeo.
await page.evaluate(() => {
  const e = window.__trace;
  const layer = e.activeLayer;
  for (let f = 0; f < e.doc.frameCount; f++) {
    e.addCel(layer.id, f, false);
    const cel = layer.cels.get(f);
    const x = 20 + f * 26;
    e.renderer.drawStamps(
      cel.surface,
      [{ x, y: 120, size: 40, angle: 0, alpha: 1, hardness: 1, aspect: 1 }],
      { r: 0.1, g: 0.1, b: 0.1 },
    );
  }
  e.touch();
});
await page.waitForTimeout(300);
const cels = await page.evaluate(() => window.__trace.activeLayer.cels.size);
check('la animación tiene 10 dibujos', cels === 10, `${cels} cels`);

console.log('\n— Exportar —');
const t0 = Date.now();
const result = await page.evaluate(async () => {
  const mod = await import('/src/core/video.ts');
  const r = await mod.exportVideo(window.__trace, { quality: 0.7 });
  const bytes = new Uint8Array(await r.blob.arrayBuffer());
  // La caja `ftyp` empieza en el byte 4 de todo MP4 válido.
  const magic = String.fromCharCode(...bytes.slice(4, 8));
  const brand = String.fromCharCode(...bytes.slice(8, 12));
  // Busca las cajas que debe traer un MP4 con pista de vídeo.
  const text = new TextDecoder('latin1').decode(bytes);
  return {
    size: r.blob.size,
    type: r.blob.type,
    extension: r.extension,
    method: r.method,
    codec: r.codec,
    magic,
    brand,
    hasMoov: text.includes('moov'),
    hasMdat: text.includes('mdat'),
    hasAvcC: text.includes('avcC'),
    // Firma EBML de Matroska/WebM: 1A 45 DF A3.
    ebml: bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3,
    magicHex: [...bytes.slice(0, 4)].map((b) => b.toString(16).padStart(2, '0')).join(' '),
    // `moov` antes que `mdat` = fastStart, se puede reproducir sin descargar todo.
    moovBeforeMdat: text.indexOf('moov') < text.indexOf('mdat'),
  };
});
const elapsed = Date.now() - t0;

// Qué contenedor sale depende de los códecs del navegador: Chromium sin
// códecs propietarios no codifica H.264 y toma la ruta VP9/WebM. Las dos son
// válidas; lo que no vale es caer a la grabación en tiempo real.
const isMp4 = result.extension === 'mp4';
check('usó WebCodecs, no grabación', result.method === 'webcodecs', `${result.method} / ${result.codec}`);
check(
  'el contenedor es MP4 o WebM',
  isMp4 || result.extension === 'webm',
  `${result.extension} (${result.type})`,
);
if (isMp4) {
  check('la cabecera es un MP4 válido (ftyp)', result.magic === 'ftyp', `${result.magic} ${result.brand}`);
  check('contiene la caja moov', result.hasMoov === true);
  check('contiene los datos mdat', result.hasMdat === true);
  check('declara la configuración H.264 (avcC)', result.hasAvcC === true);
  check('el índice va al principio (fastStart)', result.moovBeforeMdat === true);
} else {
  check('la cabecera es un Matroska válido', result.ebml === true, result.magicHex);
}
check('el archivo tiene contenido', result.size > 2000, `${result.size} bytes`);
check(
  'no graba en tiempo real',
  elapsed < 1000 * (10 / 10),
  `${elapsed} ms para 1,0 s de animación`,
);

console.log('\n— El vídeo se reproduce —');
// La prueba definitiva: que el propio navegador lo decodifique y saque un
// fotograma con el dibujo, no un cuadro en negro.
const playback = await page.evaluate(async () => {
  const mod = await import('/src/core/video.ts');
  const r = await mod.exportVideo(window.__trace, { quality: 0.7 });
  const url = URL.createObjectURL(r.blob);
  const v = document.createElement('video');
  v.muted = true;
  v.src = url;
  await new Promise((res, rej) => {
    v.onloadedmetadata = res;
    v.onerror = () => rej(new Error('el navegador no pudo abrir el vídeo'));
    setTimeout(() => rej(new Error('tiempo agotado al cargar')), 8000);
  });
  const meta = { width: v.videoWidth, height: v.videoHeight, duration: v.duration };

  // Salta al 60 % de la animación y lee los píxeles.
  await new Promise((res, rej) => {
    v.onseeked = res;
    v.onerror = () => rej(new Error('fallo al buscar'));
    v.currentTime = Math.min(0.6, (v.duration || 1) * 0.6);
    setTimeout(res, 4000);
  });
  const c = document.createElement('canvas');
  c.width = meta.width;
  c.height = meta.height;
  c.getContext('2d').drawImage(v, 0, 0);
  const px = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let dark = 0;
  let light = 0;
  for (let i = 0; i < px.length; i += 4) {
    if (px[i] < 90 && px[i + 1] < 90) dark++;
    if (px[i] > 200 && px[i + 1] > 200) light++;
  }
  URL.revokeObjectURL(url);
  return { ...meta, dark, light };
});

check(
  'las dimensiones son las del documento',
  playback.width === 320 && playback.height === 240,
  `${playback.width}×${playback.height}`,
);
check(
  'la duración coincide con la animación',
  Math.abs(playback.duration - 1.0) < 0.35,
  `${playback.duration.toFixed(2)} s`,
);
check('el fondo del vídeo es el papel blanco', playback.light > 40000, `${playback.light} px claros`);
check('el dibujo aparece en el vídeo', playback.dark > 300, `${playback.dark} px de tinta`);

console.log('\n— Interfaz —');
await page.click('[aria-label="Proyecto"]');
await page.waitForTimeout(300);
const btn = await page.locator('button', { hasText: 'Vídeo ·' }).count();
check('el botón de vídeo aparece en el panel', btn === 1);
await page.screenshot({ path: `${out}/video-panel.png` });

console.log('\n— Consola —');
check('sin errores en consola', errors.length === 0, errors.join(' | '));

console.log(`\n${failures === 0 ? 'TODO EN VERDE' : `${failures} FALLOS`}\n`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
