import { unzipSync, zipSync } from 'fflate';
import type { Engine } from './engine';
import {
  celAt,
  MAX_FRAME_COUNT,
  newDocument,
  newLayer,
  uid,
  type AdjustmentProps,
  type AudioPeak,
  type AudioTrack,
  type Cel,
  type Channel,
  type Layer,
  type LayerGroup,
  type LayerKind,
  type SpriteSwapCatalog,
  type TextLayerProps,
  type TraceDocument,
  type TransformTrack,
} from './document';
import { newBoneTrack, type Bone, type BoneTrack, type LayerRig, type Mesh, type MeshVertex, type Skeleton } from './rig';
import type { BlendMode, RGB } from './types';

const FORMAT_VERSION = 1;

interface SerializedLayer {
  id: string;
  name: string;
  kind?: LayerKind;
  visible: boolean;
  locked: boolean;
  opacity: number;
  blend: BlendMode;
  clipToBelow: boolean;
  /** Ausente en proyectos anteriores a esta función — normaliza a `false`. */
  alphaLock?: boolean;
  animated: boolean;
  cels: { frame: number; celId: string; label?: string }[];
  transform: TransformTrack;
  /** Ausente en capas sin rig — ver `normalizeLayerRig`. */
  rig?: LayerRig;
  /** El PNG de cada variante va aparte, bajo `swap/<layerId>/<variantId>.png`. */
  swap?: { variants: { id: string; label: string }[]; selected: Channel };
  /** Ausente en capas fuera de una carpeta. */
  groupId?: string;
  /** El PNG de la máscara va aparte, bajo `mask/<layerId>.png`. Ausente en
   *  capas sin máscara. */
  hasMask?: boolean;
  /** Ausente en capas que no son de texto. El cel ya lleva los píxeles
   *  horneados como cualquier otro — esto es sólo para poder reabrir el
   *  cuadro de edición con los mismos valores. */
  text?: TextLayerProps;
  /** Ausente en capas que no son de ajuste. */
  adjustment?: AdjustmentProps;
}

interface SerializedBone {
  id: string;
  name: string;
  parentId: string | null;
  length: number;
  restX: number;
  restY: number;
  restRotation: number;
  track: BoneTrack;
}

interface SerializedSkeleton {
  id: string;
  name: string;
  bones: SerializedBone[];
}

interface SerializedMeshVertex {
  x: number;
  y: number;
  u: number;
  v: number;
  boneIndices: number[];
  boneWeights: number[];
}

interface SerializedMesh {
  id: string;
  vertices: SerializedMeshVertex[];
  triangles: number[];
  skeletonId: string;
}

interface SerializedDoc {
  version: number;
  id: string;
  name: string;
  width: number;
  height: number;
  fps: number;
  frameCount: number;
  paper: RGB;
  paperAlpha: number;
  createdAt: number;
  modifiedAt: number;
  layers: SerializedLayer[];
  /** Ausentes en proyectos anteriores al Módulo de Rigging — ver `normalizeSkeleton`/`normalizeMesh`. */
  skeletons?: SerializedSkeleton[];
  meshes?: SerializedMesh[];
  /** Ausente en proyectos anteriores a las carpetas de capas. */
  layerGroups?: LayerGroup[];
  /** Ausente en proyectos sin pista de audio; el archivo real va aparte,
   *  bajo `audio/<id>` — ver `normalizeAudioTrack`. */
  audio?: AudioTrack;
}

/* ------------------------------------------------------------------ *
 * Utilidades de imagen
 * ------------------------------------------------------------------ */

function canvasFromImageData(data: ImageData): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = data.width;
  c.height = data.height;
  c.getContext('2d')!.putImageData(data, 0, 0);
  return c;
}

function canvasToPngBytes(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) return reject(new Error('No se pudo codificar el PNG'));
      blob
        .arrayBuffer()
        .then((buf) => resolve(new Uint8Array(buf)))
        .catch(reject);
    }, 'image/png');
  });
}

/* ------------------------------------------------------------------ *
 * Proyecto .trace
 * ------------------------------------------------------------------ */

