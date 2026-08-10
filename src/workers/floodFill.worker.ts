import { applyFillColor, extractRect, floodMatch, growFilled } from '../core/flood';
import type { Rect } from '../core/types';

/**
 * Hilo aparte para la parte cara del bote de relleno en CPU (barrido de
 * líneas + crecimiento + pintar el color) — no toca WebGL ni el DOM en
 * absoluto, así que no hace falta compartir el contexto de GPU con el
 * hilo principal: éste ya leyó `reference`/`target` antes de mandarlos
 * aquí, y sólo escribe el resultado de vuelta a la GPU cuando termina.
 * Ver `Engine.floodFill` para el lado que lo llama.
 *
 * El tipado de `self` se hace a mano en vez de con la lib `webworker` de
 * TypeScript: el resto del proyecto compila con `lib: ["ES2023", "DOM"]`
 * (tsconfig.app.json cubre todo `src`, este archivo incluido) y mezclar
 * ambas libs en el mismo proyecto choca por declaraciones globales
 * incompatibles de `self`. Con `unknown` de por medio no hace falta
 * arrastrar un tsconfig aparte sólo por este archivo.
 */
interface FloodFillRequest {
  /** Ecoado tal cual en la respuesta: el hilo principal reutiliza un único
   *  worker para todos los rellenos y puede tener varias peticiones en
   *  vuelo a la vez (nada bloquea el lienzo mientras se espera), así que
   *  hace falta para emparejar cada respuesta con quien la pidió. */
  id: number;
  reference: Uint8Array;
  target: Uint8Array;
  w: number;
  h: number;
  sx: number;
  sy: number;
  tolerance: number;
  expand: number;
  color: { r: number; g: number; b: number };
  /** Con bloqueo de alfa, sólo recolorea tinta que ya existía — nunca
   *  ensancha el contorno de la capa. */
  alphaLock: boolean;
}

export interface FloodFillResponse {
  id: number;
  sub: Uint8Array;
  rect: Rect;
}

type WorkerLike = {
  onmessage: ((ev: MessageEvent<FloodFillRequest>) => void) | null;
  postMessage: (data: FloodFillResponse, transfer: Transferable[]) => void;
};

const ctx = self as unknown as WorkerLike;

ctx.onmessage = (e) => {
  const { id, reference, target, w, h, sx, sy, tolerance, expand, color, alphaLock } = e.data;
  const match = floodMatch(reference, w, h, sx, sy, tolerance);
  const bounds = growFilled(match.filled, w, h, match, expand);
  applyFillColor(target, w, match.filled, bounds, color, alphaLock);
  const rect: Rect = { x: bounds.minX, y: bounds.minY, x2: bounds.maxX + 1, y2: bounds.maxY + 1 };
  const sub = extractRect(target, w, rect);
  ctx.postMessage({ id, sub, rect }, [sub.buffer]);
};
