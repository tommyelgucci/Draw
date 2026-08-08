import { Renderer, type Surface } from '../gl/renderer';
import { StrokeBuilder, type BrushPreset } from './brush';
import {
  buildClipGroups,
  celAt,
  celStartFrame,
  clampFrame,
  hasAnyKeyframes,
  newDocument,
  newLayer,
  sampleChannel,
  setKeyframe,
  sortedCelFrames,
  transformIsIdentity,
  uid,
  type Cel,
  type Layer,
  type TraceDocument,
} from './document';
import { History } from './history';
import { clamp, mat3Identity, mat3Invert, mat3Multiply, type Mat3 } from './math';
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

  playing = false;
  loop = true;

  /** Se incrementa en cualquier cambio estructural; la UI se suscribe. */
  revision = 0;
  private listeners = new Set<() => void>();

  private renderQueued = false;
  private belowCacheKey = '';
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
  private createdCelFrame = -1;
  private predictedStamps: Stamp[] = [];

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
    this.touch();
  }

  private makeCel(): Cel {
    return { id: uid('cel'), surface: this.renderer.createSurface('cel') };
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
    const copy = newLayer(`${src.name} copia`, src.animated);
    copy.visible = src.visible;
    copy.opacity = src.opacity;
    copy.blend = src.blend;
    copy.clipToBelow = src.clipToBelow;
    copy.transform = structuredCloneTransform(src.transform);

    for (const [frame, cel] of src.cels) {
      const nc = this.makeCel();
      this.renderer.copy(nc.surface, this.renderer.ensureResident(cel.surface), 1);
      copy.cels.set(frame, nc);
    }

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

  clearCel(layerId: string, frame: number) {
    const layer = this.doc.layers.find((l) => l.id === layerId);
    if (!layer) return;
    const cel = celAt(layer, frame);
    if (!cel || cel.surface.empty) return;
    const full: Rect = { x: 0, y: 0, x2: this.doc.width, y2: this.doc.height };
    const before = this.renderer.readRect(cel.surface, full);
    this.history.run({
      label: 'Borrar fotograma',
      cost: before.byteLength,
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

  /* ---------------------------------------------------------------- *
   * Trazo
   * ---------------------------------------------------------------- */

  get isDrawing() {
    return this.builder !== null;
  }

  beginStroke(sample: InputSample, ctx: StrokeContext): boolean {
    const layer = this.activeLayer;
    if (!layer || layer.locked || !layer.visible) return false;

    const { cel, created } = this.ensureCel(layer, this.currentFrame);
    this.strokeLayer = layer;
    this.strokeCel = cel;
    this.strokeCtx = ctx;
    this.createdCelFrame = created;
    this.strokeRect = emptyRect();
    this.predictedStamps = [];

    this.renderer.clear(this.renderer.scratch('wet'));
    this.renderer.clear(this.renderer.scratch('predict'));

    this.builder = new StrokeBuilder(ctx.brush);
    this.commitStamps(this.builder.begin(sample));
    if (created >= 0) this.touch();
    else this.requestRender();
    return true;
  }

  moveStroke(samples: InputSample[], predicted: InputSample[] = []) {
    if (!this.builder) return;
    const stamps: Stamp[] = [];
    for (const s of samples) stamps.push(...this.builder.push(s));
    this.commitStamps(stamps);
    this.predictedStamps = predicted.length ? this.builder.speculate(predicted) : [];
    this.requestRender();
  }

  private commitStamps(stamps: Stamp[]) {
    if (stamps.length === 0 || !this.strokeCtx) return;
    const wet = this.renderer.scratch('wet');
    this.renderer.drawStamps(wet, stamps, this.strokeCtx.color);
    for (const s of stamps) {
      expandRect(this.strokeRect, s.x, s.y, s.size * 0.75 + 2);
    }
  }

  endStroke() {
    if (!this.builder || !this.strokeCel || !this.strokeCtx || !this.strokeLayer) {
      this.cancelStroke();
      return;
    }
    this.commitStamps(this.builder.end());
    this.predictedStamps = [];
    this.renderer.clear(this.renderer.scratch('predict'));

    const layer = this.strokeLayer;
    const cel = this.strokeCel;
    const ctx = this.strokeCtx;
    const createdFrame = this.createdCelFrame;
    const rect = clampRect(this.strokeRect, this.doc.width, this.doc.height);

    this.builder = null;
    this.strokeCel = null;
    this.strokeCtx = null;
    this.strokeLayer = null;
    this.createdCelFrame = -1;

    if (rectIsEmpty(rect)) {
      if (createdFrame >= 0) layer.cels.delete(createdFrame);
      this.renderer.clear(this.renderer.scratch('wet'));
      this.touch();
      return;
    }

    const before = this.renderer.readRect(cel.surface, rect);
    this.renderer.drawOver(
      cel.surface,
      this.renderer.scratch('wet'),
      ctx.brush.opacity,
      undefined,
      ctx.brush.erase,
    );
    const after = this.renderer.readRect(cel.surface, rect);
    this.renderer.clear(this.renderer.scratch('wet'));

    this.history.push({
      label: ctx.brush.erase ? 'Borrar' : 'Trazo',
      cost: before.byteLength + after.byteLength,
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
    this.predictedStamps = [];
    this.renderer.clear(this.renderer.scratch('wet'));
    this.renderer.clear(this.renderer.scratch('predict'));
    this.touch();
  }

  /* ---------------------------------------------------------------- *
   * Reproducción
   * ---------------------------------------------------------------- */

  setFrame(frame: number) {
    const f = clampFrame(this.doc, frame);
    if (f === this.currentFrame) return;
    if (this.builder) this.endStroke();
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

  togglePlay() {
    this.playing = !this.playing;
    this.playClock = performance.now();
    this.touch(false);
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
            if (this.loop) next %= this.doc.frameCount;
            else {
              next = this.doc.frameCount - 1;
              this.playing = false;
              for (const fn of this.listeners) fn();
            }
          }
          this.currentFrame = next;
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
    const cel = celAt(layer, frame);
    const isStrokeTarget =
      includeWet && this.builder !== null && this.strokeLayer?.id === layer.id;
    if (!cel && !isStrokeTarget) return null;

    let src = cel ? this.renderer.ensureResident(cel.surface) : null;

    if (isStrokeTarget && this.strokeCtx) {
      const combined = this.renderer.scratch('xf1');
      if (src) this.renderer.copy(combined, src, 1);
      else this.renderer.clear(combined);
      const erase = this.strokeCtx.brush.erase;
      this.renderer.drawOver(
        combined,
        this.renderer.scratch('wet'),
        this.strokeCtx.brush.opacity,
        undefined,
        erase,
      );
      if (this.predictedStamps.length > 0) {
        const predict = this.renderer.scratch('predict');
        this.renderer.clear(predict);
        this.renderer.drawStamps(predict, this.predictedStamps, this.strokeCtx.color);
        this.renderer.drawOver(
          combined,
          predict,
          this.strokeCtx.brush.opacity,
          undefined,
          erase,
        );
      }
      src = combined;
    }

    if (!src) return null;
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
  }): Surface {
    const r = this.renderer;
    const { frame, ping, includeWet } = opts;
    const groups = buildClipGroups(this.doc.layers);
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
    r.present(result, this.viewMatrix(), this.doc.paper, this.doc.paperAlpha, checker);
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

  /**
   * Relleno por difusión sobre el cel activo.
   *
   * La referencia es el documento compuesto, no el cel: al colorear una
   * animación quieres que el bote respete las líneas aunque estén en otra
   * capa. La escritura sí va al cel activo.
   */
  floodFill(p: Vec2, color: RGB, tolerance = 0.15, expand = 2) {
    const layer = this.activeLayer;
    if (!layer || layer.locked || !layer.visible) return;
    const w = this.doc.width;
    const h = this.doc.height;
    const sx = Math.floor(p.x);
    const sy = Math.floor(p.y);
    if (sx < 0 || sy < 0 || sx >= w || sy >= h) return;

    const full: Rect = { x: 0, y: 0, x2: w, y2: h };
    const reference = this.renderer.readRect(
      this.compositeGroups({
        frame: this.currentFrame,
        ping: ['p0', 'p1'],
        includeWet: false,
      }),
      full,
    );

    const { cel, created } = this.ensureCel(layer, this.currentFrame);
    const target = this.renderer.readRect(cel.surface, full);
    const before = created >= 0 ? null : target.slice();

    const start = (sy * w + sx) * 4;
    const sr = reference[start];
    const sg = reference[start + 1];
    const sb = reference[start + 2];
    const sa = reference[start + 3];
    const tol = tolerance * 255;

    const matches = (i: number) =>
      Math.abs(reference[i] - sr) <= tol &&
      Math.abs(reference[i + 1] - sg) <= tol &&
      Math.abs(reference[i + 2] - sb) <= tol &&
      Math.abs(reference[i + 3] - sa) <= tol;

    const filled = new Uint8Array(w * h);
    const stack: number[] = [sx, sy];
    let minX = sx;
    let minY = sy;
    let maxX = sx;
    let maxY = sy;

    // Relleno por líneas de barrido: mucho menos tráfico de pila que el
    // recursivo por píxel, que en un lienzo grande revienta.
    while (stack.length > 0) {
      const y = stack.pop()!;
      const x = stack.pop()!;
      if (filled[y * w + x]) continue;

      let left = x;
      while (left > 0 && !filled[y * w + left - 1] && matches((y * w + left - 1) * 4)) left--;
      let right = x;
      while (right < w - 1 && !filled[y * w + right + 1] && matches((y * w + right + 1) * 4))
        right++;

      for (let i = left; i <= right; i++) filled[y * w + i] = 1;
      if (left < minX) minX = left;
      if (right > maxX) maxX = right;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;

      for (const ny of [y - 1, y + 1]) {
        if (ny < 0 || ny >= h) continue;
        for (let i = left; i <= right; i++) {
          if (!filled[ny * w + i] && matches((ny * w + i) * 4)) {
            stack.push(i, ny);
          }
        }
      }
    }

    // Un par de píxeles de crecimiento evita la orla blanca que deja el
    // antialias de la línea entre el relleno y el trazo.
    for (let pass = 0; pass < expand; pass++) {
      const grown = filled.slice();
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (filled[y * w + x]) continue;
          const up = y > 0 && filled[(y - 1) * w + x];
          const down = y < h - 1 && filled[(y + 1) * w + x];
          const lf = x > 0 && filled[y * w + x - 1];
          const rt = x < w - 1 && filled[y * w + x + 1];
          if (up || down || lf || rt) grown[y * w + x] = 1;
        }
      }
      filled.set(grown);
    }
    minX = Math.max(0, minX - expand);
    minY = Math.max(0, minY - expand);
    maxX = Math.min(w - 1, maxX + expand);
    maxY = Math.min(h - 1, maxY + expand);

    const cr = Math.round(color.r * 255);
    const cg = Math.round(color.g * 255);
    const cb = Math.round(color.b * 255);
    for (let i = 0; i < filled.length; i++) {
      if (!filled[i]) continue;
      const o = i * 4;
      target[o] = cr;
      target[o + 1] = cg;
      target[o + 2] = cb;
      target[o + 3] = 255;
    }

    const rect: Rect = { x: minX, y: minY, x2: maxX + 1, y2: maxY + 1 };
    const sub = extractRect(target, w, rect);
    const prev = before ? extractRect(before, w, rect) : new Uint8Array(sub.length);

    this.history.run({
      label: 'Rellenar',
      cost: sub.byteLength + prev.byteLength,
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
  renderFrameToImageData(frame: number): ImageData {
    const surface = this.compositeGroups({ frame, ping: ['p0', 'p1'], includeWet: false });
    return this.renderer.toImageData(surface);
  }

  /** Miniatura del cel para el panel de capas y la línea de tiempo. */
  celThumbnail(layer: Layer, frame: number, maxSize = 64): HTMLCanvasElement | null {
    const cel = celAt(layer, frame);
    if (!cel || cel.surface.empty) return null;
    const data = this.renderer.toImageData(cel.surface);
    const scale = Math.min(maxSize / data.width, maxSize / data.height);
    const full = document.createElement('canvas');
    full.width = data.width;
    full.height = data.height;
    full.getContext('2d')!.putImageData(data, 0, 0);
    const out = document.createElement('canvas');
    out.width = Math.max(1, Math.round(data.width * scale));
    out.height = Math.max(1, Math.round(data.height * scale));
    const ctx = out.getContext('2d')!;
    ctx.imageSmoothingQuality = 'medium';
    ctx.drawImage(full, 0, 0, out.width, out.height);
    return out;
  }

  hasKeyframes(layer: Layer) {
    return hasAnyKeyframes(layer.transform);
  }
}

/** Recorta un sub-rectángulo de un buffer RGBA de ancho `stride` píxeles. */
function extractRect(src: Uint8Array, stride: number, r: Rect): Uint8Array {
  const w = r.x2 - r.x;
  const h = r.y2 - r.y;
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const from = ((r.y + y) * stride + r.x) * 4;
    out.set(src.subarray(from, from + w * 4), y * w * 4);
  }
  return out;
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