export async function serializeProject(engine: Engine): Promise<Uint8Array> {
  const doc = engine.doc;
  const files: Record<string, Uint8Array> = {};

  const layers: SerializedLayer[] = [];
  for (const layer of doc.layers) {
    const cels: SerializedLayer['cels'] = [];
    for (const [frame, cel] of [...layer.cels].sort((a, b) => a[0] - b[0])) {
      cels.push({ frame, celId: cel.id, label: cel.label });
      if (!cel.surface.empty) {
        const data = engine.renderer.toImageData(
          engine.renderer.ensureResident(cel.surface),
        );
        files[`cels/${cel.id}.png`] = await canvasToPngBytes(canvasFromImageData(data));
      }
    }

    let swap: SerializedLayer['swap'];
    if (layer.swap) {
      const variants: { id: string; label: string }[] = [];
      for (const variant of layer.swap.variants) {
        variants.push({ id: variant.id, label: variant.label });
        if (!variant.surface.empty) {
          const data = engine.renderer.toImageData(
            engine.renderer.ensureResident(variant.surface),
          );
          files[`swap/${layer.id}/${variant.id}.png`] = await canvasToPngBytes(
            canvasFromImageData(data),
          );
        }
      }
      swap = { variants, selected: layer.swap.selected };
    }

    let hasMask = false;
    if (layer.mask) {
      hasMask = true;
      const data = engine.renderer.toImageData(engine.renderer.ensureResident(layer.mask.surface));
      files[`mask/${layer.id}.png`] = await canvasToPngBytes(canvasFromImageData(data));
    }

    layers.push({
      id: layer.id,
      name: layer.name,
      kind: layer.kind,
      visible: layer.visible,
      locked: layer.locked,
      opacity: layer.opacity,
      blend: layer.blend,
      clipToBelow: layer.clipToBelow,
      alphaLock: layer.alphaLock,
      animated: layer.animated,
      cels,
      transform: layer.transform,
      rig: layer.rig,
      swap,
      groupId: layer.groupId,
      hasMask,
      text: layer.text,
      adjustment: layer.adjustment,
    });
  }

  if (doc.audio && engine.audioBytes) {
    files[`audio/${doc.audio.id}`] = engine.audioBytes;
  }

  const meta: SerializedDoc = {
    version: FORMAT_VERSION,
    id: doc.id,
    name: doc.name,
    width: doc.width,
    height: doc.height,
    fps: doc.fps,
    frameCount: doc.frameCount,
    paper: doc.paper,
    paperAlpha: doc.paperAlpha,
    createdAt: doc.createdAt,
    modifiedAt: Date.now(),
    layers,
    skeletons: doc.skeletons,
    meshes: doc.meshes,
    layerGroups: doc.layerGroups,
    audio: doc.audio,
  };
  files['trace.json'] = new TextEncoder().encode(JSON.stringify(meta));

  // Los PNG ya están comprimidos; recomprimirlos sólo gasta tiempo.
  return zipSync(files, { level: 0 });
}

