import { useEffect, useRef } from 'react';
import type { Engine } from '../core/engine';
import { useUI } from '../state/store';

const SIZE = 140;
const ZOOM = 2.5;
/** Separación entre el dedo y la lupa, y umbral para voltearla si no cabe
 *  por ese lado — así el dedo nunca tapa lo que la lupa enseña. */
const GAP = 28;

/**
 * Burbuja de acercamiento sobre el punto que se está arrastrando con
 * precisión (nodo de QuickShape, tirador de selección, de hueso…) — para
 * confirmar visualmente que dos trazos se unen exacto sin que el dedo
 * tape la costura.
 *
 * No vuelve a componer el documento por su cuenta: `ctx.drawImage(canvas
 * principal, …)` copia del lienzo YA renderizado, la misma superficie que
 * ve la persona. Redibujar la lupa es un `drawImage` acelerado por
 * compositor, no una segunda pasada de WebGL — coste real, no uno que haya
 * que adivinar. Y se redibuja sólo cuando `engine.onAfterRender` avisa de
 * que el lienzo principal cambió de verdad (ver la nota de
 * `preserveDrawingBuffer` en CLAUDE.md): leerlo en cualquier otro momento
 * podría capturar un búfer que el navegador ya limpió.
 */
export function LoupeOverlay({ engine }: { engine: Engine }) {
  const at = useUI((s) => s.precisionDragAt);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const atRef = useRef(at);
  atRef.current = at;

  useEffect(() => {
    if (!at) return;
    const draw = () => {
      const p = atRef.current;
      const loupe = canvasRef.current;
      if (!p || !loupe) return;
      const src = engine.renderer.canvas;
      const rect = src.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      const scaleX = src.width / rect.width;
      const scaleY = src.height / rect.height;
      const srcSize = (SIZE / ZOOM) * scaleX;
      const srcX = (p.x - rect.left) * scaleX - srcSize / 2;
      const srcY = (p.y - rect.top) * scaleY - srcSize / 2;

      const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
      if (loupe.width !== SIZE * dpr || loupe.height !== SIZE * dpr) {
        loupe.width = SIZE * dpr;
        loupe.height = SIZE * dpr;
      }
      const ctx = loupe.getContext('2d');
      if (!ctx) return;
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, loupe.width, loupe.height);
      ctx.drawImage(src, srcX, srcY, srcSize, srcSize, 0, 0, loupe.width, loupe.height);

      // Retícula central: el punto exacto que hay debajo del dedo.
      const c = loupe.width / 2;
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.lineWidth = Math.max(1, dpr);
      ctx.beginPath();
      ctx.moveTo(c - 10 * dpr, c);
      ctx.lineTo(c + 10 * dpr, c);
      ctx.moveTo(c, c - 10 * dpr);
      ctx.lineTo(c, c + 10 * dpr);
      ctx.stroke();
    };
    draw();
    return engine.onAfterRender(draw);
  }, [engine, at]);

  if (!at) return null;

  // Por encima y a la derecha del dedo por defecto; se voltea al lado
  // contrario si no cabe, para no salirse de la pantalla.
  const flipX = at.x + GAP + SIZE > window.innerWidth;
  const flipY = at.y - GAP - SIZE < 0;
  const left = flipX ? at.x - GAP - SIZE : at.x + GAP;
  const top = flipY ? at.y + GAP : at.y - GAP - SIZE;

  return (
    <div className="loupe" style={{ left, top, width: SIZE, height: SIZE }} aria-hidden="true">
      <canvas ref={canvasRef} style={{ width: SIZE, height: SIZE }} />
    </div>
  );
}
