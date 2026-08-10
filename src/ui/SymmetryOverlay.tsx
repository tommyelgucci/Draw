import type { Engine } from '../core/engine';
import { useEngineRevision } from '../state/store';

/**
 * Línea(s) guía del eje de simetría — puramente informativa, sin
 * `pointer-events`: nada aquí captura toques, así que dibujar encima o
 * debajo del lienzo da igual para la interacción, sólo importa que se vea.
 */
export function SymmetryOverlay({ engine }: { engine: Engine }) {
  useEngineRevision(engine);
  const { vertical, horizontal, radial } = engine.symmetry;
  if (!vertical && !horizontal && radial < 2) return null;

  const lines: React.ReactNode[] = [];
  if (radial >= 2) {
    // Radios desde el centro — la misma longitud que la diagonal del
    // documento sobra de sobra para cruzar el lienzo en cualquier ángulo,
    // sin tener que intersecar contra los bordes.
    const cx = engine.doc.width / 2;
    const cy = engine.doc.height / 2;
    const len = Math.hypot(engine.doc.width, engine.doc.height);
    const center = engine.docToScreen({ x: cx, y: cy });
    for (let k = 0; k < radial; k++) {
      const theta = (Math.PI * 2 * k) / radial;
      const edge = engine.docToScreen({ x: cx + Math.cos(theta) * len, y: cy + Math.sin(theta) * len });
      lines.push(<line key={`r${k}`} x1={center.x} y1={center.y} x2={edge.x} y2={edge.y} />);
    }
  } else {
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
  }

  return (
    <svg className="symmetry-overlay" aria-hidden="true">
      {lines}
    </svg>
  );
}
