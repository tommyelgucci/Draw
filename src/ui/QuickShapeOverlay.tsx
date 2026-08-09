import { useRef } from 'react';
import type { Engine } from '../core/engine';
import { hasRotateHandle, sampleShapeOutline, shapeNodes } from '../core/quickshape';
import type { Vec2 } from '../core/types';
import { useEngineRevision, useUI } from '../state/store';

/** Diagonal de una nube de puntos, para escalar el paso de muestreo del
 * contorno visual a cada forma sin depender del tamaño del pincel. */
function boundingDiag(points: Vec2[]): number {
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
  return Math.hypot(maxX - minX, maxY - minY) || 1;
}

/**
 * Modo "Edit Shape" de QuickShape: nodos arrastrables sobre la forma
 * reconocida, en DOM sobre el lienzo — calco directo de `SelectionOverlay`
 * (mismo motivo: tamaño táctil y hover gratis sin reimplementarlos).
 *
 * A diferencia de los tiradores de `SelectionOverlay`, no hace falta
 * guardar un snapshot de arranque (escala/rotación iniciales): cada nodo de
 * `updateShapeNode` recibe directamente el punto absoluto en espacio
 * documento y ya resuelve el redimensionado anclado a la esquina opuesta,
 * así que sólo hace falta saber *qué* nodo se está arrastrando, no desde
 * dónde — el mismo `dragIndex` de `SelectionOverlay` sin el resto del
 * `DragState`.
 */
export function QuickShapeOverlay({ engine }: { engine: Engine }) {
  useEngineRevision(engine);
  const dragIndex = useRef<number | null>(null);
  const setPrecisionDragAt = useUI((s) => s.setPrecisionDragAt);

  const pending = engine.pendingQuickShape;
  if (!pending || !pending.editing) return null;

  const { shape } = pending;
  const nodes = shapeNodes(shape);
  const screenNodes = nodes.map((p) => engine.docToScreen(p));

  const begin = (index: number) => (e: React.PointerEvent) => {
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragIndex.current = index;
    setPrecisionDragAt({ x: e.clientX, y: e.clientY });
  };
  const move = (e: React.PointerEvent) => {
    if (dragIndex.current === null) return;
    e.stopPropagation();
    const rect = engine.renderer.canvas.getBoundingClientRect();
    const local = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    engine.dragQuickShapeNode(dragIndex.current, engine.screenToDoc(local));
    setPrecisionDragAt({ x: e.clientX, y: e.clientY });
  };
  const end = (e: React.PointerEvent) => {
    dragIndex.current = null;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    setPrecisionDragAt(null);
  };

  // Contorno de referencia: la silueta real ya se ve a través de `wet` (las
  // estampas del pincel); esto es sólo la línea discontinua que marca dónde
  // está la geometría exacta mientras se edita.
  const spacing = Math.max(2, boundingDiag(nodes) / 48);
  const outlinePoints =
    shape.kind === 'line' ? [nodes[0], nodes[1]] : sampleShapeOutline(shape, spacing);
  const outlineScreen = outlinePoints.map((p) => engine.docToScreen(p));

  let rotateHandle: Vec2 | null = null;
  let topMid: Vec2 | null = null;
  if (hasRotateHandle(shape)) {
    const center = engine.docToScreen({ x: shape.cx, y: shape.cy });
    topMid = {
      x: (screenNodes[0].x + screenNodes[1].x) / 2,
      y: (screenNodes[0].y + screenNodes[1].y) / 2,
    };
    const len = Math.hypot(topMid.x - center.x, topMid.y - center.y) || 1;
    rotateHandle = {
      x: topMid.x + ((topMid.x - center.x) / len) * 34,
      y: topMid.y + ((topMid.y - center.y) / len) * 34,
    };
  }

  const barAnchor = {
    x: screenNodes.reduce((sum, p) => sum + p.x, 0) / screenNodes.length,
    y: Math.min(...screenNodes.map((p) => p.y)),
  };

  return (
    <div className="sel-overlay">
      <svg className="sel-outline" aria-hidden="true">
        {shape.kind === 'line' ? (
          <line
            x1={outlineScreen[0].x}
            y1={outlineScreen[0].y}
            x2={outlineScreen[1].x}
            y2={outlineScreen[1].y}
          />
        ) : (
          <polygon points={outlineScreen.map((p) => `${p.x},${p.y}`).join(' ')} />
        )}
        {rotateHandle && topMid && (
          <line x1={topMid.x} y1={topMid.y} x2={rotateHandle.x} y2={rotateHandle.y} />
        )}
      </svg>

      {screenNodes.map((p, i) => (
        <button
          key={i}
          type="button"
          className="sel-handle sel-handle--corner"
          style={{ left: p.x, top: p.y }}
          onPointerDown={begin(i)}
          onPointerMove={move}
          onPointerUp={end}
          aria-label="Ajustar forma"
        />
      ))}
      {rotateHandle && (
        <button
          type="button"
          className="sel-handle sel-handle--rotate"
          style={{ left: rotateHandle.x, top: rotateHandle.y }}
          onPointerDown={begin(nodes.length)}
          onPointerMove={move}
          onPointerUp={end}
          aria-label="Girar forma"
        />
      )}

      <div
        className="sel-bar sel-bar--commit"
        style={{ left: barAnchor.x, top: Math.max(52, barAnchor.y - 60) }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <button type="button" onClick={() => engine.commitQuickShape()}>
          Confirmar
        </button>
        <button type="button" onClick={() => engine.cancelQuickShape()}>
          Cancelar
        </button>
      </div>
    </div>
  );
}
