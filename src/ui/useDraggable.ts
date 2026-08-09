import { useRef } from 'react';
import { clamp } from '../core/math';
import { useUI } from '../state/store';

/**
 * Arrastrar un panel por su cabecera. La posición se guarda en el store de
 * UI, no en estado local del componente: los paneles se desmontan al
 * cerrarse (`{panel === 'brush' && <BrushPanel />}` en App.tsx), así que un
 * `useState` local olvidaría dónde quedó en cuanto se cerrara — igual que
 * Procreate, que recuerda dónde dejaste cada panel dentro de la sesión.
 *
 * Antes de arrastrar, el panel usa la posición del CSS (`right`/`top` fijos
 * por `.panel--right`/`.panel--left`); en cuanto se suelta el primer
 * arrastre pasa a `position: fixed` con coordenadas explícitas, ancladas a
 * donde estaba en pantalla en ese momento — no salta.
 */
export function useDraggable(panelId: string) {
  const position = useUI((s) => s.panelPositions[panelId]);
  const setPanelPosition = useUI((s) => s.setPanelPosition);
  const drag = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    startLeft: number;
    startTop: number;
    width: number;
  } | null>(null);

  const onHeaderPointerDown = (e: React.PointerEvent<HTMLElement>) => {
    // El botón de cerrar (y cualquier otro control que acabe viviendo en la
    // cabecera) no debe arrastrar el panel al tocarlo.
    if ((e.target as HTMLElement).closest('button, input, select')) return;
    const panelEl = (e.currentTarget as HTMLElement).closest('.panel') as HTMLElement | null;
    if (!panelEl) return;
    const rect = panelEl.getBoundingClientRect();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      startLeft: rect.left,
      startTop: rect.top,
      width: rect.width,
    };
  };

  const onHeaderPointerMove = (e: React.PointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    e.stopPropagation();
    // Deja al menos un tirador de 48px dentro de la pantalla en cualquier
    // borde, para poder recuperar un panel que se soltó casi fuera.
    const margin = 48;
    const left = clamp(d.startLeft + (e.clientX - d.startX), margin - d.width, window.innerWidth - margin);
    const top = clamp(d.startTop + (e.clientY - d.startY), 0, window.innerHeight - margin);
    setPanelPosition(panelId, { left, top });
  };

  const onHeaderPointerUp = (e: React.PointerEvent<HTMLElement>) => {
    if (drag.current?.pointerId !== e.pointerId) return;
    drag.current = null;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
  };

  return { position, onHeaderPointerDown, onHeaderPointerMove, onHeaderPointerUp };
}
