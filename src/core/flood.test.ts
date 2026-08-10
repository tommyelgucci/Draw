/**
 * Unitarios de flood.ts — puro, sin GPU ni DOM, por eso se pudo mover al
 * worker (ver workers/floodFill.worker.ts). Cubre lo mismo que antes sólo
 * se ejercitaba de rebote a través de scripts/fill.mjs en un navegador
 * real; aquí se puede probar el algoritmo en sí sin levantar Chromium.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { applyFillColor, extractRect, floodMatch, growFilled } from './flood.ts';

/** Lienzo `w`×`h` en blanco opaco (255,255,255,255), con un cuadrado de
 * `size`×`size` en `(ox,oy)` pintado de negro opaco — la línea que el
 * bote debe respetar. */
function paperWithSquare(w: number, h: number, ox: number, oy: number, size: number): Uint8Array {
  const px = new Uint8Array(w * h * 4);
  for (let i = 0; i < px.length; i += 4) {
    px[i] = 255;
    px[i + 1] = 255;
    px[i + 2] = 255;
    px[i + 3] = 255;
  }
  for (let y = oy; y < oy + size; y++) {
    for (let x = ox; x < ox + size; x++) {
      const o = (y * w + x) * 4;
      px[o] = 0;
      px[o + 1] = 0;
      px[o + 2] = 0;
      px[o + 3] = 255;
    }
  }
  return px;
}

describe('floodMatch', () => {
  test('rellena sólo la región conexa del mismo color, respetando un borde', () => {
    const w = 20;
    const h = 20;
    const px = paperWithSquare(w, h, 8, 8, 4); // cuadrado negro 8..11 en ambos ejes
    const { filled, minX, minY, maxX, maxY } = floodMatch(px, w, h, 0, 0, 0.1);
    // El punto de partida (0,0) es blanco: la región rellenada es todo el
    // papel salvo el cuadrado negro — sus límites tocan los bordes del
    // lienzo, no el cuadrado.
    assert.equal(minX, 0);
    assert.equal(minY, 0);
    assert.equal(maxX, w - 1);
    assert.equal(maxY, h - 1);
    // El interior del cuadrado no se llenó.
    assert.equal(filled[9 * w + 9], 0);
    // Un punto lejos del cuadrado sí.
    assert.equal(filled[0], 1);
  });

  test('la tolerancia decide qué tan distinto puede ser un color y seguir contando', () => {
    const w = 10;
    const h = 1;
    const px = new Uint8Array(w * 4);
    for (let x = 0; x < w; x++) {
      const o = x * 4;
      // Degradado de blanco a gris a partir de x=5.
      const v = x < 5 ? 255 : 200;
      px[o] = v;
      px[o + 1] = v;
      px[o + 2] = v;
      px[o + 3] = 255;
    }
    const strict = floodMatch(px, w, h, 0, 0, 0.05); // (255-200)/255 ≈ 0.22, no pasa
    assert.equal(strict.maxX, 4);
    const loose = floodMatch(px, w, h, 0, 0, 0.3); // sí pasa
    assert.equal(loose.maxX, w - 1);
  });
});

describe('growFilled', () => {
  test('crece un píxel de radio por pasada, acotado a la caja pedida', () => {
    const w = 10;
    const h = 10;
    const filled = new Uint8Array(w * h);
    filled[5 * w + 5] = 1; // un único píxel lleno en el centro
    const bounds = growFilled(filled, w, h, { minX: 5, minY: 5, maxX: 5, maxY: 5 }, 2);
    // Tras 2 pasadas, el borde en forma de diamante alcanza distancia 2.
    assert.equal(filled[5 * w + 5], 1); // centro
    assert.equal(filled[5 * w + 6], 1); // vecino inmediato (pasada 1)
    assert.equal(filled[5 * w + 7], 1); // a distancia 2 (pasada 2)
    assert.equal(filled[5 * w + 8], 0); // fuera de alcance
    assert.deepEqual(bounds, { minX: 3, minY: 3, maxX: 7, maxY: 7 });
  });

  test('no crece más allá del borde del lienzo', () => {
    const w = 5;
    const h = 5;
    const filled = new Uint8Array(w * h);
    filled[0] = 1; // esquina superior-izquierda
    const bounds = growFilled(filled, w, h, { minX: 0, minY: 0, maxX: 0, maxY: 0 }, 3);
    assert.equal(bounds.minX, 0);
    assert.equal(bounds.minY, 0);
  });
});

describe('applyFillColor', () => {
  test('pinta sólo los píxeles marcados en `filled`, deja el resto intacto', () => {
    const w = 3;
    const target = new Uint8Array([9, 9, 9, 9, /**/ 1, 2, 3, 4, /**/ 9, 9, 9, 9]);
    const filled = new Uint8Array([0, 1, 0]);
    applyFillColor(target, w, filled, { minX: 0, minY: 0, maxX: 2, maxY: 0 }, { r: 1, g: 0, b: 0 });
    assert.deepEqual(Array.from(target.subarray(0, 4)), [9, 9, 9, 9]); // sin tocar
    assert.deepEqual(Array.from(target.subarray(4, 8)), [255, 0, 0, 255]); // pintado
    assert.deepEqual(Array.from(target.subarray(8, 12)), [9, 9, 9, 9]); // sin tocar
  });
});

describe('extractRect', () => {
  test('recorta un sub-rectángulo respetando el stride del buffer completo', () => {
    // Lienzo 4×2, valores = índice de píxel (para poder verificar la posición).
    const w = 4;
    const h = 2;
    const src = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) src[i * 4] = i;
    const rect = { x: 1, y: 0, x2: 3, y2: 2 }; // columnas 1..2, ambas filas
    const out = extractRect(src, w, rect);
    assert.equal(out.length, 2 * 2 * 4);
    // Fila 0: píxeles 1,2. Fila 1 (stride 4): píxeles 5,6.
    assert.deepEqual(
      [out[0], out[4], out[8], out[12]],
      [1, 2, 5, 6],
    );
  });
});
