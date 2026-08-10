import { useRef } from 'react';
import type { Engine } from '../core/engine';
import type { Vec2 } from '../core/types';
import { useEngineRevision, useUI } from '../state/store';

/** Radios visibles por punto de fuga — el encaje real (`snapToPerspective`)
 *  es más fino (cada 7.5°); dibujar esos 48 radios abarrotaría el lienzo,
 *  así que aquí se enseña un subconjunto representativo, no cada ángulo
 *  posible al que puede encajar un trazo. */
const GUIDE_LINES = 24;

/**
 * Tiradores y radios de la guía de perspectiva — activa independientemente
 * de qué herramienta esté puesta (a diferencia de `BoneGizmoOverlay`, que
 * sólo aparece con la herramienta de rig): la idea es poder arrastrar un
 * punto de fuga sin soltar el pincel, igual que se movería una regla física
 * sobre el papel.
 */
export function PerspectiveGuideOverlay({ engine }: { engine: Engine }) {
  useEngineRevision(engine);
  const setPrecisionDragAt = useUI((s) => s.setPrecisionDragAt);
  const dragging = useRef<'vp1' | 'vp2' | 'vp3' | null>(null);

  const g = engine.perspectiveGuide;
  if (!g.enabled) return null;

  const vps: { key: 'vp1' | 'vp2' | 'vp3'; p: Vec2 }[] =
    g.mode === '1pt'
      ? [{ key: 'vp1', p: g.vp1 }]
      : g.mode === '2pt'
        ? [
            { key: 'vp1', p: g.vp1 },
            { key: 'vp2', p: g.vp2 },
          ]
        : [
            { key: 'vp1', p: g.vp1 },
            { key: 'vp2', p: g.vp2 },
            { key: 'vp3', p: g.vp3 },
          ];

  const diag = Math.hypot(engine.doc.width, engine.doc.height);

  const begin = (key: 'vp1' | 'vp2' | 'vp3') => (e: React.PointerEvent) => {
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragging.current = key;
    setPrecisionDragAt({ x: e.clientX, y: e.clientY });
  };
  const move = (e: React.PointerEvent) => {
    if (!dragging.current) return;
    e.stopPropagation();
    const rect = engine.renderer.canvas.getBoundingClientRect();
    const local = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    engine.setPerspectiveVanishingPoint(dragging.current, engine.screenToDoc(local));
    setPrecisionDragAt({ x: e.clientX, y: e.clientY });
  };
  const end = (e: React.PointerEvent) => {
    dragging.current = null;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    setPrecisionDragAt(null);
  };

  return (
    <div className="perspective-overlay">
      <svg className="perspective-overlay__lines" aria-hidden="true">
        {vps.map(({ key, p }) => {
          const center = engine.docToScreen(p);
          const lines = [];
          for (let i = 0; i < GUIDE_LINES; i++) {
            const angle = (Math.PI * 2 * i) / GUIDE_LINES;
            const edge = engine.docToScreen({
              x: p.x + Math.cos(angle) * diag,
              y: p.y + Math.sin(angle) * diag,
            });
            lines.push(<line key={i} x1={center.x} y1={center.y} x2={edge.x} y2={edge.y} />);
          }
          return <g key={key}>{lines}</g>;
        })}
      </svg>
      {vps.map(({ key, p }) => {
        const screen = engine.docToScreen(p);
        return (
          <button
            key={key}
            type="button"
            className="perspective-overlay__vp"
            style={{ left: screen.x, top: screen.y }}
            onPointerDown={begin(key)}
            onPointerMove={move}
            onPointerUp={end}
            onPointerCancel={end}
            aria-label={`Mover punto de fuga ${key === 'vp1' ? '1' : key === 'vp2' ? '2' : '3'}`}
          />
        );
      })}
    </div>
  );
}
