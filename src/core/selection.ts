import type { Rect, Vec2 } from './types';

export type SelectionShape = 'rect' | 'lasso' | 'ellipse';

/**
 * Cómo se combina una selección nueva con la que ya había.
 * `replace` es el comportamiento por defecto; los otros dos son los
 * modificadores clásicos de sumar y restar área.
 */
export type SelectionMode = 'replace' | 'add' | 'subtract';

/**
 * Rasteriza la forma de selección en un canvas 2D.
 *
 * Se usa `fill()` del canvas en vez de un rasterizador propio por dos motivos:
 * el antialias sale gratis y correcto (un borde escalonado se nota muchísimo
 * al mover una selección), y evita escribir y mantener un scanline con reglas
 * de relleno par-impar.
 */
export function rasterizeSelection(
  canvas: HTMLCanvasElement,
  shape: SelectionShape,
  points: Vec2[],
  mode: SelectionMode,
): void {
  const ctx = canvas.getContext('2d')!;
  if (mode === 'replace') {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
  // Restar es dibujar la forma en modo "recortar", que es exactamente lo que
  // hace destination-out sobre la máscara acumulada.
  ctx.globalCompositeOperation = mode === 'subtract' ? 'destination-out' : 'source-over';
  ctx.fillStyle = '#fff';

  ctx.beginPath();
  if (shape === 'rect' && points.length >= 2) {
    const [a, b] = [points[0], points[points.length - 1]];
    ctx.rect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
  } else if (shape === 'ellipse' && points.length >= 2) {
    const [a, b] = [points[0], points[points.length - 1]];
    ctx.ellipse(
      (a.x + b.x) / 2,
      (a.y + b.y) / 2,
      Math.abs(b.x - a.x) / 2,
      Math.abs(b.y - a.y) / 2,
      0,
      0,
      Math.PI * 2,
    );
  } else if (points.length >= 3) {
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
    ctx.closePath();
  }
  ctx.fill();
  ctx.globalCompositeOperation = 'source-over';
}

/** Rectángulo que envuelve la forma, con un píxel de holgura para el antialias. */
export function shapeBounds(
  shape: SelectionShape,
  points: Vec2[],
  width: number,
  height: number,
): Rect {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const considered = shape === 'lasso' ? points : [points[0], points[points.length - 1]];
  for (const p of considered) {
    if (!p) continue;
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return {
    x: Math.max(0, Math.floor(minX) - 1),
    y: Math.max(0, Math.floor(minY) - 1),
    x2: Math.min(width, Math.ceil(maxX) + 1),
    y2: Math.min(height, Math.ceil(maxY) + 1),
  };
}

/** Une dos rectángulos; el vacío se representa con límites invertidos. */
export function unionRect(a: Rect, b: Rect): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    x2: Math.max(a.x2, b.x2),
    y2: Math.max(a.y2, b.y2),
  };
}

/** Las cuatro esquinas del rectángulo, en orden horario desde arriba-izquierda. */
export function rectCorners(r: Rect): Vec2[] {
  return [
    { x: r.x, y: r.y },
    { x: r.x2, y: r.y },
    { x: r.x2, y: r.y2 },
    { x: r.x, y: r.y2 },
  ];
}
