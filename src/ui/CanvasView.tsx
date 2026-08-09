import { useEffect, useRef } from 'react';
import { Engine } from '../core/engine';
import { clamp } from '../core/math';
import { shapeRotation } from '../core/quickshape';
import type { SelectionMode, SelectionShape } from '../core/selection';
import type { InputSample, Vec2 } from '../core/types';
import { useActiveBrush, useUI } from '../state/store';

/**
 * Cuánto tarda el lápiz en considerarse "quieto" para disparar QuickShape,
 * y qué radio de pantalla se tolera como temblor antes de eso.
 *
 * Un dedo real en pantalla táctil no sólo tiembla más que un ratón: el
 * área de contacto se mueve varios píxeles incluso "sin querer" durante los
 * ~380ms que dura la espera, y como el ancla se realinea con cada
 * movimiento que supera el radio, un radio demasiado ajustado hace que el
 * temporizador se reinicie sin parar y nunca llegue a completarse — el
 * dwell no es que falle al reconocer, es que ni siquiera llega a
 * dispararse. 8px (calibrado con ratón) se quedaba corto; el radio típico
 * de "touch slop" en apps táctiles ronda 15-20px CSS.
 */
const DWELL_MS = 380;
const DWELL_RADIUS = 18;

interface TrackedPointer {
  id: number;
  x: number;
  y: number;
  type: string;
}

interface GestureState {
  distance: number;
  angle: number;
  center: Vec2;
  view: { tx: number; ty: number; zoom: number; rotation: number };
  moved: number;
  startedAt: number;
  maxPointers: number;
  /** Con la herramienta de transformación el gesto mueve la capa, no la vista. */
  layerTransform: { x: number; y: number; scale: number; rotation: number } | null;
}

/** Los datos de inclinación llegan en grados; el motor los quiere en radianes. */
function tiltToSpherical(tiltX: number, tiltY: number) {
  const tx = (tiltX * Math.PI) / 180;
  const ty = (tiltY * Math.PI) / 180;
  const tanX = Math.tan(tx);
  const tanY = Math.tan(ty);
  const altitude = Math.atan2(1, Math.hypot(tanX, tanY));
  const azimuth = Math.atan2(tanY, tanX);
  return { altitude, azimuth };
}

