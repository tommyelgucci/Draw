import type { Vec2 } from './types';
import { TAU } from './math';

/**
 * Reconocimiento de formas para QuickShape: cuando el lápiz se queda quieto
 * al final de un trazo, se intenta sustituir el recorrido bruto por una
 * primitiva geométrica exacta.
 *
 * Módulo puro sin DOM ni temporizadores (frontera de `core/`, ver
 * CLAUDE.md) — la detección de "lápiz quieto" vive en `CanvasView.tsx`, que
 * es quien llama aquí con el recorrido ya capturado.
 *
 * No se usa un reconocedor de gestos genérico ($P/$Q): esos clasifican un
 * trazo contra una plantilla, pero QuickShape necesita además los
 * parámetros exactos de la forma (centro, radio, esquinas...) para poder
 * dibujarla y editarla, así que sale más simple ajustar cada primitiva
 * directamente.
 */
export type RecognizedShape =
  | { kind: 'line'; a: Vec2; b: Vec2 }
  | { kind: 'ellipse'; cx: number; cy: number; rx: number; ry: number; rotation: number }
  | { kind: 'rect'; cx: number; cy: number; w: number; h: number; rotation: number }
  | { kind: 'triangle'; points: [Vec2, Vec2, Vec2] }
  | { kind: 'polygon'; cx: number; cy: number; radius: number; rotation: number; sides: number };

// Umbrales de aceptación. Todos relativos al tamaño del propio trazo, para
// que un círculo de 20px y uno de 400px se juzguen con el mismo criterio.
const MIN_POINTS = 5;
const MIN_DIAGONAL = 6; // px de documento: trazos más pequeños no merecen forzarse
const CLOSE_GAP_RATIO = 0.14; // dist(inicio,fin) / diagonal para considerarlo "cerrado"
const LINE_MAX_ERROR = 0.06; // desviación perpendicular media / longitud
// Desviación radial MÁXIMA (no media) relativa al radio: un rectángulo
// dibujado a mano tiene pocos puntos en las esquinas frente a muchos en los
// lados rectos, así que el error medio los diluye y un rectángulo se cuela
// como elipse. El máximo sí acusa el pico de cada esquina.
const ELLIPSE_MAX_ERROR = 0.24;
const MIN_POLYGON_SIDES = 3;
const MAX_POLYGON_SIDES = 10;

/**
 * Intenta reconocer el recorrido como línea, elipse/círculo, rectángulo,
 * triángulo o polígono regular. Devuelve `null` cuando no hay un ajuste lo
 * bastante bueno — igual que Procreate, si no reconoce nada no fuerza nada
 * y el trazo original se queda tal cual.
 */
export function recognizeShape(points: Vec2[]): RecognizedShape | null {
  if (points.length < MIN_POINTS) return null;
  const box = boundingBox(points);
  const diag = Math.hypot(box.maxX - box.minX, box.maxY - box.minY);
  if (diag < MIN_DIAGONAL) return null;

  const first = points[0];
  const last = points[points.length - 1];
  const closed = dist(first, last) < diag * CLOSE_GAP_RATIO;

  if (!closed) {
    const line = fitLine(points);
    if (line.error < LINE_MAX_ERROR) return { kind: 'line', a: line.a, b: line.b };
    // Abierta y no es una línea recta: sin arcos ni polilíneas en esta
    // versión (ver CLAUDE.md / notas de alcance), se deja el trazo intacto.
    return null;
  }

  const ellipse = fitEllipse(points);
  if (ellipse.error < ELLIPSE_MAX_ERROR) {
    return {
      kind: 'ellipse',
      cx: ellipse.cx,
      cy: ellipse.cy,
      rx: ellipse.rx,
      ry: ellipse.ry,
      rotation: ellipse.rotation,
    };
  }

  // No es una curva suave: cuenta esquinas simplificando el lazo cerrado.
  // El propio Douglas-Peucker ya hace de "detector de esquinas" — conserva
  // los puntos de máxima desviación (las esquinas) y descarta los que caen
  // sobre un tramo recto dentro de la tolerancia.
  const epsilon = Math.max(diag * 0.035, 3);
  const corners = simplifyClosed(points, epsilon);
  const n = corners.length;
  if (n < MIN_POLYGON_SIDES || n > MAX_POLYGON_SIDES) return null;
  if (n === 3) return { kind: 'triangle', points: [corners[0], corners[1], corners[2]] };
  if (n === 4) return rectFromCorners(corners);
  return polygonFromCorners(corners);
}