export async function deserializeProject(
  engine: Engine,
  bytes: Uint8Array,
): Promise<TraceDocument> {
  const files = unzipSync(bytes);
  const metaRaw = files['trace.json'];
  if (!metaRaw) throw new Error('El archivo no es un proyecto de Trace válido.');
  const meta = JSON.parse(new TextDecoder().decode(metaRaw)) as SerializedDoc;

  const doc = newDocument(meta.width, meta.height, meta.fps, meta.frameCount);
  doc.id = meta.id;
  doc.name = meta.name;
  doc.paper = meta.paper;
  doc.paperAlpha = meta.paperAlpha ?? 1;
  doc.createdAt = meta.createdAt;
  doc.modifiedAt = meta.modifiedAt;
  doc.layers = [];
  doc.skeletons = normalizeSkeletons(meta.skeletons);
  doc.meshes = normalizeMeshes(meta.meshes);
  doc.layerGroups = normalizeLayerGroups(meta.layerGroups);

  engine.renderer.setDocumentSize(doc.width, doc.height);

  for (const sl of meta.layers) {
    const layer: Layer = {
      id: sl.id,
      name: sl.name,
      // Los proyectos anteriores a esta versión no llevan `kind`: son dibujo.
      kind: sl.kind ?? 'draw',
      visible: sl.visible,
      locked: sl.locked,
      opacity: sl.opacity,
      blend: sl.blend,
      clipToBelow: sl.clipToBelow,
      alphaLock: sl.alphaLock ?? false,
      animated: sl.animated,
      cels: new Map(),
      transform: normalizeTransform(sl.transform),
      rig: normalizeLayerRig(sl.rig),
      groupId: sl.groupId,
      text: sl.text,
      adjustment: sl.adjustment,
    };
    for (const sc of sl.cels) {
      const cel: Cel = {
        id: sc.celId,
        surface: engine.renderer.createSurface('cel'),
        label: sc.label,
      };
      const png = files[`cels/${sc.celId}.png`];
      if (png) {
        const bitmap = await createImageBitmap(
          new Blob([png as BlobPart], { type: 'image/png' }),
        );
        engine.renderer.uploadImage(cel.surface, bitmap);
        bitmap.close();
      }
      layer.cels.set(sc.frame, cel);
    }
    if (sl.swap) {
      const catalog: SpriteSwapCatalog = { variants: [], selected: sl.swap.selected };
      for (const sv of sl.swap.variants) {
        const surface = engine.renderer.createSurface('swap');
        const png = files[`swap/${sl.id}/${sv.id}.png`];
        if (png) {
          const bitmap = await createImageBitmap(
            new Blob([png as BlobPart], { type: 'image/png' }),
          );
          engine.renderer.uploadImage(surface, bitmap);
          bitmap.close();
        }
        catalog.variants.push({ id: sv.id, label: sv.label, surface });
      }
      layer.swap = catalog;
    }
    if (sl.hasMask) {
      const surface = engine.renderer.createSurface('mask');
      const png = files[`mask/${sl.id}.png`];
      if (png) {
        const bitmap = await createImageBitmap(new Blob([png as BlobPart], { type: 'image/png' }));
        engine.renderer.uploadImage(surface, bitmap);
        bitmap.close();
      } else {
        // Nunca debería faltar el PNG si `hasMask` es cierto, pero por si
        // acaso: una máscara sin datos es "revela todo", no "oculta todo".
        engine.renderer.fill(surface, { r: 1, g: 1, b: 1 }, 1);
      }
      layer.mask = { surface };
    }
    doc.layers.push(layer);
  }

  if (doc.layers.length === 0) doc.layers.push(newLayer('Capa 1'));

  if (meta.audio) {
    doc.audio = normalizeAudioTrack(meta.audio);
    const audioBytes = files[`audio/${doc.audio.id}`];
    // Sin los bytes no hay con qué reconstruir el `<audio>` — se conservan
    // los metadatos (para no perder la forma de onda) pero sin reproductor;
    // no debería pasar salvo un .trace tocado a mano.
    if (audioBytes) engine.attachAudioBytes(audioBytes, doc.audio.mimeType);
  }

  return doc;
}

/** Rellena canales que falten si el archivo viene de una versión anterior. */
function normalizeTransform(t: Partial<TransformTrack> | undefined): TransformTrack {
  const ch = (c: Channel | undefined, base: number): Channel =>
    c && Array.isArray(c.keys) ? c : { base, keys: [] };
  return {
    x: ch(t?.x, 0),
    y: ch(t?.y, 0),
    scale: ch(t?.scale, 1),
    rotation: ch(t?.rotation, 0),
    opacity: ch(t?.opacity, 1),
  };
}

/* ------------------------------------------------------------------ *
 * Rig: esqueletos, mallas y catálogos de intercambio de sprites.
 * Todos son campos opcionales de `SerializedDoc`/`SerializedLayer` — un
 * `.trace` de antes del Módulo de Rigging no los lleva, y estas funciones
 * rellenan valores base en vez de lanzar, siguiendo el mismo criterio que
 * `normalizeTransform`. No hace falta subir `FORMAT_VERSION` por esto.
 * ------------------------------------------------------------------ */

function normalizeBoneTrack(t: Partial<BoneTrack> | undefined): BoneTrack {
  const ch = (c: Channel | undefined, base: number): Channel =>
    c && Array.isArray(c.keys) ? c : { base, keys: [] };
  const base = newBoneTrack();
  return {
    x: ch(t?.x, base.x.base),
    y: ch(t?.y, base.y.base),
    rotation: ch(t?.rotation, base.rotation.base),
    scaleX: ch(t?.scaleX, base.scaleX.base),
    scaleY: ch(t?.scaleY, base.scaleY.base),
  };
}

function normalizeBone(b: Partial<SerializedBone>): Bone {
  return {
    id: b.id ?? uid('bone'),
    name: b.name ?? 'Hueso',
    parentId: b.parentId ?? null,
    length: b.length ?? 80,
    restX: b.restX ?? 0,
    restY: b.restY ?? 0,
    restRotation: b.restRotation ?? 0,
    track: normalizeBoneTrack(b.track),
  };
}

function normalizeSkeletons(list: SerializedSkeleton[] | undefined): Skeleton[] {
  if (!Array.isArray(list)) return [];
  return list.map((s) => ({
    id: s.id ?? uid('skel'),
    name: s.name ?? 'Esqueleto',
    bones: Array.isArray(s.bones) ? s.bones.map(normalizeBone) : [],
  }));
}

