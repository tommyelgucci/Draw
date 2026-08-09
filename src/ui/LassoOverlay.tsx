import type { Engine } from '../core/engine';
import { shapeBounds } from '../core/selection';
import { useEngineRevision } from '../state/store';
import { IconClose } from './icons';

/**
 * Nodo de origen + barra flotante del lazo estilo Procreate
 * (`engine.pendingLasso`). El gesto pausa entre toques del dedo — a
 * diferencia de una selección de un solo arrastre, no hay un `pointerup`
 * final que lo cierre solo — así que hace falta una señal visible en el
 * lienzo para cerrarlo: tocar el nodo de origen o aceptar desde la barra
 * hacen exactamente lo mismo, `engine.commitLasso()`.
 */
export function LassoOverlay({ engine }: { engine: Engine }) {
  useEngineRevision(engine);
  const pending = engine.pendingLasso;
  if (!pending || pending.points.length === 0) return null;

  const screenPoints = pending.points.map((p) => engine.docToScreen(p));
  const origin = screenPoints[0];
  const bounds = shapeBounds('lasso', pending.points, engine.doc.width, engine.doc.height);
  const anchor = engine.docToScreen({ x: (bounds.x + bounds.x2) / 2, y: bounds.y });
  const outline = screenPoints.map((p) => `${p.x},${p.y}`).join(' ');

  return (
    <div className="lasso-overlay">
      <svg className="sel-outline lasso-outline" aria-hidden="true">
        <polyline points={outline} />
      </svg>

      <button
        type="button"
        className="lasso-origin"
        style={{ left: origin.x, top: origin.y }}
        // Cierra al TOCAR (pointerdown), no al `click`: un `click` sólo se
        // sintetiza si el dedo se levanta cerca de donde bajó, así que un
        // toque en el origen que sigue moviéndose (p. ej. para encadenar
        // otro tramo desde ahí mismo) se tragaría el gesto entero sin
        // cerrar nada. Tocar el origen siempre cierra, de inmediato — igual
        // que en Procreate.
        onPointerDown={(e) => {
          e.stopPropagation();
          engine.commitLasso();
        }}
        aria-label="Cerrar lazo en el nodo de origen"
        title="Cerrar lazo"
      />

      <div
        className="sel-bar"
        style={{ left: anchor.x, top: Math.max(52, anchor.y - 52) }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <span className="sel-bar__readout">{pending.points.length} puntos</span>
        <button type="button" className="is-key" onClick={() => engine.commitLasso()}>
          Cerrar
        </button>
        <button type="button" onClick={() => engine.cancelLasso()} title="Cancelar lazo">
          <IconClose size={16} />
        </button>
      </div>
    </div>
  );
}