/**
 * Puntos de control editables en espacio documento. No incluyen el tirador
 * de rotación de elipse/rectángulo: ese se calcula en pantalla (el overlay
 * lo coloca perpendicular al borde superior, igual que en `SelectionOverlay`)
 * y se identifica por convención con el índice `shapeNodes(shape).length`.
 */
export function shapeNodes(shape: RecognizedShape): Vec2[] {
  switch (shape.kind) {
    case 'line':
      return [shape.a, shape.b];
    case 'ellipse':
      return orientedBoxCorners({ cx: shape.cx, cy: shape.cy, w: shape.rx * 2, h: shape.ry * 2, rotation: shape.rotation });
    case 'rect':
      return orientedBoxCorners(shape);
    case 'triangle':
      return shape.points.slice();
    case 'polygon':
      return [
        {
          x: shape.cx + Math.cos(shape.rotation) * shape.radius,
          y: shape.cy + Math.sin(shape.rotation) * shape.radius,
        },
      ];
  }
}

/** ¿Esta forma tiene tirador de rotación aparte de sus nodos normales? */
export function hasRotateHandle(
  shape: RecognizedShape,
): shape is Extract<RecognizedShape, { kind: 'ellipse' | 'rect' }> {
  return shape.kind === 'ellipse' || shape.kind === 'rect';
}

/**
 * Ángulo de la forma, o 0 para las que no tienen un único campo de
 * rotación propio (línea, triángulo — se rotan arrastrando sus puntos).
 * Lo usan tanto el gesto de dos dedos como el tirador de rotación del
 * overlay para tener un punto de partida al calcular el delta del gesto.
 */
export function shapeRotation(shape: RecognizedShape): number {
  return 'rotation' in shape ? shape.rotation : 0;
}

/**
 * Recalcula la forma al arrastrar el nodo `index` hasta `point` (espacio
 * documento). En elipse/rectángulo, el índice igual al número de nodos es
 * el tirador de rotación (ver `shapeNodes`). El resto de índices son
 * arrastre de esquina/vértice anclado al lado opuesto, como el redimensionado
 * de cualquier editor gráfico: no se mueve todo el centro a la vez, sólo el
 * punto que se agarra.
 */
export function updateShapeNode(shape: RecognizedShape, index: number, point: Vec2): RecognizedShape {
  switch (shape.kind) {
    case 'line': {
      const a = index === 0 ? point : shape.a;
      const b = index === 1 ? point : shape.b;
      return { kind: 'line', a, b };
    }
    case 'ellipse': {
      const box = updateOrientedBoxNode(shape.cx, shape.cy, shape.rx * 2, shape.ry * 2, shape.rotation, index, point);
      return { kind: 'ellipse', cx: box.cx, cy: box.cy, rx: box.w / 2, ry: box.h / 2, rotation: box.rotation };
    }
    case 'rect': {
      const box = updateOrientedBoxNode(shape.cx, shape.cy, shape.w, shape.h, shape.rotation, index, point);
      return { kind: 'rect', ...box };
    }
    case 'triangle': {
      const points = shape.points.slice() as [Vec2, Vec2, Vec2];
      if (index >= 0 && index < 3) points[index] = point;
      return { kind: 'triangle', points };
    }
    case 'polygon': {
      // Único tirador: es literalmente el primer vértice del polígono, así
      // que su posición fija radio y rotación a la vez, igual que arrastrar
      // cualquier vértice de un polígono regular real. `sides` no cambia.
      const radius = Math.hypot(point.x - shape.cx, point.y - shape.cy);
      const rotation = Math.atan2(point.y - shape.cy, point.x - shape.cx);
      return { ...shape, radius: Math.max(1, radius), rotation };
    }
  }
}

/**
 * El "segundo dedo" de Procreate: fuerza la proporción exacta (círculo,
 * cuadrado, triángulo equilátero) conservando el tamaño medio actual. La
 * línea no tiene proporción que forzar y el polígono regular ya lo es por
 * construcción.
 */
