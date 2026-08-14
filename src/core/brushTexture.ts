/**
 * Texturas de punta de pincel: máscaras de cobertura para el shader de
 * estampado (`uUseTexture`/`uTexture` en `STAMP_FS`).
 *
 * Puro cálculo, sin DOM ni WebGL — esta es la única razón de que viva en
 * `core/` y no en `gl/`: así el mismo buffer de píxeles sirve para subir la
 * textura a la GPU (`gl/renderer.ts`) y para pintar la miniatura del selector
 * en la interfaz (`ui/Panels.tsx`), sin duplicar el algoritmo en dos sitios
 * ni acoplar la generación a ningún runtime concreto.
 *
 * El shader sólo lee el canal alfa como cobertura (`texture(uTexture, uv).a`),
 * así que el RGB del buffer es irrelevante para la GPU; se deja en blanco
 * para que la miniatura en la interfaz también se vea bien sobre el fondo
 * oscuro del panel.
 */

export type BuiltinTextureId = 'grain' | 'chalk' | 'canvas' | 'splatter';

export const BUILTIN_TEXTURES: { id: BuiltinTextureId; label: string }[] = [
  { id: 'grain', label: 'Grano' },
  { id: 'chalk', label: 'Tiza' },
  { id: 'canvas', label: 'Lienzo' },
  { id: 'splatter', label: 'Salpicadura' },
];

const BUILTIN_IDS: readonly string[] = BUILTIN_TEXTURES.map((t) => t.id);

export function isBuiltinTextureId(id: string): id is BuiltinTextureId {
  return BUILTIN_IDS.includes(id);
}

/** Tamaño fijo de toda textura de punta, integrada o importada — el mismo
 *  que ya sube `gl/renderer.ts` a la GPU. */
export const BRUSH_TEXTURE_SIZE = 128;

/**
 * Textura de punta importada por quien dibuja, a diferencia de las 4
 * integradas: mismo formato de buffer (RGBA8, sólo importa el alfa como
 * cobertura), pero los píxeles vienen de un PNG propio, no de un generador
 * determinista. Vive en `TraceDocument` — es un activo del proyecto que
 * viaja con el `.trace`, no parte del kit que se distribuye con la app.
 */
export interface CustomTexture {
  id: string;
  label: string;
  pixels: Uint8Array;
}

const SEEDS: Record<BuiltinTextureId, number> = {
  grain: 0x9e3779b1,
  chalk: 0x85ebca77,
  canvas: 0xc2b2ae63,
  splatter: 0x27d4eb2f,
};

/** PRNG determinista: la textura debe ser igual en cada sesión, no ruido nuevo cada vez. */
function mulberry32(seed: number) {
  let a = seed | 0;
  return function random() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(Math.max((x - edge0) / (edge1 - edge0), 0), 1);
  return t * t * (3 - 2 * t);
}

/** Pinta un punto suave en el canal alfa de `buf`, sin oscurecer lo ya pintado. */
function paintDot(buf: Uint8Array, size: number, cx: number, cy: number, r: number, peak: number) {
  if (r <= 0) return;
  const x0 = Math.max(0, Math.floor(cx - r));
  const x1 = Math.min(size - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r));
  const y1 = Math.min(size - 1, Math.ceil(cy + r));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x - cx, y - cy) / r;
      if (d > 1) continue;
      const a = peak * (1 - smoothstep(0.55, 1, d));
      const i = (y * size + x) * 4 + 3;
      const v = Math.round(a * 255);
      if (v > buf[i]) buf[i] = v;
    }
  }
}

/**
 * Genera la máscara de una textura integrada como RGBA8 (`size`×`size`),
 * RGB en blanco y alfa = cobertura. Determinista: mismo `id` siempre produce
 * los mismos píxeles, así la textura no "respira" entre trazos ni recargas.
 */
export function generateBrushTexturePixels(id: BuiltinTextureId, size = 128): Uint8Array {
  const buf = new Uint8Array(size * size * 4);
  for (let i = 0; i < buf.length; i += 4) {
    buf[i] = 255;
    buf[i + 1] = 255;
    buf[i + 2] = 255;
    buf[i + 3] = 0;
  }
  const rand = mulberry32(SEEDS[id]);

  switch (id) {
    case 'grain': {
      // Estipulado fino: grano de lápiz sobre papel, con huecos donde asoma
      // el papel entre las motas.
      const cols = 16;
      const cell = size / cols;
      for (let gy = 0; gy < cols; gy++) {
        for (let gx = 0; gx < cols; gx++) {
          if (rand() > 0.8) continue;
          const cx = gx * cell + rand() * cell;
          const cy = gy * cell + rand() * cell;
          const r = cell * (0.18 + rand() * 0.28);
          paintDot(buf, size, cx, cy, r, 0.35 + rand() * 0.65);
        }
      }
      break;
    }
    case 'chalk': {
      // Manchas más grandes e irregulares, con polvo suelto encima: el
      // resultado deja ver más papel que el grano fino del lápiz.
      const cols = 7;
      const cell = size / cols;
      for (let gy = 0; gy < cols; gy++) {
        for (let gx = 0; gx < cols; gx++) {
          if (rand() > 0.75) continue;
          const cx = gx * cell + rand() * cell;
          const cy = gy * cell + rand() * cell;
          const r = cell * (0.4 + rand() * 0.5);
          paintDot(buf, size, cx, cy, r, 0.25 + rand() * 0.4);
        }
      }
      for (let i = 0; i < 220; i++) {
        paintDot(buf, size, rand() * size, rand() * size, 0.6 + rand() * 1.4, 0.2 + rand() * 0.3);
      }
      break;
    }
    case 'canvas': {
      // Trama regular tejida (dos senos cruzados) con algo de ruido, como el
      // tejido de un lienzo real bajo la pintura.
      const freq = (Math.PI * 2 * 9) / size;
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const weave = 0.55 + 0.35 * Math.sin(x * freq) * Math.sin(y * freq);
          const noise = (rand() - 0.5) * 0.08;
          const a = Math.min(1, Math.max(0, weave + noise));
          buf[(y * size + x) * 4 + 3] = Math.round(a * 255);
        }
      }
      break;
    }
    case 'splatter': {
      // Pocas manchas grandes y opacas más una nube de gotas pequeñas
      // alrededor: da un aerógrafo o pincel de salpicadura reconocible.
      for (let i = 0; i < 9; i++) {
        const r = size * (0.05 + rand() * 0.12);
        paintDot(buf, size, rand() * size, rand() * size, r, 0.75 + rand() * 0.25);
      }
      for (let i = 0; i < 40; i++) {
        const r = size * (0.01 + rand() * 0.025);
        paintDot(buf, size, rand() * size, rand() * size, r, 0.6 + rand() * 0.4);
      }
      break;
    }
  }

  return buf;
}