function normalizeMeshVertex(v: Partial<SerializedMeshVertex>): MeshVertex {
  const idx = Array.isArray(v.boneIndices) ? v.boneIndices : [0, 0, 0, 0];
  const w = Array.isArray(v.boneWeights) ? v.boneWeights : [1, 0, 0, 0];
  return {
    x: v.x ?? 0,
    y: v.y ?? 0,
    u: v.u ?? 0,
    v: v.v ?? 0,
    boneIndices: [idx[0] ?? 0, idx[1] ?? 0, idx[2] ?? 0, idx[3] ?? 0],
    boneWeights: [w[0] ?? 0, w[1] ?? 0, w[2] ?? 0, w[3] ?? 0],
  };
}

function normalizeMeshes(list: SerializedMesh[] | undefined): Mesh[] {
  if (!Array.isArray(list)) return [];
  return list.map((m) => ({
    id: m.id ?? uid('mesh'),
    vertices: Array.isArray(m.vertices) ? m.vertices.map(normalizeMeshVertex) : [],
    triangles: Array.isArray(m.triangles) ? m.triangles : [],
    skeletonId: m.skeletonId ?? '',
  }));
}

function normalizeLayerRig(r: LayerRig | undefined): LayerRig | undefined {
  if (!r) return undefined;
  return { skeletonId: r.skeletonId, boneId: r.boneId ?? null, meshId: r.meshId ?? null };
}

function normalizeLayerGroups(list: LayerGroup[] | undefined): LayerGroup[] {
  if (!Array.isArray(list)) return [];
  return list.map((g) => ({
    id: g.id ?? uid('grp'),
    name: g.name ?? 'Grupo',
    collapsed: g.collapsed ?? false,
  }));
}

function normalizeAudioTrack(a: Partial<AudioTrack>): AudioTrack {
  return {
    id: a.id ?? uid('audio'),
    name: a.name ?? 'Audio',
    duration: a.duration ?? 0,
    mimeType: a.mimeType ?? 'audio/mpeg',
    peaks: Array.isArray(a.peaks) ? a.peaks : [],
    offset: a.offset ?? 0,
    muted: a.muted ?? false,
  };
}

/* ------------------------------------------------------------------ *
 * Exportación
 * ------------------------------------------------------------------ */

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Damos margen a Safari, que a veces cancela la descarga si se revoca ya.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export async function exportFramePNG(engine: Engine, frame: number): Promise<Blob> {
  const data = engine.renderFrameToImageData(frame);
  const canvas = canvasFromImageData(data);
  const bytes = await canvasToPngBytes(canvas);
  return new Blob([bytes as BlobPart], { type: 'image/png' });
}

export async function exportSequenceZip(
  engine: Engine,
  onProgress?: (done: number, total: number) => void,
): Promise<Blob> {
  const files: Record<string, Uint8Array> = {};
  const total = engine.doc.frameCount;
  const pad = String(total).length;
  for (let f = 0; f < total; f++) {
    const data = engine.renderFrameToImageData(f);
    files[`${engine.doc.name}_${String(f).padStart(pad, '0')}.png`] =
      await canvasToPngBytes(canvasFromImageData(data));
    onProgress?.(f + 1, total);
    // Cedemos el hilo para que la UI siga respondiendo.
    await new Promise((r) => setTimeout(r, 0));
  }
  return new Blob([zipSync(files, { level: 0 }) as BlobPart], { type: 'application/zip' });
}

/* --- APNG ---------------------------------------------------------- *
 * Ensamblamos el APNG a partir de los PNG que ya genera el canvas: sólo hay
 * que reempaquetar chunks. Evita meter un codificador de vídeo y conserva
 * transparencia y color sin pérdida, cosa que ni GIF ni WebM dan gratis.
 * ------------------------------------------------------------------- */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

interface Chunk {
  type: string;
  data: Uint8Array;
}

function readChunks(png: Uint8Array): Chunk[] {
  const chunks: Chunk[] = [];
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let off = 8; // salta la firma
  while (off < png.length) {
    const len = view.getUint32(off);
    const type = String.fromCharCode(png[off + 4], png[off + 5], png[off + 6], png[off + 7]);
    chunks.push({ type, data: png.subarray(off + 8, off + 8 + len) });
    off += 12 + len;
  }
  return chunks;
}

function makeChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

