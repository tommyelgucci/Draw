import { unzipSync, zipSync } from 'fflate';
import type { Engine } from './engine';
import {
  celAt,
  newDocument,
  newLayer,
  uid,
  type Cel,
  type Channel,
  type Layer,
  type LayerKind,
  type TraceDocument,
  type TransformTrack,
} from './document';
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
  animated: boolean;
  cels: { frame: number; celId: string; label?: string }[];
  transform: TransformTrack;
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
    layers.push({
      id: layer.id,
      name: layer.name,
      kind: layer.kind,
      visible: layer.visible,
      locked: layer.locked,
      opacity: layer.opacity,
      blend: layer.blend,
      clipToBelow: layer.clipToBelow,
      animated: layer.animated,
      cels,
      transform: layer.transform,
    });
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
      animated: sl.animated,
      cels: new Map(),
      transform: normalizeTransform(sl.transform),
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
    doc.layers.push(layer);
  }

  if (doc.layers.length === 0) doc.layers.push(newLayer('Capa 1'));
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
    const frameCount = Math.max(1, Math.min(2000, Math.round(duration * fps)));
    const startFrame = engine.currentFrame;

    layer = engine.beginReferenceImport(baseName(file.name), true);
    for (let i = 0; i < frameCount; i++) {
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