export function forceProportion(shape: RecognizedShape): RecognizedShape {
  switch (shape.kind) {
    case 'ellipse': {
      const r = (shape.rx + shape.ry) / 2;
      return { ...shape, rx: r, ry: r };
    }
    case 'rect': {
      const side = (shape.w + shape.h) / 2;
      return { ...shape, w: side, h: side };
    }
    case 'triangle': {
      const cx = (shape.points[0].x + shape.points[1].x + shape.points[2].x) / 3;
      const cy = (shape.points[0].y + shape.points[1].y + shape.points[2].y) / 3;
      const r = shape.points.reduce((sum, p) => sum + dist(p, { x: cx, y: cy }), 0) / 3;
      // Conserva la orientación del primer vértice; los otros dos se reparten a 120°.
      const a0 = Math.atan2(shape.points[0].y - cy, shape.points[0].x - cx);
      const points = [0, 1, 2].map((i) => {
        const a = a0 + (i * TAU) / 3;
        return { x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r };
      }) as [Vec2, Vec2, Vec2];
      return { kind: 'triangle', points };
    }
    case 'line':
    case 'polygon':
      return shape;
  }
}

/**
 * Contorno a paso uniforme, en espacio documento — se usa tanto para
 * pintar la forma en vivo (estampas a lo largo de este recorrido) como
 * para el horneado final. `spacingPx` debe venir del propio pincel activo
 * (tamaño × separación), igual que hace `StrokeBuilder`.
 */
export function sampleShapeOutline(shape: RecognizedShape, spacingPx: number): Vec2[] {
  const spacing = Math.max(0.5, spacingPx);
  switch (shape.kind) {
    case 'line':
      return samplePolyline([shape.a, shape.b], spacing);
    case 'ellipse': {
      // Perímetro aproximado de Ramanujan: de sobra de preciso para decidir
      // cuántos pasos dar, no hace falta una integral elíptica exacta aquí.
      const perim =
        Math.PI *
        (3 * (shape.rx + shape.ry) - Math.sqrt((3 * shape.rx + shape.ry) * (shape.rx + 3 * shape.ry)));
      const steps = Math.max(24, Math.round(perim / spacing));
      const c = Math.cos(shape.rotation);
      const s = Math.sin(shape.rotation);
      const pts: Vec2[] = [];
      for (let i = 0; i <= steps; i++) {
        const t = (i / steps) * TAU;
        const lx = Math.cos(t) * shape.rx;
        const ly = Math.sin(t) * shape.ry;
        pts.push({ x: shape.cx + lx * c - ly * s, y: shape.cy + lx * s + ly * c });
      }
      return samplePolyline(pts, spacing);
    }
    case 'rect': {
      const corners = orientedBoxCorners(shape);
      return samplePolyline([...corners, corners[0]], spacing);
    }
    case 'triangle':
      return samplePolyline([...shape.points, shape.points[0]], spacing);
    case 'polygon': {
      const pts: Vec2[] = [];
      for (let i = 0; i < shape.sides; i++) {
        const a = shape.rotation + (i * TAU) / shape.sides;
        pts.push({ x: shape.cx + Math.cos(a) * shape.radius, y: shape.cy + Math.sin(a) * shape.radius });
      }
      pts.push(pts[0]);
      return samplePolyline(pts, spacing);
    }
  }
}

/* ------------------------------------------------------------------ *
 * Geometría genérica
 * ------------------------------------------------------------------ */

function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function boundingBox(points: Vec2[]) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

function lerpPoint(a: Vec2, b: Vec2, t: number): Vec2 {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/** Recorre segmentos consecutivos y emite puntos a paso constante de arco. */
function samplePolyline(points: Vec2[], spacing: number): Vec2[] {
  if (points.length < 2) return points.slice();
  const out: Vec2[] = [points[0]];
  let leftover = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const segLen = dist(a, b);
    if (segLen < 1e-6) continue;
    let travelled = 0;
    while (leftover + (segLen - travelled) >= spacing) {
      const need = spacing - leftover;
      travelled += need;
      leftover = 0;
      out.push(lerpPoint(a, b, travelled / segLen));
    }
    leftover += segLen - travelled;
  }
  return out;
}

