import type { Surface } from '../gl/renderer';
import type { CustomTexture } from './brushTexture';
import { clamp, lerp } from './math';
import type { LayerRig, Mesh, Skeleton } from './rig';
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

/** Una variante dentro de un catálogo de intercambio de sprites (ojo abierto/cerrado, visema...). */
export interface SpriteSwapVariant {
  id: string;
  label: string;
  /** Mismo tamaño que el documento, igual que `Cel.surface`. */
  surface: Surface;
}

/**
 * Catálogo de variantes de un nodo de intercambio de sprites (ojos, cejas,
 * boca). `selected` reutiliza `Channel` como índice discreto: `sampleChannel`
 * con easing `'hold'` ya produce un escalón exacto entre keyframes en vez de
 * interpolar, que es la semántica correcta para "qué variante se ve" — la
 * disciplina de forzar `'hold'` la impone el setter en `engine.ts`, no el tipo.
 */
export interface SpriteSwapCatalog {
  variants: SpriteSwapVariant[];
  selected: Channel;
}

/** Variante visible en `frame` — análogo a `celAt` pero para sprite-swap. */
export function pickVariant(layer: Layer, frame: number): SpriteSwapVariant | null {
  if (!layer.swap || layer.swap.variants.length === 0) return null;
  const idx = Math.round(sampleChannel(layer.swap.selected, frame));
  return layer.swap.variants[idx] ?? layer.swap.variants[0];
}

/**
 * `draw`: capa normal, se dibuja y se exporta. `reference`: imagen o vídeo
 * importado para calcar (rotoscopia) — no admite trazo, bote ni selección, y
 * queda fuera de PNG/APNG/secuencia porque no es parte de la obra final.
 * `adjustment`: no tiene dibujo propio — aplica `Layer.adjustment` a todo lo
 * compuesto por debajo, como una capa de ajuste de Photoshop/Procreate.
 */
export type LayerKind = 'draw' | 'reference' | 'adjustment';

/** Tono/saturación/brillo/contraste — ver `Layer.adjustment`. */
export interface AdjustmentProps {
  /** Radianes. */
  hue: number;
  /** -1..1, 0 = sin cambio. */
  saturation: number;
  /** -1..1, 0 = sin cambio. */
  brightness: number;
  /** -1..1, 0 = sin cambio. */
  contrast: number;
}

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
  /** Pintar en esta capa sólo afecta a píxeles que ya tenían alfa > 0 — no
   *  se puede ensanchar el contorno existente, sólo recolorear/sombrear
   *  dentro de él. */
  alphaLock: boolean;
  /**
   * `false`: un único cel (en el fotograma 0) visible en toda la animación —
   * fondos, capas de color. `true`: dibujo cuadro por cuadro.
   */
  animated: boolean;
  /** Clave = fotograma en que aparece el cel. */
  cels: Map<number, Cel>;
  transform: TransformTrack;
  /** Presente si un esqueleto de `TraceDocument.skeletons` controla esta capa. */
  rig?: LayerRig;
  /**
   * Presente si esta capa es un nodo de intercambio de sprites: sustituye a
   * `cels` como fuente del fotograma (ver `pickVariant`). `cels` queda vacío
   * por construcción en una capa con `swap`.
   */
  swap?: SpriteSwapCatalog;
  /** Presente si esta capa vive dentro de una carpeta de `TraceDocument.layerGroups`. */
  groupId?: string;
  /** Máscara de recorte no destructiva — ver `LayerMask`. */
  mask?: LayerMask;
  /**
   * Presente si esta capa es una capa de texto: su cel único (no animada)
   * se regenera desde estas propiedades cada vez que cambian, en vez de
   * pintarse a mano. La posición no vive aquí — se mueve como cualquier
   * otra capa con su `TransformTrack` normal.
   */
  text?: TextLayerProps;
  /** Presente si `kind === 'adjustment'`: el ajuste que aplica a todo lo
   *  compuesto por debajo. No usa `cels` — no hay dibujo propio. */
  adjustment?: AdjustmentProps;
  /**
   * Sólo tiene efecto en una capa `kind === 'reference'`: por defecto una
   * capa de referencia es material para calcar y queda fuera de toda
   * exportación (PNG/APNG/secuencia/vídeo), igual que antes de este campo.
   * Con esto en `true` se compone igual que cualquier otra capa a la hora
   * de exportar — para el caso de "vídeo real con dibujo animado encima"
   * (imagen o vídeo de referencia de fondo, opcional). Sigue sin admitir
   * trazo, bote ni selección: esa restricción es sobre EDITAR la capa, no
   * sobre exportarla, y sigue teniendo sentido — es material para calcar,
   * no para pintar encima.
   */
  includeInExport?: boolean;
}

