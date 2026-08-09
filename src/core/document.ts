import type { Surface } from '../gl/renderer';
import { clamp, lerp } from './math';
import type { BlendMode, RGB } from './types';

export type Easing = 'hold' | 'linear' | 'easeIn' | 'easeOut' | 'easeInOut';

export interface Keyframe {
  frame: number;
  value: number;
  easing: Easing;
}

/** Canal animable de una propiedad escalar. */
export interface Channel {
  /** Valor usado cuando no hay keyframes. */
  base: number;
  /** Ordenados por `frame`. Vacío = propiedad estática. */
  keys: Keyframe[];
}

export function channel(base: number): Channel {
  return { base, keys: [] };
}

export const EASINGS: Record<Easing, (t: number) => number> = {
  hold: () => 0,
  linear: (t) => t,
  easeIn: (t) => t * t,
  easeOut: (t) => 1 - (1 - t) * (1 - t),
  easeInOut: (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2),
};

export const EASING_LABELS: Record<Easing, string> = {
  hold: 'Mantener',
  linear: 'Lineal',
  easeIn: 'Entrada suave',
  easeOut: 'Salida suave',
  easeInOut: 'Suave',
};

/** Valor del canal en un fotograma, interpolando entre keyframes. */
export function sampleChannel(ch: Channel, frame: number): number {
  const keys = ch.keys;
  if (keys.length === 0) return ch.base;
  if (frame <= keys[0].frame) return keys[0].value;
  const last = keys[keys.length - 1];
  if (frame >= last.frame) return last.value;

  let i = 0;
  while (i < keys.length - 1 && keys[i + 1].frame <= frame) i++;
  const a = keys[i];
  const b = keys[i + 1];
  const span = b.frame - a.frame;
  if (span <= 0) return b.value;
  const t = (frame - a.frame) / span;
  // El easing lo define el keyframe de salida, como en After Effects.
  return lerp(a.value, b.value, EASINGS[a.easing](t));
}

export function setKeyframe(ch: Channel, frame: number, value: number, easing: Easing = 'easeInOut') {
  const i = ch.keys.findIndex((k) => k.frame === frame);
  if (i >= 0) {
    ch.keys[i] = { frame, value, easing: ch.keys[i].easing };
  } else {
    ch.keys.push({ frame, value, easing });
    ch.keys.sort((a, b) => a.frame - b.frame);
  }
}

export function removeKeyframe(ch: Channel, frame: number) {
  const i = ch.keys.findIndex((k) => k.frame === frame);
  if (i >= 0) ch.keys.splice(i, 1);
}

/** Las cinco propiedades interpolables de una capa. */
export interface TransformTrack {
  x: Channel;
  y: Channel;
  scale: Channel;
  rotation: Channel;
  opacity: Channel;
}

export const TRANSFORM_PROPS = ['x', 'y', 'scale', 'rotation', 'opacity'] as const;
export type TransformProp = (typeof TRANSFORM_PROPS)[number];

export const TRANSFORM_LABELS: Record<TransformProp, string> = {
  x: 'Posición X',
  y: 'Posición Y',
  scale: 'Escala',
  rotation: 'Rotación',
  opacity: 'Opacidad',
};

export function newTransform(): TransformTrack {
  return {
    x: channel(0),
    y: channel(0),
    scale: channel(1),
    rotation: channel(0),
    opacity: channel(1),
  };
}

export function transformIsIdentity(t: TransformTrack, frame: number): boolean {
  return (
    sampleChannel(t.x, frame) === 0 &&
    sampleChannel(t.y, frame) === 0 &&
    sampleChannel(t.scale, frame) === 1 &&
    sampleChannel(t.rotation, frame) === 0
  );
}

export function hasAnyKeyframes(t: TransformTrack): boolean {
  return TRANSFORM_PROPS.some((p) => t[p].keys.length > 0);
}

/** Un dibujo. Vive en un fotograma y se mantiene hasta el siguiente cel. */
export interface Cel {
  id: string;
  surface: Surface;
  /** Nombre corto opcional, útil para marcar poses clave. */
  label?: string;
}

/**
 * `draw`: capa normal, se dibuja y se exporta. `reference`: imagen o vídeo
 * importado para calcar (rotoscopia) — no admite trazo, bote ni selección, y
 * queda fuera de PNG/APNG/secuencia porque no es parte de la obra final.
 */
export type LayerKind = 'draw' | 'reference';

