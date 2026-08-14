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

/**
 * Ruido de valor 2D: una rejilla gruesa de valores al azar, interpolados
 * suavemente entre nudos — a diferencia de `mulberry32` puro (independiente
 * píxel a píxel, se ve como estática), esto da variación continua y
 * orgánica, lo que hace falta para un jirón de humo en vez de más motas.
 */
function makeValueNoise(rand: () => number, cells: number) {
  const grid = new Float32Array((cells + 1) * (cells + 1));
  for (let i = 0; i < grid.length; i++) grid[i] = rand();
  return (u: number, v: number) => {
    const gx = Math.min(cells - 1e-6, Math.max(0, u * cells));
    const gy = Math.min(cells - 1e-6, Math.max(0, v * cells));
    const x0 = Math.floor(gx);
    const y0 = Math.floor(gy);
    const fx = smoothstep(0, 1, gx - x0);
    const fy = smoothstep(0, 1, gy - y0);
    const stride = cells + 1;
    const v00 = grid[y0 * stride + x0];
    const v10 = grid[y0 * stride + x0 + 1];
    const v01 = grid[(y0 + 1) * stride + x0];
    const v11 = grid[(y0 + 1) * stride + x0 + 1];
    const a = v00 * (1 - fx) + v10 * fx;
    const b = v01 * (1 - fx) + v11 * fx;
    return a * (1 - fy) + b * fy;
  };
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

/**
 * Parámetros del generador procedural libre: las 4 integradas de arriba son
 * en el fondo esto mismo con valores fijos (trama para "lienzo", motas para
 * "grano"/"tiza", polvo para "tiza"/"salpicadura") — aquí quedan continuos,
 * para ajustar un estilo en vez de elegir entre cuatro moldes cerrados.
 * Cálculo puro sobre `seed`: no mira ni copia ninguna imagen, así que el
 * resultado no hereda derechos de nadie más que de quien mueve los mandos.
 */
export interface ParametricTextureParams {
  seed: number;
  /** 0 = sin trama de fondo, 1 = tejido de lienzo marcado. */
  weave: number;
  /** 0..1: probabilidad de que caiga una mota en cada celda de la rejilla. */
  dotDensity: number;
  /** Celdas por lado de la rejilla — más celdas, motas más finas y numerosas. */
  dotCells: number;
  dotSizeMin: number;
  dotSizeMax: number;
  dotOpacityMin: number;
  dotOpacityMax: number;
  /** Motas de polvo sueltas, muy pequeñas, encima de la capa principal. */
  dustCount: number;
  dustOpacityMax: number;
}

export function generateParametricTexturePixels(
  params: ParametricTextureParams,
  size = BRUSH_TEXTURE_SIZE,
): Uint8Array {
  const buf = new Uint8Array(size * size * 4);
  for (let i = 0; i < buf.length; i += 4) {
    buf[i] = 255;
    buf[i + 1] = 255;
    buf[i + 2] = 255;
    buf[i + 3] = 0;
  }
  const rand = mulberry32(params.seed);

  if (params.weave > 0) {
    const freq = (Math.PI * 2 * 9) / size;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const weave = 0.55 + 0.35 * Math.sin(x * freq) * Math.sin(y * freq);
        const a = Math.min(1, Math.max(0, weave)) * params.weave;
        buf[(y * size + x) * 4 + 3] = Math.round(a * 255);
      }
    }
  }

  if (params.dotDensity > 0) {
    const cols = Math.max(2, Math.min(32, Math.round(params.dotCells)));
    const cell = size / cols;
    for (let gy = 0; gy < cols; gy++) {
      for (let gx = 0; gx < cols; gx++) {
        if (rand() > params.dotDensity) continue;
        const cx = gx * cell + rand() * cell;
        const cy = gy * cell + rand() * cell;
        const r = cell * (params.dotSizeMin + rand() * (params.dotSizeMax - params.dotSizeMin));
        const peak = params.dotOpacityMin + rand() * (params.dotOpacityMax - params.dotOpacityMin);
        paintDot(buf, size, cx, cy, r, peak);
      }
    }
  }

  for (let i = 0; i < params.dustCount; i++) {
    const r = size * (0.005 + rand() * 0.015);
    paintDot(buf, size, rand() * size, rand() * size, r, rand() * params.dustOpacityMax);
  }

  return buf;
}

