import { Renderer, type Surface } from '../gl/renderer';
import { StrokeBuilder, TAPER_LENGTH_FACTOR, taperScale, type BrushPreset } from './brush';
import {
  BRUSH_TEXTURE_SIZE,
  generateBrushTexturePixels,
  isBuiltinTextureId,
  type CustomTexture,
} from './brushTexture';
import {
  buildClipGroups,
  celAt,
  celStartFrame,
  channel,
  clampFrame,
  hasAnyKeyframes,
  newDocument,
  newLayer,
  pickVariant,
  sampleChannel,
  setKeyframe,
  sortedCelFrames,
  transformIsIdentity,
  uid,
  type AudioPeak,
  type Cel,
  type Layer,
  type LayerGroup,
  type LayerMask,
  type AdjustmentProps,
  type SpriteSwapCatalog,
  type SpriteSwapVariant,
  type TextLayerProps,
  type TraceDocument,
} from './document';
import { extractRect, floodMatch } from './flood';
import { History } from './history';
import { rehydrateHistoryOp, type HistoryOp } from './historyOps';
import type { FloodFillResponse } from '../workers/floodFill.worker';
import {
  bendSignFor,
  boneRestFromDrag,
  boneRigidMatrix,
  createBone,
  evaluatePoseWorldMatrices,
  evaluateRestWorldMatrices,
  evaluateSkinMatrices,
  findBone,
  hitTestBone as hitTestBoneInSkeleton,
  hitTestBoneTail as hitTestBoneTailInSkeleton,
  isBoneDescendantOf,
  matRotation,
  newMesh,
  newSkeleton,
  removeBone as removeBoneFromSkeleton,
  reparentBoneRest,
  solveTwoBoneIK,
  topoSortBones,
  worldPointToBoneOffset,
  worldPointToBoneRotation,
  type Bone,
  type BoneTrack,
  type LayerRig,
  type Mesh,
  type Skeleton,
} from './rig';
import {
  rasterizeMask,
  rasterizeSelection,
  rectCorners,
  shapeBounds,
  unionRect,
  type SelectionMode,
  type SelectionShape,
} from './selection';
import {
  clamp,
  lerp,
  mat3Apply,
  mat3FromTRS,
  mat3Identity,
  mat3Invert,
  mat3Multiply,
  snapAngle,
  type Mat3,
} from './math';
import {
  BLEND_INDEX,
  clampRect,
  emptyRect,
  expandRect,
  rectIsEmpty,
  type InputSample,
  type RGB,
  type Rect,
  type Stamp,
  type Vec2,
} from './types';
import {
  forceProportion,
  recognizeShape,
  sampleShapeOutline,
  shapeNodes,
  updateShapeNode,
  type RecognizedShape,
} from './quickshape';

export interface ViewState {
  /** Posición en pantalla del centro del documento, en píxeles CSS. */
  tx: number;
  ty: number;
  zoom: number;
  rotation: number;
  flipX: boolean;
}

export interface OnionSettings {
  enabled: boolean;
  before: number;
  after: number;
  opacity: number;
  /** Tinta rojo lo anterior y verde lo posterior. */
  colored: boolean;
}

export interface StrokeContext {
  brush: BrushPreset;
  color: RGB;
}

/**
 * Forma reconocida por QuickShape, sostenida en memoria como geometría
 * pura hasta que se confirma. `editing` distingue las dos fases del gesto
 * de Procreate: `false` mientras el puntero que la reconoció sigue
 * apoyado (se puede seguir arrastrando o forzar proporción con un segundo
 * dedo), `true` tras soltarlo, cuando ya sólo el overlay de nodos la toca.
 */
export interface PendingQuickShape {
  shape: RecognizedShape;
  layer: Layer;
  cel: Cel;
  ctx: StrokeContext;
  /** Igual semántica que `createdCelFrame` del trazo normal. */
  createdCelFrame: number;
  /** Igual semántica que `strokeStartFrame` del trazo normal. */
  startFrame: number;
  editing: boolean;
  /** Nodo más cercano al punto donde se disparó el dwell — el que sigue el
   * arrastre mientras el puntero original no se ha soltado todavía. */
  holdNodeIndex: number;
}

export interface SelectionState {
  active: boolean;
  /** Límites reales de la máscara, no del gesto que la creó. */
  bounds: Rect;
}

/**
 * Lazo estilo Procreate: sobrevive entre subidas y bajadas del dedo, así que
 * no puede vivir en un ref de React (muere en el primer pointerup). Cada
 * arrastre añade puntos en mano alzada; cada toque suelto (sin arrastre)
 * añade un único vértice recto — así se combinan tramos curvos y poligonales
 * en el mismo lazo, igual que en Procreate. Se cierra tocando el nodo de
 * origen o aceptando desde la barra flotante.
 */
export interface PendingLasso {
  points: Vec2[];
  mode: SelectionMode;
}

export type PerspectiveMode = '1pt' | '2pt' | '3pt';

/** Ver `Engine.perspectiveGuide`. */
export interface PerspectiveGuide {
  enabled: boolean;
  mode: PerspectiveMode;
  vp1: Vec2;
  vp2: Vec2;
  vp3: Vec2;
}

/**
 * Selección "varita mágica" en marcha: la referencia compuesta se lee UNA
 * vez al empezar (coste fijo caro, por GPU) y se cachea aquí — arrastrar
 * para ajustar la tolerancia sólo repite el flood-fill en CPU sobre esta
 * misma referencia, sin volver a leer la GPU en cada muestra de arrastre.
 */
export interface PendingWand {
  reference: Uint8Array;
  w: number;
  h: number;
  sx: number;
  sy: number;
  tolerance: number;
  mode: SelectionMode;
  /** Límites de la última vista previa — para acotar el escaneo de
   *  `commitSelectionCanvas` al soltar, en vez de recorrer todo el
   *  documento otra vez. */
  lastRect: Rect;
}

/** Píxeles levantados de UN cel dentro de una transformación flotante. */
export interface FloatingCel {
  /** Fotograma donde empieza este cel de origen. */
  celFrame: number;
  surface: Surface;
  /** Píxeles originales de `sourceRect` en este cel, para cancelar o deshacer. */
  before: Uint8Array;
}

/**
 * Píxeles levantados de uno o varios cels que se están moviendo, escalando o
 * girando a la vez. Mientras existe, cada cel de `cels` tiene un hueco donde
 * estaban los suyos.
 *
 * El mismo rectángulo de origen y la misma transformación (tx/ty/scale/
 * rotation/pivot) se aplican a todos los cels del lote: es un único gesto
 * — mover un brazo en 8 cuadros a la vez — no ocho gestos independientes.
 * Lo que varía por cel son sólo los píxeles: `liftSelection` produce un
 * `cels` de un solo elemento; `liftSelectionRange` uno por cada cel
 * distinto dentro del rango.
 */
export interface FloatingSelection {
  cels: FloatingCel[];
  layerId: string;
  tx: number;
  ty: number;
  scale: number;
  rotation: number;
  pivotX: number;
  pivotY: number;
  sourceRect: Rect;
}

const MAX_ONION = 3;

export class Engine {
  renderer: Renderer;
  doc: TraceDocument;
  history = new History();

  currentFrame = 0;
  activeLayerId: string | null = null;

  view: ViewState = { tx: 0, ty: 0, zoom: 1, rotation: 0, flipX: false };
  onion: OnionSettings = {
    enabled: true,
    before: 1,
    after: 1,
    opacity: 0.35,
    colored: true,
  };
  /** Espejo en vivo: cada estampa del trazo se refleja también al otro lado
   *  del eje (o de los dos) mientras se dibuja — no es un filtro que se
   *  aplique después, es tinta real puesta en los dos sitios a la vez.
   *  `radial` (0 = apagada, si no el número de repeticiones alrededor del
   *  centro del documento) es mutuamente excluyente con vertical/horizontal
   *  — activar una apaga la otra, la UI lo hace cumplir; ver `mirrorStamps`. */
  symmetry: { vertical: boolean; horizontal: boolean; radial: number } = {
    vertical: false,
    horizontal: false,
    radial: 0,
  };
  /**
   * Guía(s) de perspectiva — asistente visual y de encaje de trazo, no se
   * guarda con el documento (como `symmetry`): es preferencia de sesión de
   * dibujo, no parte de la obra. `vp2`/`vp3` sólo se usan en 2/3 puntos.
   * Los puntos se recentran cuando cambia el tamaño del documento — ver
   * `centerPerspectiveGuide`.
   */
  perspectiveGuide: PerspectiveGuide = {
    enabled: false,
    mode: '1pt',
    vp1: { x: 960, y: 540 },
    vp2: { x: 100, y: 540 },
    vp3: { x: 960, y: 100 },
  };

  playing = false;
  loop = true;

  /** Elemento reproductor de la pista de audio (ver `AudioTrack` en
   *  document.ts) — vive fuera del documento serializable, como la
   *  superficie GPU de un `Cel`. Null si no hay audio importado. */
  audioElement: HTMLAudioElement | null = null;
  /** Bytes originales del archivo, cacheados para no tener que volver a
   *  pedirle el archivo al usuario al guardar el proyecto. */
  audioBytes: Uint8Array | null = null;
  private audioObjectUrl: string | null = null;

  selection: SelectionState = { active: false, bounds: emptyRect() };
  floating: FloatingSelection | null = null;
  pendingQuickShape: PendingQuickShape | null = null;
  pendingLasso: PendingLasso | null = null;
  pendingWand: PendingWand | null = null;
  private selectionCanvas: HTMLCanvasElement | null = null;
  private selectionBackup: HTMLCanvasElement | null = null;
  /** Límites de `selectionBackup` en el momento de guardarlo — lo que hacía
   *  falta para poder acotar `commitSelectionCanvas` a la zona realmente
   *  tocada en vez de escanear el documento entero cada vez. */
  private selectionBackupBounds: Rect = emptyRect();
  /** Arrastre de IK de 2 huesos en marcha — `bendSign` se fija al empezar y
   *  se mantiene todo el gesto, ver `bendSignFor` en `rig.ts`. */
  private ikDrag: {
    skeletonId: string;
    rootId: string;
    midId: string;
    root: Vec2;
    len1: number;
    len2: number;
    bendSign: 1 | -1;
  } | null = null;

  /** Se incrementa en cualquier cambio estructural; la UI se suscribe. */
  revision = 0;
  private listeners = new Set<() => void>();
  /** Se llama al final de cada `render()` de verdad — no en cada `touch()`,
   *  que sólo PIDE uno. Lo usa `LoupeOverlay` para copiar del lienzo justo
   *  después de que el frame real quedó presentado: leerlo en cualquier
   *  otro momento (p. ej. un `requestAnimationFrame` propio) podría pillar
   *  el búfer ya limpiado por el navegador, con `preserveDrawingBuffer:
   *  false` — ver la nota de `page.screenshot()` en CLAUDE.md. */
  private afterRenderListeners = new Set<() => void>();

  private renderQueued = false;
  private belowCacheKey = '';
  private thumbCache = new Map<string, { canvas: HTMLCanvasElement; version: number }>();
  private lastViewportW = 0;
  private lastViewportH = 0;
  private viewInitialised = false;
  private playClock = 0;
  private rafId = 0;

  // --- estado del trazo en curso ---
  private builder: StrokeBuilder | null = null;
  private strokeCel: Cel | null = null;
  private strokeLayer: Layer | null = null;
  private strokeCtx: StrokeContext | null = null;
  private strokeRect: Rect = emptyRect();
  /** Color que va arrastrando "Difuminar" (`brush.smudge`) de una estampa a
   *  la siguiente — `null` hasta la primera muestra del trazo. Se reinicia
   *  en cada `beginStroke`: el arrastre no debe "recordar" nada del trazo
   *  anterior. Ver `sampleSmudgeColor` y `drawToWet`. */
  private smudgeColor: RGB | null = null;
  private createdCelFrame = -1;
  /** Fotograma vigente al empezar el trazo — hace falta junto a
   *  `createdCelFrame` para resolver el cel sostenido correcto al persistir
   *  el paso de historial, ver `storedCelFrame`. */
  private strokeStartFrame = -1;
  private predictedStamps: Stamp[] = [];
  /** Recorrido crudo del trazo en curso, en espacio documento — lo único
   * que necesita el reconocedor de QuickShape; `StrokeBuilder` ya filtra y
   * suaviza el suyo, así que se lleva por separado sin tocarlo. */
  private strokeRawPoints: Vec2[] = [];
  /** Estampas del extremo del trazo en curso que todavía podrían volver a
   * escalarse: mientras la mano siga en movimiento, `rasterizeLayer` las
   * redibuja cada fotograma contra la punta viva (igual que `predictedStamps`
   * más abajo). Sólo se "queman" en `wet` cuando quedan a más de la longitud
   * de afinado del pincel actual — así la cola nunca crece con el trazo
   * entero, sólo con esa distancia fija. Vacío salvo pincel con `taper > 0`. */
  private tailStamps: { stamp: Stamp; dist: number }[] = [];
  private strokeLen = 0;
  private lastTailPos: Vec2 | null = null;

  constructor(canvas: HTMLCanvasElement, doc?: TraceDocument) {
    this.renderer = new Renderer(canvas);
    this.doc = doc ?? newDocument();
    this.renderer.setDocumentSize(this.doc.width, this.doc.height);
    if (this.doc.layers.length === 0) {
      const layer = newLayer('Capa 1');
      this.doc.layers.push(layer);
      this.activeLayerId = layer.id;
    } else {
      this.activeLayerId = this.doc.layers[this.doc.layers.length - 1].id;
    }
    this.centerPerspectiveGuide();
    this.resetView();
    this.startLoop();
  }

  /* ---------------------------------------------------------------- *
   * Suscripción
   * ---------------------------------------------------------------- */

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Se dispara al final de cada `render()` real — ver `afterRenderListeners`. */
  onAfterRender(fn: () => void): () => void {
    this.afterRenderListeners.add(fn);
    return () => this.afterRenderListeners.delete(fn);
  }

  /** Notifica a la UI y descarta la caché de composición. */
  touch(structural = true) {
    if (structural) this.belowCacheKey = '';
    this.doc.modifiedAt = Date.now();
    this.revision++;
    for (const fn of this.listeners) fn();
    this.requestRender();
  }

  /* ---------------------------------------------------------------- *
   * Vista
   * ---------------------------------------------------------------- */

  get cssWidth() {
    return this.renderer.canvas.clientWidth || 1;
  }

  get cssHeight() {
    return this.renderer.canvas.clientHeight || 1;
  }

  resetView() {
    const margin = 0.9;
    const zoom = Math.min(
      (this.cssWidth * margin) / this.doc.width,
      (this.cssHeight * margin) / this.doc.height,
    );
    this.view = {
      tx: this.cssWidth / 2,
      ty: this.cssHeight / 2,
      zoom: zoom > 0 ? zoom : 1,
      rotation: 0,
      flipX: false,
    };
    this.lastViewportW = this.cssWidth;
    this.lastViewportH = this.cssHeight;
    this.requestRender();
  }

  /**
   * Reacciona a un cambio de tamaño del lienzo. El primer tamaño real llega
   * después del montaje, cuando la rejilla ya repartió el espacio: si no se
   * recalculara aquí, el documento quedaría centrado respecto a una ventana
   * que ya no existe. Después de esa primera vez sólo se desplaza la vista,
   * para no tirar el encuadre del usuario al girar el dispositivo.
   */
  syncViewport() {
    const w = this.cssWidth;
    const h = this.cssHeight;
    if (w <= 1 || h <= 1) return;
    if (w === this.lastViewportW && h === this.lastViewportH) return;

    if (!this.viewInitialised) {
      this.viewInitialised = true;
      this.resetView();
      return;
    }
    this.view.tx += (w - this.lastViewportW) / 2;
    this.view.ty += (h - this.lastViewportH) / 2;
    this.lastViewportW = w;
    this.lastViewportH = h;
    this.requestRender();
  }

  /** Unidad (0..1) del documento -> píxeles del framebuffer de pantalla. */
  viewMatrix(): Mat3 {
    const dpr = this.renderer.canvas.width / this.cssWidth;
    const { tx, ty, zoom, rotation, flipX } = this.view;
    const c = Math.cos(rotation);
    const s = Math.sin(rotation);
    const sx = zoom * (flipX ? -1 : 1) * dpr;
    const sy = zoom * dpr;

    // scale(docW,docH) -> centrar -> escalar -> rotar -> trasladar
    const toDoc: Mat3 = new Float32Array([
      this.doc.width,
      0,
      0,
      0,
      this.doc.height,
      0,
      -this.doc.width / 2,
      -this.doc.height / 2,
      1,
    ]);
    const scaleRotate: Mat3 = new Float32Array([
      c * sx,
      s * sx,
      0,
      -s * sy,
      c * sy,
      0,
      tx * dpr,
      ty * dpr,
      1,
    ]);
    return mat3Multiply(scaleRotate, toDoc);
  }

  /** Píxeles CSS del canvas -> píxeles de documento. */
  screenToDoc(p: Vec2): Vec2 {
    const { tx, ty, zoom, rotation, flipX } = this.view;
    const dx = p.x - tx;
    const dy = p.y - ty;
    const c = Math.cos(-rotation);
    const s = Math.sin(-rotation);
    let rx = dx * c - dy * s;
    let ry = dx * s + dy * c;
    rx /= zoom * (flipX ? -1 : 1);
    ry /= zoom;
    return { x: rx + this.doc.width / 2, y: ry + this.doc.height / 2 };
  }

  docToScreen(p: Vec2): Vec2 {
    const { tx, ty, zoom, rotation, flipX } = this.view;
    const dx = (p.x - this.doc.width / 2) * zoom * (flipX ? -1 : 1);
    const dy = (p.y - this.doc.height / 2) * zoom;
    const c = Math.cos(rotation);
    const s = Math.sin(rotation);
    return { x: dx * c - dy * s + tx, y: dx * s + dy * c + ty };
  }

  zoomAt(screenPoint: Vec2, factor: number) {
    const before = this.screenToDoc(screenPoint);
    this.view.zoom = clamp(this.view.zoom * factor, 0.02, 64);
    const after = this.docToScreen(before);
    this.view.tx += screenPoint.x - after.x;
    this.view.ty += screenPoint.y - after.y;
    this.requestRender();
  }

  /* ---------------------------------------------------------------- *
   * Capas y cels
   * ---------------------------------------------------------------- */

  get activeLayer(): Layer | null {
    return this.doc.layers.find((l) => l.id === this.activeLayerId) ?? null;
  }

  get activeLayerIndex(): number {
    return this.doc.layers.findIndex((l) => l.id === this.activeLayerId);
  }

  setActiveLayer(id: string) {
    if (this.activeLayerId === id) return;
    this.activeLayerId = id;
    // Cambiar de capa activa sale del modo "editar máscara" si era el de
    // otra capa — pintar la máscara de una capa que ya no se está mirando
    // sería fácil de hacer sin darse cuenta.
    if (this.editingMaskLayerId !== null && this.editingMaskLayerId !== id) {
      this.editingMaskLayerId = null;
    }
    this.touch();
  }

  private makeCel(): Cel {
    return { id: uid('cel'), surface: this.renderer.createSurface('cel') };
  }

  /** Fotograma real en `layer.cels` de un cel resuelto por `ensureCel`/
   *  `celAt` — hace falta para que un paso de historial persistido (que
   *  direcciona por clave del `Map`, no por el objeto en sí) apunte al cel
   *  correcto incluso cuando se dibujó sobre un cuadro sostenido. */
  private storedCelFrame(layer: Layer, frame: number, created: number): number {
    return created >= 0 ? created : celStartFrame(layer, frame);
  }

  addLayer(above = true) {
    const layer = newLayer(`Capa ${this.doc.layers.length + 1}`);
    const index = above ? this.activeLayerIndex + 1 : this.activeLayerIndex;
    const at = index < 0 ? this.doc.layers.length : index;
    const prevActive = this.activeLayerId;
    this.history.run({
      label: 'Añadir capa',
      redo: () => {
        this.doc.layers.splice(at, 0, layer);
        this.activeLayerId = layer.id;
        this.touch();
      },
      undo: () => {
        const i = this.doc.layers.indexOf(layer);
        if (i >= 0) this.doc.layers.splice(i, 1);
        this.activeLayerId = prevActive;
        this.touch();
      },
    });
  }

  deleteLayer(id: string) {
    if (this.doc.layers.length <= 1) return;
    const index = this.doc.layers.findIndex((l) => l.id === id);
    if (index < 0) return;
    const layer = this.doc.layers[index];
    const prevActive = this.activeLayerId;
    this.history.run({
      label: 'Eliminar capa',
      redo: () => {
        this.doc.layers.splice(index, 1);
        if (this.activeLayerId === id) {
          const next = this.doc.layers[Math.min(index, this.doc.layers.length - 1)];
          this.activeLayerId = next?.id ?? null;
        }
        this.touch();
      },
      undo: () => {
        this.doc.layers.splice(index, 0, layer);
        this.activeLayerId = prevActive;
        this.touch();
      },
    });
  }

  duplicateLayer(id: string) {
    const index = this.doc.layers.findIndex((l) => l.id === id);
    if (index < 0) return;
    const src = this.doc.layers[index];
    const copy = newLayer(`${src.name} copia`, src.animated, src.kind);
    copy.visible = src.visible;
    copy.opacity = src.opacity;
    copy.blend = src.blend;
    copy.clipToBelow = src.clipToBelow;
    copy.alphaLock = src.alphaLock;
    copy.transform = structuredCloneTransform(src.transform);

    for (const [frame, cel] of src.cels) {
      const nc = this.makeCel();
      this.renderer.copy(nc.surface, this.renderer.ensureResident(cel.surface), 1);
      copy.cels.set(frame, nc);
    }
    if (src.mask) {
      const surface = this.renderer.createSurface('mask');
      this.renderer.copy(surface, this.renderer.ensureResident(src.mask.surface), 1);
      copy.mask = { surface };
    }
    if (src.text) copy.text = { ...src.text };
    if (src.adjustment) copy.adjustment = { ...src.adjustment };

    this.history.run({
      label: 'Duplicar capa',
      redo: () => {
        this.doc.layers.splice(index + 1, 0, copy);
        this.activeLayerId = copy.id;
        this.touch();
      },
      undo: () => {
        const i = this.doc.layers.indexOf(copy);
        if (i >= 0) this.doc.layers.splice(i, 1);
        this.activeLayerId = src.id;
        this.touch();
      },
    });
  }

