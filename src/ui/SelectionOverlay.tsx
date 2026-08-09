import { useRef } from 'react';
import type { Engine } from '../core/engine';
import { clamp } from '../core/math';
import type { Vec2 } from '../core/types';
import { useEngineRevision, useUI } from '../state/store';
import { IconClose, IconTrash, IconTransform } from './icons';

type DragKind = 'move' | 'scale' | 'rotate';

interface DragState {
  kind: DragKind;
  start: Vec2;
  centerScreen: Vec2;
  startTx: number;
  startTy: number;
  startScale: number;
  startRotation: number;
  startDistance: number;
  startAngle: number;
}

/**
 * Tiradores de la transformación libre, en DOM sobre el lienzo.
 *
 * Van en DOM y no dibujados en el canvas porque así heredan el tamaño mínimo
 * táctil, el foco de teclado y los estados de hover sin reimplementar nada.
 */
export function SelectionOverlay({ engine }: { engine: Engine }) {
  useEngineRevision(engine);
  const drag = useRef<DragState | null>(null);
  const color = useUI((s) => s.color);
  const frameRangeStart = useUI((s) => s.frameRangeStart);
  const frameRangeEnd = useUI((s) => s.frameRangeEnd);
  const setFrameRange = useUI((s) => s.setFrameRange);
  const setRangeSelectMode = useUI((s) => s.setRangeSelectMode);
  const setPrecisionDragAt = useUI((s) => s.setPrecisionDragAt);

  const floating = engine.floating;
  const hasSelection = engine.selection.active;
  // Un rango de un solo cuadro no es un lote — sería lo mismo que
  // "Transformar", así que sólo cuenta como rango de verdad por encima de 1.
  const hasFrameRange =
    frameRangeStart !== null && frameRangeEnd !== null && frameRangeEnd > frameRangeStart;

  // Mientras el lazo de Procreate está en marcha, `engine.selection` ya
  // refleja la vista previa del polígono a medio cerrar (para que se vea
  // rellena mientras se dibuja) pero todavía no es una selección de verdad
  // — su barra de acciones (Transformar/Rellenar/…) la pinta `LassoOverlay`.
  if (engine.pendingLasso) return null;
  if (!hasSelection && !floating) return null;

  /* ---------------- barra de acciones sobre la selección ---------------- */

  if (!floating) {
    const b = engine.selection.bounds;
    const anchor = engine.docToScreen({ x: (b.x + b.x2) / 2, y: b.y });
    return (
      <div
        className="sel-bar"
        style={{ left: anchor.x, top: Math.max(52, anchor.y - 52) }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <button type="button" onClick={() => engine.liftSelection()} title="Transformar">
          <IconTransform size={16} /> Transformar
        </button>
        {hasFrameRange && (
          <button
            type="button"
            onClick={() => {
              // El lote marcado en la línea de tiempo se consume al usarlo:
              // dejarlo puesto invitaría a pulsar el botón otra vez sobre un
              // rango que ya no tiene sentido (la transformación anterior ya
              // se está editando).
              if (engine.liftSelectionRange(frameRangeStart!, frameRangeEnd!)) {
                setFrameRange(null, null);
                setRangeSelectMode(false);
              }
            }}
            title="Transformar el rango marcado en la línea de tiempo"
          >
            <IconTransform size={16} /> Transformar rango ({frameRangeEnd! - frameRangeStart! + 1})
          </button>
        )}
        <button type="button" onClick={() => engine.fillSelection(color)} title="Rellenar">
          Rellenar
        </button>
        <button type="button" onClick={() => engine.deleteSelection()} title="Borrar">
          <IconTrash size={16} />
        </button>
        <button type="button" onClick={() => engine.invertSelection()} title="Invertir">
          Invertir
        </button>
        <button type="button" onClick={() => engine.clearSelection()} title="Deseleccionar">
          <IconClose size={16} />
        </button>
      </div>
    );
  }

  /* ---------------- transformación libre ---------------- */

  const corners = engine.floatingCorners() ?? [];
  const screen = corners.map((p) => engine.docToScreen(p));
  const center = engine.docToScreen({
    x: floating.pivotX + floating.tx,
    y: floating.pivotY + floating.ty,
  });

  // El tirador de giro sale perpendicular al borde superior, así que sigue al
  // objeto cuando se rota en vez de quedarse siempre arriba en pantalla.
  const topMid = { x: (screen[0].x + screen[1].x) / 2, y: (screen[0].y + screen[1].y) / 2 };
  const len = Math.hypot(topMid.x - center.x, topMid.y - center.y) || 1;
  const rotateHandle = {
    x: topMid.x + ((topMid.x - center.x) / len) * 34,
    y: topMid.y + ((topMid.y - center.y) / len) * 34,
  };

  const begin = (kind: DragKind) => (e: React.PointerEvent) => {
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const rect = engine.renderer.canvas.getBoundingClientRect();
    const start = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    drag.current = {
      kind,
      start,
      centerScreen: center,
      startTx: floating.tx,
      startTy: floating.ty,
      startScale: floating.scale,
      startRotation: floating.rotation,
      startDistance: Math.hypot(start.x - center.x, start.y - center.y) || 1,
      startAngle: Math.atan2(start.y - center.y, start.x - center.x),
    };
    setPrecisionDragAt({ x: e.clientX, y: e.clientY });
  };

  const move = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    e.stopPropagation();
    const rect = engine.renderer.canvas.getBoundingClientRect();
    const p = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    setPrecisionDragAt({ x: e.clientX, y: e.clientY });

    if (d.kind === 'move') {
      // El desplazamiento se expresa en píxeles de documento, y el lienzo
      // puede estar rotado respecto a la pantalla.
      const a = engine.screenToDoc(d.start);
      const b = engine.screenToDoc(p);
      engine.updateFloating({
        tx: d.startTx + (b.x - a.x),
        ty: d.startTy + (b.y - a.y),
      });
      return;
    }
    if (d.kind === 'scale') {
      const dist = Math.hypot(p.x - d.centerScreen.x, p.y - d.centerScreen.y);
      engine.updateFloating({
        scale: clamp((d.startScale * dist) / d.startDistance, 0.02, 20),
      });
      return;
    }
    const angle = Math.atan2(p.y - d.centerScreen.y, p.x - d.centerScreen.x);
    engine.updateFloating({ rotation: d.startRotation + (angle - d.startAngle) });
  };

  const end = (e: React.PointerEvent) => {
    drag.current = null;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    setPrecisionDragAt(null);
  };

  const outline = screen.map((p) => `${p.x},${p.y}`).join(' ');

  return (
    <div className="sel-overlay">
      <svg className="sel-outline" aria-hidden="true">
        <polygon points={outline} />
        <line x1={topMid.x} y1={topMid.y} x2={rotateHandle.x} y2={rotateHandle.y} />
      </svg>

      <button
        type="button"
        className="sel-handle sel-handle--move"
        style={{ left: center.x, top: center.y }}
        onPointerDown={begin('move')}
        onPointerMove={move}
        onPointerUp={end}
        aria-label="Mover selección"
      />
      {screen.map((p, i) => (
        <button
          key={i}
          type="button"
          className="sel-handle sel-handle--corner"
          style={{ left: p.x, top: p.y }}
          onPointerDown={begin('scale')}
          onPointerMove={move}
          onPointerUp={end}
          aria-label="Escalar selección"
        />
      ))}
      <button
        type="button"
        className="sel-handle sel-handle--rotate"
        style={{ left: rotateHandle.x, top: rotateHandle.y }}
        onPointerDown={begin('rotate')}
        onPointerMove={move}
        onPointerUp={end}
        aria-label="Girar selección"
      />

      <div
        className="sel-bar sel-bar--commit"
        // Por encima del tirador de giro, que sobresale 34 px del borde.
        style={{ left: center.x, top: Math.max(52, Math.min(...screen.map((p) => p.y)) - 88) }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <span className="sel-bar__readout">
          {Math.round(floating.scale * 100)}% · {Math.round((floating.rotation * 180) / Math.PI)}°
        </span>
        <button type="button" onClick={() => engine.commitFloating()}>
          Confirmar
        </button>
        <button type="button" onClick={() => engine.cancelFloating()}>
          Cancelar
        </button>
      </div>
    </div>
  );
}