/**
 * Media, varianza a lo largo del eje principal/secundario y ángulo de ese
 * eje, vía la forma cerrada del autovector de la matriz de covarianza 2x2.
 * Es la base tanto del ajuste de línea (un eje casi sin varianza) como del
 * de elipse (dos ejes con varianza comparable).
 */
function covarianceFit(points: Vec2[]) {
  let mx = 0;
  let my = 0;
  for (const p of points) {
    mx += p.x;
    my += p.y;
  }
  mx /= points.length;
  my /= points.length;

  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const p of points) {
    const dx = p.x - mx;
    const dy = p.y - my;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  sxx /= points.length;
  sxy /= points.length;
  syy /= points.length;

  const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  let varMajor = 0;
  let varMinor = 0;
  for (const p of points) {
    const dx = p.x - mx;
    const dy = p.y - my;
    const u = dx * c + dy * s;
    const v = -dx * s + dy * c;
    varMajor += u * u;
    varMinor += v * v;
  }
  varMajor /= points.length;
  varMinor /= points.length;

  return { cx: mx, cy: my, angle, varMajor, varMinor };
}

function fitLine(points: Vec2[]): { a: Vec2; b: Vec2; error: number } {
  const { cx, cy, angle } = covarianceFit(points);
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  let tMin = Infinity;
  let tMax = -Infinity;
  let sumDev = 0;
  for (const p of points) {
    const dx = p.x - cx;
    const dy = p.y - cy;
    const t = dx * c + dy * s;
    sumDev += Math.abs(-dx * s + dy * c);
    if (t < tMin) tMin = t;
    if (t > tMax) tMax = t;
  }
  const length = tMax - tMin;
  const meanDev = sumDev / points.length;
  return {
    a: { x: cx + c * tMin, y: cy + s * tMin },
    b: { x: cx + c * tMax, y: cy + s * tMax },
    error: length > 1e-3 ? meanDev / length : meanDev,
  };
}

function fitEllipse(points: Vec2[]) {
  const { cx, cy, angle, varMajor, varMinor } = covarianceFit(points);
  // Para puntos uniformemente repartidos en ángulo sobre una elipse, el
  // radio de cada eje es exactamente √2 veces la desviación típica en ese
  // eje — de ahí el factor, en vez de un ajuste iterativo.
  const rx = Math.max(1, Math.sqrt(varMajor) * Math.SQRT2);
  const ry = Math.max(1, Math.sqrt(varMinor) * Math.SQRT2);
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  let maxErr = 0;
  for (const p of points) {
    const dx = p.x - cx;
    const dy = p.y - cy;
    const u = (dx * c + dy * s) / rx;
    const v = (-dx * s + dy * c) / ry;
    const err = Math.abs(Math.hypot(u, v) - 1);
    if (err > maxErr) maxErr = err;
  }
  return { cx, cy, rx, ry, rotation: angle, error: maxErr };
}

function douglasPeucker(points: Vec2[], epsilon: number): Vec2[] {
  if (points.length < 3) return points.slice();
  const first = points[0];
  const last = points[points.length - 1];
  let maxDist = -1;
  let index = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const d = perpendicularDistance(points[i], first, last);
    if (d > maxDist) {
      maxDist = d;
      index = i;
    }
  }
  if (maxDist > epsilon) {
    const left = douglasPeucker(points.slice(0, index + 1), epsilon);
    const right = douglasPeucker(points.slice(index), epsilon);
    return left.slice(0, -1).concat(right);
  }
  return [first, last];
}

function perpendicularDistance(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return dist(p, a);
  return Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / len;
}

/**
 * Douglas-Peucker está pensado para un tramo abierto. Para un lazo cerrado
 * se ancla en el punto más lejano del centroide y en el punto más lejano de
 * ése: parten el lazo en dos tramos abiertos que sí se pueden simplificar
 * con el algoritmo estándar, y se vuelven a pegar sin duplicar los anclajes.
 */