/**
 * Marca alargada (cicatriz, subrayado, arañazo): una franja horizontal con
 * las puntas afiladas o romas y el borde limpio o rasgado, según los
 * parámetros — no un tarro cerrado de "cicatriz" y otro de "subrayado",
 * sino los dos extremos del mismo mando de aspereza. Distinta forma de base
 * a `ParametricTextureParams` (dispersión radial): aquí todo se mide a lo
 * largo de un eje, así que necesita su propio generador, no una rama del
 * de motas. Como cualquier textura de punta, se orienta con la rotación de
 * cada estampa — recta por defecto, alineada con la dirección del trazo si
 * el pincel ya gira con él.
 */
export interface StreakTextureParams {
  seed: number;
  /** 0..1: fracción del lienzo de textura que ocupa la longitud. */
  length: number;
  /** 0..1: grosor en el centro, como fracción del lienzo. */
  thickness: number;
  /** 0..1: cuánto se afinan las puntas — 0 quedan romas, 1 casi en punta. */
  taper: number;
  /** 0..1: cuánto tiembla el borde respecto a una franja perfectamente recta. */
  roughness: number;
  opacity: number;
}

export function generateStreakTexturePixels(
  params: StreakTextureParams,
  size = BRUSH_TEXTURE_SIZE,
): Uint8Array {
  const buf = new Uint8Array(size * size * 4);
  for (let i = 0; i < buf.length; i += 4) {
    buf[i] = 255;
    buf[i + 1] = 255;
    buf[i + 2] = 255;
    buf[i + 3] = 0;
  }
  const halfLen = (params.length * size) / 2;
  if (halfLen <= 0) return buf;

  const rand = mulberry32(params.seed);
  // Puntos de control del temblor del borde, interpolados a lo largo de la
  // marca: una onda coherente, no ruido por píxel — ruido por píxel se vería
  // como estática, no como un borde rasgado de verdad.
  const CONTROLS = 24;
  const edgeNoise = Array.from({ length: CONTROLS + 1 }, () => rand() * 2 - 1);
  const noiseAt = (u: number) => {
    const t = u * CONTROLS;
    const i0 = Math.floor(t);
    const i1 = Math.min(CONTROLS, i0 + 1);
    const f = t - i0;
    return edgeNoise[i0] * (1 - f) + edgeNoise[i1] * f;
  };

  const cx = size / 2;
  const cy = size / 2;
  const baseHalfThick = (params.thickness * size) / 2;
  const reach = halfLen + baseHalfThick + 2;

  for (let y = 0; y < size; y++) {
    const dy = y - cy;
    for (let x = 0; x < size; x++) {
      const dx = x - cx;
      if (Math.abs(dx) > reach) continue;
      const u = Math.min(1, Math.max(0, (dx / halfLen + 1) / 2));
      const endTaper = 1 - params.taper * smoothstep(0.5, 1, Math.abs(dx) / halfLen);
      const wobble = 1 + noiseAt(u) * params.roughness * 0.6;
      const halfThickHere = Math.max(0.5, baseHalfThick * endTaper * wobble);
      const lenFalloff = 1 - smoothstep(halfLen * 0.85, halfLen, Math.abs(dx));
      const edge = Math.abs(dy) - halfThickHere;
      const edgeAlpha = 1 - smoothstep(-1.5, 1.5, edge);
      const a = Math.min(1, Math.max(0, edgeAlpha * lenFalloff)) * params.opacity;
      buf[(y * size + x) * 4 + 3] = Math.round(a * 255);
    }
  }

  return buf;
}

/**
 * Jirón de humo/niebla/nube: un contorno redondeado deformado por ruido de
 * valor de dos escalas (una gruesa para el contorno general, una fina para
 * el detalle interno) — tercera forma de base, ni dispersión radial ni eje
 * recto, así que tampoco reutiliza los otros dos generadores.
 */
export interface WispTextureParams {
  seed: number;
  /** 0..1: cuánto del lienzo ocupa la nube antes de disolverse. */
  spread: number;
  /** 0..1: cuánto se retuerce el contorno — bajo da una nube redondeada, alto da zarcillos sueltos. */
  turbulence: number;
  /** 0..1: cuánto relleno interno hay frente a huecos. */
  density: number;
  opacity: number;
}

