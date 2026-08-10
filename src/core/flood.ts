import type { Rect } from './types';

/**
 * El barrido de líneas y sus dos pasadas siguientes (crecer el borde,
 * aplicar el color) puro — sin `Engine`, sin GPU, sin DOM — a propósito:
 * es exactamente lo que hace falta poder correr también dentro de un
 * Worker (`workers/floodFill.worker.ts`), que no ve ninguna de esas tres
 * cosas. `Engine` sigue usando estas mismas funciones en el hilo principal
 * para la varita mágica (`beginSelectWand`/`updateSelectWandTolerance`):
 * ese camino necesita respuesta inmediata en cada muestra de arrastre, así
 * que ahí un viaje de ida y vuelta a un Worker sería más lento, no menos.
 */

export interface FloodBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface FloodMatchResult extends FloodBounds {
  filled: Uint8Array;
}

/**
 * Región conexa por semejanza de color desde `(sx,sy)` sobre `reference`
 * (RGBA, `w`×`h`), con relleno por líneas de barrido — mucho menos tráfico
 * de pila que el recursivo por píxel, que en un lienzo grande revienta.
 */
export function floodMatch(
  reference: Uint8Array,
  w: number,
  h: number,
  sx: number,
  sy: number,
  tolerance: number,
): FloodMatchResult {
  const start = (sy * w + sx) * 4;
  const sr = reference[start];
  const sg = reference[start + 1];
  const sb = reference[start + 2];
  const sa = reference[start + 3];
  const tol = tolerance * 255;

  const matches = (i: number) =>
    Math.abs(reference[i] - sr) <= tol &&
    Math.abs(reference[i + 1] - sg) <= tol &&
    Math.abs(reference[i + 2] - sb) <= tol &&
    Math.abs(reference[i + 3] - sa) <= tol;

  const filled = new Uint8Array(w * h);
  const stack: number[] = [sx, sy];
  let minX = sx;
  let minY = sy;
  let maxX = sx;
  let maxY = sy;

  while (stack.length > 0) {
    const y = stack.pop()!;
    const x = stack.pop()!;
    if (filled[y * w + x]) continue;

    let left = x;
    while (left > 0 && !filled[y * w + left - 1] && matches((y * w + left - 1) * 4)) left--;
    let right = x;
    while (right < w - 1 && !filled[y * w + right + 1] && matches((y * w + right + 1) * 4)) right++;

    for (let i = left; i <= right; i++) filled[y * w + i] = 1;
    if (left < minX) minX = left;
    if (right > maxX) maxX = right;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;

    for (const ny of [y - 1, y + 1]) {
      if (ny < 0 || ny >= h) continue;
      for (let i = left; i <= right; i++) {
        if (!filled[ny * w + i] && matches((ny * w + i) * 4)) {
          stack.push(i, ny);
        }
      }
    }
  }

  return { filled, minX, minY, maxX, maxY };
}

/**
 * Crece `filled` en el sitio `expand` píxeles — evita la orla blanca que
 * deja el antialias de la línea entre el relleno y el trazo. Cada pasada
 * sólo puede alcanzar un píxel más allá de lo ya lleno, así que tras
 * `expand` pasadas nada fuera de `bounds` ensanchado por `expand` puede
 * haber cambiado — acotar el bucle a esa caja, en vez de recorrer el
 * lienzo entero, es la diferencia entre millones de comprobaciones y unos
 * pocos miles en un documento grande con un relleno pequeño. Devuelve la
 * caja ya ensanchada.
 */
export function growFilled(filled: Uint8Array, w: number, h: number, bounds: FloodBounds, expand: number): FloodBounds {
  const boundMinX = Math.max(0, bounds.minX - expand);
  const boundMinY = Math.max(0, bounds.minY - expand);
  const boundMaxX = Math.min(w - 1, bounds.maxX + expand);
  const boundMaxY = Math.min(h - 1, bounds.maxY + expand);

  for (let pass = 0; pass < expand; pass++) {
    const grown = filled.slice();
    for (let y = boundMinY; y <= boundMaxY; y++) {
      for (let x = boundMinX; x <= boundMaxX; x++) {
        if (filled[y * w + x]) continue;
        const up = y > 0 && filled[(y - 1) * w + x];
        const down = y < h - 1 && filled[(y + 1) * w + x];
        const lf = x > 0 && filled[y * w + x - 1];
        const rt = x < w - 1 && filled[y * w + x + 1];
        if (up || down || lf || rt) grown[y * w + x] = 1;
      }
    }
    filled.set(grown);
  }

  return { minX: boundMinX, minY: boundMinY, maxX: boundMaxX, maxY: boundMaxY };
}

/**
 * Pinta `color` (0..1) sobre los píxeles de `filled` dentro de `bounds`, en
 * el sitio sobre `target` (RGBA premultiplicado, ancho `w`). Los píxeles de
 * `bounds` que no están en `filled` conservan lo que ya tuvieran — es lo
 * que deja el borde antialiasado de la línea intacto.
 *
 * Con `alphaLock`, el bote sólo puede recolorear tinta que ya existía en
 * esta capa — nunca ensanchar su contorno. `target[o + 3]` todavía es el
 * alfa ORIGINAL en este punto: cada píxel se escribe una sola vez en este
 * bucle, así que leerlo justo antes de sobrescribirlo es seguro.
 */
export function applyFillColor(
  target: Uint8Array,
  w: number,
  filled: Uint8Array,
  bounds: FloodBounds,
  color: { r: number; g: number; b: number },
  alphaLock = false,
): void {
  const cr = Math.round(color.r * 255);
  const cg = Math.round(color.g * 255);
  const cb = Math.round(color.b * 255);
  for (let y = bounds.minY; y <= bounds.maxY; y++) {
    for (let x = bounds.minX; x <= bounds.maxX; x++) {
      const i = y * w + x;
      if (!filled[i]) continue;
      const o = i * 4;
      if (alphaLock && target[o + 3] === 0) continue;
      target[o] = cr;
      target[o + 1] = cg;
      target[o + 2] = cb;
      target[o + 3] = 255;
    }
  }
}

/** Recorta un rect de un buffer RGBA de ancho `stride`. */
export function extractRect(src: Uint8Array, stride: number, r: Rect): Uint8Array {
  const w = r.x2 - r.x;
  const h = r.y2 - r.y;
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const from = ((r.y + y) * stride + r.x) * 4;
    out.set(src.subarray(from, from + w * 4), y * w * 4);
  }
  return out;
}