  moveLayer(id: string, delta: number) {
    const from = this.doc.layers.findIndex((l) => l.id === id);
    if (from < 0) return;
    const to = clamp(from + delta, 0, this.doc.layers.length - 1);
    if (to === from) return;
    const apply = (a: number, b: number) => {
      const [l] = this.doc.layers.splice(a, 1);
      this.doc.layers.splice(b, 0, l);
      this.touch();
    };
    this.history.run({
      label: 'Reordenar capa',
      redo: () => apply(from, to),
      undo: () => apply(to, from),
    });
  }

  /** Cambio de propiedad simple con un solo paso de deshacer. */
  setLayerProp<K extends keyof Layer>(id: string, key: K, value: Layer[K], label: string) {
    const layer = this.doc.layers.find((l) => l.id === id);
    if (!layer) return;
    const before = layer[key];
    if (before === value) return;
    this.history.run({
      label,
      redo: () => {
        layer[key] = value;
        this.touch();
      },
      undo: () => {
        layer[key] = before;
        this.touch();
      },
    });
  }

  /** Ajuste continuo (deslizadores): aplica ya, registra al soltar. */
  setLayerPropLive<K extends keyof Layer>(id: string, key: K, value: Layer[K]) {
    const layer = this.doc.layers.find((l) => l.id === id);
    if (!layer) return;
    layer[key] = value;
    this.touch();
  }

  /* ---------------------------------------------------------------- *
   * Máscara de capa
   * ---------------------------------------------------------------- */

  /** Capa cuya máscara se está pintando en vez de su dibujo — null si no
   *  hay ninguna en edición. Un trazo la usa como destino en vez del cel
   *  activo (ver `resolveStrokeCel`), y `rasterizeLayer` compone en vivo el
   *  resultado de aplicarla mientras se pinta. */
  editingMaskLayerId: string | null = null;
  /** El trazo en curso (o la forma QuickShape pendiente) pinta sobre la
   *  máscara de `strokeLayer`, no sobre su cel — se fija una vez al empezar
   *  el gesto y no cambia aunque `editingMaskLayerId` se toque a mitad,
   *  igual que `bendSign` en el arrastre de IK. */
  private strokeTargetsMask = false;

  setEditingMaskLayer(layerId: string | null) {
    if (layerId !== null) {
      const layer = this.doc.layers.find((l) => l.id === layerId);
      if (!layer?.mask) return;
    }
    this.editingMaskLayerId = layerId;
    this.touch();
  }

  /** Añade una máscara en blanco (blanco opaco = revela todo) a la capa —
   *  no se puede pintar nada hasta que exista. */
  addLayerMask(layerId: string) {
    const layer = this.doc.layers.find((l) => l.id === layerId);
    if (!layer || layer.mask) return;
    const surface = this.renderer.createSurface('mask');
    this.renderer.fill(surface, { r: 1, g: 1, b: 1 }, 1);
    const mask: LayerMask = { surface };
    this.history.run({
      label: 'Añadir máscara',
      redo: () => {
        layer.mask = mask;
        this.editingMaskLayerId = layerId;
        this.touch();
      },
      undo: () => {
        layer.mask = undefined;
        if (this.editingMaskLayerId === layerId) this.editingMaskLayerId = null;
        this.touch();
      },
    });
  }

  /** Quita la máscara de la capa — deshacer restaura su contenido tal cual
   *  estaba, no una en blanco nueva. */
  removeLayerMask(layerId: string) {
    const layer = this.doc.layers.find((l) => l.id === layerId);
    if (!layer?.mask) return;
    const mask = layer.mask;
    const wasEditing = this.editingMaskLayerId === layerId;
    this.history.run({
      label: 'Quitar máscara',
      redo: () => {
        layer.mask = undefined;
        if (this.editingMaskLayerId === layerId) this.editingMaskLayerId = null;
        this.touch();
      },
      undo: () => {
        layer.mask = mask;
        if (wasEditing) this.editingMaskLayerId = layerId;
        this.touch();
      },
    });
  }

  /**
   * Agrupa capas EXISTENTES bajo una carpeta nueva. Una carpeta es un tramo
   * CONTIGUO de `doc.layers` (como `ClipGroup`, no un árbol aparte), así
   * que agrupar reordena la pila: las capas elegidas se juntan donde
   * estaba la más profunda de ellas, conservando su orden relativo entre
   * sí — el resto de la pila no se mueve. Null si `layerIds` no llega a
   * dos capas, alguna no existe, o alguna ya está en otra carpeta (anidar
   * carpetas queda fuera de alcance por ahora).
   */
  groupLayers(layerIds: string[], name = 'Grupo'): string | null {
    const ids = new Set(layerIds);
    if (ids.size < 2) return null;
    const before = this.doc.layers.slice();
    const members = before.filter((l) => ids.has(l.id));
    if (members.length !== ids.size || members.some((l) => l.groupId)) return null;

    const insertAt = Math.min(...before.map((l, i) => (ids.has(l.id) ? i : Infinity)));
    const rest = before.filter((l) => !ids.has(l.id));
    const insertAtInRest = rest.filter((l) => before.indexOf(l) < insertAt).length;
    const after = [...rest.slice(0, insertAtInRest), ...members, ...rest.slice(insertAtInRest)];
    const group: LayerGroup = { id: uid('grp'), name, collapsed: false };

    this.history.run({
      label: 'Agrupar capas',
      redo: () => {
        for (const l of members) l.groupId = group.id;
        this.doc.layerGroups.push(group);
        this.doc.layers = after;
        this.touch();
      },
      undo: () => {
        for (const l of members) l.groupId = undefined;
        this.doc.layerGroups = this.doc.layerGroups.filter((g) => g.id !== group.id);
        this.doc.layers = before;
        this.touch();
      },
    });
    return group.id;
  }

  /** Disuelve la carpeta; las capas se quedan donde están (ya son contiguas). */
  ungroupLayers(groupId: string) {
    const group = this.doc.layerGroups.find((g) => g.id === groupId);
    if (!group) return;
    const members = this.doc.layers.filter((l) => l.groupId === groupId);
    this.history.run({
      label: 'Desagrupar capas',
      redo: () => {
        for (const l of members) l.groupId = undefined;
        this.doc.layerGroups = this.doc.layerGroups.filter((g) => g.id !== groupId);
        this.touch();
      },
      undo: () => {
        for (const l of members) l.groupId = groupId;
        this.doc.layerGroups.push(group);
        this.touch();
      },
    });
  }

  /** Muestra/oculta todas las capas de la carpeta a la vez, en un único
   *  paso de deshacer — no una toggleada por capa. */
  setLayerGroupVisible(groupId: string, visible: boolean) {
    const members = this.doc.layers.filter((l) => l.groupId === groupId);
    if (members.length === 0) return;
    const before = members.map((l) => l.visible);
    this.history.run({
      label: visible ? 'Mostrar grupo' : 'Ocultar grupo',
      redo: () => {
        for (const l of members) l.visible = visible;
        this.touch();
      },
      undo: () => {
        members.forEach((l, i) => {
          l.visible = before[i];
        });
        this.touch();
      },
    });
  }

  renameLayerGroup(groupId: string, name: string) {
    const group = this.doc.layerGroups.find((g) => g.id === groupId);
    if (!group || group.name === name) return;
    const before = group.name;
    this.history.run({
      label: 'Renombrar grupo',
      redo: () => {
        group.name = name;
        this.touch();
      },
      undo: () => {
        group.name = before;
        this.touch();
      },
    });
  }

  /** Colapsar/expandir es presentación pura del panel, no contenido del
   *  documento — no entra en el historial, igual que `onion.enabled`. */
  setLayerGroupCollapsed(groupId: string, collapsed: boolean) {
    const group = this.doc.layerGroups.find((g) => g.id === groupId);
    if (!group) return;
    group.collapsed = collapsed;
    this.touch();
  }

  mergeDown(id: string) {
    const index = this.doc.layers.findIndex((l) => l.id === id);
    if (index <= 0) return;
    const top = this.doc.layers[index];
    const bottom = this.doc.layers[index - 1];

    // Fusionamos fotograma a fotograma sobre los cels que ya existen abajo,
    // más los fotogramas donde sólo la capa de arriba tiene dibujo.
    const frames = new Set<number>([...top.cels.keys(), ...bottom.cels.keys()]);
    const merged = newLayer(bottom.name, bottom.animated || top.animated);
    merged.opacity = 1;
    merged.blend = 'normal';
    merged.visible = bottom.visible;

    for (const f of [...frames].sort((a, b) => a - b)) {
      const cel = this.makeCel();
      const b = celAt(bottom, f);
      const t = celAt(top, f);
      this.renderer.clear(cel.surface);
      if (b) this.renderer.drawOver(cel.surface, b.surface, bottom.opacity);
      if (t) this.renderer.drawOver(cel.surface, t.surface, top.opacity);
      merged.cels.set(f, cel);
    }

    const snapshot = this.doc.layers.slice();
    this.history.run({
      label: 'Combinar hacia abajo',
      redo: () => {
        this.doc.layers.splice(index - 1, 2, merged);
        this.activeLayerId = merged.id;
        this.touch();
      },
      undo: () => {
        this.doc.layers = snapshot.slice();
        this.activeLayerId = top.id;
        this.touch();
      },
    });
  }

  /* --- capas de referencia --- */

  private fitCanvas: HTMLCanvasElement | null = null;

  /**
   * Dibuja una imagen o un fotograma de vídeo centrado y a escala de
   * contención dentro del lienzo del documento, y lo sube a `surface`.
   *
   * El origen casi nunca coincide con las proporciones del documento (una
   * foto vertical sobre un lienzo panorámico, por ejemplo), así que se ajusta
   * en vez de estirar o recortar.
   */
  private uploadFitted(surface: Surface, source: CanvasImageSource, sw: number, sh: number) {
    if (
      !this.fitCanvas ||
      this.fitCanvas.width !== this.doc.width ||
      this.fitCanvas.height !== this.doc.height
    ) {
      this.fitCanvas = document.createElement('canvas');
      this.fitCanvas.width = this.doc.width;
      this.fitCanvas.height = this.doc.height;
    }
    const ctx = this.fitCanvas.getContext('2d')!;
    ctx.clearRect(0, 0, this.fitCanvas.width, this.fitCanvas.height);
    if (sw > 0 && sh > 0) {
      const scale = Math.min(this.doc.width / sw, this.doc.height / sh);
      const w = sw * scale;
      const h = sh * scale;
      ctx.drawImage(source, (this.doc.width - w) / 2, (this.doc.height - h) / 2, w, h);
    }
    this.renderer.uploadImage(surface, this.fitCanvas);
  }

  /**
   * Arranca una capa de referencia sin insertarla todavía en el documento.
   * `io.ts` la va llenando fotograma a fotograma mientras decodifica el
   * origen (imagen o vídeo); `finishReferenceImport` la cierra en un único
   * paso de deshacer.
   */
  beginReferenceImport(name: string, animated: boolean): Layer {
    const layer = newLayer(`Ref: ${name}`, animated, 'reference');
    // La referencia no debe competir visualmente con el dibujo por defecto.
    layer.opacity = 0.6;
    return layer;
  }

  /** Sube un fotograma decodificado a la capa de referencia en construcción. */
  addReferenceFrame(layer: Layer, frame: number, source: CanvasImageSource, sw: number, sh: number) {
    const cel = this.makeCel();
    this.uploadFitted(cel.surface, source, sw, sh);
    layer.cels.set(frame, cel);
  }

  /** Inserta la capa de referencia ya completa, creciendo la duración si hace falta. */
  finishReferenceImport(layer: Layer, label: string) {
    if (layer.cels.size === 0) return;
    const maxFrame = Math.max(...layer.cels.keys());
    const index = this.activeLayerIndex + 1;
    const at = index < 0 ? this.doc.layers.length : index;
    const prevActive = this.activeLayerId;
    const prevFrameCount = this.doc.frameCount;
    const needsGrow = maxFrame + 1 > prevFrameCount;
    this.history.run({
      label,
      redo: () => {
        if (needsGrow) this.doc.frameCount = maxFrame + 1;
        this.doc.layers.splice(at, 0, layer);
        this.activeLayerId = layer.id;
        this.touch();
      },
      undo: () => {
        const i = this.doc.layers.indexOf(layer);
        if (i >= 0) this.doc.layers.splice(i, 1);
        if (needsGrow) this.doc.frameCount = prevFrameCount;
        this.activeLayerId = prevActive;
        this.touch();
      },
    });
  }

  /** Libera los cels de una importación de referencia cancelada a medias. */
  discardReferenceImport(layer: Layer) {
    for (const cel of layer.cels.values()) this.renderer.release(cel.surface);
    layer.cels.clear();
  }

  /* --- capas de texto --- */

  private textCanvas: HTMLCanvasElement | null = null;