export function CanvasView() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<Engine | null>(null);
  const pointers = useRef(new Map<number, TrackedPointer>());
  const drawingId = useRef<number | null>(null);
  const gesture = useRef<GestureState | null>(null);
  const lastPenAt = useRef(0);
  const dwellTimer = useRef<number | null>(null);
  const dwellAnchor = useRef<Vec2 | null>(null);
  /** Aro que crece durante el dwell: sin él, "mantener quieto" es un gesto
   * invisible que nadie puede aprender ni depurar cuando falla. */
  const dwellRingRef = useRef<HTMLDivElement>(null);
  /** Gesto de segundo dedo mientras se sostiene una forma QuickShape recién
   * reconocida: rotación en incrementos de 15°, independiente del gesto de
   * vista/capa de `GestureState` (ver `beginGesture`). */
  const quickShapeGesture = useRef<{ startAngle: number; startRotation: number } | null>(null);
  const selectingId = useRef<number | null>(null);
  const selectPath = useRef<{
    shape: SelectionShape;
    points: Vec2[];
    mode: SelectionMode;
  } | null>(null);

  const setEngine = useUI((s) => s.setEngine);
  const brush = useActiveBrush();
  const brushRef = useRef(brush);
  brushRef.current = brush;
  const ui = useUI();
  const uiRef = useRef(ui);
  uiRef.current = ui;

  useEffect(() => {
    const canvas = canvasRef.current!;
    let engine: Engine;
    try {
      engine = new Engine(canvas);
    } catch (err) {
      console.error(err);
      return;
    }
    engineRef.current = engine;
    setEngine(engine);
    engine.requestRender();

    if (import.meta.env.DEV) {
      // Punto de entrada para inspeccionar el motor desde la consola y desde
      // las pruebas de navegador.
      (window as unknown as { __trace: Engine }).__trace = engine;
    }

    const onResize = () => {
      engine.syncViewport();
      engine.requestRender();
    };
    window.addEventListener('resize', onResize);
    const observer = new ResizeObserver(onResize);
    observer.observe(canvas);

    return () => {
      window.removeEventListener('resize', onResize);
      observer.disconnect();
      engine.dispose();
      setEngine(null);
      engineRef.current = null;
    };
  }, [setEngine]);

  /* ---------------------------------------------------------------- *
   * Conversión de eventos
   * ---------------------------------------------------------------- */

  const localPoint = (e: { clientX: number; clientY: number }): Vec2 => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const toSample = (e: PointerEvent | React.PointerEvent): InputSample => {
    const engine = engineRef.current!;
    const local = localPoint(e);
    const doc = engine.screenToDoc(local);

    let pressure = e.pressure;
    // El ratón reporta 0.5 o 0; un lápiz sin contacto reporta 0. Sin este
    // ajuste las dinámicas de presión dejarían trazos invisibles.
    if (e.pointerType === 'mouse' || pressure <= 0) pressure = 0.5;

    let altitude = Math.PI / 2;
    let azimuth = 0;
    const native = e as PointerEvent & { altitudeAngle?: number; azimuthAngle?: number };
    if (typeof native.altitudeAngle === 'number') {
      altitude = native.altitudeAngle;
      azimuth = native.azimuthAngle ?? 0;
    } else if (e.tiltX || e.tiltY) {
      const s = tiltToSpherical(e.tiltX, e.tiltY);
      altitude = s.altitude;
      azimuth = s.azimuth;
    }
    // La inclinación llega en el marco de la pantalla; el lienzo puede estar rotado.
    azimuth -= engine.view.rotation;

    return {
      x: doc.x,
      y: doc.y,
      pressure: clamp(pressure, 0.01, 1),
      altitude,
      azimuth,
      time: e.timeStamp || performance.now(),
    };
  };

  /** Un dedo no dibuja si el usuario lo desactivó o si acaba de usar el lápiz. */
  const canDrawWith = (type: string) => {
    if (type === 'pen' || type === 'mouse') return true;
    if (!uiRef.current.fingerDraws) return false;
    return performance.now() - lastPenAt.current > 700;
  };

  /* ---------------------------------------------------------------- *
   * QuickShape: detección de "lápiz quieto"
   * ---------------------------------------------------------------- */

  const hideDwellRing = () => {
    dwellRingRef.current?.classList.remove('is-armed');
  };

  /** (Re)arranca la animación del aro en `local`, reiniciándola aunque ya
   * estuviera a mitad — por eso el `classList.remove` + reflow forzado antes
   * de volver a añadir la clase que dispara la transición CSS. */
  const showDwellRing = (local: Vec2) => {
    const el = dwellRingRef.current;
    if (!el) return;
    el.style.left = `${local.x}px`;
    el.style.top = `${local.y}px`;
    el.classList.remove('is-armed');
    void el.offsetWidth;
    el.style.transitionDuration = `${DWELL_MS}ms`;
    el.classList.add('is-armed');
  };

  const clearDwell = () => {
    if (dwellTimer.current !== null) {
      window.clearTimeout(dwellTimer.current);
      dwellTimer.current = null;
    }
    dwellAnchor.current = null;
    hideDwellRing();
  };

  /**
   * Reinicia el temporizador cada vez que el puntero se mueve más allá del
   * radio de temblor. Si nunca se reinicia, `fireDwell` dispara sola tras
   * `DWELL_MS` — no hace falta guardar cuánto tiempo lleva quieto, sólo no
   * tocar el timer mientras siga dentro del radio.
   */
  const updateDwell = (pointerId: number, local: Vec2) => {
    if (!uiRef.current.quickShapeEnabled) return;
    const anchor = dwellAnchor.current;
    if (anchor && Math.hypot(local.x - anchor.x, local.y - anchor.y) <= DWELL_RADIUS) return;
    dwellAnchor.current = local;
    if (dwellTimer.current !== null) window.clearTimeout(dwellTimer.current);
    dwellTimer.current = window.setTimeout(() => fireDwell(pointerId), DWELL_MS);
    showDwellRing(local);
  };

  const fireDwell = (pointerId: number) => {
    dwellTimer.current = null;
    dwellAnchor.current = null;
    hideDwellRing();
    const engine = engineRef.current;
    // El trazo pudo terminar mientras esperábamos: sin efecto si ya no es
    // el puntero que sigue dibujando.
    if (!engine || drawingId.current !== pointerId) return;
    engine.tryQuickShape(uiRef.current.quickShapePrecision);
  };

  /* ---------------------------------------------------------------- *
   * Gestos
   * ---------------------------------------------------------------- */

  const beginGesture = () => {
    const engine = engineRef.current!;
    const pts = [...pointers.current.values()];
    if (pts.length < 2) return;
    const [a, b] = pts;
    const layer = engine.activeLayer;
    const useLayer = uiRef.current.tool === 'transform' && layer !== null;
    gesture.current = {
      distance: Math.hypot(b.x - a.x, b.y - a.y),
      angle: Math.atan2(b.y - a.y, b.x - a.x),
      center: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      view: { ...engine.view },
      moved: 0,
      startedAt: performance.now(),
      maxPointers: pts.length,
      layerTransform:
        useLayer && layer
          ? {
              x: engine.getTransformValue(layer, 'x'),
              y: engine.getTransformValue(layer, 'y'),
              scale: engine.getTransformValue(layer, 'scale'),
              rotation: engine.getTransformValue(layer, 'rotation'),
            }
          : null,
    };
  };

  const updateGesture = () => {
    const engine = engineRef.current!;
    const pts = [...pointers.current.values()];
    if (pts.length < 2) return;
    const [a, b] = pts;

    if (quickShapeGesture.current) {
      const qg = quickShapeGesture.current;
      const angle = Math.atan2(b.y - a.y, b.x - a.x);
      let rotationDelta = angle - qg.startAngle;
      // Normaliza el salto de ±π al cruzar el eje, igual que el gesto normal.
      if (rotationDelta > Math.PI) rotationDelta -= Math.PI * 2;
      if (rotationDelta < -Math.PI) rotationDelta += Math.PI * 2;
      engine.rotateQuickShapeSnapped(qg.startRotation + rotationDelta);
      return;
    }

    const g = gesture.current;
    if (!g) return;
    const distance = Math.hypot(b.x - a.x, b.y - a.y);
    const angle = Math.atan2(b.y - a.y, b.x - a.x);
    const center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };

    const scaleDelta = g.distance > 8 ? distance / g.distance : 1;
    let rotationDelta = angle - g.angle;
    // Normaliza el salto de ±π al cruzar el eje.
    if (rotationDelta > Math.PI) rotationDelta -= Math.PI * 2;
    if (rotationDelta < -Math.PI) rotationDelta += Math.PI * 2;

    g.moved += Math.hypot(center.x - g.center.x, center.y - g.center.y);

    if (g.layerTransform) {
      const layer = engine.activeLayer;
      if (!layer) return;
      const dx = (center.x - g.center.x) / engine.view.zoom;
      const dy = (center.y - g.center.y) / engine.view.zoom;
      engine.setTransformValue(layer.id, 'x', g.layerTransform.x + dx);
      engine.setTransformValue(layer.id, 'y', g.layerTransform.y + dy);
      engine.setTransformValue(
        layer.id,
        'scale',
        clamp(g.layerTransform.scale * scaleDelta, 0.02, 20),
      );
      engine.setTransformValue(
        layer.id,
        'rotation',
        g.layerTransform.rotation + rotationDelta,
      );
      return;
    }

    engine.view.zoom = clamp(g.view.zoom * scaleDelta, 0.02, 64);
    engine.view.rotation = g.view.rotation + rotationDelta;

    // Mantiene bajo los dedos el mismo punto del documento que había al empezar.
    const anchorDoc = screenToDocWith(g.view, g.center, engine);
    const anchorNow = engine.docToScreen(anchorDoc);
    engine.view.tx += center.x - anchorNow.x;
    engine.view.ty += center.y - anchorNow.y;
    engine.requestRender();
  };

  const endGesture = () => {
    const engine = engineRef.current!;
    const g = gesture.current;
    gesture.current = null;
    quickShapeGesture.current = null;
    if (!g) return;
    const duration = performance.now() - g.startedAt;
    // Toque rápido con varios dedos: los atajos de Procreate.
    if (duration < 320 && g.moved < 16) {
      if (g.maxPointers === 2) engine.history.undo();
      else if (g.maxPointers >= 3) engine.history.redo();
    }
  };

  /* ---------------------------------------------------------------- *
   * Punteros
   * ---------------------------------------------------------------- */

  const onPointerDown = (e: React.PointerEvent) => {
    const engine = engineRef.current;
    if (!engine) return;
    const canvas = canvasRef.current!;
    canvas.setPointerCapture(e.pointerId);
    if (e.pointerType === 'pen') lastPenAt.current = performance.now();

    const local = localPoint(e);
    pointers.current.set(e.pointerId, {
      id: e.pointerId,
      x: local.x,
      y: local.y,
      type: e.pointerType,
    });

    if (pointers.current.size >= 2) {
      // Segundo dedo con una forma QuickShape pendiente — recién reconocida
      // y todavía sostenida, o ya soltada y en modo de edición de nodos:
      // fuerza proporción exacta, como en Procreate, y arma el gesto de
      // rotación en incrementos de 15° en vez de mover la vista o la capa.
      // (Los tiradores y la barra de `QuickShapeOverlay` hacen
      // `stopPropagation`, así que este bloque sólo ve dedos que tocan
      // lienzo vacío, no los que arrastran un nodo.)
      if (engine.pendingQuickShape) {
        engine.forceQuickShapeProportion();
        const [pa, pb] = [...pointers.current.values()];
        quickShapeGesture.current = {
          startAngle: Math.atan2(pb.y - pa.y, pb.x - pa.x),
          startRotation: shapeRotation(engine.pendingQuickShape.shape),
        };
        return;
      }

      if (drawingId.current !== null) {
        engine.cancelStroke();
        clearDwell();
        drawingId.current = null;
      }
      if (selectingId.current !== null) {
        selectingId.current = null;
        selectPath.current = null;
      }
      beginGesture();
      if (gesture.current) gesture.current.maxPointers = pointers.current.size;
      return;
    }

    const tool = uiRef.current.tool;
    if (tool === 'pan') return;
    if (!canDrawWith(e.pointerType)) return;

    const sample = toSample(e);

    if (tool === 'selectRect' || tool === 'selectLasso') {
      engine.beginSelectionDrag();
      selectPath.current = {
        shape: tool === 'selectRect' ? 'rect' : 'lasso',
        points: [{ x: sample.x, y: sample.y }],
        mode: uiRef.current.selectionMode,
      };
      selectingId.current = e.pointerId;
      return;
    }

    if (tool === 'eyedropper') {
      const picked = engine.pickColor({ x: sample.x, y: sample.y });
      if (picked) uiRef.current.setColor(picked, true);
      return;
    }
    if (tool === 'fill') {
      uiRef.current.setBusy('Rellenando…');
      // Un frame de respiro para que se pinte el indicador antes de bloquear.
      requestAnimationFrame(() => {
        engine.floodFill({ x: sample.x, y: sample.y }, uiRef.current.color);
        uiRef.current.setBusy(null);
      });
      return;
    }
    if (tool === 'transform') return;

    if (engine.beginStroke(sample, { brush: brushRef.current, color: uiRef.current.color })) {
      drawingId.current = e.pointerId;
      updateDwell(e.pointerId, local);
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const engine = engineRef.current;
    if (!engine) return;
    if (e.pointerType === 'pen') lastPenAt.current = performance.now();

    const tracked = pointers.current.get(e.pointerId);
    if (tracked) {
      const local = localPoint(e);
      tracked.x = local.x;
      tracked.y = local.y;
    }

    if (gesture.current || quickShapeGesture.current) {
      updateGesture();
      return;
    }

    if (selectingId.current === e.pointerId && selectPath.current) {
      const path = selectPath.current;
      const s = toSample(e);
      const last = path.points[path.points.length - 1];
      // El lazo no necesita cada muestra: un punto por píxel sobra y mantiene
      // barata la rasterización en cada movimiento.
      if (path.shape === 'rect') {
        path.points = [path.points[0], { x: s.x, y: s.y }];
      } else if (!last || Math.hypot(s.x - last.x, s.y - last.y) > 1.5) {
        path.points.push({ x: s.x, y: s.y });
      }
      engine.previewSelectionShape(path.shape, path.points, path.mode);
      return;
    }

    if (drawingId.current !== e.pointerId) return;

    // Puntero sosteniendo una forma ya reconocida (aún sin soltar): sigue
    // ajustando el nodo más cercano en vez de alimentar el trazo libre, que
    // ya está apagado (`tryQuickShape` puso `builder` a null).
    if (engine.pendingQuickShape && !engine.pendingQuickShape.editing) {
      const s = toSample(e);
      engine.adjustQuickShape({ x: s.x, y: s.y });
      return;
    }

    // Los eventos fusionados traen todas las muestras que el navegador agrupó
    // en este frame: en un iPad a 120 Hz son varias, y perderlas se nota.
    const native = e.nativeEvent as PointerEvent & {
      getCoalescedEvents?: () => PointerEvent[];
      getPredictedEvents?: () => PointerEvent[];
    };
    const coalesced = native.getCoalescedEvents?.() ?? [];
    const samples =
      coalesced.length > 0 ? coalesced.map((ev) => toSample(ev)) : [toSample(e)];
    const predicted = (native.getPredictedEvents?.() ?? []).map((ev) => toSample(ev));

    engine.moveStroke(samples, predicted);
    updateDwell(e.pointerId, localPoint(e));
  };

  const finishPointer = (e: React.PointerEvent) => {
    const engine = engineRef.current;
    if (!engine) return;
    pointers.current.delete(e.pointerId);
    canvasRef.current?.releasePointerCapture?.(e.pointerId);

    if (drawingId.current === e.pointerId) {
      clearDwell();
      // Si hay una forma reconocida pendiente, soltar el puntero no la
      // hornea: pasa al modo de edición de nodos (`QuickShapeOverlay`),
      // igual que el "Edit Shape" de Procreate.
      if (engine.pendingQuickShape) engine.finishQuickShapeHold();
      else engine.endStroke();
      drawingId.current = null;
    }
    if (selectingId.current === e.pointerId) {
      const path = selectPath.current;
      selectingId.current = null;
      selectPath.current = null;
      if (path) {
        const tooSmall =
          path.shape === 'rect'
            ? path.points.length < 2 ||
              Math.hypot(
                path.points[1].x - path.points[0].x,
                path.points[1].y - path.points[0].y,
              ) < 3
            : path.points.length < 3;
        // Un toque suelto con la herramienta de selección deselecciona, que
        // es lo que espera cualquiera que venga de un editor de imagen.
        if (tooSmall) engine.clearSelection();
        else engine.applySelectionShape(path.shape, path.points, path.mode);
      }
    }
    if ((gesture.current || quickShapeGesture.current) && pointers.current.size < 2) {
      endGesture();
    }
  };

  const onWheel = (e: React.WheelEvent) => {
    const engine = engineRef.current;
    if (!engine) return;
    const local = localPoint(e);
    if (e.ctrlKey || e.metaKey) {
      engine.zoomAt(local, Math.exp(-e.deltaY * 0.01));
    } else {
      engine.view.tx -= e.deltaX;
      engine.view.ty -= e.deltaY;
      engine.requestRender();
    }
  };

  return (
    <>
      <canvas
        ref={canvasRef}
        className="canvas-surface"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finishPointer}
        onPointerCancel={finishPointer}
        onWheel={onWheel}
        onContextMenu={(e) => e.preventDefault()}
      />
      <div ref={dwellRingRef} className="dwell-ring" aria-hidden="true" />
    </>
  );
}

/** `screenToDoc` con un estado de vista arbitrario, para anclar gestos. */
function screenToDocWith(
  view: { tx: number; ty: number; zoom: number; rotation: number },
  p: Vec2,
  engine: Engine,
): Vec2 {
  const dx = p.x - view.tx;
  const dy = p.y - view.ty;
  const c = Math.cos(-view.rotation);
  const s = Math.sin(-view.rotation);
  const rx = (dx * c - dy * s) / view.zoom;
  const ry = (dx * s + dy * c) / view.zoom;
  return { x: rx + engine.doc.width / 2, y: ry + engine.doc.height / 2 };
}
