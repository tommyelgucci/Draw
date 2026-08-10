import { ArrayBufferTarget, Muxer } from 'mp4-muxer';
import {
  ArrayBufferTarget as WebMTarget,
  Muxer as WebMMuxer,
} from 'webm-muxer';
import type { Engine } from './engine';

export interface VideoExportOptions {
  /** 0..1; escala el bitrate calculado a partir de la resolución. */
  quality: number;
  onProgress?: (done: number, total: number) => void;
}

export interface VideoExportResult {
  blob: Blob;
  extension: string;
  /** Qué ruta se acabó usando, para poder decírselo al usuario. */
  method: 'webcodecs' | 'mediarecorder';
  codec: string;
}

/**
 * Perfiles H.264 de mayor a menor capacidad. Se prueban en orden porque el
 * nivel limita resolución y tasa: Baseline 3.1 no admite 1080p, así que fijar
 * un solo string dejaría fuera los lienzos grandes en unos navegadores y los
 * pequeños en otros.
 */
const AVC_CODECS = [
  'avc1.640034', // High 5.2
  'avc1.640028', // High 4.0
  'avc1.4d0034', // Main 5.2
  'avc1.4d0028', // Main 4.0
  'avc1.42001f', // Baseline 3.1
];

/**
 * Alternativa cuando falta el codificador H.264.
 *
 * No es un caso raro: Chromium compilado sin códecs propietarios —el de
 * muchas distribuciones de Linux y varios Android— decodifica H.264 pero no
 * lo codifica. Sin esta ruta, esos usuarios caerían a la grabación en tiempo
 * real aun teniendo WebCodecs delante.
 */
const VPX_CODECS = [
  'vp09.00.10.08', // VP9, perfil 0, 8 bits
  'vp8',
];

/** Contenedores de MediaRecorder, en orden de preferencia. */
const RECORDER_TYPES = [
  'video/mp4;codecs=avc1',
  'video/mp4',
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
];

function hasWebCodecs(): boolean {
  return typeof globalThis.VideoEncoder === 'function';
}

/**
 * H.264 exige dimensiones pares. Recortar un píxel es preferible a escalar:
 * no reinterpola el dibujo.
 */
function evenSize(w: number, h: number): [number, number] {
  return [w - (w % 2), h - (h % 2)];
}

function bitrateFor(w: number, h: number, fps: number, quality: number): number {
  // 0,10 bits por píxel y fotograma da un H.264 limpio para dibujo plano,
  // que comprime mucho mejor que imagen real.
  const base = w * h * fps * 0.1;
  return Math.round(Math.max(600_000, Math.min(base * (0.4 + quality), 60_000_000)));
}

/**
 * Lienzo intermedio con el papel debajo.
 *
 * El vídeo no tiene canal alfa: sin este paso, un documento con papel
 * transparente saldría con el fondo en negro en vez de en blanco.
 */
function makeFrameCanvas(w: number, h: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  return canvas;
}

function paperStyle(engine: Engine): string {
  const { paper, paperAlpha } = engine.doc;
  if (paperAlpha <= 0) return '#ffffff';
  const to = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255);
  return `rgb(${to(paper.r)}, ${to(paper.g)}, ${to(paper.b)})`;
}

/**
 * De dónde saca cada fotograma un vídeo — hoy sólo la anima­ción del
 * documento (`animationFrameSource`); el time-lapse tiene su propio par de
 * funciones (`exportSequenceWithWebCodecs`/`exportSequenceWithRecorder`,
 * más abajo) porque parte de una lista de lienzos ya en memoria, no de
 * `doc.frameCount`. `exportWithWebCodecs`/`exportWithRecorder` no saben ni
 * les importa de dónde sale cada fotograma: sólo piden `frameImage(i)`.
 */
interface FrameSource {
  width: number;
  height: number;
  fps: number;
  frameCount: number;
  background: string;
  frameImage(index: number): CanvasImageSource;
}

/** `drawImage` no acepta `ImageData` directo — hace falta un lienzo suelto
 *  de por medio. */