  /**
   * Hornea `layer.text` en su único cel (no animada) con Canvas 2D — igual
   * que `uploadFitted` para imágenes de referencia: el resto del pipeline
   * (composición, rig, máscara, transform) no distingue una capa de texto
   * de cualquier otra, porque lo único que cambia es de dónde salen los
   * píxeles del cel. La posición no se toca aquí: el texto siempre se
   * hornea centrado en el documento, y moverlo es cosa del `TransformTrack`
   * normal de la capa, como con cualquier otra.
   */
  private renderTextIntoLayer(layer: Layer) {
    if (!layer.text) return;
    const { cel } = this.ensureCel(layer, 0);
    if (
      !this.textCanvas ||
      this.textCanvas.width !== this.doc.width ||
      this.textCanvas.height !== this.doc.height
    ) {
      this.textCanvas = document.createElement('canvas');
      this.textCanvas.width = this.doc.width;
      this.textCanvas.height = this.doc.height;
    }
    const ctx = this.textCanvas.getContext('2d')!;
    ctx.clearRect(0, 0, this.doc.width, this.doc.height);
    const t = layer.text;
    const style = t.italic ? 'italic ' : '';
    const weight = t.bold ? 'bold ' : '';
    ctx.font = `${style}${weight}${t.fontSize}px ${t.fontFamily}`;
    ctx.fillStyle = `rgb(${Math.round(t.color.r * 255)}, ${Math.round(t.color.g * 255)}, ${Math.round(t.color.b * 255)})`;
    ctx.textAlign = t.align;
    ctx.textBaseline = 'middle';
    const anchorX =
      t.align === 'left' ? this.doc.width * 0.08 : t.align === 'right' ? this.doc.width * 0.92 : this.doc.width / 2;
    const lines = t.text.length > 0 ? t.text.split('\n') : [''];
    const lineHeight = t.fontSize * 1.2;
    const startY = this.doc.height / 2 - ((lines.length - 1) * lineHeight) / 2;
    for (let i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i], anchorX, startY + i * lineHeight);
    }
    this.renderer.clear(cel.surface);
    this.renderer.uploadImage(cel.surface, this.textCanvas);
  }

  /** Crea una capa de texto nueva encima de la activa, con valores por
   *  defecto razonables — el tamaño escala con el documento para que no
   *  salga microscópico en un lienzo grande ni gigante en uno pequeño. */
  createTextLayer(text = 'Texto') {
    const layer = newLayer('Texto', false, 'draw');
    layer.text = {
      text,
      fontFamily: 'sans-serif',
      fontSize: Math.round(this.doc.height * 0.08),
      color: { r: 0, g: 0, b: 0 },
      align: 'center',
      bold: false,
      italic: false,
    };
    this.renderTextIntoLayer(layer);

    const index = this.activeLayerIndex + 1;
    const at = index < 0 ? this.doc.layers.length : index;
    const prevActive = this.activeLayerId;
    this.history.run({
      label: 'Añadir texto',
      redo: () => {
        this.doc.layers.splice(at, 0, layer);
        this.activeLayerId = layer.id;
        this.touch();
      },
      undo: () => {
        const i = this.doc.layers.indexOf(layer);
        if (i >= 0) this.doc.layers.splice(i, 1);
        this.activeLayerId = prevActive;
        this.touch();
      },
    });
  }

  /** Cambia el contenido/estilo de una capa de texto y la vuelve a hornear
   *  — sin paso de deshacer propio, igual que `setLayerPropLive` para
   *  cualquier otro ajuste continuo (nombre, opacidad): cada pulsación de
   *  tecla no merece su propio "deshacer". */
  setTextLayerProps(layerId: string, patch: Partial<TextLayerProps>) {
    const layer = this.doc.layers.find((l) => l.id === layerId);
    if (!layer?.text) return;
    layer.text = { ...layer.text, ...patch };
    this.renderTextIntoLayer(layer);
    this.touch();
  }

  /* --- capas de ajuste --- */

  /** Crea una capa de ajuste (tono/saturación/brillo/contraste) sin efecto
   *  encima de la activa — no tiene dibujo propio, `compositeGroups` la
   *  reconoce por `kind` y aplica el ajuste al acumulador en vez de
   *  componer un cel. */
  createAdjustmentLayer() {
    const layer = newLayer('Ajuste', false, 'adjustment');
    layer.adjustment = { hue: 0, saturation: 0, brightness: 0, contrast: 0 };

    const index = this.activeLayerIndex + 1;
    const at = index < 0 ? this.doc.layers.length : index;
    const prevActive = this.activeLayerId;
    this.history.run({
      label: 'Añadir capa de ajuste',
      redo: () => {
        this.doc.layers.splice(at, 0, layer);
        this.activeLayerId = layer.id;
        this.touch();
      },
      undo: () => {
        const i = this.doc.layers.indexOf(layer);
        if (i >= 0) this.doc.layers.splice(i, 1);
        this.activeLayerId = prevActive;
        this.touch();
      },
    });
  }

  /** Ajuste continuo de los deslizadores — sin paso de deshacer propio,
   *  igual que `setTextLayerProps`/`setLayerPropLive`. */
  setLayerAdjustment(layerId: string, patch: Partial<AdjustmentProps>) {
    const layer = this.doc.layers.find((l) => l.id === layerId);
    if (!layer?.adjustment) return;
    layer.adjustment = { ...layer.adjustment, ...patch };
    this.touch();
  }

  /* ---------------------------------------------------------------- *
   * Time-lapse del proceso de dibujo
   * ---------------------------------------------------------------- */

  timelapseRecording = false;
  private timelapseFrames: HTMLCanvasElement[] = [];
  private timelapseCaptureIntervalMs = 1000;
  private lastTimelapseCaptureAt = 0;
  private timelapseLastRevision = -1;
  private unsubscribeTimelapse: (() => void) | null = null;

  private static readonly TIMELAPSE_MAX_FRAMES = 600;
  private static readonly TIMELAPSE_CAPTURE_WIDTH = 480;

  get timelapseFrameCount(): number {
    return this.timelapseFrames.length;
  }

  /** Empieza a capturar fotogramas periódicos mientras se dibuja — la
   *  captura de verdad ocurre en `captureTimelapseFrame`, enganchada a
   *  `onAfterRender` en vez de a un `setInterval` propio: así sólo se
   *  intenta cuando el lienzo cambió de verdad, no a ciegas cada segundo. */
  startTimelapseRecording() {
    if (this.timelapseRecording) return;
    this.timelapseRecording = true;
    this.timelapseFrames = [];
    this.timelapseCaptureIntervalMs = 1000;
    this.lastTimelapseCaptureAt = 0;
    this.timelapseLastRevision = -1;
    this.unsubscribeTimelapse = this.onAfterRender(() => this.captureTimelapseFrame());
    this.touch();
  }

  /** Deja de capturar, conservando lo grabado hasta ahora para exportar. */
  stopTimelapseRecording() {
    if (!this.timelapseRecording) return;
    this.timelapseRecording = false;
    this.unsubscribeTimelapse?.();
    this.unsubscribeTimelapse = null;
    this.touch();
  }

  /** Descarta la grabación en marcha o ya parada. */
  discardTimelapse() {
    this.stopTimelapseRecording();
    this.timelapseFrames = [];
    this.touch();
  }

  /** Lienzos capturados, en orden — sólo para `exportImageSequenceAsVideo`. */
  get timelapseFramesSnapshot(): readonly HTMLCanvasElement[] {
    return this.timelapseFrames;
  }

  private captureTimelapseFrame() {
    const now = performance.now();
    if (now - this.lastTimelapseCaptureAt < this.timelapseCaptureIntervalMs) return;
    // Nada cambió desde la última captura: no merece un fotograma repetido
    // (dejaría tramos "congelados" en el vídeo sin aportar nada).
    if (this.revision === this.timelapseLastRevision) return;
    this.lastTimelapseCaptureAt = now;
    this.timelapseLastRevision = this.revision;

    // `renderFrameToImageData` — el mismo camino determinista que usa la
    // exportación normal — en vez de copiar del lienzo interactivo: éste
    // lleva el zoom/giro/paneo que tenga puesto el usuario en ese instante,
    // y el time-lapse tiene que verse siempre encuadrado igual, no dando
    // saltos de cámara cada vez que alguien mueve la vista mientras dibuja.
    const data = this.renderFrameToImageData(this.currentFrame);
    const full = document.createElement('canvas');
    full.width = data.width;
    full.height = data.height;
    full.getContext('2d')!.putImageData(data, 0, 0);

    const targetW = Math.min(Engine.TIMELAPSE_CAPTURE_WIDTH, data.width);
    const targetH = Math.max(1, Math.round(targetW * (data.height / data.width)));
    const small = document.createElement('canvas');
    small.width = targetW;
    small.height = targetH;
    const sctx = small.getContext('2d')!;
    // Fondo blanco antes de copiar: `renderFrameToImageData` puede llevar
    // alfa parcial si el papel es transparente, y un vídeo no tiene canal
    // alfa — igual que hace `drawFrame` en video.ts para la exportación
    // normal.
    sctx.fillStyle = '#ffffff';
    sctx.fillRect(0, 0, targetW, targetH);
    sctx.drawImage(full, 0, 0, targetW, targetH);

    this.timelapseFrames.push(small);
    if (this.timelapseFrames.length > Engine.TIMELAPSE_MAX_FRAMES) {
      // Diezmado: en una sesión larga, en vez de crecer sin límite se queda
      // con la mitad (una de cada dos) y dobla el intervalo de captura, para
      // que el ritmo futuro siga siendo coherente con lo ya grabado.
      this.timelapseFrames = this.timelapseFrames.filter((_, i) => i % 2 === 0);
      this.timelapseCaptureIntervalMs *= 2;
    }
    this.touch(false);
  }

  /* --- intercambio de sprites (poses/visemas) --- */

  /**
   * Capa-nodo de intercambio de sprites (ojos, cejas, boca...): un catálogo
   * de variantes en vez de `cels` — `pickVariant()` decide cuál se ve en
   * cada fotograma según el canal discreto `selected`. Sigue siendo una
   * capa normal a efectos de composición (opacidad, blend, orden en la
   * pila); sólo cambia de dónde sale la superficie a componer.
   */
  createSwapNode(name: string): Layer {
    const layer = newLayer(name, false);
    layer.swap = { variants: [], selected: channel(0) };
    const index = this.activeLayerIndex + 1;
    const at = index < 0 ? this.doc.layers.length : index;
    const prevActive = this.activeLayerId;
    this.history.run({
      label: 'Crear nodo de intercambio',
      redo: () => {
        this.doc.layers.splice(at, 0, layer);
        this.activeLayerId = layer.id;
        this.touch();
      },
      undo: () => {
        const i = this.doc.layers.indexOf(layer);
        if (i >= 0) this.doc.layers.splice(i, 1);
        this.activeLayerId = prevActive;
        this.touch();
      },
    });
    return layer;
  }

  /** Añade una variante vacía y la selecciona — a partir de ahí, cualquier
   *  trazo en esta capa pinta sobre ella (ver `resolveStrokeCel`). */
  addSwapVariant(layerId: string, label: string): SpriteSwapVariant | null {
    const layer = this.doc.layers.find((l) => l.id === layerId);
    if (!layer?.swap) return null;
    const catalog = layer.swap;
    const variant: SpriteSwapVariant = {
      id: uid('swap'),
      label,
      surface: this.renderer.createSurface('swap'),
    };
    const index = catalog.variants.length;
    const prevBase = catalog.selected.base;
    const prevKeys = catalog.selected.keys.slice();
    this.history.run({
      label: 'Añadir variante',
      redo: () => {
        catalog.variants.push(variant);
        this.setSwapSelection(catalog, index);
        this.touch();
      },
      undo: () => {
        catalog.variants = catalog.variants.filter((v) => v.id !== variant.id);
        catalog.selected.base = prevBase;
        catalog.selected.keys = prevKeys.slice();
        this.touch();
      },
    });
    return variant;
  }

  /** Quita una variante del catálogo. Si algún keyframe de `selected`
   *  apuntaba a su índice, `pickVariant` cae a la variante 0 sin más —
   *  reordenar los índices de los keyframes existentes queda para cuando
   *  haga falta de verdad. */
  removeSwapVariant(layerId: string, variantId: string) {
    const layer = this.doc.layers.find((l) => l.id === layerId);
    const catalog = layer?.swap;
    if (!catalog) return;
    const index = catalog.variants.findIndex((v) => v.id === variantId);
    if (index < 0) return;
    const variant = catalog.variants[index];
    this.history.run({
      label: 'Quitar variante',
      redo: () => {
        catalog.variants = catalog.variants.filter((v) => v.id !== variantId);
        this.touch();
      },
      undo: () => {
        catalog.variants.splice(index, 0, variant);
        this.touch();
      },
    });
  }

  /* --- texturas de punta personalizadas --- */

  /**
   * Píxeles de una textura de punta por id: las 4 integradas se generan al
   * vuelo (deterministas, ver `brushTexture.ts`); cualquier otro id se busca
   * en `doc.customTextures` — las que ha importado quien dibuja para ESTE
   * proyecto. Si el id no aparece en ninguna (p. ej. el pincel activo
   * apuntaba a una textura ya borrada), cae a un buffer transparente en vez
   * de fallar: una punta sin cobertura visible, no un trazo roto.
   *
   * `hasColor` viaja junto a los píxeles (no sólo el `Uint8Array`) porque
   * `Renderer.getBrushTexture` la cachea junto a la textura de GPU — sólo
   * las integradas y las de `doc.customTextures` con `hasColor` puesto (el
   * generador de racimo con sombra/base/brillo) devuelven `true`.
   */
  private resolveTexturePixels(id: string): { pixels: Uint8Array; hasColor: boolean } {
    if (isBuiltinTextureId(id)) return { pixels: generateBrushTexturePixels(id, BRUSH_TEXTURE_SIZE), hasColor: false };
    const custom = this.doc.customTextures.find((t) => t.id === id);
    return {
      pixels: custom?.pixels ?? new Uint8Array(BRUSH_TEXTURE_SIZE * BRUSH_TEXTURE_SIZE * 4),
      hasColor: custom?.hasColor ?? false,
    };
  }

  /** Registra una textura ya decodificada (ver `importCustomBrushTexture` en
   *  `io.ts`) como activo del proyecto — viaja con el `.trace`, no con la app. */
  addCustomTexture(texture: CustomTexture) {
    this.history.run({
      label: 'Importar textura de pincel',
      redo: () => {
        this.doc.customTextures.push(texture);
        this.touch();
      },
      undo: () => {
        this.doc.customTextures = this.doc.customTextures.filter((t) => t.id !== texture.id);
        this.touch();
      },
    });
  }

  /** Quita una textura personalizada. Un pincel que la tuviera activa no se
   *  toca aquí (las presets de pincel son estado de interfaz, no del
   *  documento) — vuelve a resolver a un buffer transparente, ver
   *  `resolveTexturePixels`. */
  removeCustomTexture(id: string) {
    const index = this.doc.customTextures.findIndex((t) => t.id === id);
    if (index < 0) return;
    const texture = this.doc.customTextures[index];
    this.history.run({
      label: 'Quitar textura de pincel',
      redo: () => {
        this.doc.customTextures = this.doc.customTextures.filter((t) => t.id !== id);
        this.touch();
      },
      undo: () => {
        this.doc.customTextures.splice(index, 0, texture);
        this.touch();
      },
    });
  }

  /**
   * Cambia qué variante se ve en el fotograma actual. Sin `history.run` a
   * propósito, igual que `setTransformValue`/`setBonePose`: es lo que
   * dispara tocar una miniatura del picker, no un paso que tenga sentido
   * deshacer suelto.
   */
  selectSwapVariant(layerId: string, variantIndex: number) {
    const layer = this.doc.layers.find((l) => l.id === layerId);
    if (!layer?.swap) return;
    this.setSwapSelection(layer.swap, variantIndex);
    this.touch();
  }

  /**
   * Marca qué variante se ve en el fotograma actual, forzando SIEMPRE
   * easing `'hold'` — es la disciplina que hace que `sampleChannel` salte
   * entre variantes en vez de interpolar sus índices, y vive aquí (no en
   * el tipo) para que sea imposible crear un keyframe de `selected` con
   * otro easing por error.
   *
   * A diferencia de `setTransformValue`/`setBonePose`, aquí SIEMPRE se crea
   * un keyframe, sin el "auto-key sólo si el canal ya tiene alguno": elegir
   * una variante es un clic deliberado, no una muestra de un arrastre
   * continuo, así que no hay avalancha de keyframes que evitar. Con un
   * único keyframe (el caso normal antes de animar nada) `sampleChannel`
   * devuelve ese mismo valor en cualquier fotograma — se comporta exacto
   * igual que si sólo se hubiera tocado `base`.
   */
  private setSwapSelection(catalog: SpriteSwapCatalog, variantIndex: number) {
    setKeyframe(catalog.selected, this.currentFrame, variantIndex, 'hold');
  }

  /** Índice de variante visible en el fotograma actual, para resaltarlo en el picker. */
  getSwapSelection(layer: Layer): number {
    return layer.swap ? sampleChannel(layer.swap.selected, this.currentFrame) : 0;
  }

  /** Miniatura de una variante, cacheada por versión — mismo mecanismo que
   *  `celThumbnail`, para el mini-picker visual de la librería de poses. */
  swapVariantThumbnail(layer: Layer, variantIndex: number, maxSize = 64): HTMLCanvasElement | null {
    const variant = layer.swap?.variants[variantIndex];
    if (!variant || variant.surface.empty) return null;
    const key = `${variant.id}@${maxSize}`;
    const cached = this.thumbCache.get(key);
    if (cached && cached.version === variant.surface.version) return cached.canvas;
    const canvas = this.renderer.downscaleToCanvas(variant.surface, maxSize);
    if (!canvas) return null;
    if (this.thumbCache.size > 200) this.thumbCache.clear();
    this.thumbCache.set(key, { canvas, version: variant.surface.version });
    return canvas;
  }

  /* --- cels --- */

  /** Cel dibujable en el fotograma actual, creándolo si hace falta. */
  private ensureCel(layer: Layer, frame: number): { cel: Cel; created: number } {
    if (!layer.animated) {
      const existing = layer.cels.values().next();
      if (!existing.done) return { cel: existing.value, created: -1 };
      const cel = this.makeCel();
      layer.cels.set(0, cel);
      return { cel, created: 0 };
    }
    const existing = celAt(layer, frame);
    if (existing) return { cel: existing, created: -1 };
    const cel = this.makeCel();
    layer.cels.set(frame, cel);
    return { cel, created: frame };
  }

  /**
   * Cel a dibujar cuando empieza un trazo — para un nodo de intercambio de
   * sprites es la variante seleccionada, no un cel de `layer.cels` (que ni
   * siquiera se usa en ese tipo de capa); para una capa con su máscara en
   * edición es la propia máscara. En los tres casos el resto del trazo —
   * `drawOver`, `readRect`, `writeRect` en `endStroke` — no ve diferencia,
   * porque `LayerMask`/`SpriteSwapVariant` tienen la misma forma que `Cel`
   * (id + surface). `rasterizeLayer` sí necesita saber cuál de los tres es
   * — ver `strokeTargetsMask`.
   */
  private resolveStrokeCel(layer: Layer, frame: number): { cel: Cel; created: number } | null {
    if (this.editingMaskLayerId === layer.id && layer.mask) {
      this.strokeTargetsMask = true;
      return { cel: { id: `${layer.id}:mask`, surface: layer.mask.surface }, created: -1 };
    }
    this.strokeTargetsMask = false;
    if (layer.swap) {
      const variant = pickVariant(layer, frame);
      return variant ? { cel: variant, created: -1 } : null;
    }
    return this.ensureCel(layer, frame);
  }

  addCel(layerId: string, frame: number, copyPrevious = false) {
    const layer = this.doc.layers.find((l) => l.id === layerId);
    if (!layer || layer.cels.has(frame)) return;
    const cel = this.makeCel();
    if (copyPrevious) {
      const prev = celAt(layer, frame);
      if (prev) this.renderer.copy(cel.surface, prev.surface, 1);
    }
    this.history.run({
      label: copyPrevious ? 'Duplicar fotograma' : 'Nuevo fotograma',
      redo: () => {
        layer.animated = true;
        layer.cels.set(frame, cel);
        this.touch();
      },
      undo: () => {
        layer.cels.delete(frame);
        this.touch();
      },
    });
  }

  deleteCel(layerId: string, frame: number) {
    const layer = this.doc.layers.find((l) => l.id === layerId);
    const cel = layer?.cels.get(frame);
    if (!layer || !cel) return;
    this.history.run({
      label: 'Eliminar fotograma',
      redo: () => {
        layer.cels.delete(frame);
        this.touch();
      },
      undo: () => {
        layer.cels.set(frame, cel);
        this.touch();
      },
    });
  }

  moveCel(layerId: string, from: number, to: number) {
    const layer = this.doc.layers.find((l) => l.id === layerId);
    if (!layer || from === to) return;
    const cel = layer.cels.get(from);
    if (!cel) return;
    const displaced = layer.cels.get(to) ?? null;
    this.history.run({
      label: 'Mover fotograma',
      redo: () => {
        layer.cels.delete(from);
        layer.cels.set(to, cel);
        this.touch();
      },
      undo: () => {
        layer.cels.delete(to);
        layer.cels.set(from, cel);
        if (displaced) layer.cels.set(to, displaced);
        this.touch();
      },
    });
  }

  /**
   * Copia los dibujos que EMPIEZAN dentro de `[fromFrame, toFrame]` justo
   * después del rango, desplazados por su misma longitud — para repetir un
   * ciclo (una caminata, un parpadeo) sin volver a dibujarlo. Mismo
   * criterio que `liftSelectionRange`: sólo los cels que empiezan ahí, no
   * cada fotograma sostenido, porque tocar el mismo dibujo una vez por
   * fotograma lo procesaría de más para el mismo resultado. Amplía
   * `frameCount` si el destino no cabe todavía.
   */
  duplicateFrameRange(fromFrame: number, toFrame: number) {
    const layer = this.activeLayer;
    if (!layer || layer.locked || layer.kind === 'reference' || !layer.animated) return;
    const lo = Math.min(fromFrame, toFrame);
    const hi = Math.max(fromFrame, toFrame);
    const span = hi - lo + 1;
    const sourceFrames = sortedCelFrames(layer).filter((f) => f >= lo && f <= hi);
    if (sourceFrames.length === 0) return;

    const copies = sourceFrames.map((f) => {
      const src = layer.cels.get(f)!;
      const cel = this.makeCel();
      this.renderer.copy(cel.surface, this.renderer.ensureResident(src.surface), 1);
      return { frame: f + span, cel };
    });

    const destEnd = hi + span;
    const before = layer.cels;
    const prevFrameCount = this.doc.frameCount;
    const growsDoc = destEnd >= this.doc.frameCount;

    this.history.run({
      label: 'Duplicar rango de cuadros',
      redo: () => {
        if (growsDoc) this.doc.frameCount = destEnd + 1;
        const after = new Map(before);
        for (const c of copies) after.set(c.frame, c.cel);
        layer.cels = after;
        this.touch();
      },
      undo: () => {
        layer.cels = before;
        if (growsDoc) this.doc.frameCount = prevFrameCount;
        this.touch();
      },
    });
  }

  /**
   * Invierte el orden temporal de los dibujos dentro de `[fromFrame,
   * toFrame]` en la capa activa — para recorrer un ciclo hacia atrás sin
   * redibujarlo. No copia superficies: reubica los mismos `Cel` que ya
   * existían en los fotogramas espejados, así que lo único que cambia es
   * en qué fotograma EMPIEZA a sostenerse cada uno.
   */
  reverseFrameRange(fromFrame: number, toFrame: number) {
    const layer = this.activeLayer;
    if (!layer || layer.locked || layer.kind === 'reference' || !layer.animated) return;
    const lo = Math.min(fromFrame, toFrame);
    const hi = Math.max(fromFrame, toFrame);
    if (lo >= hi) return;

    const before = layer.cels;
    const after = new Map(before);
    for (const f of [...after.keys()]) if (f >= lo && f <= hi) after.delete(f);

    // `celAt` lee `layer.cels`, que sigue siendo `before` hasta el redo():
    // el bucle de abajo calcula sobre el estado ORIGINAL, no sobre `after`.
    let prevCel = lo > 0 ? celAt(layer, lo - 1) : null;
    for (let f = lo; f <= hi; f++) {
      const cel = celAt(layer, lo + hi - f);
      if (cel !== prevCel) {
        if (cel) after.set(f, cel);
        prevCel = cel;
      }
    }

    this.history.run({
      label: 'Invertir rango de cuadros',
      redo: () => {
        layer.cels = after;
        this.touch();
      },
      undo: () => {
        layer.cels = before;
        this.touch();
      },
    });
  }

  clearCel(layerId: string, frame: number) {
    const layer = this.doc.layers.find((l) => l.id === layerId);
    if (!layer) return;
    const cel = celAt(layer, frame);
    if (!cel || cel.surface.empty) return;
    const full: Rect = { x: 0, y: 0, x2: this.doc.width, y2: this.doc.height };
    const before = this.renderer.readRect(cel.surface, full);
    const after = new Uint8Array(before.length);
    this.history.run({
      label: 'Borrar fotograma',
      cost: before.byteLength,
      op: layer.swap
        ? undefined
        : {
            type: 'rasterEdit',
            label: 'Borrar fotograma',
            layerId: layer.id,
            frame: this.storedCelFrame(layer, frame, -1),
            createdFrame: -1,
            rect: full,
            before,
            after,
          },
      redo: () => {
        this.renderer.clear(cel.surface);
        this.touch(false);
      },
      undo: () => {
        this.renderer.writeRect(cel.surface, full, before);
        this.touch(false);
      },
    });
  }

  /* --- keyframes de transformación --- */

  toggleKeyframe(layerId: string, prop: 'x' | 'y' | 'scale' | 'rotation' | 'opacity') {
    const layer = this.doc.layers.find((l) => l.id === layerId);
    if (!layer) return;
    const ch = layer.transform[prop];
    const frame = this.currentFrame;
    const existing = ch.keys.find((k) => k.frame === frame);
    const before = ch.keys.slice();
    const value = sampleChannel(ch, frame);
    this.history.run({
      label: existing ? 'Quitar keyframe' : 'Añadir keyframe',
      redo: () => {
        if (existing) {
          ch.keys = ch.keys.filter((k) => k.frame !== frame);
        } else {
          setKeyframe(ch, frame, value);
        }
        this.touch();
      },
      undo: () => {
        ch.keys = before.slice();
        this.touch();
      },
    });
  }

  setTransformValue(
    layerId: string,
    prop: 'x' | 'y' | 'scale' | 'rotation' | 'opacity',
    value: number,
  ) {
    const layer = this.doc.layers.find((l) => l.id === layerId);
    if (!layer) return;
    const ch = layer.transform[prop];
    // Con keyframes activos, editar el valor escribe un keyframe aquí:
    // es el comportamiento de auto-key que espera cualquiera que venga de AE.
    if (ch.keys.length > 0) setKeyframe(ch, this.currentFrame, value);
    else ch.base = value;
    this.touch();
  }

  getTransformValue(
    layer: Layer,
    prop: 'x' | 'y' | 'scale' | 'rotation' | 'opacity',
  ): number {
    return sampleChannel(layer.transform[prop], this.currentFrame);
  }

  /* --- rig: esqueletos, huesos y su vínculo con las capas --- */

  createSkeleton(name = 'Esqueleto'): Skeleton {
    const skel = newSkeleton(name);
    this.history.run({
      label: 'Crear esqueleto',
      redo: () => {
        this.doc.skeletons.push(skel);
        this.touch();
      },
      undo: () => {
        this.doc.skeletons = this.doc.skeletons.filter((s) => s.id !== skel.id);
        this.touch();
      },
    });
    return skel;
  }

  addBone(
    skeletonId: string,
    name: string,
    parentId: string | null,
    rest: { x: number; y: number; rotation?: number; length?: number },
  ): Bone | null {
    const skel = this.doc.skeletons.find((s) => s.id === skeletonId);
    if (!skel) return null;
    // Se construye fuera de redo() para que el mismo objeto Bone sea el que
    // entra y sale del array en cada redo/undo — igual que `createSkeleton`.
    const bone = createBone(name, parentId, rest);
    this.history.run({
      label: 'Añadir hueso',
      redo: () => {
        skel.bones.push(bone);
        this.touch();
      },
      undo: () => {
        skel.bones = skel.bones.filter((b) => b.id !== bone.id);
        this.touch();
      },
    });
    return bone;
  }

  removeBone(skeletonId: string, boneId: string) {
    const skel = this.doc.skeletons.find((s) => s.id === skeletonId);
    if (!skel) return;
    // `removeBoneFromSkeleton` reengancha a los hijos del hueso borrado a su
    // padre, mutando `parentId` en sitio — clonamos antes para poder
    // restaurar exactamente ese árbol al deshacer.
    const before = skel.bones.map((b) => ({ ...b }));
    this.history.run({
      label: 'Quitar hueso',
      redo: () => {
        removeBoneFromSkeleton(skel, boneId);
        this.touch();
      },
      undo: () => {
        skel.bones = before;
        this.touch();
      },
    });
  }

  /**
   * Reasigna el padre de un hueso sin que salte de sitio: recalcula su
   * reposo en el marco del nuevo padre (`reparentBoneRest`, `rig.ts`) y
   * reordena `bones` para conservar el invariante topológico — el padre
   * nuevo puede estar DESPUÉS en el array, y evaluar la pose asume que
   * nunca lo está. `newParentId: null` lo desengancha a hueso raíz.
   *
   * Rechaza en silencio (sin tocar el historial) los casos que romperían
   * el árbol: colgar un hueso de sí mismo o de uno de sus propios
   * descendientes crearía un ciclo, y `evaluatePoseWorldMatrices` no
   * termina nunca sobre un ciclo.
   */
  reparentBone(skeletonId: string, boneId: string, newParentId: string | null) {
    const skel = this.doc.skeletons.find((s) => s.id === skeletonId);
    const bone = skel && findBone(skel, boneId);
    if (!skel || !bone || bone.parentId === newParentId) return;
    if (newParentId === boneId) return;
    const newParent = newParentId ? findBone(skel, newParentId) : null;
    if (newParentId && !newParent) return;
    if (newParentId && isBoneDescendantOf(skel, newParentId, boneId)) return;

    const restWorlds = evaluateRestWorldMatrices(skel);
    const oldWorld = restWorlds.get(boneId) ?? mat3Identity();
    const newParentWorld = newParent ? (restWorlds.get(newParent.id) ?? mat3Identity()) : mat3Identity();
    const rest = reparentBoneRest(oldWorld, newParentWorld);

    const before = skel.bones.map((b) => ({ ...b }));
    const after = topoSortBones(
      skel.bones.map((b) =>
        b.id === boneId
          ? { ...b, parentId: newParentId, restX: rest.x, restY: rest.y, restRotation: rest.rotation }
          : b,
      ),
    );

    this.history.run({
      label: 'Reparentar hueso',
      redo: () => {
        skel.bones = after;
        this.touch();
      },
      undo: () => {
        skel.bones = before;
        this.touch();
      },
    });
  }

  attachLayerToBone(layerId: string, skeletonId: string, boneId: string | null) {
    const layer = this.doc.layers.find((l) => l.id === layerId);
    if (!layer) return;
    const before = layer.rig;
    const after: LayerRig = { skeletonId, boneId, meshId: before?.meshId ?? null };
    this.history.run({
      label: 'Vincular capa a hueso',
      redo: () => {
        layer.rig = after;
        this.touch();
      },
      undo: () => {
        layer.rig = before;
        this.touch();
      },
    });
  }

  /**
   * Crea una malla de rejilla con auto-peso para `skeletonId` (cubre todo
   * el documento — ver `newGridMesh`). No la vincula a ninguna capa por sí
   * sola: eso lo hace `attachLayerToMesh`, como dos pasos separados igual
   * que `createSkeleton`/`addBone` lo son de `attachLayerToBone`.
   */
  createMesh(skeletonId: string, cols?: number, rows?: number): Mesh | null {
    const skel = this.doc.skeletons.find((s) => s.id === skeletonId);
    if (!skel) return null;
    const mesh = newMesh(skel, this.doc.width, this.doc.height, cols, rows);
    this.history.run({
      label: 'Crear malla',
      redo: () => {
        this.doc.meshes.push(mesh);
        this.touch();
      },
      undo: () => {
        this.doc.meshes = this.doc.meshes.filter((m) => m.id !== mesh.id);
        this.touch();
      },
    });
    return mesh;
  }

  /** Vincula una capa a una malla — sustituye al transform rígido por hueso
   *  en la composición (ver `rasterizeLayer`), sin perder a qué hueso
   *  estaba pegada por si se quita la malla más adelante. */
  attachLayerToMesh(layerId: string, skeletonId: string, meshId: string) {
    const layer = this.doc.layers.find((l) => l.id === layerId);
    if (!layer) return;
    const before = layer.rig;
    const after: LayerRig = { skeletonId, boneId: before?.boneId ?? null, meshId };
    this.history.run({
      label: 'Vincular capa a malla',
      redo: () => {
        layer.rig = after;
        this.touch();
      },
      undo: () => {
        layer.rig = before;
        this.touch();
      },
    });
  }

  /** Cabeza y cola de cada hueso en `frame`, en espacio documento — lo que
   *  necesita el gizmo del modo Viewport para dibujarse y para convertir
   *  arrastres de pantalla en valores de `track`. */
  boneEndpoints(skeletonId: string): { bone: Bone; head: Vec2; tail: Vec2 }[] {
    const skel = this.doc.skeletons.find((s) => s.id === skeletonId);
    if (!skel) return [];
    const matrices = evaluatePoseWorldMatrices(skel, this.currentFrame);
    return skel.bones.map((bone) => {
      const m = matrices.get(bone.id) ?? mat3Identity();
      return { bone, head: mat3Apply(m, { x: 0, y: 0 }), tail: mat3Apply(m, { x: bone.length, y: 0 }) };
    });
  }

  /** Mundo del padre de un hueso en `frame`, o identidad si es raíz — lo
   *  que necesita `worldPointToBoneOffset`/`worldPointToBoneRotation` para
   *  traducir un punto de pantalla a valores de `track`. */
  boneParentWorldMatrix(skeletonId: string, boneId: string): Mat3 {
    const skel = this.doc.skeletons.find((s) => s.id === skeletonId);
    const bone = skel && findBone(skel, boneId);
    if (!skel || !bone || !bone.parentId) return mat3Identity();
    return evaluatePoseWorldMatrices(skel, this.currentFrame).get(bone.parentId) ?? mat3Identity();
  }

  hitTestBone(skeletonId: string, point: Vec2, tolerance = 12): Bone | null {
    const skel = this.doc.skeletons.find((s) => s.id === skeletonId);
    if (!skel) return null;
    const matrices = evaluatePoseWorldMatrices(skel, this.currentFrame);
    return hitTestBoneInSkeleton(skel, matrices, point, tolerance);
  }

  /** Hueso cuya cola cae bajo `point` — la señal para encadenar un hijo en
   *  vez de seleccionar (ver `beginBoneDrag`). Se mide en pose, no en
   *  reposo, para que el punto de enganche sea el que se ve en pantalla en
   *  el fotograma actual, no uno invisible si el hueso está animado. */
  hitTestBoneTail(skeletonId: string, point: Vec2, tolerance = 16): Bone | null {
    const skel = this.doc.skeletons.find((s) => s.id === skeletonId);
    if (!skel) return null;
    const matrices = evaluatePoseWorldMatrices(skel, this.currentFrame);
    return hitTestBoneTailInSkeleton(skel, matrices, point, tolerance);
  }

  /**
   * Arranca un hueso por arrastre: crea el esqueleto si el documento no
   * tiene ninguno todavía, y el hueso con longitud mínima en `worldPoint`
   * (o en la cola de `parentBoneId` si se está encadenando uno hijo).
   * `updateBoneDrag` ajusta longitud y rotación en cada muestra del
   * arrastre; `createSkeleton`/`addBone` ya son Commands, así que crear
   * el hueso (y el esqueleto, si hizo falta) son los únicos pasos que
   * entran en el historial — arrastrar no añade más. `createdSkeleton` le
   * dice a `cancelBoneDrag` cuántos de esos pasos deshacer si el gesto
   * queda en nada.
   */
  beginBoneDrag(
    worldPoint: Vec2,
    parentBoneId: string | null,
  ): { skeletonId: string; boneId: string; createdSkeleton: boolean } {
    const createdSkeleton = this.doc.skeletons.length === 0;
    const skel = this.doc.skeletons[0] ?? this.createSkeleton('Esqueleto');
    let restX = worldPoint.x;
    let restY = worldPoint.y;
    const parent = parentBoneId ? findBone(skel, parentBoneId) : null;
    if (parent) {
      // El hijo nace en la cola de reposo del padre, en SU espacio local
      // — el mismo convenio que ya usan todos los esqueletos de prueba
      // (restX = longitud del padre, restY = 0).
      restX = parent.length;
      restY = 0;
    }
    const bone = this.addBone(skel.id, `Hueso ${skel.bones.length + 1}`, parentBoneId, {
      x: restX,
      y: restY,
      length: 1,
    })!;
    return { skeletonId: skel.id, boneId: bone.id, createdSkeleton };
  }

  /**
   * Longitud y rotación de reposo del hueso en creación, siguiendo a
   * `worldPoint`. Sin `history.run`: la creación en sí ya quedó registrada
   * en `beginBoneDrag`, y esto es la misma muestra continua de arrastre
   * que `setBonePose`, no un paso aparte que deshacer.
   */
  updateBoneDrag(skeletonId: string, boneId: string, worldPoint: Vec2) {
    const skel = this.doc.skeletons.find((s) => s.id === skeletonId);
    const bone = skel && findBone(skel, boneId);
    if (!skel || !bone) return;
    let parentWorldRotation = 0;
    let worldHead: Vec2 = { x: bone.restX, y: bone.restY };
    if (bone.parentId) {
      const parent = findBone(skel, bone.parentId);
      const parentM = evaluateRestWorldMatrices(skel).get(bone.parentId);
      if (parent && parentM) {
        parentWorldRotation = matRotation(parentM);
        worldHead = { x: parentM[0] * parent.length + parentM[6], y: parentM[1] * parent.length + parentM[7] };
      }
    }
    const { length, restRotation } = boneRestFromDrag(parentWorldRotation, worldHead, worldPoint);
    bone.length = length;
    bone.restRotation = restRotation;
    this.touch();
  }

  /**
   * Deshace un hueso creado por arrastre que quedó demasiado corto — un
   * toque, no un gesto de verdad. Nada más ha pasado por el historial
   * desde `beginBoneDrag`, así que uno o dos `undo()` (el hueso, y el
   * esqueleto si `beginBoneDrag` tuvo que crear uno) lo revierten limpio,
   * igual que `cancelStroke`/`cancelFloating` deshacen su propio gesto
   * pendiente sin dejar rastro.
   */
  cancelBoneDrag(createdSkeleton: boolean) {
    this.history.undo();
    if (createdSkeleton) this.history.undo();
  }

  getBoneValue(bone: Bone, prop: 'x' | 'y' | 'rotation' | 'scaleX' | 'scaleY'): number {
    return sampleChannel(bone.track[prop], this.currentFrame);
  }

  /**
   * Mueve/rota/escala un hueso. Sin `history.run`, a propósito: igual que
   * `setTransformValue`, se llama en cada muestra de un arrastre continuo, y
   * envolver cada una en un Command inundaría la pila de deshacer con pasos
   * intermedios que nadie quiere deshacer uno a uno.
   */
  setBonePose(
    skeletonId: string,
    boneId: string,
    patch: Partial<{ x: number; y: number; rotation: number; scaleX: number; scaleY: number }>,
  ) {
    const skel = this.doc.skeletons.find((s) => s.id === skeletonId);
    const bone = skel && findBone(skel, boneId);
    if (!bone) return;
    for (const prop of Object.keys(patch) as (keyof typeof patch)[]) {
      const value = patch[prop];
      if (value === undefined) continue;
      const ch = bone.track[prop];
      if (ch.keys.length > 0) setKeyframe(ch, this.currentFrame, value);
      else ch.base = value;
    }
    this.touch();
  }

  toggleBoneKeyframe(
    skeletonId: string,
    boneId: string,
    prop: 'x' | 'y' | 'rotation' | 'scaleX' | 'scaleY',
  ) {
    const skel = this.doc.skeletons.find((s) => s.id === skeletonId);
    const bone = skel && findBone(skel, boneId);
    if (!bone) return;
    const ch = bone.track[prop];
    const frame = this.currentFrame;
    const existing = ch.keys.find((k) => k.frame === frame);
    const before = ch.keys.slice();
    const value = sampleChannel(ch, frame);
    this.history.run({
      label: existing ? 'Quitar keyframe de hueso' : 'Añadir keyframe de hueso',
      redo: () => {
        if (existing) ch.keys = ch.keys.filter((k) => k.frame !== frame);
        else setKeyframe(ch, frame, value);
        this.touch();
      },
      undo: () => {
        ch.keys = before.slice();
        this.touch();
      },
    });
  }

  /**
   * Añade (o quita) un fotograma clave con la pose entera del hueso — los
   * cinco canales de `BoneTrack` a la vez, en un solo paso de deshacer. Es
   * lo que dispara el botón de rombo del gizmo: grabar "así está posado
   * ahora" es lo que se espera, no tener que armar cinco keyframes sueltos.
   * Si los cinco ya están marcados en este fotograma, los quita todos; si
   * falta alguno, los añade todos (los que ya estaban, sin cambiar de valor).
   */
  toggleBonePoseKeyframe(skeletonId: string, boneId: string) {
    const skel = this.doc.skeletons.find((s) => s.id === skeletonId);
    const bone = skel && findBone(skel, boneId);
    if (!bone) return;
    const props: (keyof BoneTrack)[] = ['x', 'y', 'rotation', 'scaleX', 'scaleY'];
    const frame = this.currentFrame;
    const allKeyed = props.every((p) => bone.track[p].keys.some((k) => k.frame === frame));
    const before = props.map((p) => bone.track[p].keys.slice());
    const values = props.map((p) => sampleChannel(bone.track[p], frame));
    this.history.run({
      label: allKeyed ? 'Quitar fotograma clave del hueso' : 'Fotograma clave del hueso',
      redo: () => {
        props.forEach((p, i) => {
          const ch = bone.track[p];
          if (allKeyed) ch.keys = ch.keys.filter((k) => k.frame !== frame);
          else setKeyframe(ch, frame, values[i]);
        });
        this.touch();
      },
      undo: () => {
        props.forEach((p, i) => {
          bone.track[p].keys = before[i].slice();
        });
        this.touch();
      },
    });
  }

  /** Si los cinco canales del hueso llevan keyframe en el fotograma actual. */
  boneHasKeyframeHere(bone: Bone): boolean {
    const frame = this.currentFrame;
    const props: (keyof BoneTrack)[] = ['x', 'y', 'rotation', 'scaleX', 'scaleY'];
    return props.every((p) => bone.track[p].keys.some((k) => k.frame === frame));
  }

  /** Punto de `worldPoint` traducido a los valores (x,y) de `track` que
   *  pondrían la cabeza del hueso ahí — envuelve `worldPointToBoneOffset`
   *  con el mundo del padre resuelto en `frame`. */
  boneOffsetForWorldPoint(skeletonId: string, bone: Bone, worldPoint: Vec2): Vec2 {
    return worldPointToBoneOffset(bone, this.boneParentWorldMatrix(skeletonId, bone.id), worldPoint);
  }

  /** Rotación de `track` que apuntaría la cola del hueso hacia `worldPoint`,
   *  dada su posición de cabeza actual. */
  boneRotationForWorldPoint(skeletonId: string, bone: Bone, worldPoint: Vec2): number {
    const offset = { x: this.getBoneValue(bone, 'x'), y: this.getBoneValue(bone, 'y') };
    return worldPointToBoneRotation(
      bone,
      this.boneParentWorldMatrix(skeletonId, bone.id),
      offset,
      worldPoint,
    );
  }

  /**
   * Padre e hijo de `boneId` si forman una cadena de IK de 2 huesos válida
   * — `boneId` es el hueso INFERIOR (p. ej. el antebrazo), y necesita un
   * padre (el brazo) del que tirar. Null si `boneId` es un hueso raíz: sin
   * padre no hay cadena que resolver, sólo el arrastre normal de un hueso.
   */
  twoBoneChain(skeletonId: string, boneId: string): { root: Bone; mid: Bone } | null {
    const skel = this.doc.skeletons.find((s) => s.id === skeletonId);
    const mid = skel && findBone(skel, boneId);
    if (!skel || !mid || !mid.parentId) return null;
    const root = findBone(skel, mid.parentId);
    return root ? { root, mid } : null;
  }

  /**
   * Arranca un arrastre de IK: el `bendSign` (de qué lado cae el codo/
   * rodilla) se calcula UNA VEZ aquí, a partir de dónde está la
   * articulación ahora mismo, y se mantiene fijo durante todo el gesto —
   * ver `bendSignFor` en `rig.ts`. Sin fijarlo, el codo saltaría de lado en
   * cuanto la mano cruzara la línea hombro→mano.
   */
  beginBoneIKDrag(skeletonId: string, boneId: string): boolean {
    const chain = this.twoBoneChain(skeletonId, boneId);
    if (!chain) return false;
    const endpoints = this.boneEndpoints(skeletonId);
    const rootEp = endpoints.find((ep) => ep.bone.id === chain.root.id);
    const midEp = endpoints.find((ep) => ep.bone.id === chain.mid.id);
    if (!rootEp || !midEp) return false;
    this.ikDrag = {
      skeletonId,
      rootId: chain.root.id,
      midId: chain.mid.id,
      root: rootEp.head,
      len1: chain.root.length,
      len2: chain.mid.length,
      bendSign: bendSignFor(rootEp.head, midEp.head, midEp.tail),
    };
    return true;
  }

  /**
   * Resuelve la cadena para `worldPoint` y orienta los dos huesos. Primero
   * el raíz hacia el codo resuelto; luego, con el raíz ya orientado, el
   * intermedio hacia el objetivo real — el orden importa porque el mundo
   * del intermedio depende de la pose nueva del raíz, no de la vieja. Sin
   * `history.run`, igual que `setBonePose`: es una muestra continua de
   * arrastre, no un paso que deshacer de por sí.
   */
  updateBoneIKDrag(worldPoint: Vec2) {
    const drag = this.ikDrag;
    if (!drag) return;
    const skel = this.doc.skeletons.find((s) => s.id === drag.skeletonId);
    const root = skel && findBone(skel, drag.rootId);
    const mid = skel && findBone(skel, drag.midId);
    if (!skel || !root || !mid) return;

    const elbow = solveTwoBoneIK(drag.root, drag.len1, drag.len2, worldPoint, drag.bendSign);

    const rootParentWorld = this.boneParentWorldMatrix(drag.skeletonId, root.id);
    const rootOffset = { x: this.getBoneValue(root, 'x'), y: this.getBoneValue(root, 'y') };
    this.setBonePose(drag.skeletonId, root.id, {
      rotation: worldPointToBoneRotation(root, rootParentWorld, rootOffset, elbow),
    });

    // El mundo del raíz cambió con la línea de arriba: se vuelve a leer en
    // vez de reutilizar `rootParentWorld`/`elbow`, que ya están obsoletos.
    const midParentWorld = evaluatePoseWorldMatrices(skel, this.currentFrame).get(root.id) ?? mat3Identity();
    const midOffset = { x: this.getBoneValue(mid, 'x'), y: this.getBoneValue(mid, 'y') };
    this.setBonePose(drag.skeletonId, mid.id, {
      rotation: worldPointToBoneRotation(mid, midParentWorld, midOffset, worldPoint),
    });
  }

  endBoneIKDrag() {
    this.ikDrag = null;
  }

  /* ---------------------------------------------------------------- *
   * Trazo
   * ---------------------------------------------------------------- */

  get isDrawing() {
    return this.builder !== null;
  }

  /**
   * Se resuelve en cuanto no haya un trazo en curso — de inmediato si ya
   * está quieto. La usa el autoguardado (`App.tsx`) para no cortar un trazo
   * a la mitad ni saltarse el guardado los dos minutos enteros por haber
   * caído justo encima de uno: espera a que termine en vez de cualquiera de
   * las dos.
   */
  whenIdle(): Promise<void> {
    if (!this.isDrawing) return Promise.resolve();
    return new Promise((resolve) => {
      const check = () => {
        if (this.isDrawing) return;
        unsub();
        clearInterval(poll);
        resolve();
      };
      const unsub = this.subscribe(check);
      // Red de seguridad: `touch()` ya se llama en cada muestra del trazo y
      // al soltar, pero un candado que se pudiera quedar pegado para
      // siempre por un camino que termine el trazo sin pasar por ahí es
      // peor que revisar cada poco.
      const poll = setInterval(check, 150);
    });
  }

  /** Encaja la posición de una muestra a la guía de perspectiva si está
   *  activa — sin tocar el resto de campos (presión, inclinación...). */
  private snapSample(s: InputSample): InputSample {
    if (!this.perspectiveGuide.enabled) return s;
    const p = this.snapToPerspective({ x: s.x, y: s.y });
    return { ...s, x: p.x, y: p.y };
  }

  beginStroke(rawSample: InputSample, ctx: StrokeContext): boolean {
    const layer = this.activeLayer;
    if (!layer || layer.locked || !layer.visible || layer.kind !== 'draw') return false;

    // Un trazo nuevo confirma cualquier forma QuickShape que hubiera
    // quedado pendiente de edición — es lo que espera cualquiera que venga
    // de Procreate: seguir dibujando la da por buena.
    if (this.pendingQuickShape) this.commitQuickShape();

    const sample = this.snapSample(rawSample);
    const resolved = this.resolveStrokeCel(layer, this.currentFrame);
    if (!resolved) return false;
    const { cel, created } = resolved;
    this.strokeLayer = layer;
    this.strokeCel = cel;
    this.strokeCtx = ctx;
    this.createdCelFrame = created;
    this.strokeStartFrame = this.currentFrame;
    this.strokeRect = emptyRect();
    this.predictedStamps = [];
    this.strokeRawPoints = [{ x: sample.x, y: sample.y }];
    this.tailStamps = [];
    this.strokeLen = 0;
    this.lastTailPos = null;
    this.smudgeColor = null;

    this.renderer.clear(this.renderer.scratch('wet'));
    this.renderer.clear(this.renderer.scratch('predict'));

    this.builder = new StrokeBuilder(ctx.brush);
    this.commitStamps(this.builder.begin(sample));
    if (created >= 0) this.touch();
    else this.requestRender();
    return true;
  }

  moveStroke(rawSamples: InputSample[], rawPredicted: InputSample[] = []) {
    if (!this.builder) return;
    const samples = this.perspectiveGuide.enabled ? rawSamples.map((s) => this.snapSample(s)) : rawSamples;
    const predicted = this.perspectiveGuide.enabled ? rawPredicted.map((s) => this.snapSample(s)) : rawPredicted;
    const stamps: Stamp[] = [];
    for (const s of samples) {
      stamps.push(...this.builder.push(s));
      this.strokeRawPoints.push({ x: s.x, y: s.y });
    }
    this.commitStamps(stamps);
    const speculated = predicted.length ? this.builder.speculate(predicted) : [];
    this.predictedStamps = [...speculated, ...this.mirrorStamps(speculated)];
    this.requestRender();
  }

  /**
   * Copias reflejadas o rotadas de `stamps` según `symmetry`.
   *
   * Vertical (eje X en `doc.width/2`), horizontal (eje Y en `doc.height/2`),
   * o las dos a la vez, que añade también la copia en diagonal (reflejada en
   * ambos ejes), como la simetría de 4 vías de Procreate. El ángulo se
   * refleja junto con la posición: sin eso, una estampa ovalada (pincel
   * achatado) quedaría girada al revés de como se ve al otro lado del eje.
   *
   * Radial (mutuamente excluyente con las anteriores — ver el campo) reparte
   * `radial` copias en corona alrededor del centro del documento, rotando
   * tanto la posición como el ángulo de cada estampa: un pétalo dibujado a
   * mano se convierte en un mandala completo mientras se dibuja.
   */
  private mirrorStamps(stamps: Stamp[]): Stamp[] {
    const { vertical, horizontal, radial } = this.symmetry;
    if (radial > 1) {
      const cx = this.doc.width / 2;
      const cy = this.doc.height / 2;
      const out: Stamp[] = [];
      for (let k = 1; k < radial; k++) {
        const theta = (Math.PI * 2 * k) / radial;
        const c = Math.cos(theta);
        const s = Math.sin(theta);
        for (const st of stamps) {
          const dx = st.x - cx;
          const dy = st.y - cy;
          out.push({ ...st, x: cx + dx * c - dy * s, y: cy + dx * s + dy * c, angle: st.angle + theta });
        }
      }
      return out;
    }
    if (!vertical && !horizontal) return [];
    const mirrorV = (s: Stamp): Stamp => ({ ...s, x: this.doc.width - s.x, angle: Math.PI - s.angle });
    const mirrorH = (s: Stamp): Stamp => ({ ...s, y: this.doc.height - s.y, angle: -s.angle });
    const out: Stamp[] = [];
    if (vertical) out.push(...stamps.map(mirrorV));
    if (horizontal) out.push(...stamps.map(mirrorH));
    if (vertical && horizontal) out.push(...stamps.map((s) => mirrorH(mirrorV(s))));
    return out;
  }

  /* ---------------------------------------------------------------- *
   * Guía de perspectiva
   * ---------------------------------------------------------------- */

  private centerPerspectiveGuide() {
    const w = this.doc.width;
    const h = this.doc.height;
    this.perspectiveGuide.vp1 = { x: w / 2, y: h / 2 };
    this.perspectiveGuide.vp2 = { x: w * 0.08, y: h / 2 };
    this.perspectiveGuide.vp3 = { x: w / 2, y: h * 0.08 };
  }

  setPerspectiveGuide(patch: Partial<Omit<PerspectiveGuide, 'vp1' | 'vp2' | 'vp3'>>) {
    this.perspectiveGuide = { ...this.perspectiveGuide, ...patch };
    this.touch();
  }

  setPerspectiveVanishingPoint(which: 'vp1' | 'vp2' | 'vp3', p: Vec2) {
    this.perspectiveGuide[which] = p;
    this.touch();
  }

  /**
   * Encaja `p` a la línea radial más cercana de cualquiera de los puntos de
   * fuga activos — cada punto de fuga tiene radios imaginarios cada 7.5°
   * (48 por vuelta, bastante fino para no notarse como "escalones" al
   * trazar una curva suave). Se prueban todos los puntos de fuga del modo
   * activo y se queda con el que menos desplaza `p` — así una línea que
   * apunta claramente a un punto de fuga no se encaja al otro por
   * casualidad sólo por estar más cerca en línea recta.
   */
  private snapToPerspective(p: Vec2): Vec2 {
    const g = this.perspectiveGuide;
    if (!g.enabled) return p;
    const vps = g.mode === '1pt' ? [g.vp1] : g.mode === '2pt' ? [g.vp1, g.vp2] : [g.vp1, g.vp2, g.vp3];
    const step = (Math.PI * 2) / 48;
    let best = p;
    let bestDelta = Infinity;
    for (const vp of vps) {
      const dx = p.x - vp.x;
      const dy = p.y - vp.y;
      const dist = Math.hypot(dx, dy);
      if (dist < 1) continue;
      const angle = Math.round(Math.atan2(dy, dx) / step) * step;
      const candidate = { x: vp.x + Math.cos(angle) * dist, y: vp.y + Math.sin(angle) * dist };
      const delta = Math.hypot(candidate.x - p.x, candidate.y - p.y);
      if (delta < bestDelta) {
        bestDelta = delta;
        best = candidate;
      }
    }
    return best;
  }

  private commitStamps(stamps: Stamp[]) {
    if (stamps.length === 0 || !this.strokeCtx) return;
    // El rectángulo sucio usa el tamaño sin afinar como cota (la versión
    // afinada siempre es igual o más pequeña) y tiene que cubrir también las
    // copias reflejadas de la simetría, o un trazo cerca de un eje dejaría
    // su mitad reflejada fuera del área que se lee para deshacer.
    const allForRect = [...stamps, ...this.mirrorStamps(stamps)];
    for (const s of allForRect) {
      expandRect(this.strokeRect, s.x, s.y, s.size * 0.75 + 2);
    }

    if (this.strokeCtx.brush.taper <= 0) {
      this.drawToWet(stamps, this.strokeCtx);
      return;
    }

    // Con afinado de cierre no se quema directo: cada estampa nueva entra a
    // la cola y sólo se vuelca a `wet` cuando queda a más de la longitud de
    // afinado de la punta viva — momento en el que su tamaño definitivo ya
    // no puede cambiar. Lo que sigue en la cola se redibuja cada fotograma
    // en `rasterizeLayer`, igual que las estampas especulativas.
    const taperLen = this.strokeCtx.brush.size * TAPER_LENGTH_FACTOR * this.strokeCtx.brush.taper;
    for (const s of stamps) {
      if (this.lastTailPos) {
        this.strokeLen += Math.hypot(s.x - this.lastTailPos.x, s.y - this.lastTailPos.y);
      }
      this.lastTailPos = { x: s.x, y: s.y };
      this.tailStamps.push({ stamp: s, dist: this.strokeLen });
    }
    const promoted: Stamp[] = [];
    while (this.tailStamps.length > 0 && this.strokeLen - this.tailStamps[0].dist > taperLen) {
      promoted.push(this.tailStamps.shift()!.stamp);
    }
    if (promoted.length > 0) this.drawToWet(promoted, this.strokeCtx);
  }

  /** Único punto donde el trazo en curso llega a `wet`: quemado directo sin
   * afinado, estampas promovidas de la cola, o el cierre en `finalizeTail`.
   * Reflejar aquí, no en cada llamador, es lo que garantiza que la simetría
   * cubra los tres caminos sin repetir el cálculo. */
  private drawToWet(stamps: Stamp[], ctx: StrokeContext) {
    if (stamps.length === 0) return;
    const wet = this.renderer.scratch('wet');
    const texId = ctx.brush.textureId;
    const allStamps = [...stamps, ...this.mirrorStamps(stamps)];
    const color = ctx.brush.smudge > 0 ? this.updateSmudgeColor(stamps[0], ctx) : ctx.color;
    this.renderer.drawStamps(
      wet,
      allStamps,
      color,
      texId ? this.renderer.getBrushTexture(texId, () => this.resolveTexturePixels(texId)) : undefined,
    );
  }

  /**
   * Color de esta tanda de estampas para "Difuminar" — se muestrea UNA vez
   * por tanda (en la posición de la primera estampa), no por estampa
   * individual: leer la GPU en cada una saturaría el arrastre de sincronías
   * de más sin que se note el arrastre más suave, ya que `moveStroke` ya
   * agrupa varias estampas por fotograma.
   *
   * `smudgeColor` es la "cubeta" que se va diluyendo: en cada tanda se
   * mezcla con lo recién muestreado según `smudgeLength` (alto = cambia
   * despacio, bajo = casi al instante), y el color final de la estampa es
   * esa cubeta mezclada con el color activo del pincel según `smudge` (1 =
   * sólo lo recogido del lienzo, nada de pigmento nuevo).
   */
  private updateSmudgeColor(first: Stamp, ctx: StrokeContext): RGB {
    if (!this.strokeCel) return ctx.color;
    const halfExtent = Math.min(20, Math.max(2, first.size * 0.25));
    const sampled = this.sampleSmudgeColor(this.strokeCel.surface, first.x, first.y, halfExtent);
    if (sampled) {
      this.smudgeColor = this.smudgeColor
        ? {
            r: lerp(sampled.r, this.smudgeColor.r, ctx.brush.smudgeLength),
            g: lerp(sampled.g, this.smudgeColor.g, ctx.brush.smudgeLength),
            b: lerp(sampled.b, this.smudgeColor.b, ctx.brush.smudgeLength),
          }
        : sampled;
    }
    // Sin nada recogido todavía (lienzo vacío bajo el primer toque): se
    // pinta con el color activo del pincel, como cualquier trazo normal,
    // hasta que el arrastre encuentre algo que recoger.
    const bucket = this.smudgeColor ?? ctx.color;
    return {
      r: lerp(ctx.color.r, bucket.r, ctx.brush.smudge),
      g: lerp(ctx.color.g, bucket.g, ctx.brush.smudge),
      b: lerp(ctx.color.b, bucket.b, ctx.brush.smudge),
    };
  }

  /** Color medio bajo un punto de UN cel (no la composición de capas
   *  visibles — a diferencia de `pickColor`, "Difuminar" arrastra la pintura
   *  del propio cel que se está pintando, no lo que se vea encima o debajo).
   *  Promedia un cuadro pequeño en vez de leer un solo píxel, para que el
   *  arrastre no tiemble con el grano de una textura; `null` si el área está
   *  vacía (nada que recoger). Los píxeles vienen premultiplicados: sumar
   *  RGB y alfa por separado y dividir da la media ponderada por cobertura,
   *  sin necesidad de despremultiplicar píxel a píxel. */
  private sampleSmudgeColor(surface: Surface, x: number, y: number, halfExtent: number): RGB | null {
    const rect = {
      x: Math.max(0, Math.round(x - halfExtent)),
      y: Math.max(0, Math.round(y - halfExtent)),
      x2: Math.min(this.doc.width, Math.round(x + halfExtent)),
      y2: Math.min(this.doc.height, Math.round(y + halfExtent)),
    };
    if (rect.x2 <= rect.x || rect.y2 <= rect.y) return null;
    const px = this.renderer.readRect(surface, rect);
    let sumR = 0;
    let sumG = 0;
    let sumB = 0;
    let sumA = 0;
    const n = px.length / 4;
    for (let i = 0; i < n; i++) {
      sumR += px[i * 4];
      sumG += px[i * 4 + 1];
      sumB += px[i * 4 + 2];
      sumA += px[i * 4 + 3];
    }
    if (sumA === 0) return null;
    return { r: sumR / sumA, g: sumG / sumA, b: sumB / sumA };
  }

  /** Al soltar el lápiz ya se sabe la longitud real del trazo: lo que
   * quedaba en la cola se quema en `wet` con su escala definitiva en vez de
   * seguir esperando un fotograma más que no va a llegar. */
  private finalizeTail() {
    if (this.tailStamps.length === 0 || !this.strokeCtx) return;
    const ctx = this.strokeCtx;
    const final = this.tailStamps.map(({ stamp, dist }) => {
      const ratio = taperScale(this.strokeLen - dist, ctx.brush);
      return ratio >= 1 ? stamp : { ...stamp, size: stamp.size * ratio };
    });
    this.drawToWet(final, ctx);
    this.tailStamps = [];
  }

  endStroke() {
    if (!this.builder || !this.strokeCel || !this.strokeCtx || !this.strokeLayer) {
      this.cancelStroke();
      return;
    }
    this.commitStamps(this.builder.end());
    this.finalizeTail();
    this.predictedStamps = [];
    this.renderer.clear(this.renderer.scratch('predict'));

    const layer = this.strokeLayer;
    const cel = this.strokeCel;
    const ctx = this.strokeCtx;
    const createdFrame = this.createdCelFrame;
    const startFrame = this.strokeStartFrame;
    const rect = clampRect(this.strokeRect, this.doc.width, this.doc.height);

    this.builder = null;
    this.strokeCel = null;
    this.strokeCtx = null;
    this.strokeLayer = null;
    this.createdCelFrame = -1;
    this.strokeStartFrame = -1;

    if (rectIsEmpty(rect)) {
      if (createdFrame >= 0) layer.cels.delete(createdFrame);
      this.renderer.clear(this.renderer.scratch('wet'));
      this.touch();
      return;
    }

    const before = this.renderer.readRect(cel.surface, rect);
    this.mergeStroke(
      cel.surface,
      this.renderer.scratch('wet'),
      ctx.brush.opacity,
      ctx.brush.erase,
      layer,
      ctx.brush.pigmentMix,
    );
    const after = this.renderer.readRect(cel.surface, rect);
    this.renderer.clear(this.renderer.scratch('wet'));

    const label = ctx.brush.erase ? 'Borrar' : 'Trazo';
    this.history.push({
      label,
      cost: before.byteLength + after.byteLength,
      op: layer.swap
        ? undefined
        : {
            type: 'rasterEdit',
            label,
            layerId: layer.id,
            frame: this.storedCelFrame(layer, startFrame, createdFrame),
            createdFrame,
            rect,
            before,
            after,
          },
      redo: () => {
        if (createdFrame >= 0) layer.cels.set(createdFrame, cel);
        this.renderer.writeRect(cel.surface, rect, after);
        this.touch();
      },
      undo: () => {
        this.renderer.writeRect(cel.surface, rect, before);
        if (createdFrame >= 0) layer.cels.delete(createdFrame);
        this.touch();
      },
    });
    this.touch();
  }

  cancelStroke() {
    if (this.createdCelFrame >= 0 && this.strokeLayer) {
      this.strokeLayer.cels.delete(this.createdCelFrame);
    }
    this.builder = null;
    this.strokeCel = null;
    this.strokeCtx = null;
    this.strokeLayer = null;
    this.createdCelFrame = -1;
    this.strokeStartFrame = -1;
    this.predictedStamps = [];
    this.tailStamps = [];
    this.strokeLen = 0;
    this.lastTailPos = null;
    this.renderer.clear(this.renderer.scratch('wet'));
    this.renderer.clear(this.renderer.scratch('predict'));
    this.touch();
  }

  /* ---------------------------------------------------------------- *
   * QuickShape
   * ---------------------------------------------------------------- */

  /** Redibuja `wet` desde cero con el contorno actual de la forma. Barato:
   * son unas pocas decenas de estampas, no el trazo entero. */
  private paintQuickShapeOutline(shape: RecognizedShape, ctx: StrokeContext) {
    const wet = this.renderer.scratch('wet');
    this.renderer.clear(wet);
    const b = ctx.brush;
    const points = sampleShapeOutline(shape, Math.max(0.5, b.size * b.spacing));

    // Estampas a presión plena y sin las variaciones que dependen de datos
    // de puntero reales (jitter, dispersión, inclinación, velocidad): una
    // forma "perfecta" no debe temblar, es justo lo contrario de lo que
    // QuickShape promete.
    const stamps: Stamp[] = [];
    this.strokeRect = emptyRect();
    let last: Vec2 | null = null;
    for (const p of points) {
      const angle = b.followDirection && last ? Math.atan2(p.y - last.y, p.x - last.x) : 0;
      stamps.push({
        x: p.x,
        y: p.y,
        size: b.size,
        angle,
        alpha: clamp(b.flow, 0, 1),
        hardness: b.hardness,
        aspect: clamp(b.aspect, 0.05, 1),
      });
      expandRect(this.strokeRect, p.x, p.y, b.size * 0.75 + 2);
      last = p;
    }
    if (stamps.length > 0) {
      const texId = b.textureId;
      this.renderer.drawStamps(
        wet,
        stamps,
        ctx.color,
        texId ? this.renderer.getBrushTexture(texId, () => this.resolveTexturePixels(texId)) : undefined,
      );
    }
  }

  /**
   * Se llama cuando el lápiz lleva quieto el tiempo de dwell (el
   * temporizador vive en `CanvasView`, que es DOM; ver CLAUDE.md sobre la
   * frontera de `core/`). Si el recorrido bruto del trazo en curso encaja
   * con una forma conocida, la sustituye por su versión geométrica
   * editable; si no reconoce nada, no toca nada y el trazo libre sigue
   * exactamente igual — igual que Procreate.
   *
   * `precision` es el ajuste de la persona que dibuja (ver
   * `quickShapePrecision` en el store); vive fuera del motor porque es
   * preferencia de UI, no estado del documento.
   */
  tryQuickShape(precision = 0.6): boolean {
    if (!this.builder || !this.strokeLayer || !this.strokeCel || !this.strokeCtx) return false;
    const shape = recognizeShape(this.strokeRawPoints, precision);
    if (!shape) return false;

    const layer = this.strokeLayer;
    const cel = this.strokeCel;
    const ctx = this.strokeCtx;
    const createdCelFrame = this.createdCelFrame;
    const startFrame = this.strokeStartFrame;
    const anchor = this.strokeRawPoints[this.strokeRawPoints.length - 1];

    // Apaga el trazo libre: a partir de aquí no le llegan más muestras (lo
    // decide `CanvasView` al ver `pendingQuickShape`), la forma vive sólo
    // como geometría hasta que se hornee.
    this.builder = null;
    this.strokeLayer = null;
    this.strokeCel = null;
    this.strokeCtx = null;
    this.createdCelFrame = -1;
    this.strokeStartFrame = -1;
    this.strokeRawPoints = [];
    this.predictedStamps = [];
    this.renderer.clear(this.renderer.scratch('predict'));

    const nodes = shapeNodes(shape);
    let holdNodeIndex = 0;
    let bestDist = Infinity;
    for (let i = 0; i < nodes.length; i++) {
      const d = Math.hypot(nodes[i].x - anchor.x, nodes[i].y - anchor.y);
      if (d < bestDist) {
        bestDist = d;
        holdNodeIndex = i;
      }
    }

    this.pendingQuickShape = {
      shape,
      layer,
      cel,
      ctx,
      createdCelFrame,
      startFrame,
      editing: false,
      holdNodeIndex,
    };
    this.paintQuickShapeOutline(shape, ctx);
    this.touch();
    return true;
  }

  /**
   * Arrastre mientras el puntero que disparó el reconocimiento sigue
   * apoyado: sigue moviendo el mismo nodo que ya estaba "tocando" cuando
   * se hizo el snap, como una continuación natural del trazo original.
   */
  adjustQuickShape(point: Vec2) {
    const p = this.pendingQuickShape;
    if (!p) return;
    p.shape = updateShapeNode(p.shape, p.holdNodeIndex, point);
    this.paintQuickShapeOutline(p.shape, p.ctx);
    this.touch(false);
  }

  /** Arrastre de un nodo concreto del overlay de edición (tras soltar). */
  dragQuickShapeNode(index: number, point: Vec2) {
    const p = this.pendingQuickShape;
    if (!p) return;
    p.shape = updateShapeNode(p.shape, index, point);
    this.paintQuickShapeOutline(p.shape, p.ctx);
    this.touch(false);
  }

  /** El "segundo dedo" de Procreate: fuerza proporción exacta. */
  forceQuickShapeProportion() {
    const p = this.pendingQuickShape;
    if (!p) return;
    p.shape = forceProportion(p.shape);
    this.paintQuickShapeOutline(p.shape, p.ctx);
    this.touch(false);
  }

  /**
   * Rotación absoluta en incrementos de 15°, para el gesto de dos dedos —
   * `rotation` es el ángulo ya calculado por la UI (arranque + delta del
   * gesto), no un incremento a sumar, igual que `updateFloating`. Sólo las
   * formas con un único campo `rotation` propio lo soportan; triángulo y
   * línea se rotan arrastrando un vértice/extremo, no tienen este gesto.
   */
  rotateQuickShapeSnapped(rotation: number) {
    const p = this.pendingQuickShape;
    if (!p) return;
    const snapped = snapAngle(rotation, Math.PI / 12);
    switch (p.shape.kind) {
      case 'ellipse':
      case 'rect':
      case 'polygon':
        p.shape = { ...p.shape, rotation: snapped };
        break;
      default:
        return;
    }
    this.paintQuickShapeOutline(p.shape, p.ctx);
    this.touch(false);
  }

  /**
   * El puntero que reconoció la forma se soltó: en vez de hornear directo,
   * pasa al modo "Edit Shape" con nodos arrastrables — hornear ocurre sólo
   * al confirmar (`commitQuickShape`) o al empezar otra acción.
   */
  finishQuickShapeHold() {
    if (!this.pendingQuickShape) return;
    this.pendingQuickShape.editing = true;
    this.touch(false);
  }

  /** Mismo patrón exacto que el horneado final de `endStroke()`. */
  commitQuickShape() {
    const p = this.pendingQuickShape;
    if (!p) return;
    this.pendingQuickShape = null;

    const wet = this.renderer.scratch('wet');
    const rect = clampRect(this.strokeRect, this.doc.width, this.doc.height);
    if (rectIsEmpty(rect)) {
      if (p.createdCelFrame >= 0) p.layer.cels.delete(p.createdCelFrame);
      this.renderer.clear(wet);
      this.touch();
      return;
    }

    const before = this.renderer.readRect(p.cel.surface, rect);
    this.mergeStroke(p.cel.surface, wet, p.ctx.brush.opacity, p.ctx.brush.erase, p.layer, p.ctx.brush.pigmentMix);
    const after = this.renderer.readRect(p.cel.surface, rect);
    this.renderer.clear(wet);

    const layer = p.layer;
    const cel = p.cel;
    const createdCelFrame = p.createdCelFrame;
    const label = p.ctx.brush.erase ? 'Borrar' : 'Forma';
    this.history.push({
      label,
      cost: before.byteLength + after.byteLength,
      op: layer.swap
        ? undefined
        : {
            type: 'rasterEdit',
            label,
            layerId: layer.id,
            frame: this.storedCelFrame(layer, p.startFrame, createdCelFrame),
            createdFrame: createdCelFrame,
            rect,
            before,
            after,
          },
      redo: () => {
        if (createdCelFrame >= 0) layer.cels.set(createdCelFrame, cel);
        this.renderer.writeRect(cel.surface, rect, after);
        this.touch();
      },
      undo: () => {
        this.renderer.writeRect(cel.surface, rect, before);
        if (createdCelFrame >= 0) layer.cels.delete(createdCelFrame);
        this.touch();
      },
    });
    this.touch();
  }

  cancelQuickShape() {
    const p = this.pendingQuickShape;
    if (!p) return;
    if (p.createdCelFrame >= 0) p.layer.cels.delete(p.createdCelFrame);
    this.pendingQuickShape = null;
    this.renderer.clear(this.renderer.scratch('wet'));
    this.touch();
  }

  /* ---------------------------------------------------------------- *
   * Reproducción
   * ---------------------------------------------------------------- */

  setFrame(frame: number) {
    const f = clampFrame(this.doc, frame);
    if (f === this.currentFrame) return;
    if (this.builder) this.endStroke();
    if (this.pendingQuickShape) this.commitQuickShape();
    this.currentFrame = f;
    this.touch();
  }

  stepFrame(delta: number) {
    this.setFrame(this.currentFrame + delta);
  }

  /** Salta al inicio del cel anterior/siguiente de la capa activa. */
  stepCel(delta: number) {
    const layer = this.activeLayer;
    if (!layer) return this.stepFrame(delta);
    const frames = sortedCelFrames(layer);
    if (frames.length === 0) return this.stepFrame(delta);
    const current = celStartFrame(layer, this.currentFrame);
    const i = frames.indexOf(current);
    const target = frames[clamp(i + delta, 0, frames.length - 1)];
    this.setFrame(target ?? this.currentFrame);
  }

  /* ---------------------------------------------------------------- *
   * Audio
   * ---------------------------------------------------------------- */

  /** Sustituye el elemento `<audio>` en marcha por uno nuevo — usado tanto
   *  al importar un archivo como al reabrir un proyecto guardado. No toca
   *  `doc.audio`: el llamador decide esos metadatos aparte. */
  private loadAudioBytes(bytes: Uint8Array, mimeType: string) {
    this.releaseAudioElement();
    const blob = new Blob([bytes as BlobPart], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const el = document.createElement('audio');
    el.src = url;
    el.preload = 'auto';
    this.audioElement = el;
    this.audioBytes = bytes;
    this.audioObjectUrl = url;
  }

  private releaseAudioElement() {
    this.audioElement?.pause();
    this.audioElement = null;
    this.audioBytes = null;
    if (this.audioObjectUrl) {
      URL.revokeObjectURL(this.audioObjectUrl);
      this.audioObjectUrl = null;
    }
  }

  /**
   * Importa una pista de audio nueva — `bytes`/`mimeType`/`duration`/`peaks`
   * ya vienen calculados por `importAudioTrack` (io.ts), que es quien sabe
   * decodificar el archivo; aquí sólo se engancha el resultado. No pasa por
   * el historial: es adjuntar un archivo externo, no una edición de dibujo,
   * mismo criterio que `beginReferenceImport`.
   */
  setAudioTrack(bytes: Uint8Array, mimeType: string, name: string, duration: number, peaks: AudioPeak[]) {
    this.loadAudioBytes(bytes, mimeType);
    this.doc.audio = { id: uid('audio'), name, duration, mimeType, peaks, offset: 0, muted: false };
    this.touch();
  }

  /** Reengancha el elemento reproductor al reabrir un proyecto — los
   *  metadatos (`doc.audio`) ya vienen normalizados por `deserializeProject`,
   *  aquí sólo hace falta el archivo real para poder reproducirlo. */
  attachAudioBytes(bytes: Uint8Array, mimeType: string) {
    this.loadAudioBytes(bytes, mimeType);
  }

  removeAudio() {
    this.releaseAudioElement();
    this.doc.audio = undefined;
    this.touch();
  }

  setAudioOffset(seconds: number) {
    if (!this.doc.audio) return;
    this.doc.audio.offset = seconds;
    this.touch(false);
  }

  setAudioMuted(muted: boolean) {
    if (!this.doc.audio) return;
    this.doc.audio.muted = muted;
    if (muted) this.audioElement?.pause();
    else if (this.playing) this.playAudioTrack();
    this.touch(false);
  }

  togglePlay() {
    this.playing = !this.playing;
    this.playClock = performance.now();
    if (this.playing) this.playAudioTrack();
    else this.audioElement?.pause();
    this.touch(false);
  }

  /** Coloca el audio en el punto que le corresponde a `currentFrame` y lo
   *  arranca — llamado al empezar a reproducir y al dar la vuelta del bucle. */
  private playAudioTrack() {
    const el = this.audioElement;
    const audio = this.doc.audio;
    if (!el || !audio || audio.muted) return;
    const t = this.currentFrame / this.doc.fps + audio.offset;
    if (t < 0 || t >= audio.duration) {
      el.pause();
      return;
    }
    el.currentTime = t;
    // Los navegadores pueden rechazar `play()` (política de autoplay) si no
    // hubo antes un gesto del usuario; el play/pausa del propio botón de
    // reproducción ya cuenta como uno, pero por si acaso no se deja una
    // promesa sin capturar rechazada en la consola.
    el.play().catch(() => {});
  }

  setFrameCount(n: number) {
    const before = this.doc.frameCount;
    const value = Math.max(1, Math.round(n));
    if (value === before) return;
    this.history.run({
      label: 'Duración',
      redo: () => {
        this.doc.frameCount = value;
        this.currentFrame = clampFrame(this.doc, this.currentFrame);
        this.touch();
      },
      undo: () => {
        this.doc.frameCount = before;
        this.currentFrame = clampFrame(this.doc, this.currentFrame);
        this.touch();
      },
    });
  }

  private startLoop() {
    const tick = (now: number) => {
      this.rafId = requestAnimationFrame(tick);
      if (this.playing) {
        const dt = now - this.playClock;
        const step = 1000 / this.doc.fps;
        if (dt >= step) {
          const advance = Math.floor(dt / step);
          this.playClock += advance * step;
          let next = this.currentFrame + advance;
          if (next >= this.doc.frameCount) {
            if (this.loop) {
              next %= this.doc.frameCount;
              this.currentFrame = next;
              this.playAudioTrack();
            } else {
              next = this.doc.frameCount - 1;
              this.playing = false;
              this.audioElement?.pause();
              this.currentFrame = next;
            }
          } else {
            this.currentFrame = next;
          }
          this.belowCacheKey = '';
          this.renderQueued = true;
          for (const fn of this.listeners) fn();
        }
      }
      if (this.renderQueued) {
        this.renderQueued = false;
        this.render();
      }
    };
    this.rafId = requestAnimationFrame(tick);
  }

  dispose() {
    cancelAnimationFrame(this.rafId);
    this.listeners.clear();
    this.releaseAudioElement();
  }

  requestRender() {
    this.renderQueued = true;
  }

  /* ---------------------------------------------------------------- *
   * Composición
   * ---------------------------------------------------------------- */

  /**
   * Deja la capa lista para componer: aplica la tinta húmeda si es la capa que
   * se está dibujando y su transformación animada si no es la identidad.
   */
  private rasterizeLayer(layer: Layer, frame: number, includeWet: boolean): Surface | null {
    // Un nodo de intercambio de sprites saca su superficie del catálogo de
    // variantes en vez de `cels` — todo lo demás (trazo húmedo, transform,
    // rig, composición) sigue viendo "una superficie del tamaño del
    // documento", así que no hace falta ramificar el resto de la función.
    const cel = layer.swap ? pickVariant(layer, frame) : celAt(layer, frame);
    // Con la máscara de esta capa en edición, el trazo/QuickShape en curso
    // pinta sobre ELLA (ver `resolveStrokeCel`), no sobre el cel — así que
    // no cuenta como "objetivo del cel" de cara al bloque `wetCtx` de abajo;
    // tiene su propio bloque más adelante, junto a la aplicación de la
    // máscara.
    const isMaskWetTarget =
      includeWet &&
      this.strokeTargetsMask &&
      ((this.builder !== null && this.strokeLayer?.id === layer.id) ||
        (this.pendingQuickShape !== null && this.pendingQuickShape.layer.id === layer.id));
    const isStrokeTarget =
      includeWet && this.builder !== null && this.strokeLayer?.id === layer.id && !isMaskWetTarget;
    // Mientras hay una forma QuickShape pendiente, `wet` guarda su contorno
    // en vez de un trazo libre — mismo mecanismo de composición en vivo,
    // sólo cambia qué lo alimenta (ver `paintQuickShapeOutline`).
    const isQuickShapeTarget =
      includeWet &&
      this.pendingQuickShape !== null &&
      this.pendingQuickShape.layer.id === layer.id &&
      !isMaskWetTarget;
    // Un flotante puede llevar varios cels a la vez (transformación por
    // lote — `liftSelectionRange`): sólo se superpone el que corresponde al
    // cel realmente visible en `frame`, no el primero de la lista, porque
    // esta misma función se llama también para los fotogramas del papel
    // cebolla, con `includeWet` en false.
    const floatingCel =
      includeWet && this.floating && this.floating.layerId === layer.id
        ? (this.floating.cels.find(
            (c) => c.celFrame === (layer.swap ? -1 : celStartFrame(layer, frame)),
          ) ?? null)
        : null;
    const hasFloating = floatingCel !== null;
    if (!cel && !isStrokeTarget && !isQuickShapeTarget && !hasFloating) return null;

    let src = cel ? this.renderer.ensureResident(cel.surface) : null;

    const wetCtx = isStrokeTarget
      ? this.strokeCtx
      : this.pendingQuickShape && isQuickShapeTarget
        ? this.pendingQuickShape.ctx
        : null;
    if (wetCtx) {
      const combined = this.renderer.scratch('xf1');
      if (src) this.renderer.copy(combined, src, 1);
      else this.renderer.clear(combined);
      const erase = wetCtx.brush.erase;
      const mask = this.clipMask;
      this.renderer.drawOver(
        combined,
        this.renderer.scratch('wet'),
        wetCtx.brush.opacity,
        undefined,
        erase,
        mask,
      );
      if (isStrokeTarget && this.tailStamps.length > 0) {
        // Cola de afinado de cierre: no está quemada en `wet` todavía porque
        // su escala definitiva depende de dónde termine cayendo la punta
        // viva, así que se recalcula contra `this.strokeLen` actual en cada
        // fotograma — mismo mecanismo que la especulación de abajo, sólo que
        // aquí las estampas ya son reales, no extrapoladas.
        const tail = this.renderer.scratch('tail');
        this.renderer.clear(tail);
        const texId = wetCtx.brush.textureId;
        const scaled = this.tailStamps.map(({ stamp, dist }) => {
          const ratio = taperScale(this.strokeLen - dist, wetCtx.brush);
          return ratio >= 1 ? stamp : { ...stamp, size: stamp.size * ratio };
        });
        this.renderer.drawStamps(
          tail,
          [...scaled, ...this.mirrorStamps(scaled)],
          wetCtx.color,
          texId ? this.renderer.getBrushTexture(texId, () => this.resolveTexturePixels(texId)) : undefined,
        );
        this.renderer.drawOver(combined, tail, wetCtx.brush.opacity, undefined, erase, mask);
      }
      if (isStrokeTarget && this.predictedStamps.length > 0) {
        const predict = this.renderer.scratch('predict');
        this.renderer.clear(predict);
        const texId = wetCtx.brush.textureId;
        this.renderer.drawStamps(
          predict,
          this.predictedStamps,
          wetCtx.color,
          texId ? this.renderer.getBrushTexture(texId, () => this.resolveTexturePixels(texId)) : undefined,
        );
        this.renderer.drawOver(
          combined,
          predict,
          wetCtx.brush.opacity,
          undefined,
          erase,
          mask,
        );
      }
      src = combined;
    }

    if (floatingCel && this.floating) {
      const combined = this.renderer.scratch('xf1');
      if (src && src !== combined) this.renderer.copy(combined, src, 1);
      else if (!src) this.renderer.clear(combined);
      this.renderer.drawOver(
        combined,
        floatingCel.surface,
        1,
        this.floatingMatrixFor(this.floating),
      );
      src = combined;
    }

    if (!src) return null;

    // Máscara de capa: se aplica en espacio LOCAL (antes de rig/transform)
    // para que se mueva con la capa, no fija al documento. Si su edición
    // está en marcha, no se lee `layer.mask.surface` tal cual — se copia a
    // un scratch y se le funde encima el `wet`/cola/especulación en curso,
    // igual que el bloque de arriba hace con el cel, para que la vista
    // previa se vea sin esperar a soltar el dedo.
    if (layer.mask) {
      let maskSurface: Surface = layer.mask.surface;
      if (isMaskWetTarget) {
        const isFreehand = this.builder !== null && this.strokeLayer?.id === layer.id;
        const maskCtx = isFreehand ? this.strokeCtx! : this.pendingQuickShape!.ctx;
        const erase = maskCtx.brush.erase;
        const liveMask = this.renderer.scratch('lmask');
        this.renderer.copy(liveMask, layer.mask.surface, 1);
        this.renderer.drawOver(liveMask, this.renderer.scratch('wet'), maskCtx.brush.opacity, undefined, erase);
        if (isFreehand && this.tailStamps.length > 0) {
          const tail = this.renderer.scratch('tail');
          this.renderer.clear(tail);
          const texId = maskCtx.brush.textureId;
          const scaled = this.tailStamps.map(({ stamp, dist }) => {
            const ratio = taperScale(this.strokeLen - dist, maskCtx.brush);
            return ratio >= 1 ? stamp : { ...stamp, size: stamp.size * ratio };
          });
          this.renderer.drawStamps(
            tail,
            [...scaled, ...this.mirrorStamps(scaled)],
            maskCtx.color,
            texId ? this.renderer.getBrushTexture(texId, () => this.resolveTexturePixels(texId)) : undefined,
          );
          this.renderer.drawOver(liveMask, tail, maskCtx.brush.opacity, undefined, erase);
        }
        if (isFreehand && this.predictedStamps.length > 0) {
          const predict = this.renderer.scratch('predict');
          this.renderer.clear(predict);
          const texId = maskCtx.brush.textureId;
          this.renderer.drawStamps(
            predict,
            this.predictedStamps,
            maskCtx.color,
            texId ? this.renderer.getBrushTexture(texId, () => this.resolveTexturePixels(texId)) : undefined,
          );
          this.renderer.drawOver(liveMask, predict, maskCtx.brush.opacity, undefined, erase);
        }
        maskSurface = liveMask;
      }
      const masked = this.renderer.scratch('lmaskout');
      this.renderer.clear(masked);
      this.renderer.drawOver(masked, src, 1, undefined, false, maskSurface);
      src = masked;
    }

    // Una capa riggeada sigue a su rig en vez de su propio TransformTrack:
    // son dos formas de mover la misma capa que no tiene sentido combinar.
    // La malla (si la hay) sustituye al transform rígido por hueso — no se
    // combinan los dos caminos para una misma capa.
    if (layer.rig?.meshId) {
      const skel = this.doc.skeletons.find((s) => s.id === layer.rig!.skeletonId);
      const mesh = this.doc.meshes.find((m) => m.id === layer.rig!.meshId);
      if (skel && mesh) {
        const skin = evaluateSkinMatrices(skel, frame);
        // MeshVertex.boneIndices son posiciones en skel.bones, no ids: hay
        // que subir las matrices en ese mismo orden para poder indexarlas
        // con un entero en el shader.
        const boneMats = skel.bones.map((b) => skin.get(b.id) ?? mat3Identity());
        const out = this.renderer.scratch('xf2');
        this.renderer.clear(out);
        this.renderer.drawSkinned(out, src, mesh, boneMats);
        return out;
      }
    }
    if (layer.rig?.boneId) {
      const skel = this.doc.skeletons.find((s) => s.id === layer.rig!.skeletonId);
      if (skel) {
        // `drawOver` espera una matriz "quad unidad -> destino" (por eso el
        // resto del motor multiplica por doc.width/doc.height antes de
        // pasarla) — la matriz de piel opera en píxeles de documento, así
        // que hay que anteponerle ese mismo paso quad->documento.
        const skin = boneRigidMatrix(skel, layer.rig.boneId, frame);
        const unitToDoc = mat3FromTRS(0, 0, 0, this.doc.width, this.doc.height);
        const m = mat3Multiply(skin, unitToDoc);
        const out = this.renderer.scratch('xf2');
        this.renderer.clear(out);
        this.renderer.drawOver(out, src, 1, m);
        return out;
      }
    }

    if (transformIsIdentity(layer.transform, frame)) return src;

    const tx = sampleChannel(layer.transform.x, frame);
    const ty = sampleChannel(layer.transform.y, frame);
    const scale = sampleChannel(layer.transform.scale, frame);
    const rot = sampleChannel(layer.transform.rotation, frame);

    const cx = this.doc.width / 2;
    const cy = this.doc.height / 2;
    const c = Math.cos(rot) * scale;
    const s = Math.sin(rot) * scale;
    // Quad unidad -> documento, escalando y rotando alrededor del centro.
    const m: Mat3 = new Float32Array([
      this.doc.width * c,
      this.doc.width * s,
      0,
      -this.doc.height * s,
      this.doc.height * c,
      0,
      tx + cx - (c * cx - s * cy),
      ty + cy - (s * cx + c * cy),
      1,
    ]);
    const out = this.renderer.scratch('xf2');
    this.renderer.clear(out);
    this.renderer.drawOver(out, src, 1, m);
    return out;
  }

  /**
   * Compone los grupos `[from, to)` de la pila. Si no se pasa `startAcc`
   * arranca de un lienzo limpio con el papel del documento.
   *
   * `ping` nombra el par de superficies de intercambio: el pase de onion skin
   * usa uno distinto del pase principal porque ambos están vivos a la vez.
   */
  private compositeGroups(opts: {
    frame: number;
    ping: [string, string];
    includeWet: boolean;
    from?: number;
    to?: number;
    startAcc?: Surface;
    /** Omite el papel: el fantasma del onion skin sólo debe llevar el dibujo. */
    transparent?: boolean;
    /** Deja fuera las capas de referencia — salvo las que se marcaron
     *  explícitamente para exportar (`Layer.includeInExport`): son la
     *  excepción a "no son parte de la obra final". */
    excludeReference?: boolean;
  }): Surface {
    const r = this.renderer;
    const { frame, ping, includeWet } = opts;
    const layers = opts.excludeReference
      ? this.doc.layers.filter((l) => l.kind !== 'reference' || l.includeInExport)
      : this.doc.layers;
    const groups = buildClipGroups(layers);
    const from = opts.from ?? 0;
    const to = Math.min(opts.to ?? groups.length, groups.length);

    let acc = opts.startAcc ?? r.scratch(ping[0]);
    let other = acc === r.scratch(ping[0]) ? r.scratch(ping[1]) : r.scratch(ping[0]);

    if (!opts.startAcc) {
      if (this.doc.paperAlpha > 0 && !opts.transparent) {
        r.fill(acc, this.doc.paper, this.doc.paperAlpha);
      } else {
        r.clear(acc);
      }
    }

    for (let gi = from; gi < to; gi++) {
      const { base, clipped } = groups[gi];
      if (!base.visible) continue;

      // Una capa de ajuste no tiene dibujo propio: transforma TODO lo
      // compuesto hasta aquí (`acc`) en vez de aportar contenido nuevo. Se
      // resuelve en dos pasos — calcular el resultado ajustado aparte y
      // fundirlo con `composite()` normal contra el propio `acc` — para que
      // la opacidad de la capa siga funcionando igual que en cualquier
      // otra, sin un shader de blending distinto sólo para esto.
      if (base.kind === 'adjustment' && base.adjustment) {
        const adjusted = r.scratch('adjTmp');
        r.applyAdjustment(adjusted, acc, base.adjustment);
        r.composite(other, acc, adjusted, {
          opacity: base.opacity * sampleChannel(base.transform.opacity, frame),
          blend: BLEND_INDEX[base.blend],
        });
        [acc, other] = [other, acc];
        continue;
      }

      const baseSurface = this.rasterizeLayer(base, frame, includeWet);
      const visibleClipped = clipped.filter((l) => l.visible);
      if (!baseSurface && visibleClipped.length === 0) continue;

      let source: Surface;
      if (visibleClipped.length === 0 && baseSurface) {
        source = baseSurface;
      } else {
        // Las capas recortadas se resuelven contra la base en su propio par
        // de superficies antes de que el grupo entero toque el acumulador.
        let g = r.scratch('grpA');
        let g2 = r.scratch('grpB');
        if (baseSurface) r.copy(g, baseSurface, 1);
        else r.clear(g);
        for (const child of visibleClipped) {
          const cs = this.rasterizeLayer(child, frame, includeWet);
          if (!cs) continue;
          r.composite(g2, g, cs, {
            opacity: child.opacity * sampleChannel(child.transform.opacity, frame),
            blend: BLEND_INDEX[child.blend],
            clip: true,
          });
          [g, g2] = [g2, g];
        }
        source = g;
      }

      r.composite(other, acc, source, {
        opacity: base.opacity * sampleChannel(base.transform.opacity, frame),
        blend: BLEND_INDEX[base.blend],
      });
      [acc, other] = [other, acc];
    }
    return acc;
  }

  private compositeFrame(): Surface {
    const r = this.renderer;
    const frame = this.currentFrame;
    const groups = buildClipGroups(this.doc.layers);

    // El grupo que contiene la capa activa marca la frontera de la caché:
    // todo lo de debajo no cambia mientras se dibuja.
    let activeGroup = groups.length;
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      if (g.base.id === this.activeLayerId || g.clipped.some((l) => l.id === this.activeLayerId)) {
        activeGroup = i;
        break;
      }
    }

    const key = `${frame}|${activeGroup}|${this.revision}|${this.onion.enabled}|${this.onion.before}|${this.onion.after}|${this.onion.opacity}|${this.onion.colored}`;
    const below = r.scratch('below');

    if (this.belowCacheKey !== key) {
      let acc = r.scratch('p0');
      if (this.doc.paperAlpha > 0) r.fill(acc, this.doc.paper, this.doc.paperAlpha);
      else r.clear(acc);

      if (this.onion.enabled) {
        acc = this.drawOnionSkins(acc, frame);
      }

      const result = this.compositeGroups({
        frame,
        ping: ['p0', 'p1'],
        includeWet: false,
        to: activeGroup,
        startAcc: acc,
      });
      r.copy(below, result, 1);
      this.belowCacheKey = key;
    }

    // Desde la caché hacia arriba recomponemos: aquí sí entra la tinta húmeda.
    const start = r.scratch('p0');
    r.copy(start, below, 1);
    return this.compositeGroups({
      frame,
      ping: ['p0', 'p1'],
      includeWet: true,
      from: activeGroup,
      startAcc: start,
    });
  }

  private drawOnionSkins(acc: Surface, frame: number): Surface {
    const r = this.renderer;
    const offsets: number[] = [];
    for (let i = Math.min(this.onion.before, MAX_ONION); i >= 1; i--) offsets.push(-i);
    for (let i = 1; i <= Math.min(this.onion.after, MAX_ONION); i++) offsets.push(i);

    let current = acc;
    let other = current === r.scratch('p0') ? r.scratch('p1') : r.scratch('p0');

    for (const off of offsets) {
      const f = frame + off;
      if (f < 0 || f >= this.doc.frameCount) continue;
      // Se dibuja sobre un lienzo aparte para poder teñir el resultado entero.
      const ghost = this.compositeGroups({
        frame: f,
        ping: ['o0', 'o1'],
        includeWet: false,
        transparent: true,
      });
      // El cuadro contiguo se muestra a la intensidad que pide el usuario;
      // los más lejanos se desvanecen. Sin esto, "35%" nunca daba 35%.
      const falloff = 1 / Math.abs(off);
      const tint: [number, number, number, number] = this.onion.colored
        ? off < 0
          ? [1, 0.25, 0.3, 0.85]
          : [0.25, 0.75, 1, 0.85]
        : [0, 0, 0, 0];
      r.composite(other, current, ghost, {
        opacity: this.onion.opacity * falloff,
        blend: BLEND_INDEX.normal,
        tint,
      });
      const tmp = current;
      current = other;
      other = tmp;
    }
    return current;
  }

  render() {
    const r = this.renderer;
    const canvas = r.canvas;
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const w = Math.round(this.cssWidth * dpr);
    const h = Math.round(this.cssHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }

    const result = this.compositeFrame();
    const checker = Math.max(6, 16 / this.view.zoom);
    const matrix = this.viewMatrix();
    r.present(result, matrix, this.doc.paper, this.doc.paperAlpha, checker);

    if (this.selection.active && !this.floating) {
      r.drawSelectionOutline(
        this.selectionMask,
        matrix,
        this.view.zoom,
        performance.now() / 1000,
      );
      // El contorno se mueve solo, así que hay que seguir pidiendo cuadros.
      this.requestRender();
    }

    for (const fn of this.afterRenderListeners) fn();
  }

  /* ---------------------------------------------------------------- *
   * Selección
   * ---------------------------------------------------------------- */

  /** Máscara de selección: alfa = cobertura, en resolución de documento. */
  get selectionMask(): Surface {
    return this.renderer.scratch('selmask');
  }

  /** Máscara a pasar a las operaciones de dibujo, o null si no hay selección. */
  private get clipMask(): Surface | null {
    return this.selection.active ? this.selectionMask : null;
  }

  /** Copia el alfa actual de `cel` a un scratch aparte: es la máscara del
   *  bloqueo de alfa (sólo pintar donde ya había algo). No puede ser el
   *  propio `cel.surface` porque `drawOver` lo usaría a la vez como
   *  destino y como fuente de la máscara en la misma pasada — prohibido en
   *  WebGL2, igual que el resto de invariantes de `composite()`. */
  private alphaLockMask(cel: Surface): Surface {
    const snap = this.renderer.scratch('alock');
    this.renderer.clear(snap);
    this.renderer.drawOver(snap, cel, 1);
    return snap;
  }

  /**
   * Funde `src` sobre `cel.surface` respetando la selección activa y el
   * bloqueo de alfa de `layer` a la vez si hace falta. `drawOver` sólo
   * admite una máscara por pasada, así que cuando las dos aplican a la vez
   * se resuelve con dos pasadas encadenadas — recorta `src` a la selección
   * sobre un scratch limpio primero, y ese resultado es el que se funde de
   * verdad usando el bloqueo de alfa como máscara — en vez de un shader
   * nuevo sólo para multiplicar dos máscaras. Sin ninguna de las dos
   * activa (el caso normal), es exactamente el `drawOver` de siempre.
   *
   * Con `pigmentMix > 0` (y sin borrar — borrar no tiene "color" que
   * mezclar) el fundido final pasa por `mixOver` en vez de `drawOver`: hace
   * falta una copia de `dst` en un scratch aparte porque `MIX_FS` lee el
   * color de debajo en el propio shader, no vía el blend fijo de la GPU
   * (ver `Renderer.mixOver`) — WebGL2 no deja leer y escribir la misma
   * textura en un pase, la misma razón por la que `composite()` pide tres
   * superficies.
   */
  private mergeStroke(
    dst: Surface,
    src: Surface,
    opacity: number,
    erase: boolean,
    layer: Layer,
    pigmentMix = 0,
  ) {
    const selMask = this.clipMask;
    const lockMask = layer.alphaLock ? this.alphaLockMask(dst) : null;

    let finalSrc = src;
    let finalMask = selMask ?? lockMask;
    if (selMask && lockMask) {
      const pre = this.renderer.scratch('paintmask');
      this.renderer.clear(pre);
      this.renderer.drawOver(pre, src, 1, undefined, false, selMask);
      finalSrc = pre;
      finalMask = lockMask;
    }

    if (!erase && pigmentMix > 0) {
      let mixSrc = finalSrc;
      if (finalMask) {
        const masked = this.renderer.scratch('mixMasked');
        this.renderer.clear(masked);
        this.renderer.drawOver(masked, finalSrc, 1, undefined, false, finalMask);
        mixSrc = masked;
      }
      const backdrop = this.renderer.scratch('mixBackdrop');
      this.renderer.copy(backdrop, dst, 1);
      this.renderer.mixOver(dst, backdrop, mixSrc, { opacity, pigmentMix });
      return;
    }

    this.renderer.drawOver(dst, finalSrc, opacity, undefined, erase, finalMask);
  }

  private selectionSurfaceCanvas(): HTMLCanvasElement {
    if (
      !this.selectionCanvas ||
      this.selectionCanvas.width !== this.doc.width ||
      this.selectionCanvas.height !== this.doc.height
    ) {
      this.selectionCanvas = document.createElement('canvas');
      this.selectionCanvas.width = this.doc.width;
      this.selectionCanvas.height = this.doc.height;
    }
    return this.selectionCanvas;
  }

  /** Limpia la máscara de GPU y la resube desde el canvas 2D — el paso que
   *  comparten `commitSelectionCanvas` y cualquier atajo que ya conozca los
   *  límites de sobra y no necesite escanear nada. */
  private uploadSelectionMask() {
    const mask = this.selectionMask;
    this.renderer.clear(mask);
    this.renderer.uploadImage(mask, this.selectionSurfaceCanvas());
  }

  /**
   * Sube la máscara rasterizada a GPU y recalcula sus límites reales.
   *
   * `scanRect`, si se da, acota dónde puede haber cambiado algo: componer
   * con replace/add/subtract sólo puede tocar píxeles dentro de la forma
   * nueva o, como mucho, dentro de la unión con lo que ya hubiera
   * seleccionado antes — nunca más allá. Escanear sólo esa caja en vez del
   * documento entero es la diferencia entre recorrer unos cientos de miles
   * de píxeles y varios millones en un lienzo grande, y no es una
   * aproximación: da exactamente el mismo resultado porque fuera de esa
   * caja no hay nada que pueda haber cambiado. Sin `scanRect` (invertir
   * selección, que sí puede tocar cualquier píxel) se escanea todo.
   */
  private commitSelectionCanvas(scanRect?: Rect) {
    const canvas = this.selectionSurfaceCanvas();
    this.uploadSelectionMask();

    const region = scanRect
      ? clampRect(scanRect, canvas.width, canvas.height)
      : { x: 0, y: 0, x2: canvas.width, y2: canvas.height };
    const rw = region.x2 - region.x;
    const rh = region.y2 - region.y;

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    if (rw > 0 && rh > 0) {
      const data = canvas.getContext('2d')!.getImageData(region.x, region.y, rw, rh).data;
      for (let y = 0; y < rh; y++) {
        const row = y * rw;
        for (let x = 0; x < rw; x++) {
          if (data[(row + x) * 4 + 3] > 8) {
            const docX = region.x + x;
            const docY = region.y + y;
            if (docX < minX) minX = docX;
            if (docX > maxX) maxX = docX;
            if (docY < minY) minY = docY;
            if (docY > maxY) maxY = docY;
          }
        }
      }
    }

    if (minX > maxX) {
      this.selection = { active: false, bounds: emptyRect() };
    } else {
      this.selection = {
        active: true,
        bounds: { x: minX, y: minY, x2: maxX + 1, y2: maxY + 1 },
      };
    }
    this.touch();
  }

  /**
   * Guarda la máscara antes de empezar a arrastrar.
   *
   * Sin esto, sumar o restar área acumularía la forma en cada movimiento del
   * dedo en vez de mostrar el resultado de un único gesto.
   */
  beginSelectionDrag() {
    if (this.floating) this.commitFloating();
    if (this.pendingQuickShape) this.commitQuickShape();
    const src = this.selectionSurfaceCanvas();
    if (
      !this.selectionBackup ||
      this.selectionBackup.width !== src.width ||
      this.selectionBackup.height !== src.height
    ) {
      this.selectionBackup = document.createElement('canvas');
      this.selectionBackup.width = src.width;
      this.selectionBackup.height = src.height;
    }
    const ctx = this.selectionBackup.getContext('2d')!;
    ctx.clearRect(0, 0, src.width, src.height);
    ctx.drawImage(src, 0, 0);
    this.selectionBackupBounds = this.selection.active ? this.selection.bounds : emptyRect();
  }

  private restoreSelectionBackup() {
    const canvas = this.selectionSurfaceCanvas();
    const ctx = canvas.getContext('2d')!;
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (this.selectionBackup) ctx.drawImage(this.selectionBackup, 0, 0);
  }

  /**
   * Vista previa mientras se arrastra. Usa los límites del gesto en vez de
   * escanear la máscara: el escaneo cuesta un recorrido del documento entero
   * y aquí sólo hace falta al soltar.
   */
  previewSelectionShape(shape: SelectionShape, points: Vec2[], mode: SelectionMode) {
    if (points.length === 0) return;
    this.restoreSelectionBackup();
    rasterizeSelection(this.selectionSurfaceCanvas(), shape, points, mode);
    const mask = this.selectionMask;
    this.renderer.clear(mask);
    this.renderer.uploadImage(mask, this.selectionSurfaceCanvas());
    this.selection = {
      active: true,
      bounds: shapeBounds(shape, points, this.doc.width, this.doc.height),
    };
    this.touch(false);
  }

  /** Cierra el gesto y calcula los límites reales de la máscara. */
  applySelectionShape(shape: SelectionShape, points: Vec2[], mode: SelectionMode) {
    if (points.length === 0) return;
    this.restoreSelectionBackup();
    rasterizeSelection(this.selectionSurfaceCanvas(), shape, points, mode);
    const newBounds = shapeBounds(shape, points, this.doc.width, this.doc.height);
    // "replace" empieza limpiando el canvas: todo lo de fuera de la forma
    // nueva ya es transparente, así que no hace falta la unión con lo
    // anterior. add/subtract sí pueden dejar contenido fuera de la forma
    // nueva (lo que ya hubiera antes), de ahí la unión.
    const scanRect = mode === 'replace' ? newBounds : unionRect(this.selectionBackupBounds, newBounds);
    this.commitSelectionCanvas(scanRect);
  }

  /**
   * Arranca (o retoma) un lazo estilo Procreate: a diferencia de
   * `beginSelectionDrag`, sobrevive a que el dedo se levante — el estado no
   * puede vivir en un ref de React porque muere en el primer `pointerup`.
   * Idempotente a propósito: `CanvasView` llama esto en cada toque nuevo del
   * gesto sin comprobar antes si ya hay uno en marcha, igual que
   * `beginBoneDrag`/`beginStroke` asumen su propio guardado de estado.
   */
  beginLasso(mode: SelectionMode) {
    if (this.pendingLasso) return;
    this.beginSelectionDrag();
    this.pendingLasso = { points: [], mode };
  }

  /** Punto de un tramo en mano alzada — filtra por distancia, igual que el
   *  lazo de un solo gesto de antes, para no rasterizar en cada píxel. */
  lassoAddPoint(point: Vec2) {
    const pending = this.pendingLasso;
    if (!pending) return;
    const last = pending.points[pending.points.length - 1];
    if (last && Math.hypot(point.x - last.x, point.y - last.y) <= 1.5) return;
    pending.points.push(point);
    this.previewSelectionShape('lasso', pending.points, pending.mode);
  }

  /** Vértice de un toque suelto (modo polígono) — siempre se añade, sin
   *  filtro de distancia: un toque quieto debe dejar esquina igualmente. */
  lassoAddVertex(point: Vec2) {
    const pending = this.pendingLasso;
    if (!pending) return;
    pending.points.push(point);
    this.previewSelectionShape('lasso', pending.points, pending.mode);
  }

  /** Cierra el lazo — desde el nodo de origen o la barra flotante. */
  commitLasso() {
    const pending = this.pendingLasso;
    if (!pending) return;
    this.pendingLasso = null;
    if (pending.points.length < 3) this.clearSelection();
    else this.applySelectionShape('lasso', pending.points, pending.mode);
  }

  /** Descarta el lazo entero y vuelve a la selección previa al gesto. */
  cancelLasso() {
    if (!this.pendingLasso) return;
    this.pendingLasso = null;
    this.restoreSelectionBackup();
    // Tras restaurar, el contenido es exactamente el de antes del gesto:
    // sus límites de entonces ya acotan dónde puede haber algo.
    this.commitSelectionCanvas(this.selectionBackupBounds);
  }

  /**
   * Arranca una selección "varita mágica": semilla + tolerancia inicial.
   * Lee la referencia compuesta una sola vez — ver `PendingWand` — y deja
   * ya la primera vista previa, igual que tocar sin arrastrar en Procreate.
   */
  beginSelectWand(p: Vec2, mode: SelectionMode, tolerance = 0.15): boolean {
    const w = this.doc.width;
    const h = this.doc.height;
    const sx = Math.floor(p.x);
    const sy = Math.floor(p.y);
    if (sx < 0 || sy < 0 || sx >= w || sy >= h) return false;

    this.beginSelectionDrag();
    // Misma referencia que `floodFill`: el documento compuesto, no una capa
    // suelta, para que la selección respete líneas que estén en otra capa.
    const reference = this.renderer.readRect(
      this.compositeGroups({
        frame: this.currentFrame,
        ping: ['p0', 'p1'],
        includeWet: false,
        excludeReference: true,
      }),
      { x: 0, y: 0, x2: w, y2: h },
    );
    this.pendingWand = { reference, w, h, sx, sy, tolerance: clamp(tolerance, 0, 1), mode, lastRect: emptyRect() };
    this.previewSelectWand();
    return true;
  }

  /** Reajusta la tolerancia (0..1) mientras se sigue arrastrando — el
   *  "arrastra hacia la izquierda o derecha" de la varita de Procreate. */
  updateSelectWandTolerance(tolerance: number) {
    if (!this.pendingWand) return;
    this.pendingWand.tolerance = clamp(tolerance, 0, 1);
    this.previewSelectWand();
  }

  /** Vista previa: recorre de nuevo el flood-fill en CPU sobre la
   *  referencia ya cacheada, no vuelve a leer la GPU. */
  private previewSelectWand() {
    const pending = this.pendingWand;
    if (!pending) return;
    const { filled, minX, minY, maxX, maxY } = floodMatch(
      pending.reference,
      pending.w,
      pending.h,
      pending.sx,
      pending.sy,
      pending.tolerance,
    );
    this.restoreSelectionBackup();
    const rect: Rect = minX <= maxX ? { x: minX, y: minY, x2: maxX + 1, y2: maxY + 1 } : emptyRect();
    rasterizeMask(this.selectionSurfaceCanvas(), filled, pending.w, rect, pending.mode);
    pending.lastRect = rect;
    this.uploadSelectionMask();
    this.selection = { active: !rectIsEmpty(rect), bounds: rect };
    this.touch(false);
  }

  /** Cierra el gesto y calcula los límites reales de la máscara. */
  endSelectWand() {
    const pending = this.pendingWand;
    if (!pending) return;
    this.pendingWand = null;
    const scanRect =
      pending.mode === 'replace'
        ? pending.lastRect
        : unionRect(this.selectionBackupBounds, pending.lastRect);
    this.commitSelectionCanvas(scanRect);
  }

  /** Descarta la selección en marcha y vuelve a la previa al gesto. */
  cancelSelectWand() {
    if (!this.pendingWand) return;
    this.pendingWand = null;
    this.restoreSelectionBackup();
    this.commitSelectionCanvas(this.selectionBackupBounds);
  }

  selectAll() {
    if (this.floating) this.commitFloating();
    const canvas = this.selectionSurfaceCanvas();
    const ctx = canvas.getContext('2d')!;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    // Todo el lienzo queda seleccionado sin ambigüedad — no hace falta
    // escanear nada para saber los límites, ya se conocen de sobra.
    this.uploadSelectionMask();
    this.selection = { active: true, bounds: { x: 0, y: 0, x2: this.doc.width, y2: this.doc.height } };
    this.touch();
  }

  invertSelection() {
    if (!this.selection.active) return this.selectAll();
    if (this.floating) this.commitFloating();
    const canvas = this.selectionSurfaceCanvas();
    const ctx = canvas.getContext('2d')!;
    // XOR con un relleno completo deja alfa = 1 - alfa: la inversión exacta.
    ctx.globalCompositeOperation = 'xor';
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.globalCompositeOperation = 'source-over';
    this.commitSelectionCanvas();
  }

  clearSelection() {
    if (this.floating) this.commitFloating();
    const canvas = this.selectionSurfaceCanvas();
    canvas.getContext('2d')!.clearRect(0, 0, canvas.width, canvas.height);
    this.renderer.clear(this.selectionMask);
    this.selection = { active: false, bounds: emptyRect() };
    this.touch();
  }

  /** Borra los píxeles de la capa activa que caen dentro de la selección. */
  deleteSelection() {
    const layer = this.activeLayer;
    if (!layer || layer.locked || !this.selection.active || layer.kind !== 'draw') return;
    const cel = celAt(layer, this.currentFrame);
    if (!cel) return;
    const rect = clampRect(this.selection.bounds, this.doc.width, this.doc.height);
    const before = this.renderer.readRect(cel.surface, rect);
    this.renderer.drawOver(cel.surface, this.selectionMask, 1, undefined, true);
    const after = this.renderer.readRect(cel.surface, rect);
    const label = 'Borrar selección';
    this.history.push({
      label,
      cost: before.byteLength + after.byteLength,
      op: {
        type: 'rasterEdit',
        label,
        layerId: layer.id,
        frame: this.storedCelFrame(layer, this.currentFrame, -1),
        createdFrame: -1,
        rect,
        before,
        after,
      },
      redo: () => {
        this.renderer.writeRect(cel.surface, rect, after);
        this.touch();
      },
      undo: () => {
        this.renderer.writeRect(cel.surface, rect, before);
        this.touch();
      },
    });
    this.touch();
  }

  /** Rellena la selección con un color plano en la capa activa. */
  fillSelection(color: RGB) {
    const layer = this.activeLayer;
    if (!layer || layer.locked || !this.selection.active || layer.kind !== 'draw') return;
    const { cel, created } = this.ensureCel(layer, this.currentFrame);
    const rect = clampRect(this.selection.bounds, this.doc.width, this.doc.height);
    const before = created >= 0 ? null : this.renderer.readRect(cel.surface, rect);

    const flat = this.renderer.scratch('flat');
    this.renderer.fill(flat, color, 1);
    this.mergeStroke(cel.surface, flat, 1, false, layer);

    const after = this.renderer.readRect(cel.surface, rect);
    const prev = before ?? new Uint8Array(after.length);
    const label = 'Rellenar selección';
    this.history.push({
      label,
      cost: prev.byteLength + after.byteLength,
      op: layer.swap
        ? undefined
        : {
            type: 'rasterEdit',
            label,
            layerId: layer.id,
            frame: this.storedCelFrame(layer, this.currentFrame, created),
            createdFrame: created,
            rect,
            before: prev,
            after,
          },
      redo: () => {
        if (created >= 0) layer.cels.set(created, cel);
        this.renderer.writeRect(cel.surface, rect, after);
        this.touch();
      },
      undo: () => {
        this.renderer.writeRect(cel.surface, rect, prev);
        if (created >= 0) layer.cels.delete(created);
        this.touch();
      },
    });
    this.touch();
  }

  /* ---------------------------------------------------------------- *
   * Transformación libre de la selección
   * ---------------------------------------------------------------- */

  /**
   * Levanta los píxeles seleccionados a una capa flotante y los quita del cel.
   *
   * A partir de aquí la selección se mueve, escala y gira sin volver a tocar
   * el cel hasta confirmar, así que arrastrarla no acumula pérdidas de
   * remuestreo: cada fotograma se compone desde los píxeles originales.
   */
  liftSelection(): boolean {
    if (this.floating) return true;
    const layer = this.activeLayer;
    if (!layer || layer.locked || !this.selection.active || layer.kind !== 'draw')
      return false;
    const cel = celAt(layer, this.currentFrame);
    if (!cel || cel.surface.empty) return false;

    const rect = clampRect(this.selection.bounds, this.doc.width, this.doc.height);
    if (rectIsEmpty(rect)) return false;

    const lifted = this.liftCel(cel, celStartFrame(layer, this.currentFrame), rect);
    if (!lifted) return false;
    this.beginFloating(layer.id, rect, [lifted]);
    return true;
  }

  /**
   * Igual que `liftSelection`, pero levanta un cel distinto por cada dibujo
   * que empiece dentro de `[fromFrame, toFrame]` en la capa activa — la
   * transformación multi-fotograma: mover un brazo en varios cuadros a la
   * vez en vez de repetir el gesto cuadro por cuadro.
   *
   * Sólo toca cels que YA EMPIEZAN en el rango (`sortedCelFrames`), no cada
   * fotograma del rango uno por uno: un cel sostenido sobre 8 fotogramas es
   * un único dibujo, y tocarlo una vez por fotograma visible lo procesaría
   * ocho veces por nada (y con el mismo resultado, porque `liftCel` opera
   * sobre el cel entero, no sobre el fotograma).
   */
  liftSelectionRange(fromFrame: number, toFrame: number): boolean {
    if (this.floating) return true;
    const layer = this.activeLayer;
    if (!layer || layer.locked || !this.selection.active || layer.kind !== 'draw')
      return false;

    const rect = clampRect(this.selection.bounds, this.doc.width, this.doc.height);
    if (rectIsEmpty(rect)) return false;

    const lo = Math.min(fromFrame, toFrame);
    const hi = Math.max(fromFrame, toFrame);
    const cels: FloatingCel[] = [];
    for (const celFrame of sortedCelFrames(layer)) {
      if (celFrame < lo || celFrame > hi) continue;
      const cel = layer.cels.get(celFrame)!;
      const lifted = this.liftCel(cel, celFrame, rect);
      if (lifted) cels.push(lifted);
    }
    if (cels.length === 0) return false;

    this.beginFloating(layer.id, rect, cels);
    return true;
  }

  /** Levanta los píxeles de `rect` de UN cel: la parte que `liftSelection` y
   *  `liftSelectionRange` comparten por cada dibujo que tocan. */
  private liftCel(cel: Cel, celFrame: number, rect: Rect): FloatingCel | null {
    if (cel.surface.empty) return null;
    const surface = this.renderer.createSurface('floating');
    surface.pinned = true;
    this.renderer.copy(surface, cel.surface, 1, undefined, this.selectionMask);

    const before = this.renderer.readRect(cel.surface, rect);
    this.renderer.drawOver(cel.surface, this.selectionMask, 1, undefined, true);
    return { celFrame, surface, before };
  }

  private beginFloating(layerId: string, rect: Rect, cels: FloatingCel[]) {
    this.floating = {
      cels,
      layerId,
      tx: 0,
      ty: 0,
      scale: 1,
      rotation: 0,
      pivotX: (rect.x + rect.x2) / 2,
      pivotY: (rect.y + rect.y2) / 2,
      sourceRect: rect,
    };
    this.touch();
  }

  updateFloating(patch: Partial<Pick<FloatingSelection, 'tx' | 'ty' | 'scale' | 'rotation'>>) {
    if (!this.floating) return;
    Object.assign(this.floating, patch);
    this.touch(false);
  }

  /** Matriz que lleva el quad unidad a la posición transformada del flotante. */
  private floatingMatrixFor(f: FloatingSelection): Mat3 {
    const c = Math.cos(f.rotation) * f.scale;
    const s = Math.sin(f.rotation) * f.scale;
    return new Float32Array([
      this.doc.width * c,
      this.doc.width * s,
      0,
      -this.doc.height * s,
      this.doc.height * c,
      0,
      f.pivotX + f.tx - (c * f.pivotX - s * f.pivotY),
      f.pivotY + f.ty - (s * f.pivotX + c * f.pivotY),
      1,
    ]);
  }

  private floatingCornersFor(f: FloatingSelection): Vec2[] {
    const c = Math.cos(f.rotation) * f.scale;
    const s = Math.sin(f.rotation) * f.scale;
    return rectCorners(f.sourceRect).map((p) => {
      const dx = p.x - f.pivotX;
      const dy = p.y - f.pivotY;
      return {
        x: c * dx - s * dy + f.pivotX + f.tx,
        y: s * dx + c * dy + f.pivotY + f.ty,
      };
    });
  }

  floatingMatrix(): Mat3 | null {
    return this.floating ? this.floatingMatrixFor(this.floating) : null;
  }

  /** Esquinas del flotante en coordenadas de documento, para los tiradores. */
  floatingCorners(): Vec2[] | null {
    return this.floating ? this.floatingCornersFor(this.floating) : null;
  }

  commitFloating() {
    const f = this.floating;
    if (!f) return;
    const layer = this.doc.layers.find((l) => l.id === f.layerId);
    this.floating = null;

    if (!layer) {
      for (const fc of f.cels) this.renderer.release(fc.surface);
      this.touch();
      return;
    }

    // La operación toca dos zonas: de donde se levantaron los píxeles y donde
    // acaban. Deshacer necesita ambas, así que el paso se guarda sobre su
    // rectángulo unión en vez de sobre el documento entero. Es la misma
    // región para todos los cels del lote: comparten `sourceRect` y matriz.
    const destRect = emptyRect();
    for (const p of this.floatingCornersFor(f)) expandRect(destRect, p.x, p.y, 1);
    const region = clampRect(
      unionRect(f.sourceRect, destRect),
      this.doc.width,
      this.doc.height,
    );
    const matrix = this.floatingMatrixFor(f);

    // Un paso de deshacer por cel tocado — así un lote de N cuadros se
    // deshace/rehace de una vez, no cuadro por cuadro.
    const steps: { frame: number; surface: Surface; before: Uint8Array; after: Uint8Array }[] = [];
    for (const fc of f.cels) {
      const cel = layer.cels.get(fc.celFrame);
      if (!cel) {
        this.renderer.release(fc.surface);
        continue;
      }
      // Estado previo a levantar la selección: lo que hay ahora en el cel es
      // el original menos los píxeles levantados, así que basta con
      // reinsertarlos.
      const beforeRegion = this.renderer.readRect(cel.surface, region);
      spliceRect(beforeRegion, region, fc.before, f.sourceRect);

      this.renderer.drawOver(cel.surface, fc.surface, 1, matrix);
      this.renderer.release(fc.surface);
      const afterRegion = this.renderer.readRect(cel.surface, region);
      steps.push({ frame: fc.celFrame, surface: cel.surface, before: beforeRegion, after: afterRegion });
    }

    if (steps.length === 0) {
      this.touch();
      return;
    }

    const label =
      steps.length > 1 ? `Transformar selección (${steps.length} cuadros)` : 'Transformar selección';
    this.history.push({
      label,
      cost: steps.reduce((n, s) => n + s.before.byteLength + s.after.byteLength, 0),
      op: layer.swap
        ? undefined
        : {
            type: 'rasterEditBatch',
            label,
            layerId: layer.id,
            region,
            steps: steps.map((s) => ({ frame: s.frame, before: s.before, after: s.after })),
          },
      redo: () => {
        for (const s of steps) this.renderer.writeRect(s.surface, region, s.after);
        this.touch();
      },
      undo: () => {
        for (const s of steps) this.renderer.writeRect(s.surface, region, s.before);
        this.touch();
      },
    });
    this.touch();
  }

  cancelFloating() {
    const f = this.floating;
    if (!f) return;
    const layer = this.doc.layers.find((l) => l.id === f.layerId);
    for (const fc of f.cels) {
      const cel = layer ? layer.cels.get(fc.celFrame) : null;
      if (cel) this.renderer.writeRect(cel.surface, f.sourceRect, fc.before);
      this.renderer.release(fc.surface);
    }
    this.floating = null;
    this.touch();
  }

  /* ---------------------------------------------------------------- *
   * Cuentagotas y relleno
   * ---------------------------------------------------------------- */

  /** Color compuesto bajo un punto del documento, o null si está fuera. */
  pickColor(p: Vec2): RGB | null {
    const x = Math.floor(p.x);
    const y = Math.floor(p.y);
    if (x < 0 || y < 0 || x >= this.doc.width || y >= this.doc.height) return null;
    const surface = this.compositeGroups({
      frame: this.currentFrame,
      ping: ['p0', 'p1'],
      includeWet: false,
    });
    const px = this.renderer.readRect(surface, { x, y, x2: x + 1, y2: y + 1 });
    const a = px[3] / 255;
    if (a === 0) return null;
    // Los píxeles vienen premultiplicados.
    return { r: px[0] / 255 / a, g: px[1] / 255 / a, b: px[2] / 255 / a };
  }

  /** Worker perezoso para la parte en CPU de `floodFill` — un solo hilo
   *  para la vida del `Engine`, no uno por relleno; el worker no guarda
   *  nada entre mensajes. */
  private floodWorker: Worker | null = null;
  /** Un bote de relleno puede lanzarse mientras el anterior sigue en vuelo
   *  (doble toque rápido: nada bloquea el lienzo mientras se espera al
   *  worker, sólo hay un indicador visual). `addEventListener('message',
   *  ..., {once:true})` por llamada no vale aquí: TODOS los listeners
   *  registrados se disparan con el PRIMER mensaje que llega, así que dos
   *  rellenos pendientes acababan resolviendo ambos con la misma respuesta
   *  y la segunda de verdad se perdía sin que nadie la recogiera. Cada
   *  petición lleva un id y un único handler fijo la reparte. */
  private floodPending = new Map<number, (r: FloodFillResponse) => void>();
  private floodRequestId = 0;
  private getFloodWorker(): Worker {
    if (!this.floodWorker) {
      const worker = new Worker(new URL('../workers/floodFill.worker.ts', import.meta.url), {
        type: 'module',
      });
      worker.onmessage = (e: MessageEvent<FloodFillResponse>) => {
        const resolve = this.floodPending.get(e.data.id);
        if (!resolve) return;
        this.floodPending.delete(e.data.id);
        resolve(e.data);
      };
      this.floodWorker = worker;
    }
    return this.floodWorker;
  }

  private runFloodFillWorker(
    reference: Uint8Array,
    target: Uint8Array,
    w: number,
    h: number,
    sx: number,
    sy: number,
    tolerance: number,
    expand: number,
    color: RGB,
    alphaLock: boolean,
  ): Promise<FloodFillResponse> {
    return new Promise((resolve) => {
      const worker = this.getFloodWorker();
      const id = ++this.floodRequestId;
      this.floodPending.set(id, resolve);
      // Se transfieren los dos buffers (no se copian): ya no hacen falta
      // aquí — `before` es una copia aparte, tomada antes de esto.
      worker.postMessage(
        { id, reference, target, w, h, sx, sy, tolerance, expand, color, alphaLock },
        [reference.buffer, target.buffer],
      );
    });
  }

  /**
   * Relleno por difusión sobre el cel activo.
   *
   * La referencia es el documento compuesto, no el cel: al colorear una
   * animación quieres que el bote respete las líneas aunque estén en otra
   * capa. La escritura sí va al cel activo.
   *
   * El barrido de líneas y sus dos pasadas siguientes (crecer el borde,
   * pintar el color) corren en un Worker — ver `workers/floodFill.worker.ts`
   * y `core/flood.ts` para el porqué está partido así. Las dos lecturas de
   * GPU (la referencia compuesta y el cel) siguen aquí, en el hilo
   * principal: son la parte que de verdad no se puede mover, porque hace
   * falta el contexto WebGL vivo para leerlas.
   */
  async floodFill(p: Vec2, color: RGB, tolerance = 0.15, expand = 2): Promise<void> {
    const layer = this.activeLayer;
    if (!layer || layer.locked || !layer.visible || layer.kind !== 'draw') return;
    const w = this.doc.width;
    const h = this.doc.height;
    const sx = Math.floor(p.x);
    const sy = Math.floor(p.y);
    if (sx < 0 || sy < 0 || sx >= w || sy >= h) return;

    const full: Rect = { x: 0, y: 0, x2: w, y2: h };
    // Sin la referencia: una foto de fondo tiene gradientes por todas partes y
    // el bote pararía en el primer píxel en vez de respetar sólo las líneas.
    const reference = this.renderer.readRect(
      this.compositeGroups({
        frame: this.currentFrame,
        ping: ['p0', 'p1'],
        includeWet: false,
        excludeReference: true,
      }),
      full,
    );

    const { cel, created } = this.ensureCel(layer, this.currentFrame);
    const target = this.renderer.readRect(cel.surface, full);
    const before = created >= 0 ? null : target.slice();

    const { sub, rect } = await this.runFloodFillWorker(
      reference,
      target,
      w,
      h,
      sx,
      sy,
      tolerance,
      expand,
      color,
      layer.alphaLock,
    );
    const prev = before ? extractRect(before, w, rect) : new Uint8Array(sub.length);

    const label = 'Rellenar';
    this.history.run({
      label,
      cost: sub.byteLength + prev.byteLength,
      op: layer.swap
        ? undefined
        : {
            type: 'rasterEdit',
            label,
            layerId: layer.id,
            frame: this.storedCelFrame(layer, this.currentFrame, created),
            createdFrame: created,
            rect,
            before: prev,
            after: sub,
          },
      redo: () => {
        if (created >= 0) layer.cels.set(created, cel);
        this.renderer.writeRect(cel.surface, rect, sub);
        this.touch();
      },
      undo: () => {
        this.renderer.writeRect(cel.surface, rect, prev);
        if (created >= 0) layer.cels.delete(created);
        this.touch();
      },
    });
  }

  /** Composición limpia de un fotograma arbitrario, para exportar. */
  /* ---------------------------------------------------------------- *
   * Tamaño del lienzo
   * ---------------------------------------------------------------- */

  /**
   * Copia el contenido de todos los cels a lienzos de CPU.
   *
   * Hay que sacarlos antes de tocar el tamaño del documento: en cuanto
   * `setDocumentSize` cambia, las texturas se reservan con las medidas nuevas
   * y lo que hubiera dentro se pierde.
   */
  private snapshotCels(): Map<string, HTMLCanvasElement> {
    const shots = new Map<string, HTMLCanvasElement>();
    for (const layer of this.doc.layers) {
      for (const cel of layer.cels.values()) {
        if (cel.surface.empty) continue;
        const data = this.renderer.toImageData(this.renderer.ensureResident(cel.surface));
        const canvas = document.createElement('canvas');
        canvas.width = data.width;
        canvas.height = data.height;
        canvas.getContext('2d')!.putImageData(data, 0, 0);
        shots.set(cel.id, canvas);
      }
    }
    return shots;
  }

  /** Igual que `snapshotCels`, pero para las máscaras de capa — indexadas
   *  por id de CAPA, no de cel, porque una máscara no vive en `layer.cels`. */
  private snapshotMasks(): Map<string, HTMLCanvasElement> {
    const shots = new Map<string, HTMLCanvasElement>();
    for (const layer of this.doc.layers) {
      if (!layer.mask) continue;
      const data = this.renderer.toImageData(this.renderer.ensureResident(layer.mask.surface));
      const canvas = document.createElement('canvas');
      canvas.width = data.width;
      canvas.height = data.height;
      canvas.getContext('2d')!.putImageData(data, 0, 0);
      shots.set(layer.id, canvas);
    }
    return shots;
  }

  /** Reconstruye todos los cels al tamaño dado, colocando cada copia en `dx, dy`. */
  private applyCanvasSize(
    width: number,
    height: number,
    shots: Map<string, HTMLCanvasElement>,
    maskShots: Map<string, HTMLCanvasElement>,
    dx: number,
    dy: number,
  ) {
    this.doc.width = width;
    this.doc.height = height;
    this.renderer.setDocumentSize(width, height);
    this.thumbCache.clear();
    // La máscara de selección tenía las medidas viejas; ya no vale.
    this.selection = { active: false, bounds: emptyRect() };
    this.selectionCanvas = null;
    this.selectionBackup = null;

    for (const layer of this.doc.layers) {
      for (const cel of layer.cels.values()) {
        this.renderer.release(cel.surface);
        cel.surface.empty = true;
        const shot = shots.get(cel.id);
        if (!shot) continue;

        const placed = document.createElement('canvas');
        placed.width = width;
        placed.height = height;
        placed.getContext('2d')!.drawImage(shot, dx, dy);
        this.renderer.uploadImage(cel.surface, placed);
      }
      if (layer.mask) {
        this.renderer.release(layer.mask.surface);
        // El área nueva de una máscara empieza en blanco (revela todo), no
        // transparente (ocultaría todo) — al revés que un cel, donde lo de
        // fuera del dibujo siempre fue "no hay tinta".
        const placed = document.createElement('canvas');
        placed.width = width;
        placed.height = height;
        const pctx = placed.getContext('2d')!;
        pctx.fillStyle = '#fff';
        pctx.fillRect(0, 0, width, height);
        const shot = maskShots.get(layer.id);
        if (shot) {
          // `putImageData`, no `drawImage`: escribe los píxeles del recorte
          // TAL CUAL, sin compositar — un agujero borrado en la máscara
          // tiene alfa 0, y `drawImage` con blending normal (o con
          // `globalCompositeOperation:'copy'`, que además borra el lienzo
          // entero fuera del recorte) lo habría revelado otra vez en vez de
          // conservar el 0 tal cual.
          const shotData = shot.getContext('2d')!.getImageData(0, 0, shot.width, shot.height);
          pctx.putImageData(shotData, dx, dy);
        }
        this.renderer.uploadImage(layer.mask.surface, placed);
      }
    }
    this.resetView();
    this.touch();
  }

  /**
   * Sustituye el documento entero — proyecto nuevo o archivo abierto —
   * liberando antes las superficies GPU del anterior. Sin esto, cada cel de
   * cada capa se queda ocupando textura sin que nada vuelva a soltarla: el
   * documento viejo lo recoge el recolector de basura de JS, pero la GPU no
   * tiene uno propio.
   */
  private replaceDocument(doc: TraceDocument) {
    if (this.floating) this.cancelFloating();
    if (this.builder) this.cancelStroke();
    if (this.pendingQuickShape) this.cancelQuickShape();
    for (const layer of this.doc.layers) {
      for (const cel of layer.cels.values()) this.renderer.release(cel.surface);
      if (layer.mask) this.renderer.release(layer.mask.surface);
    }
    this.doc = doc;
    this.renderer.setDocumentSize(doc.width, doc.height);
    this.currentFrame = 0;
    this.activeLayerId = doc.layers[doc.layers.length - 1]?.id ?? null;
    this.editingMaskLayerId = null;
    this.selection = { active: false, bounds: emptyRect() };
    this.history.clear();
    this.thumbCache.clear();
    this.centerPerspectiveGuide();
    this.resetView();
    this.touch();
  }

  /** Empieza un proyecto en blanco, descartando el actual (con su propia
   * capa "Capa 1" — un documento sin capas no se puede dibujar). */
  newProject(width: number, height: number, fps = 12, frameCount = 24) {
    const w = Math.round(clamp(width, 16, 8192));
    const h = Math.round(clamp(height, 16, 8192));
    const doc = newDocument(w, h, fps, frameCount);
    doc.layers.push(newLayer('Capa 1'));
    this.replaceDocument(doc);
  }

  /** Reemplaza el documento por uno leído de un archivo `.trace`. */
  loadDocument(doc: TraceDocument) {
    this.replaceDocument(doc);
  }

  /**
   * Repuebla la pila de deshacer tras `loadDocument` con los pasos que
   * `deserializeProject` haya podido reconstruir del `.trace` — ver
   * `historyOps.ts`. Va aparte de `loadDocument` (no dentro de
   * `replaceDocument`) porque `deserializeProject` sólo entrega el
   * documento y el historial juntos cuando termina de leer el archivo; el
   * llamador decide el orden, pero siempre después de que `this.doc` ya sea
   * el nuevo. Los pasos que no se puedan reconstruir (capa o cel que ya no
   * existen) se descartan en silencio: mejor un historial más corto que
   * romper la carga por un paso viejo.
   */
  loadHistoryOps(ops: HistoryOp[]) {
    const cmds = ops
      .map((op) => rehydrateHistoryOp(this.doc, this.renderer, () => this.touch(), op))
      .filter((cmd): cmd is NonNullable<typeof cmd> => cmd !== null);
    this.history.loadPast(cmds);
  }

  /**
   * Cambia el tamaño del lienzo conservando los dibujos.
   *
   * `anchor` va de 0 a 1 en cada eje y decide dónde queda el contenido
   * anterior: 0.5 lo centra, 0 lo pega arriba-izquierda. Al reducir se
   * recorta lo que sobresalga, y por eso deshacer guarda una copia de todos
   * los cels en vez de intentar recalcularlos.
   */
  resizeCanvas(width: number, height: number, anchorX = 0.5, anchorY = 0.5) {
    const w = Math.round(clamp(width, 16, 8192));
    const h = Math.round(clamp(height, 16, 8192));
    if (w === this.doc.width && h === this.doc.height) return;

    if (this.floating) this.commitFloating();
    if (this.builder) this.endStroke();
    if (this.pendingQuickShape) this.commitQuickShape();

    const oldW = this.doc.width;
    const oldH = this.doc.height;
    const shots = this.snapshotCels();
    const maskShots = this.snapshotMasks();
    const dx = Math.round((w - oldW) * anchorX);
    const dy = Math.round((h - oldH) * anchorY);

    let cost = 0;
    for (const c of shots.values()) cost += c.width * c.height * 4;
    for (const c of maskShots.values()) cost += c.width * c.height * 4;

    this.history.run({
      label: 'Tamaño del lienzo',
      cost,
      redo: () => this.applyCanvasSize(w, h, shots, maskShots, dx, dy),
      // Volver atrás reinserta las copias en su sitio original, porque al
      // encoger se perdieron píxeles que no se pueden deducir.
      undo: () => this.applyCanvasSize(oldW, oldH, shots, maskShots, 0, 0),
    });
  }

  renderFrameToImageData(frame: number): ImageData {
    const surface = this.compositeGroups({
      frame,
      ping: ['p0', 'p1'],
      includeWet: false,
      excludeReference: true,
    });
    return this.renderer.toImageData(surface);
  }

  /** Miniatura del cel para el panel de capas y la línea de tiempo. */
  /**
   * Miniatura del cel visible, cacheada por versión de contenido.
   *
   * El panel de capas se redibuja en cada cambio del documento, así que sin
   * caché cada trazo costaría una miniatura por capa. Y sin la reducción en
   * GPU cada una de ésas se traería el documento entero a CPU.
   */
  celThumbnail(layer: Layer, frame: number, maxSize = 64): HTMLCanvasElement | null {
    const cel = celAt(layer, frame);
    if (!cel || cel.surface.empty) return null;

    const key = `${cel.id}@${maxSize}`;
    const cached = this.thumbCache.get(key);
    if (cached && cached.version === cel.surface.version) return cached.canvas;

    const canvas = this.renderer.downscaleToCanvas(cel.surface, maxSize);
    if (!canvas) return null;

    if (this.thumbCache.size > 200) this.thumbCache.clear();
    this.thumbCache.set(key, { canvas, version: cel.surface.version });
    return canvas;
  }

  hasKeyframes(layer: Layer) {
    return hasAnyKeyframes(layer.transform);
  }
}

