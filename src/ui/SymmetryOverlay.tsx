import type { Engine } from '../core/engine';
import { useEngineRevision } from '../state/store';

/**
 * Línea(s) guía del eje de simetría — puramente informativa, sin
 * `pointer-events`: nada aquí captura toques, así que dibujar encima o
 * debajo del lienzo da igual para la interacción, sólo importa que se vea.
 */
export function SymmetryOverlay({ engine }: { engine: Engine }) {
  useEngineRevision(engine);
  const { vertical, horizontal } = engine.symmetry;
  if (!vertical && !horizontal) return null;

  const lines: React.ReactNode[] = [];
  if (vertical) {
    const a = engine.docToScreen({ x: engine.doc.width / 2, y: 0 });
    const b = engine.docToScreen({ x: engine.doc.width / 2, y: engine.doc.height });
    lines.push(<line key="v" x1={a.x} y1={a.y} x2={b.x} y2={b.y} />);
  }
  if (horizontal) {
    const a = engine.docToScreen({ x: 0, y: engine.doc.height / 2 });
    const b = engine.docToScreen({ x: engine.doc.width, y: engine.doc.height / 2 });
    lines.push(<line key="h" x1={a.x} y1={a.y} x2={b.x} y2={b.y} />);
  }

  return (
    <svg className="symmetry-overlay" aria-hidden="true">
      {lines}
    </svg>
  );
}