export function generateWispTexturePixels(
  params: WispTextureParams,
  size = BRUSH_TEXTURE_SIZE,
): Uint8Array {
  const buf = new Uint8Array(size * size * 4);
  for (let i = 0; i < buf.length; i += 4) {
    buf[i] = 255;
    buf[i + 1] = 255;
    buf[i + 2] = 255;
    buf[i + 3] = 0;
  }
  const rand = mulberry32(params.seed);
  const coarse = makeValueNoise(rand, 5);
  const fine = makeValueNoise(rand, 12);

  const cx = size / 2;
  const cy = size / 2;
  const radius = size * 0.5 * Math.max(0.15, params.spread);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.hypot(dx, dy) / radius;
      if (dist > 1.7) continue;
      const warp = (coarse(x / size, y / size) - 0.5) * 2 * params.turbulence;
      const shaped = dist - warp * 0.6;
      const contour = 1 - smoothstep(0.3, 1.15, shaped);
      const detail = 0.35 + 0.65 * (params.density * 0.5 + fine(x / size, y / size) * 0.5);
      const a = Math.min(1, Math.max(0, contour * detail)) * params.opacity;
      buf[(y * size + x) * 4 + 3] = Math.round(a * 255);
    }
  }

  return buf;
}

/**
 * Destello radial (lente, chispa, estrella, sol): rayos que salen de un
 * núcleo central, afinándose hasta un punto, con longitud y ángulo con
 * algo de temblor propio — cuarta forma de base, mide en polar (radio +
 * ángulo) en vez de en un eje recto como la marca alargada.
 */
export interface BurstTextureParams {
  seed: number;
  spokeCount: number;
  /** 0..1: longitud de los rayos como fracción del lienzo. */
  length: number;
  /** 0..1: grosor de cada rayo en la base. */
  thickness: number;
  /** 0..1: cuánto varían longitud y ángulo de un rayo a otro. */
  irregularity: number;
  /** 0..1: tamaño del núcleo brillante central; 0 = sin núcleo. */
  coreSize: number;
  opacity: number;
}

function angleDistance(a: number, b: number): number {
  let d = Math.abs(a - b) % (Math.PI * 2);
  if (d > Math.PI) d = Math.PI * 2 - d;
  return d;
}

export function generateBurstTexturePixels(
  params: BurstTextureParams,
  size = BRUSH_TEXTURE_SIZE,
): Uint8Array {
  const buf = new Uint8Array(size * size * 4);
  for (let i = 0; i < buf.length; i += 4) {
    buf[i] = 255;
    buf[i + 1] = 255;
    buf[i + 2] = 255;
    buf[i + 3] = 0;
  }
  const rand = mulberry32(params.seed);
  const spokeCount = Math.max(2, Math.round(params.spokeCount));
  const angleStep = (Math.PI * 2) / spokeCount;
  const spokeAngles = Array.from(
    { length: spokeCount },
    (_, i) => i * angleStep + (rand() * 2 - 1) * angleStep * 0.15 * params.irregularity,
  );
  const spokeLengths = Array.from(
    { length: spokeCount },
    () => (size / 2) * params.length * (1 + (rand() * 2 - 1) * params.irregularity * 0.7),
  );
  const baseHalfThick = Math.max(0.6, (params.thickness * size) / 2);

  const cx = size / 2;
  const cy = size / 2;
  const reach = size * 0.72;

  for (let y = 0; y < size; y++) {
    const dy = y - cy;
    for (let x = 0; x < size; x++) {
      const dx = x - cx;
      const r = Math.hypot(dx, dy);
      if (r > reach) continue;
      const theta = Math.atan2(dy, dx);
      let best = 0;
      let bestDelta = Infinity;
      for (let i = 0; i < spokeCount; i++) {
        const d = angleDistance(theta, spokeAngles[i]);
        if (d < bestDelta) {
          bestDelta = d;
          best = i;
        }
      }
      const len = spokeLengths[best];
      if (r > len) continue;
      const crossDist = r * Math.sin(bestDelta);
      const widthHere = baseHalfThick * Math.max(0, 1 - r / len);
      const edge = Math.abs(crossDist) - widthHere;
      const a = Math.min(1, Math.max(0, 1 - smoothstep(-1, 1.2, edge))) * params.opacity;
      const idx = (y * size + x) * 4 + 3;
      const v = Math.round(a * 255);
      if (v > buf[idx]) buf[idx] = v;
    }
  }

  if (params.coreSize > 0) {
    paintDot(buf, size, cx, cy, size * 0.5 * params.coreSize, params.opacity);
  }

  return buf;
}