function simplifyClosed(points: Vec2[], epsilon: number): Vec2[] {
  if (points.length < 4) return points.slice();
  const c = centroidOf(points);
  const i1 = farthestIndex(points, c);
  const i2 = farthestIndex(points, points[i1]);
  const [lo, hi] = i1 < i2 ? [i1, i2] : [i2, i1];
  const arcA = points.slice(lo, hi + 1);
  const arcB = points.slice(hi).concat(points.slice(0, lo + 1));
  const simpA = douglasPeucker(arcA, epsilon);
  const simpB = douglasPeucker(arcB, epsilon);
  return simpA.slice(0, -1).concat(simpB.slice(0, -1));
}

function centroidOf(points: Vec2[]): Vec2 {
  let x = 0;
  let y = 0;
  for (const p of points) {
    x += p.x;
    y += p.y;
  }
  return { x: x / points.length, y: y / points.length };
}

function farthestIndex(points: Vec2[], from: Vec2): number {
  let idx = 0;
  let best = -1;
  for (let i = 0; i < points.length; i++) {
    const d = dist(points[i], from);
    if (d > best) {
      best = d;
      idx = i;
    }
  }
  return idx;
}

function rectFromCorners(corners: Vec2[]): RecognizedShape {
  const [v0, v1, v2, v3] = corners;
  const e0 = dist(v0, v1);
  const e1 = dist(v1, v2);
  const e2 = dist(v2, v3);
  const e3 = dist(v3, v0);
  const w = (e0 + e2) / 2;
  const h = (e1 + e3) / 2;
  const cx = (v0.x + v1.x + v2.x + v3.x) / 4;
  const cy = (v0.y + v1.y + v2.y + v3.y) / 4;
  const rotation = Math.atan2(v1.y - v0.y, v1.x - v0.x);
  return { kind: 'rect', cx, cy, w: Math.max(1, w), h: Math.max(1, h), rotation };
}

function polygonFromCorners(corners: Vec2[]): RecognizedShape {
  const cx = corners.reduce((s, p) => s + p.x, 0) / corners.length;
  const cy = corners.reduce((s, p) => s + p.y, 0) / corners.length;
  const radius = corners.reduce((s, p) => s + dist(p, { x: cx, y: cy }), 0) / corners.length;
  const rotation = Math.atan2(corners[0].y - cy, corners[0].x - cx);
  return { kind: 'polygon', cx, cy, radius: Math.max(1, radius), rotation, sides: corners.length };
}

/* ------------------------------------------------------------------ *
 * Caja orientada — comparte la lógica de esquinas/redimensionado entre
 * elipse (rx=w/2, ry=h/2) y rectángulo.
 * ------------------------------------------------------------------ */

interface OrientedBox {
  cx: number;
  cy: number;
  w: number;
  h: number;
  rotation: number;
}

function orientedBoxCorners(b: OrientedBox): Vec2[] {
  const c = Math.cos(b.rotation);
  const s = Math.sin(b.rotation);
  const hw = b.w / 2;
  const hh = b.h / 2;
  const local: Vec2[] = [
    { x: -hw, y: -hh },
    { x: hw, y: -hh },
    { x: hw, y: hh },
    { x: -hw, y: hh },
  ];
  return local.map((p) => ({ x: b.cx + p.x * c - p.y * s, y: b.cy + p.x * s + p.y * c }));
}

function updateOrientedBoxNode(
  cx: number,
  cy: number,
  w: number,
  h: number,
  rotation: number,
  index: number,
  point: Vec2,
): OrientedBox {
  if (index === 4) {
    // Tirador de rotación: gira sobre el centro actual, tamaño intacto.
    return { cx, cy, w, h, rotation: Math.atan2(point.y - cy, point.x - cx) };
  }
  const corners = orientedBoxCorners({ cx, cy, w, h, rotation });
  // La esquina opuesta queda fija: es el redimensionado "de toda la vida",
  // no un escalado simétrico desde el centro.
  const anchor = corners[(index + 2) % 4];
  const c = Math.cos(rotation);
  const s = Math.sin(rotation);
  const dx = point.x - anchor.x;
  const dy = point.y - anchor.y;
  const local = { x: dx * c + dy * s, y: -dx * s + dy * c };
  return {
    cx: anchor.x + dx / 2,
    cy: anchor.y + dy / 2,
    w: Math.max(1, Math.abs(local.x)),
    h: Math.max(1, Math.abs(local.y)),
    rotation,
  };
}
