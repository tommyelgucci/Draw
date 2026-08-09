import type { RGB, Vec2 } from './types';

export const clamp = (v: number, lo: number, hi: number) =>
  v < lo ? lo : v > hi ? hi : v;

export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export const TAU = Math.PI * 2;

/** Redondea un ángulo (radianes) al incremento `step` más cercano. */
export const snapAngle = (angle: number, step: number) => Math.round(angle / step) * step;

/* ------------------------------------------------------------------ *
 * Matriz 3x3 afín, column-major, lista para `uniformMatrix3fv`.
 * ------------------------------------------------------------------ */

export type Mat3 = Float32Array;

export function mat3Identity(): Mat3 {
  return new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
}

export function mat3Multiply(a: Mat3, b: Mat3, out = new Float32Array(9)): Mat3 {
  for (let c = 0; c < 3; c++) {
    const col = c * 3;
    for (let r = 0; r < 3; r++) {
      out[col + r] = a[r] * b[col] + a[3 + r] * b[col + 1] + a[6 + r] * b[col + 2];
    }
  }
  return out as Mat3;
}

export function mat3FromTRS(
  tx: number,
  ty: number,
  rotation: number,
  scaleX: number,
  scaleY: number,
  originX = 0,
  originY = 0,
): Mat3 {
  const c = Math.cos(rotation);
  const s = Math.sin(rotation);
  const a = c * scaleX;
  const b = s * scaleX;
  const d = -s * scaleY;
  const e = c * scaleY;
  // Traslada al origen, escala+rota, y devuelve, todo plegado.
  const f = tx + originX - (a * originX + d * originY);
  const g = ty + originY - (b * originX + e * originY);
  return new Float32Array([a, b, 0, d, e, 0, f, g, 1]);
}

export function mat3Invert(m: Mat3): Mat3 {
  const [a, b, , d, e, , f, g] = m;
  const det = a * e - b * d;
  if (Math.abs(det) < 1e-12) return mat3Identity();
  const id = 1 / det;
  return new Float32Array([
    e * id,
    -b * id,
    0,
    -d * id,
    a * id,
    0,
    (d * g - e * f) * id,
    (b * f - a * g) * id,
    1,
  ]);
}

export function mat3Apply(m: Mat3, p: Vec2): Vec2 {
  return { x: m[0] * p.x + m[3] * p.y + m[6], y: m[1] * p.x + m[4] * p.y + m[7] };
}

/* ------------------------------------------------------------------ *
 * Color
 * ------------------------------------------------------------------ */

export function hsvToRgb(h: number, s: number, v: number): RGB {
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  switch (i % 6) {
    case 0:
      return { r: v, g: t, b: p };
    case 1:
      return { r: q, g: v, b: p };
    case 2:
      return { r: p, g: v, b: t };
    case 3:
      return { r: p, g: q, b: v };
    case 4:
      return { r: t, g: p, b: v };
    default:
      return { r: v, g: p, b: q };
  }
}

export function rgbToHsv(c: RGB): { h: number; s: number; v: number } {
  const max = Math.max(c.r, c.g, c.b);
  const min = Math.min(c.r, c.g, c.b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === c.r) h = ((c.g - c.b) / d) % 6;
    else if (max === c.g) h = (c.b - c.r) / d + 2;
    else h = (c.r - c.g) / d + 4;
    h /= 6;
    if (h < 0) h += 1;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

export function rgbToHex(c: RGB): string {
  const to = (v: number) =>
    Math.round(clamp(v, 0, 1) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${to(c.r)}${to(c.g)}${to(c.b)}`;
}

export function hexToRgb(hex: string): RGB {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return { r: 0, g: 0, b: 0 };
  const n = parseInt(m[1], 16);
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
}

/* ------------------------------------------------------------------ *
 * Filtro One Euro: suaviza el trazo sin añadir el retardo constante
 * que introduce una media móvil. Ver Casiez et al., CHI 2012.
 * ------------------------------------------------------------------ */

class LowPass {
  private y = 0;
  private initialised = false;

  filter(value: number, alpha: number): number {
    if (!this.initialised) {
      this.y = value;
      this.initialised = true;
      return value;
    }
    this.y = alpha * value + (1 - alpha) * this.y;
    return this.y;
  }

  get last() {
    return this.y;
  }

  reset() {
    this.initialised = false;
  }
}

export class OneEuroFilter {
  private xf = new LowPass();
  private dxf = new LowPass();
  private lastTime = -1;
  private lastValue = 0;
  private started = false;
  private minCutoff: number;
  private beta: number;
  private dCutoff: number;

  constructor(minCutoff = 1.2, beta = 0.008, dCutoff = 1.0) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
  }

  reset() {
    this.xf.reset();
    this.dxf.reset();
    this.lastTime = -1;
    this.started = false;
  }

  filter(value: number, timeMs: number): number {
    if (!this.started) {
      this.started = true;
      this.lastTime = timeMs;
      this.lastValue = value;
      return this.xf.filter(value, 1);
    }
    const dt = Math.max((timeMs - this.lastTime) / 1000, 1 / 1000);
    this.lastTime = timeMs;

    const dValue = (value - this.lastValue) / dt;
    this.lastValue = value;
    const edValue = this.dxf.filter(dValue, alphaFor(dt, this.dCutoff));
    const cutoff = this.minCutoff + this.beta * Math.abs(edValue);
    return this.xf.filter(value, alphaFor(dt, cutoff));
  }
}

function alphaFor(dt: number, cutoff: number): number {
  const tau = 1 / (TAU * cutoff);
  return 1 / (1 + tau / dt);
}