function imageDataToCanvas(data: ImageData): HTMLCanvasElement {
  const tmp = document.createElement('canvas');
  tmp.width = data.width;
  tmp.height = data.height;
  tmp.getContext('2d')!.putImageData(data, 0, 0);
  return tmp;
}

function animationFrameSource(engine: Engine): FrameSource {
  const { width, height, fps, frameCount } = engine.doc;
  return {
    width,
    height,
    fps,
    frameCount,
    background: paperStyle(engine),
    frameImage: (f) => imageDataToCanvas(engine.renderFrameToImageData(f)),
  };
}

function drawFrame(
  source: FrameSource,
  ctx: CanvasRenderingContext2D,
  frame: number,
  w: number,
  h: number,
) {
  ctx.fillStyle = source.background;
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(source.frameImage(frame), 0, 0);
}

/* ------------------------------------------------------------------ *
 * Ruta preferente: WebCodecs + muxado a MP4
 * ------------------------------------------------------------------ */

async function firstSupported(
  codecs: string[],
  w: number,
  h: number,
  fps: number,
  bitrate: number,
): Promise<string | null> {
  for (const codec of codecs) {
    try {
      const support = await VideoEncoder.isConfigSupported({
        codec,
        width: w,
        height: h,
        bitrate,
        framerate: fps,
      });
      if (support.supported) return codec;
    } catch {
      // Un códec no soportado puede lanzar en vez de responder que no.
    }
  }
  return null;
}

/** Elige contenedor y códec según lo que sepa codificar este navegador. */
async function pickEncoding(w: number, h: number, fps: number, bitrate: number) {
  const avc = await firstSupported(AVC_CODECS, w, h, fps, bitrate);
  if (avc) return { codec: avc, container: 'mp4' as const };
  const vpx = await firstSupported(VPX_CODECS, w, h, fps, bitrate);
  if (vpx) return { codec: vpx, container: 'webm' as const };
  return null;
}

