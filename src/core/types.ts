/**
 * Tipos compartidos del núcleo de Trace.
 *
 * Este módulo no importa nada de React ni del DOM: el objetivo es que el motor
 * pueda portarse a otro runtime (Rust/wgpu, WASM) tocando sólo `gl/`.
 */

export type Vec2 = { x: number; y: number };

/** Coordenadas en píxeles del documento, origen arriba-izquierda, Y hacia abajo. */
export type DocPoint = Vec2;

export type BlendMode =
  | 'normal'
  | 'multiply'
  | 'screen'
  | 'overlay'
  | 'darken'
  | 'lighten'
  | 'colorDodge'
  | 'colorBurn'
  | 'hardLight'
  | 'softLight'
  | 'difference'
  | 'exclusion'
  | 'add';

export const BLEND_MODES: BlendMode[] = [
  'normal',
  'multiply',
  'screen',
  'overlay',
  'darken',
  'lighten',
  'colorDodge',
  'colorBurn',
  'hardLight',
  'softLight',
  'difference',
  'exclusion',
  'add',
];

export const BLEND_LABELS: Record<BlendMode, string> = {
  normal: 'Normal',
  multiply: 'Multiplicar',
  screen: 'Trama',
  overlay: 'Superponer',
  darken: 'Oscurecer',
  lighten: 'Aclarar',
  colorDodge: 'Sobreexponer',
  colorBurn: 'Subexponer',
  hardLight: 'Luz fuerte',
  softLight: 'Luz suave',
  difference: 'Diferencia',
  exclusion: 'Exclusión',
  add: 'Añadir',
};

/** Índice numérico que consume el shader de composición. */
export const BLEND_INDEX: Record<BlendMode, number> = {
  normal: 0,
  multiply: 1,
  screen: 2,
  overlay: 3,
  darken: 4,
  lighten: 5,
  colorDodge: 6,
  colorBurn: 7,
  hardLight: 8,
  softLight: 9,
  difference: 10,
  exclusion: 11,
  add: 12,
};

/** Muestra cruda del dispositivo de entrada, ya convertida a espacio documento. */
export interface InputSample {
  x: number;
  y: number;
  /** 0..1. Los dispositivos sin presión reportan 0.5 constante. */
  pressure: number;
  /** Radianes desde la vertical. 0 = perpendicular al lienzo. */
  altitude: number;
  /** Radianes, dirección de la inclinación en el plano del lienzo. */
  azimuth: number;
  /** Milisegundos, reloj monótono. */
  time: number;
  /** true si el dato viene de `getPredictedEvents()` y debe descartarse luego. */
  predicted?: boolean;
}

/** Una estampa lista para enviarse a la GPU. */
export interface Stamp {
  x: number;
  y: number;
  /** Diámetro en píxeles de documento. */
  size: number;
  /** Radianes. */
  angle: number;
  /** 0..1, cobertura de esta estampa concreta. */
  alpha: number;
  /** 0..1, 1 = borde duro. */
  hardness: number;
  /** Achatamiento 0..1 aplicado en el eje menor (1 = círculo). */
  aspect: number;
}

/** Rectángulo entero en píxeles de documento, `x2`/`y2` exclusivos. */
export interface Rect {
  x: number;
  y: number;
  x2: number;
  y2: number;
}

export function emptyRect(): Rect {
  return { x: Infinity, y: Infinity, x2: -Infinity, y2: -Infinity };
}

export function rectIsEmpty(r: Rect): boolean {
  return r.x2 <= r.x || r.y2 <= r.y;
}

export function expandRect(r: Rect, x: number, y: number, radius: number): void {
  if (x - radius < r.x) r.x = x - radius;
  if (y - radius < r.y) r.y = y - radius;
  if (x + radius > r.x2) r.x2 = x + radius;
  if (y + radius > r.y2) r.y2 = y + radius;
}

export function clampRect(r: Rect, w: number, h: number): Rect {
  return {
    x: Math.max(0, Math.floor(r.x)),
    y: Math.max(0, Math.floor(r.y)),
    x2: Math.min(w, Math.ceil(r.x2)),
    y2: Math.min(h, Math.ceil(r.y2)),
  };
}

/** Color RGB lineal-sRGB en 0..1 (sin alfa; el alfa vive en el pincel). */
export interface RGB {
  r: number;
  g: number;
  b: number;
}