export interface Layer {
  id: string;
  name: string;
  kind: LayerKind;
  visible: boolean;
  locked: boolean;
  opacity: number;
  blend: BlendMode;
  /** Recorta esta capa a la alfa de la capa base que tiene debajo. */
  clipToBelow: boolean;
  /**
   * `false`: un único cel (en el fotograma 0) visible en toda la animación —
   * fondos, capas de color. `true`: dibujo cuadro por cuadro.
   */
  animated: boolean;
  /** Clave = fotograma en que aparece el cel. */
  cels: Map<number, Cel>;
  transform: TransformTrack;
}

export interface TraceDocument {
  id: string;
  name: string;
  width: number;
  height: number;
  fps: number;
  frameCount: number;
  /** Capas de abajo hacia arriba, como la pila de la GPU. */
  layers: Layer[];
  paper: RGB;
  /** 0 = lienzo transparente, 1 = papel opaco. */
  paperAlpha: number;
  createdAt: number;
  modifiedAt: number;
}

let idCounter = 0;
export function uid(prefix = 'id'): string {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${idCounter.toString(36)}`;
}

export function newLayer(name: string, animated = true, kind: LayerKind = 'draw'): Layer {
  return {
    id: uid('layer'),
    name,
    kind,
    visible: true,
    locked: false,
    opacity: 1,
    blend: 'normal',
    clipToBelow: false,
    animated,
    cels: new Map(),
    transform: newTransform(),
  };
}

export function newDocument(
  width = 1920,
  height = 1080,
  fps = 12,
  frameCount = 24,
): TraceDocument {
  return {
    id: uid('doc'),
    name: 'Sin título',
    width,
    height,
    fps,
    frameCount,
    layers: [],
    paper: { r: 1, g: 1, b: 1 },
    paperAlpha: 1,
    createdAt: Date.now(),
    modifiedAt: Date.now(),
  };
}

/**
 * Cel visible en `frame`: el más reciente en o antes de ese fotograma.
 * Una capa no animada usa siempre su único cel, esté donde esté.
 */
export function celAt(layer: Layer, frame: number): Cel | null {
  if (!layer.animated) {
    const first = layer.cels.values().next();
    return first.done ? null : first.value;
  }
  let best: Cel | null = null;
  let bestFrame = -1;
  for (const [f, cel] of layer.cels) {
    if (f <= frame && f > bestFrame) {
      bestFrame = f;
      best = cel;
    }
  }
  return best;
}

/** Fotograma en el que empieza el cel visible en `frame`, o -1. */
export function celStartFrame(layer: Layer, frame: number): number {
  if (!layer.animated) return layer.cels.size > 0 ? 0 : -1;
  let bestFrame = -1;
  for (const f of layer.cels.keys()) {
    if (f <= frame && f > bestFrame) bestFrame = f;
  }
  return bestFrame;
}

/** Cuántos fotogramas se mantiene en pantalla el cel que empieza en `start`. */
export function celHoldLength(layer: Layer, start: number, frameCount: number): number {
  if (!layer.animated) return frameCount;
  let next = frameCount;
  for (const f of layer.cels.keys()) {
    if (f > start && f < next) next = f;
  }
  return next - start;
}

export function sortedCelFrames(layer: Layer): number[] {
  return [...layer.cels.keys()].sort((a, b) => a - b);
}

export function layerIndexById(doc: TraceDocument, id: string): number {
  return doc.layers.findIndex((l) => l.id === id);
}

/**
 * Agrupa la pila en grupos de recorte: una capa base y las capas encima que
 * llevan `clipToBelow`. Es la unidad de composición del renderizador.
 */
export interface ClipGroup {
  base: Layer;
  clipped: Layer[];
}

export function buildClipGroups(layers: Layer[]): ClipGroup[] {
  const groups: ClipGroup[] = [];
  for (const layer of layers) {
    if (!layer.clipToBelow || groups.length === 0) {
      groups.push({ base: layer, clipped: [] });
    } else {
      groups[groups.length - 1].clipped.push(layer);
    }
  }
  return groups;
}

export function frameToTimecode(frame: number, fps: number): string {
  const totalSeconds = frame / fps;
  const s = Math.floor(totalSeconds);
  const f = Math.round((totalSeconds - s) * fps);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}+${String(f).padStart(2, '0')}`;
}

export function clampFrame(doc: TraceDocument, frame: number): number {
  return clamp(Math.round(frame), 0, Math.max(0, doc.frameCount - 1));
}
