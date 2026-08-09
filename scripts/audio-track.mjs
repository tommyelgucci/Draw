import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const out = process.env.SHOT_DIR || 'shots';

/**
 * WAV mono PCM de 16 bits hecho a mano — no hace falta ninguna librería de
 * audio para probar la importación, sólo un archivo válido que
 * `AudioContext.decodeAudioData` sepa leer. El primer segundo lleva un
 * tono real (440 Hz) y el segundo silencio, para poder comprobar que la
 * forma de onda dibuja más "grueso" donde de verdad suena algo.
 */
function makeWav({ seconds = 2, sampleRate = 8000, loudSeconds = 1 } = {}) {
  const numSamples = seconds * sampleRate;
  const data = new Int16Array(numSamples);
  const loudSamples = Math.floor(loudSeconds * sampleRate);
  for (let i = 0; i < numSamples; i++) {
    if (i < loudSamples) {
      data[i] = Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 20000);
    } else {
      data[i] = 0;
    }
  }
  const blockAlign = 2; // mono, 16 bit
  const byteRate = sampleRate * blockAlign;
  const dataSize = data.length * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < data.length; i++) buf.writeInt16LE(data[i], 44 + i * 2);
  return buf;
}

const wavPath = join(tmpdir(), 'trace-test-audio.wav');
writeFileSync(wavPath, makeWav());

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

/* ------------------------------------------------------------------ */

console.log('\n— Importar un WAV de 2s (1s de tono + 1s de silencio) —');
await page.evaluate(() => window.__uiStore.getState().setPanel('layers'));
await page.waitForTimeout(150);

const importBtn = page.locator('button', { hasText: 'Importar audio' });
check('aparece el botón de importar audio', (await importBtn.count()) === 1);
const audioInput = page.locator('input[type="file"][accept="audio/*"]');
await audioInput.setInputFiles(wavPath);
await page.waitForTimeout(2000);

let audio = await page.evaluate(() => {
  const a = window.__trace.doc.audio;
  return a ? { id: a.id, name: a.name, duration: a.duration, mimeType: a.mimeType, peakCount: a.peaks.length, offset: a.offset, muted: a.muted } : null;
});
check('el documento tiene una pista de audio', !!audio, JSON.stringify(audio));
check('la duración ronda los 2 segundos', Math.abs(audio.duration - 2) < 0.2, `${audio.duration}`);
check('se calculan 800 picos', audio.peakCount === 800, `${audio.peakCount}`);
check('el nombre viene del archivo', audio.name === 'trace-test-audio', audio.name);
check('empieza sin desplazamiento y sin silenciar', audio.offset === 0 && audio.muted === false);

console.log('\n— La línea de tiempo dibuja la forma de onda —');
const waveCanvas = page.locator('.audio-track canvas');
check('aparece el canvas de la forma de onda', (await waveCanvas.count()) === 1);

const inkByHalf = await page.evaluate(() => {
  const canvas = document.querySelector('.audio-track canvas');
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  const left = ctx.getImageData(0, 0, Math.floor(w / 2), h).data;
  const right = ctx.getImageData(Math.floor(w / 2), 0, Math.ceil(w / 2), h).data;
  let leftInk = 0;
  let rightInk = 0;
  for (let i = 3; i < left.length; i += 4) if (left[i] > 10) leftInk++;
  for (let i = 3; i < right.length; i += 4) if (right[i] > 10) rightInk++;
  return { leftInk, rightInk };
});
check(
  'la mitad con tono pinta más grueso que la mitad en silencio',
  inkByHalf.leftInk > inkByHalf.rightInk * 1.5,
  JSON.stringify(inkByHalf),
);

await page.screenshot({ path: `${out}/audio-track-01-importado.png` });

console.log('\n— Guardar y reabrir conserva el audio —');
const roundTrip = await page.evaluate(async () => {
  const { serializeProject, deserializeProject } = await import('/src/core/io.ts');
  const e = window.__trace;
  const bytes = await serializeProject(e);
  const reopened = await deserializeProject(e, bytes);
  return {
    hasAudio: !!reopened.audio,
    duration: reopened.audio?.duration,
    peakCount: reopened.audio?.peaks.length,
    hasElementAfterReload: e.audioElement !== null,
  };
});
check('la pista sobrevive guardar y reabrir', roundTrip.hasAudio === true, JSON.stringify(roundTrip));
check('la duración se conserva', Math.abs((roundTrip.duration ?? 0) - 2) < 0.2, `${roundTrip.duration}`);
check('los 800 picos se conservan', roundTrip.peakCount === 800, `${roundTrip.peakCount}`);
check('el reproductor queda enganchado tras reabrir', roundTrip.hasElementAfterReload === true);

console.log('\n— Reproducir sincroniza el elemento de audio —');
await page.evaluate(() => window.__trace.setFrame(0));
const playBtn = page.locator('button[title="Reproducir"]');
await playBtn.click();
await page.waitForTimeout(300);
let playState = await page.evaluate(() => ({
  paused: window.__trace.audioElement?.paused,
  currentTime: window.__trace.audioElement?.currentTime,
}));
check('el audio se pone en marcha al reproducir', playState.paused === false, JSON.stringify(playState));

const pauseBtn = page.locator('button[title="Pausar"]');
await pauseBtn.click();
await page.waitForTimeout(200);
playState = await page.evaluate(() => window.__trace.audioElement?.paused);
check('pausar la animación también pausa el audio', playState === true);

console.log('\n— Cambiar el inicio (offset) —');
const offsetInput = page.locator('input[type="number"][step="0.1"]');
await offsetInput.fill('0.5');
await offsetInput.blur();
await page.waitForTimeout(150);
audio = await page.evaluate(() => window.__trace.doc.audio);
check('el offset se guarda', audio.offset === 0.5, `${audio.offset}`);

console.log('\n— Silenciar impide que se reproduzca —');
const muteCheck = page.locator('label.check', { hasText: 'Silenciar' }).locator('input[type="checkbox"]');
await muteCheck.check();
await page.waitForTimeout(100);
audio = await page.evaluate(() => window.__trace.doc.audio);
check('queda silenciado', audio.muted === true);
await playBtn.click();
await page.waitForTimeout(300);
playState = await page.evaluate(() => window.__trace.audioElement?.paused);
check('silenciado, reproducir no arranca el audio', playState === true);
await pauseBtn.click();
await page.waitForTimeout(150);
await muteCheck.uncheck();
await page.waitForTimeout(100);

console.log('\n— Quitar el audio —');
const removeBtn = page.locator('button', { hasText: 'Quitar audio' });
await removeBtn.click();
await page.waitForTimeout(150);
audio = await page.evaluate(() => window.__trace.doc.audio);
const audioElementAfterRemove = await page.evaluate(() => window.__trace.audioElement);
check('el documento se queda sin audio', audio === undefined, JSON.stringify(audio));
check('el reproductor se suelta', audioElementAfterRemove === null);
check('la fila de la forma de onda desaparece', (await page.locator('.audio-track').count()) === 0);
check('vuelve el botón de importar', (await importBtn.count()) === 1);

console.log('\n— Consola —');
check('sin errores en consola', errors.length === 0, errors.join(' | '));

console.log(`\n${failures === 0 ? 'TODO EN VERDE' : `${failures} FALLOS`}\n`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