/**
 * Copia `src` (que cubre `srcRect`) dentro de `dst` (que cubre `dstRect`).
 * Se usa para reconstruir el estado previo a levantar una selección sin
 * guardar un segundo snapshot del cel entero.
 */
function spliceRect(dst: Uint8Array, dstRect: Rect, src: Uint8Array, srcRect: Rect) {
  const dstW = dstRect.x2 - dstRect.x;
  const srcW = srcRect.x2 - srcRect.x;
  const srcH = srcRect.y2 - srcRect.y;
  for (let y = 0; y < srcH; y++) {
    const dy = srcRect.y + y - dstRect.y;
    if (dy < 0 || dy >= dstRect.y2 - dstRect.y) continue;
    const dx = srcRect.x - dstRect.x;
    if (dx < 0 || dx + srcW > dstW) continue;
    const from = y * srcW * 4;
    dst.set(src.subarray(from, from + srcW * 4), (dy * dstW + dx) * 4);
  }
}

function structuredCloneTransform(t: Layer['transform']): Layer['transform'] {
  return {
    x: { base: t.x.base, keys: t.x.keys.map((k) => ({ ...k })) },
    y: { base: t.y.base, keys: t.y.keys.map((k) => ({ ...k })) },
    scale: { base: t.scale.base, keys: t.scale.keys.map((k) => ({ ...k })) },
    rotation: { base: t.rotation.base, keys: t.rotation.keys.map((k) => ({ ...k })) },
    opacity: { base: t.opacity.base, keys: t.opacity.keys.map((k) => ({ ...k })) },
  };
}

export { mat3Identity, mat3Invert };