export interface TextLayerProps {
  text: string;
  fontFamily: string;
  fontSize: number;
  color: RGB;
  align: 'left' | 'center' | 'right';
  bold: boolean;
  italic: boolean;
}

/**
 * Máscara de capa: una superficie gris del tamaño del documento cuya alfa
 * modula la de la capa entera al componer — blanco (alfa 1) revela, negro
 * (alfa 0) oculta, sin borrar el dibujo real. Un solo cel, no animado por
 * fotograma: igual que `clipToBelow`, una decisión de v1 para no ampliar el
 * modelo de datos hasta que haga falta de verdad.
 */
export interface LayerMask {
  surface: Surface;
}

/**
 * Carpeta organizativa del panel de capas: agrupa un tramo CONTIGUO de
 * `TraceDocument.layers` bajo un mismo `groupId` — la misma idea que
 * `ClipGroup` (agrupar por adyacencia en la lista plana), no un árbol
 * nuevo. No afecta a la composición del lienzo en absoluto: mostrar/ocultar
 * la carpeta entera es sólo aplicar `visible` a cada capa miembro, y
 * `collapsed` sólo cambia cómo se ve el panel — el pipeline de render nunca
 * necesita saber que existen las carpetas.
 */
export interface LayerGroup {
  id: string;
  name: string;
  collapsed: boolean;
}

/** Pico (mínimo/máximo, -1..1) de un tramo de la onda — lo que hace falta
 *  para dibujar la forma de onda sin volver a decodificar el audio. */
export interface AudioPeak {
  min: number;
  max: number;
}

/**
 * Pista de audio única del documento — para sincronizar labios contra el
 * catálogo de intercambio de sprites (`SpriteSwapCatalog`) sin tener que
 * llevar la cuenta de memoria. Los bytes del archivo original viven fuera
 * de `TraceDocument` (en `Engine.audioBytes`, como `Cel.surface` vive en
 * GPU): esta interfaz sólo lleva datos serializables, no el elemento
 * `<audio>` que de verdad reproduce — ver `Engine.audioElement`.
 */
export interface AudioTrack {
  id: string;
  name: string;
  /** Segundos. */
  duration: number;
  mimeType: string;
  peaks: AudioPeak[];
  /** Segundos desde el cuadro 0 del documento hasta el inicio del audio. */
  offset: number;
  muted: boolean;
}

/** Techo práctico de `frameCount`, no del motor (los cels viven en un `Map`
 * disperso, así que un cuadro vacío no cuesta memoria): la línea de tiempo
 * no está virtualizada, pinta una celda de DOM por cuadro y por capa —
 * medido en navegador, más allá de esto ya se nota al abrir el panel. Un
 * vídeo importado se trocea al mismo techo por la misma razón: sus cels
 * también acaban ahí. */
export const MAX_FRAME_COUNT = 6000;

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
  /**
   * Esqueletos del documento. Viven aquí y no dentro de una `Layer` porque
   * un rig suele gobernar varias capas a la vez (torso, brazo, antebrazo).
   */
  skeletons: Skeleton[];
  /** Mallas deformables, referenciadas por id desde `Layer.rig.meshId`. */
  meshes: Mesh[];
  /** Carpetas del panel de capas — ver `LayerGroup`. */
  layerGroups: LayerGroup[];
  /** Presente si el proyecto tiene una pista de audio importada. */
  audio?: AudioTrack;
  /**
   * Texturas de punta importadas por quien dibuja — a diferencia de las 4
   * integradas (`BUILTIN_TEXTURES`), viajan con el proyecto en vez de con la
   * app: así lo que se importa aquí nunca se distribuye con Trace.
   */
  customTextures: CustomTexture[];
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
    alphaLock: false,
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
    skeletons: [],
    meshes: [],
    layerGroups: [],
    customTextures: [],
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