/**
 * Púas paralelas (peine, cerdas): varias marcas alargadas horizontales
 * apiladas en carriles regulares, cada una con su propia semilla de
 * aspereza de borde y longitud — un peine es esto con poca variación entre
 * púas; unas cerdas gastadas, con mucha. Con `angleJitter` del pincel en 0
 * salen todas alineadas (peine); subiéndolo, cada estampa gira al azar y
 * el resultado se dispersa como mechones de pelo o césped — la orientación
 * no vive en la textura, vive en cómo se estampa cada copia.
 */
export interface RakeTextureParams {
  seed: number;
  count: number;
  /** 0..1: longitud de cada púa como fracción del lienzo. */
  length: number;
  /** 0..1: grosor de cada púa respecto al carril que le toca. */
  thickness: number;
  /** 0..1: cuánto varía la longitud de una púa a otra. */
  irregularity: number;
  /** 0..1: cuánto tiembla el borde de cada púa. */
  roughness: number;
  opacity: number;
}

export function generateRakeTexturePixels(
  params: RakeTextureParams,
  size = BRUSH_TEXTURE_SIZE,
): Uint8Array {
  const buf = new Uint8Array(size * size * 4);
  for (let i = 0; i < buf.length; i += 4) {
    buf[i] = 255;
    buf[i + 1] = 255;
    buf[i + 2] = 255;
    buf[i + 3] = 0;
  }
  const rand = mulberry32(params.seed);
  const count = Math.max(2, Math.round(params.count));
  const laneHeight = size / count;
  const cx = size / 2;

  for (let lane = 0; lane < count; lane++) {
    const cy = laneHeight * (lane + 0.5);
    const halfLen = (size / 2) * params.length * (1 + (rand() * 2 - 1) * params.irregularity * 0.6);
    if (halfLen <= 0) continue;
    const baseHalfThick = Math.max(0.5, laneHeight * 0.5 * params.thickness);

    const CONTROLS = 16;
    const edgeNoise = Array.from({ length: CONTROLS + 1 }, () => rand() * 2 - 1);
    const noiseAt = (u: number) => {
      const t = u * CONTROLS;
      const i0 = Math.floor(t);
      const i1 = Math.min(CONTROLS, i0 + 1);
      const f = t - i0;
      return edgeNoise[i0] * (1 - f) + edgeNoise[i1] * f;
    };

    const y0 = Math.max(0, Math.floor(cy - baseHalfThick - 2));
    const y1 = Math.min(size - 1, Math.ceil(cy + baseHalfThick + 2));
    const x0 = Math.max(0, Math.floor(cx - halfLen - 2));
    const x1 = Math.min(size - 1, Math.ceil(cx + halfLen + 2));
    for (let y = y0; y <= y1; y++) {
      const dy = y - cy;
      for (let x = x0; x <= x1; x++) {
        const dx = x - cx;
        const u = Math.min(1, Math.max(0, (dx / halfLen + 1) / 2));
        // Las púas se afinan un poco hacia la punta siempre, aunque la marca
        // alargada suelta deje elegir — así se leen como púas, no como barras.
        const endTaper = 1 - 0.5 * smoothstep(0.6, 1, Math.abs(dx) / halfLen);
        const wobble = 1 + noiseAt(u) * params.roughness * 0.6;
        const halfThickHere = Math.max(0.5, baseHalfThick * endTaper * wobble);
        const lenFalloff = 1 - smoothstep(halfLen * 0.85, halfLen, Math.abs(dx));
        const edge = Math.abs(dy) - halfThickHere;
        const edgeAlpha = 1 - smoothstep(-1.2, 1.2, edge);
        const a = Math.min(1, Math.max(0, edgeAlpha * lenFalloff)) * params.opacity;
        const idx = (y * size + x) * 4 + 3;
        const v = Math.round(a * 255);
        if (v > buf[idx]) buf[idx] = v;
      }
    }
  }

  return buf;
}
