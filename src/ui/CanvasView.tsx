import { useEffect, useRef } from 'react';
import { Engine } from '../core/engine';
import { clamp } from '../core/math';
import type { InputSample, Vec2 } from '../core/types';
import { useActiveBrush, useUI } from '../state/store';

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
    const g = gesture.current;
    if (!g) return;
    const pts = [...pointers.current.values()];
    if (pts.length < 2) return;
    const [a, b] = pts;
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
      if (drawingId.current !== null) {
        engine.cancelStroke();
        drawingId.current = null;
      }
      beginGesture();
      if (gesture.current) gesture.current.maxPointers = pointers.current.size;
      return;
    }

    const tool = uiRef.current.tool;
    if (tool === 'pan') return;
    if (!canDrawWith(e.pointerType)) return;

    const sample = toSample(e);

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

    if (gesture.current) {
      updateGesture();
      return;
    }

    if (drawingId.current !== e.pointerId) return;

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
  };

  const finishPointer = (e: React.PointerEvent) => {
    const engine = engineRef.current;
    if (!engine) return;
    pointers.current.delete(e.pointerId);
    canvasRef.current?.releasePointerCapture?.(e.pointerId);

    if (drawingId.current === e.pointerId) {
      engine.endStroke();
      drawingId.current = null;
    }
    if (gesture.current && pointers.current.size < 2) {
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