async function exportWithWebCodecs(
  source: FrameSource,
  opts: VideoExportOptions,
): Promise<VideoExportResult | null> {
  const { fps, frameCount } = source;
  const [w, h] = evenSize(source.width, source.height);
  const bitrate = bitrateFor(w, h, fps, opts.quality);

  const picked = await pickEncoding(w, h, fps, bitrate);
  if (!picked) return null;
  const { codec, container } = picked;

  const mp4Muxer =
    container === 'mp4'
      ? new Muxer({
          target: new ArrayBufferTarget(),
          video: { codec: 'avc', width: w, height: h, frameRate: fps },
          // Deja el índice al principio del archivo: sin esto, reproductores
          // y webs tienen que descargarlo entero antes de empezar.
          fastStart: 'in-memory',
        })
      : null;
  const webmMuxer =
    container === 'webm'
      ? new WebMMuxer({
          target: new WebMTarget(),
          video: {
            codec: codec.startsWith('vp09') ? 'V_VP9' : 'V_VP8',
            width: w,
            height: h,
            frameRate: fps,
          },
        })
      : null;

  let failure: Error | null = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      if (mp4Muxer) mp4Muxer.addVideoChunk(chunk, meta);
      else webmMuxer!.addVideoChunk(chunk, meta);
    },
    error: (e) => {
      failure = e instanceof Error ? e : new Error(String(e));
    },
  });
  encoder.configure({ codec, width: w, height: h, bitrate, framerate: fps });

  const canvas = makeFrameCanvas(w, h);
  const ctx = canvas.getContext('2d')!;
  const frameDuration = 1_000_000 / fps;

  for (let f = 0; f < frameCount; f++) {
    if (failure) break;
    drawFrame(source, ctx, f, w, h);

    const videoFrame = new VideoFrame(canvas, {
      timestamp: Math.round(f * frameDuration),
      duration: Math.round(frameDuration),
    });
    // Un keyframe cada dos segundos: permite saltar por la línea de tiempo
    // sin inflar el archivo.
    encoder.encode(videoFrame, { keyFrame: f % Math.max(1, fps * 2) === 0 });
    videoFrame.close();

    opts.onProgress?.(f + 1, frameCount);
    // La cola del codificador crece más rápido de lo que drena; sin ceder el
    // hilo la pestaña se queda sin memoria en animaciones largas.
    if (encoder.encodeQueueSize > 8) {
      await new Promise<void>((resolve) => {
        const wait = () =>
          encoder.encodeQueueSize > 4 ? setTimeout(wait, 8) : resolve();
        wait();
      });
    } else {
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  await encoder.flush();
  encoder.close();
  if (failure) throw failure;

  if (mp4Muxer) {
    mp4Muxer.finalize();
    return {
      blob: new Blob([(mp4Muxer.target as ArrayBufferTarget).buffer], {
        type: 'video/mp4',
      }),
      extension: 'mp4',
      method: 'webcodecs',
      codec,
    };
  }
  webmMuxer!.finalize();
  return {
    blob: new Blob([(webmMuxer!.target as WebMTarget).buffer], { type: 'video/webm' }),
    extension: 'webm',
    method: 'webcodecs',
    codec,
  };
}

/* ------------------------------------------------------------------ *
 * Alternativa: MediaRecorder sobre un canvas
 * ------------------------------------------------------------------ */

interface CaptureTrack extends MediaStreamTrack {
  requestFrame?: () => void;
}

async function exportWithRecorder(
  source: FrameSource,
  opts: VideoExportOptions,
): Promise<VideoExportResult> {
  if (typeof MediaRecorder === 'undefined') {
    throw new Error('Este navegador no puede exportar vídeo.');
  }
  const mimeType = RECORDER_TYPES.find((t) => MediaRecorder.isTypeSupported(t));
  if (!mimeType) throw new Error('Este navegador no ofrece ningún formato de vídeo.');

  const { fps, frameCount } = source;
  const [w, h] = evenSize(source.width, source.height);
  const canvas = makeFrameCanvas(w, h);
  const ctx = canvas.getContext('2d')!;

  // Con `requestFrame` controlamos cuándo entra cada fotograma; sin él hay
  // que dejar que el navegador muestree el canvas a la fps pedida.
  const stream = canvas.captureStream(0) as MediaStream;
  const track = stream.getVideoTracks()[0] as CaptureTrack;
  const manual = typeof track.requestFrame === 'function';
  const timedStream = manual ? stream : (canvas.captureStream(fps) as MediaStream);

  const chunks: BlobPart[] = [];
  const recorder = new MediaRecorder(timedStream, {
    mimeType,
    videoBitsPerSecond: bitrateFor(w, h, fps, opts.quality),
  });
  recorder.ondataavailable = (e) => e.data.size > 0 && chunks.push(e.data);

  const finished = new Promise<void>((resolve, reject) => {
    recorder.onstop = () => resolve();
    recorder.onerror = () => reject(new Error('Falló la grabación del vídeo.'));
  });

  recorder.start();
  const step = 1000 / fps;
  for (let f = 0; f < frameCount; f++) {
    drawFrame(source, ctx, f, w, h);
    if (manual) track.requestFrame!();
    opts.onProgress?.(f + 1, frameCount);
    // Esta ruta graba en tiempo real: exportar 4 segundos tarda 4 segundos.
    await new Promise((r) => setTimeout(r, step));
  }
  recorder.stop();
  await finished;

  const extension = mimeType.startsWith('video/mp4') ? 'mp4' : 'webm';
  return {
    blob: new Blob(chunks, { type: mimeType }),
    extension,
    method: 'mediarecorder',
    codec: mimeType,
  };
}

/* ------------------------------------------------------------------ *
 * Time-lapse: mismo par de rutas de codificación que `exportVideo`, pero
 * la fuente es una lista de lienzos ya renderizados (capturas periódicas
 * mientras se dibuja — ver `Engine.timelapseFrames`) en vez del documento
 * animado. Se duplica el cuerpo de `exportWithWebCodecs`/`exportWithRecorder`
 * en vez de generalizarlos: la fuente de fotogramas de la exportación
 * normal (`drawFrame`, ligada a `engine.doc`) y la del time-lapse (una
 * lista ya en memoria) son lo bastante distintas como para que forzar un
 * parámetro común complique más de lo que ahorra, y así la ruta de
 * exportación normal —ya probada— no se toca en absoluto.
 * ------------------------------------------------------------------ */

async function exportSequenceWithWebCodecs(
  frames: HTMLCanvasElement[],
  fps: number,
  quality: number,
  onProgress?: (done: number, total: number) => void,
): Promise<VideoExportResult | null> {
  const [w, h] = evenSize(frames[0].width, frames[0].height);
  const bitrate = bitrateFor(w, h, fps, quality);

  const picked = await pickEncoding(w, h, fps, bitrate);
  if (!picked) return null;
  const { codec, container } = picked;

  const mp4Muxer =
    container === 'mp4'
      ? new Muxer({
          target: new ArrayBufferTarget(),
          video: { codec: 'avc', width: w, height: h, frameRate: fps },
          fastStart: 'in-memory',
        })
      : null;
  const webmMuxer =
    container === 'webm'
      ? new WebMMuxer({
          target: new WebMTarget(),
          video: {
            codec: codec.startsWith('vp09') ? 'V_VP9' : 'V_VP8',
            width: w,
            height: h,
            frameRate: fps,
          },
        })
      : null;

  let failure: Error | null = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      if (mp4Muxer) mp4Muxer.addVideoChunk(chunk, meta);
      else webmMuxer!.addVideoChunk(chunk, meta);
    },
    error: (e) => {
      failure = e instanceof Error ? e : new Error(String(e));
    },
  });
  encoder.configure({ codec, width: w, height: h, bitrate, framerate: fps });

  const canvas = makeFrameCanvas(w, h);
  const ctx = canvas.getContext('2d')!;
  const frameDuration = 1_000_000 / fps;

  for (let i = 0; i < frames.length; i++) {
    if (failure) break;
    ctx.drawImage(frames[i], 0, 0, w, h);

    const videoFrame = new VideoFrame(canvas, {
      timestamp: Math.round(i * frameDuration),
      duration: Math.round(frameDuration),
    });
    encoder.encode(videoFrame, { keyFrame: i % Math.max(1, fps * 2) === 0 });
    videoFrame.close();

    onProgress?.(i + 1, frames.length);
    if (encoder.encodeQueueSize > 8) {
      await new Promise<void>((resolve) => {
        const wait = () =>
          encoder.encodeQueueSize > 4 ? setTimeout(wait, 8) : resolve();
        wait();
      });
    } else {
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  await encoder.flush();
  encoder.close();
  if (failure) throw failure;

  if (mp4Muxer) {
    mp4Muxer.finalize();
    return {
      blob: new Blob([(mp4Muxer.target as ArrayBufferTarget).buffer], { type: 'video/mp4' }),
      extension: 'mp4',
      method: 'webcodecs',
      codec,
    };
  }
  webmMuxer!.finalize();
  return {
    blob: new Blob([(webmMuxer!.target as WebMTarget).buffer], { type: 'video/webm' }),
    extension: 'webm',
    method: 'webcodecs',
    codec,
  };
}

async function exportSequenceWithRecorder(
  frames: HTMLCanvasElement[],
  fps: number,
  quality: number,
  onProgress?: (done: number, total: number) => void,
): Promise<VideoExportResult> {
  if (typeof MediaRecorder === 'undefined') {
    throw new Error('Este navegador no puede exportar vídeo.');
  }
  const mimeType = RECORDER_TYPES.find((t) => MediaRecorder.isTypeSupported(t));
  if (!mimeType) throw new Error('Este navegador no ofrece ningún formato de vídeo.');

  const [w, h] = evenSize(frames[0].width, frames[0].height);
  const canvas = makeFrameCanvas(w, h);
  const ctx = canvas.getContext('2d')!;

  const stream = canvas.captureStream(0) as MediaStream;
  const track = stream.getVideoTracks()[0] as CaptureTrack;
  const manual = typeof track.requestFrame === 'function';
  const timedStream = manual ? stream : (canvas.captureStream(fps) as MediaStream);

  const chunks: BlobPart[] = [];
  const recorder = new MediaRecorder(timedStream, {
    mimeType,
    videoBitsPerSecond: bitrateFor(w, h, fps, quality),
  });
  recorder.ondataavailable = (e) => e.data.size > 0 && chunks.push(e.data);

  const finished = new Promise<void>((resolve, reject) => {
    recorder.onstop = () => resolve();
    recorder.onerror = () => reject(new Error('Falló la grabación del vídeo.'));
  });

  recorder.start();
  const step = 1000 / fps;
  for (let i = 0; i < frames.length; i++) {
    ctx.drawImage(frames[i], 0, 0, w, h);
    if (manual) track.requestFrame!();
    onProgress?.(i + 1, frames.length);
    await new Promise((r) => setTimeout(r, step));
  }
  recorder.stop();
  await finished;

  const extension = mimeType.startsWith('video/mp4') ? 'mp4' : 'webm';
  return {
    blob: new Blob(chunks, { type: mimeType }),
    extension,
    method: 'mediarecorder',
    codec: mimeType,
  };
}

/** Exporta las capturas de un time-lapse como vídeo — mismo par de rutas
 *  que `exportVideo`, fuente distinta. */
export async function exportImageSequenceAsVideo(
  frames: HTMLCanvasElement[],
  fps: number,
  quality: number,
  onProgress?: (done: number, total: number) => void,
): Promise<VideoExportResult> {
  if (frames.length === 0) throw new Error('No hay fotogramas que exportar.');
  if (hasWebCodecs()) {
    try {
      const result = await exportSequenceWithWebCodecs(frames, fps, quality, onProgress);
      if (result) return result;
    } catch (err) {
      console.warn('WebCodecs falló, se intenta con MediaRecorder', err);
    }
  }
  return exportSequenceWithRecorder(frames, fps, quality, onProgress);
}

/**
 * Exporta la animación como vídeo.
 *
 * Se prefiere WebCodecs porque codifica tan rápido como pueda la máquina y
 * pone los tiempos exactos de cada fotograma. MediaRecorder es la reserva:
 * graba en tiempo real y depende del reloj, así que un tirón del navegador
 * se cuela en el archivo.
 */
export async function exportVideo(
  engine: Engine,
  opts: VideoExportOptions,
): Promise<VideoExportResult> {
  const source = animationFrameSource(engine);
  if (hasWebCodecs()) {
    try {
      const result = await exportWithWebCodecs(source, opts);
      if (result) return result;
    } catch (err) {
      console.warn('WebCodecs falló, se intenta con MediaRecorder', err);
    }
  }
  return exportWithRecorder(source, opts);
}

export interface VideoSupport {
  available: boolean;
  /** true si hay que grabar en tiempo real, con lo que exportar tarda lo que dura. */
  realtime: boolean;
  label: string;
}

/**
 * Qué ruta usaría este navegador, para avisar antes de empezar.
 *
 * Comprueba de verdad qué códecs hay en vez de suponer que WebCodecs implica
 * H.264: el navegador puede tener la API y no el codificador.
 */
export async function describeVideoSupport(
  width = 1920,
  height = 1080,
  fps = 24,
): Promise<VideoSupport> {
  const [w, h] = evenSize(width, height);
  if (hasWebCodecs()) {
    const picked = await pickEncoding(w, h, fps, bitrateFor(w, h, fps, 0.7));
    if (picked) {
      return {
        available: true,
        realtime: false,
        label: picked.container === 'mp4' ? 'MP4 (H.264)' : 'WebM (VP9)',
      };
    }
  }
  if (typeof MediaRecorder !== 'undefined') {
    const mime = RECORDER_TYPES.find((t) => MediaRecorder.isTypeSupported(t));
    if (mime) {
      return {
        available: true,
        realtime: true,
        label: mime.startsWith('video/mp4') ? 'MP4 (grabación)' : 'WebM (grabación)',
      };
    }
  }
  return { available: false, realtime: false, label: 'no disponible' };
}