export async function exportAPNG(
  engine: Engine,
  onProgress?: (done: number, total: number) => void,
): Promise<Blob> {
  const { frameCount, fps, width, height } = engine.doc;
  const framePngs: Uint8Array[] = [];
  for (let f = 0; f < frameCount; f++) {
    const data = engine.renderFrameToImageData(f);
    framePngs.push(await canvasToPngBytes(canvasFromImageData(data)));
    onProgress?.(f + 1, frameCount);
    await new Promise((r) => setTimeout(r, 0));
  }

  const parts: Uint8Array[] = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])];
  const first = readChunks(framePngs[0]);
  const ihdr = first.find((c) => c.type === 'IHDR')!;
  parts.push(makeChunk('IHDR', ihdr.data));

  // acTL: número de fotogramas y repeticiones (0 = bucle infinito).
  const actl = new Uint8Array(8);
  new DataView(actl.buffer).setUint32(0, frameCount);
  new DataView(actl.buffer).setUint32(4, 0);
  parts.push(makeChunk('acTL', actl));

  // El denominador de retardo es uint16: 1000/fps*1000 se sale por encima de
  // 65 fps, así que escalamos a la baja en ese caso.
  const den = fps * 1000 <= 65535 ? fps * 1000 : fps * 10;
  const num = fps * 1000 <= 65535 ? 1000 : 10;

  let sequence = 0;
  for (let f = 0; f < frameCount; f++) {
    const fctl = new Uint8Array(26);
    const dv = new DataView(fctl.buffer);
    dv.setUint32(0, sequence++);
    dv.setUint32(4, width);
    dv.setUint32(8, height);
    dv.setUint32(12, 0); // x_offset
    dv.setUint32(16, 0); // y_offset
    dv.setUint16(20, num);
    dv.setUint16(22, den);
    fctl[24] = 1; // dispose_op: limpiar a transparente antes del siguiente
    fctl[25] = 0; // blend_op: SOURCE, cada fotograma reemplaza al anterior
    parts.push(makeChunk('fcTL', fctl));

    const idats = readChunks(framePngs[f]).filter((c) => c.type === 'IDAT');
    for (const idat of idats) {
      if (f === 0) {
        parts.push(makeChunk('IDAT', idat.data));
      } else {
        const fdat = new Uint8Array(4 + idat.data.length);
        new DataView(fdat.buffer).setUint32(0, sequence++);
        fdat.set(idat.data, 4);
        parts.push(makeChunk('fdAT', fdat));
      }
    }
  }

  parts.push(makeChunk('IEND', new Uint8Array(0)));
  return new Blob(parts as BlobPart[], { type: 'image/apng' });
}

/* ------------------------------------------------------------------ *
 * Autoguardado en IndexedDB
 * ------------------------------------------------------------------ */

const DB_NAME = 'trace';
const STORE = 'projects';

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(key: string, value: unknown): Promise<void> {
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

async function idbGet<T>(key: string): Promise<T | undefined> {
  const db = await openDB();
  const result = await new Promise<T | undefined>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return result;
}

export interface AutosaveRecord {
  bytes: Uint8Array;
  name: string;
  savedAt: number;
}

export async function autosave(engine: Engine): Promise<void> {
  const bytes = await serializeProject(engine);
  const record: AutosaveRecord = {
    bytes,
    name: engine.doc.name,
    savedAt: Date.now(),
  };
  await idbPut('autosave', record);
}

export async function loadAutosave(): Promise<AutosaveRecord | undefined> {
  try {
    return await idbGet<AutosaveRecord>('autosave');
  } catch {
    return undefined;
  }
}

export function newProjectId(): string {
  return uid('doc');
}

/** Fotogramas que realmente tienen dibujo, para avisar antes de exportar. */
export function documentIsEmpty(doc: TraceDocument): boolean {
  for (const layer of doc.layers) {
    // Una capa de referencia no cuenta: no sale en la exportación.
    if (layer.kind === 'reference') continue;
    for (let f = 0; f < doc.frameCount; f++) {
      const cel = celAt(layer, f);
      if (cel && !cel.surface.empty) return false;
    }
  }
  return true;
}

/* ------------------------------------------------------------------ *
 * Importar imagen o vídeo de referencia (rotoscopia)
 * ------------------------------------------------------------------ */

function baseName(filename: string): string {
  return filename.replace(/\.[^./]+$/, '') || filename;
}

/**
 * Audio: decodifica el archivo para calcular los picos de la forma de onda
 * (`AudioPeak[]`) una sola vez aquí, y le pasa a `engine.setAudioTrack` el
 * resultado ya listo — el motor sólo engancha el `<audio>`, no decodifica
 * nada. Se cierra el `AudioContext` en cuanto termina: no hace falta uno
 * en marcha para simplemente reproducir el elemento después.
 */
export async function importAudioTrack(engine: Engine, file: File): Promise<void> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const AudioCtx =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new AudioCtx();
  let duration = 0;
  const peaks: AudioPeak[] = [];
  try {
    // `decodeAudioData` transfiere y vacía el ArrayBuffer que recibe; se le
    // pasa una copia para poder quedarse con `bytes` intactos y guardarlos
    // tal cual en el .trace al exportar.
    const buffer = await ctx.decodeAudioData(bytes.slice().buffer as ArrayBuffer);
    duration = buffer.duration;
    const data = buffer.getChannelData(0);
    const BUCKETS = 800;
    const bucketSize = Math.max(1, Math.floor(data.length / BUCKETS));
    for (let i = 0; i < BUCKETS; i++) {
      const start = i * bucketSize;
      const end = Math.min(data.length, start + bucketSize);
      let min = 0;
      let max = 0;
      for (let j = start; j < end; j++) {
        const v = data[j];
        if (v < min) min = v;
        if (v > max) max = v;
      }
      peaks.push({ min, max });
    }
  } finally {
    await ctx.close();
  }
  engine.setAudioTrack(bytes, file.type || 'audio/mpeg', baseName(file.name), duration, peaks);
}

/** Imagen suelta: una capa de referencia con un único cel sostenido. */
export async function importReferenceImage(engine: Engine, file: File): Promise<void> {
  const bitmap = await createImageBitmap(file);
  try {
    const layer = engine.beginReferenceImport(baseName(file.name), false);
    engine.addReferenceFrame(layer, 0, bitmap, bitmap.width, bitmap.height);
    engine.finishReferenceImport(layer, 'Importar imagen de referencia');
  } finally {
    bitmap.close();
  }
}

/**
 * Vídeo: una capa de referencia con un cel por fotograma del documento, para
 * calcar cuadro por cuadro. Extrae buscando (`seek`) en vez de reproducir en
 * tiempo real porque necesitamos fotogramas exactos, no lo que caiga a 60 Hz.
 */
export async function importReferenceVideo(
  engine: Engine,
  file: File,
  onProgress?: (done: number, total: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  let layer: Layer | null = null;
  try {
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.src = url;
    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new Error('No se pudo leer el vídeo.'));
    });

    const duration = video.duration;
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error('El vídeo no tiene una duración válida.');
    }
    const fps = engine.doc.fps;
    const frameCount = Math.max(1, Math.min(MAX_FRAME_COUNT, Math.round(duration * fps)));
    const startFrame = engine.currentFrame;

    layer = engine.beginReferenceImport(baseName(file.name), true);
    for (let i = 0; i < frameCount; i++) {
      // Cada fotograma es un `seek` + subida a GPU secuenciales: en un
      // clip largo un cuadro de por medio no basta, hay que poder cortar
      // a media importación en vez de esperar a que termine sola.
      if (signal?.aborted) throw new DOMException('Importación cancelada', 'AbortError');
      const t = Math.min(i / fps, Math.max(0, duration - 1 / fps));
      await seekVideo(video, t);
      engine.addReferenceFrame(layer, startFrame + i, video, video.videoWidth, video.videoHeight);
      onProgress?.(i + 1, frameCount);
    }
    engine.finishReferenceImport(layer, 'Importar vídeo de referencia');
  } catch (err) {
    if (layer) engine.discardReferenceImport(layer);
    throw err;
  } finally {
    video.src = '';
    URL.revokeObjectURL(url);
  }
}

/**
 * Espera a que el vídeo tenga decodificado el fotograma en `t`.
 *
 * Si ya está ahí, `seeked` no llega a dispararse; y en algún navegador puede
 * no llegar nunca. El plazo evita colgar la importación entera por un solo
 * fotograma flojo — a cambio, en el peor caso ese fotograma sale duplicado.
 */
function seekVideo(video: HTMLVideoElement, t: number): Promise<void> {
  return new Promise((resolve) => {
    if (Math.abs(video.currentTime - t) < 1 / 240 && video.readyState >= 2) {
      resolve();
      return;
    }
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      video.removeEventListener('seeked', finish);
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, 2000);
    video.addEventListener('seeked', finish);
    video.currentTime = t;
  });
}
