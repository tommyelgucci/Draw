import { useEffect, useMemo, useRef, useState } from 'react';
import type { Engine } from '../core/engine';
import {
  celHoldLength,
  frameToTimecode,
  MAX_FRAME_COUNT,
  sampleChannel,
  sortedCelFrames,
  TRANSFORM_PROPS,
  type AudioTrack,
  type Layer,
} from '../core/document';
import { useEngineRevision, useUI } from '../state/store';
import { IconButton, Slider } from './controls';
import {
  IconClose,
  IconCopy,
  IconNext,
  IconOnion,
  IconPause,
  IconPlay,
  IconPlus,
  IconPrev,
  IconSelectRect,
  IconTrash,
} from './icons';

const FRAME_W = 26;
const ROW_H = 34;

export function Timeline({ engine }: { engine: Engine }) {
  // El documento es un objeto mutable; esta suscripción es lo que provoca el
  // re-render, así que los datos derivados se calculan sin memoizar.
  const rev = useEngineRevision(engine);
  const showTimeline = useUI((s) => s.showTimeline);
  const rangeSelectMode = useUI((s) => s.rangeSelectMode);
  const setRangeSelectMode = useUI((s) => s.setRangeSelectMode);
  const frameRangeStart = useUI((s) => s.frameRangeStart);
  const frameRangeEnd = useUI((s) => s.frameRangeEnd);
  const setFrameRange = useUI((s) => s.setFrameRange);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [onionOpen, setOnionOpen] = useState(false);
  const [dragCel, setDragCel] = useState<{ layerId: string; from: number } | null>(null);
  /** Ancla del arrastre que marca el rango en la regla — vive fuera de React
   *  porque cambia en cada muestra de puntero, igual que `boneDrag` en
   *  `CanvasView`. */
  const rangeAnchor = useRef<number | null>(null);

  const doc = engine.doc;
  const layers = doc.layers.slice().reverse();
  const frames = useMemo(
    () => Array.from({ length: doc.frameCount }, (_, i) => i),
    [doc.frameCount],
  );

  // Mismo atajo que el resto de paneles flotantes de la app (`Panel` en
  // controls.tsx): éste no es uno de ésos — es un popover suelto propio de
  // la línea de tiempo — así que repite el mismo `useEffect` en vez de
  // heredarlo.
  useEffect(() => {
    if (!onionOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOnionOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onionOpen]);

  // Mantiene el cabezal a la vista durante la reproducción.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const x = engine.currentFrame * FRAME_W;
    if (x < el.scrollLeft + 40 || x > el.scrollLeft + el.clientWidth - 80) {
      el.scrollTo({ left: Math.max(0, x - el.clientWidth / 2), behavior: 'smooth' });
    }
  }, [engine.currentFrame, rev]);

  if (!showTimeline) return null;

  const scrub = (clientX: number, target: HTMLElement) => {
    const rect = target.getBoundingClientRect();
    engine.setFrame(Math.floor((clientX - rect.left) / FRAME_W));
  };

  const frameAt = (clientX: number, target: HTMLElement) => {
    const rect = target.getBoundingClientRect();
    const f = Math.floor((clientX - rect.left) / FRAME_W);
    return Math.max(0, Math.min(doc.frameCount - 1, f));
  };

  return (
    <section className="timeline" aria-label="Línea de tiempo">
      <header className="timeline__bar">
        <div className="transport">
          <IconButton title="Fotograma anterior" onClick={() => engine.stepFrame(-1)}>
            <IconPrev size={18} />
          </IconButton>
          <IconButton
            title={engine.playing ? 'Pausar' : 'Reproducir'}
            onClick={() => engine.togglePlay()}
            className="icon-btn--primary"
          >
            {engine.playing ? <IconPause size={18} /> : <IconPlay size={18} />}
          </IconButton>
          <IconButton title="Fotograma siguiente" onClick={() => engine.stepFrame(1)}>
            <IconNext size={18} />
          </IconButton>
        </div>

        <div className="timecode">
          <strong>{frameToTimecode(engine.currentFrame, doc.fps)}</strong>
          <span>
            {engine.currentFrame + 1} / {doc.frameCount}
          </span>
        </div>

        <div className="timeline__tools">
          <IconButton
            title="Nuevo fotograma vacío"
            onClick={() =>
              engine.activeLayer &&
              engine.addCel(engine.activeLayer.id, engine.currentFrame, false)
            }
          >
            <IconPlus size={18} />
          </IconButton>
          <IconButton
            title="Duplicar dibujo anterior"
            onClick={() =>
              engine.activeLayer &&
              engine.addCel(engine.activeLayer.id, engine.currentFrame, true)
            }
          >
            <IconCopy size={18} />
          </IconButton>
          <IconButton
            title="Eliminar fotograma"
            onClick={() =>
              engine.activeLayer &&
              engine.deleteCel(engine.activeLayer.id, engine.currentFrame)
            }
          >
            <IconTrash size={18} />
          </IconButton>
          <IconButton
            title="Papel cebolla"
            active={engine.onion.enabled}
            onClick={() => setOnionOpen((v) => !v)}
          >
            <IconOnion size={18} />
          </IconButton>
          <IconButton
            title="Marcar rango de cuadros (para transformar varios a la vez)"
            active={rangeSelectMode}
            onClick={() => setRangeSelectMode(!rangeSelectMode)}
          >
            <IconSelectRect size={18} />
          </IconButton>
        </div>

        <label className="fps-field">
          <span>fps</span>
          <input
            type="number"
            min={1}
            max={60}
            value={doc.fps}
            onChange={(e) => {
              doc.fps = Math.max(1, Math.min(60, Number(e.target.value) || 12));
              engine.touch(false);
            }}
          />
        </label>
        <label className="fps-field fps-field--count">
          <span>cuadros</span>
          <input
            type="number"
            min={1}
            // Ver `MAX_FRAME_COUNT` en document.ts: medido en navegador
            // (no adivinado), con 10 capas subir hasta ahí tarda ~2s en
            // pintar la primera vez; pasado eso ya se nota. 6000 cuadros
            // son 8:20 min a 12 fps o 4:10 a 24 fps — de sobra para lo que
            // pide cualquier corto.
            max={MAX_FRAME_COUNT}
            value={doc.frameCount}
            onChange={(e) => engine.setFrameCount(Number(e.target.value) || 1)}
          />
        </label>
      </header>

      {frameRangeStart !== null && frameRangeEnd !== null && frameRangeEnd > frameRangeStart && (
        <div className="frame-range-actions">
          <span className="frame-range-actions__label">
            {frameRangeEnd - frameRangeStart + 1} cuadros marcados
          </span>
          <button
            type="button"
            onClick={() => {
              engine.duplicateFrameRange(frameRangeStart, frameRangeEnd);
              setFrameRange(null, null);
            }}
            title="Duplicar el rango justo después"
          >
            <IconCopy size={16} /> Duplicar
          </button>
          <button
            type="button"
            onClick={() => {
              engine.reverseFrameRange(frameRangeStart, frameRangeEnd);
              setFrameRange(null, null);
            }}
            title="Invertir el orden de los dibujos del rango"
          >
            Invertir
          </button>
          <button type="button" onClick={() => setFrameRange(null, null)} aria-label="Quitar la marca de rango">
            <IconClose size={16} />
          </button>
        </div>
      )}

      {onionOpen && (
        <div className="onion-popover">
          <div className="onion-popover__head">
            <span>Papel cebolla</span>
            <IconButton title="Cerrar" onClick={() => setOnionOpen(false)} className="icon-btn--ghost">
              <IconClose size={16} />
            </IconButton>
          </div>
          <label className="check">
            <input
              type="checkbox"
              checked={engine.onion.enabled}
              onChange={(e) => {
                engine.onion.enabled = e.target.checked;
                engine.touch();
              }}
            />
            <span>Activar papel cebolla</span>
          </label>
          <Slider
            label="Anteriores"
            value={engine.onion.before}
            min={0}
            max={3}
            step={1}
            format={(v) => String(Math.round(v))}
            onChange={(v) => {
              engine.onion.before = Math.round(v);
              engine.touch();
            }}
          />
          <Slider
            label="Posteriores"
            value={engine.onion.after}
            min={0}
            max={3}
            step={1}
            format={(v) => String(Math.round(v))}
            onChange={(v) => {
              engine.onion.after = Math.round(v);
              engine.touch();
            }}
          />
          <Slider
            label="Intensidad"
            value={engine.onion.opacity}
            min={0.05}
            max={1}
            format={(v) => `${Math.round(v * 100)}%`}
            onChange={(v) => {
              engine.onion.opacity = v;
              engine.touch();
            }}
          />
          <label className="check">
            <input
              type="checkbox"
              checked={engine.onion.colored}
              onChange={(e) => {
                engine.onion.colored = e.target.checked;
                engine.touch();
              }}
            />
            <span>Teñir rojo/azul</span>
          </label>
        </div>
      )}

      <div className="timeline__grid">
        <div className="timeline__names">
          <div className="ruler-spacer" />
          {doc.audio && (
            <div className="track-name" style={{ height: ROW_H }}>
              <span>{doc.audio.name}</span>
            </div>
          )}
          {layers.map((layer) => (
            <div
              key={layer.id}
              className={`track-name ${layer.id === engine.activeLayerId ? 'is-active' : ''}`}
              style={{ height: ROW_H }}
              onClick={() => engine.setActiveLayer(layer.id)}
            >
              <span className={layer.visible ? '' : 'is-hidden'}>{layer.name}</span>
            </div>
          ))}
        </div>

        <div className="timeline__scroll" ref={scrollRef}>
          <div style={{ width: doc.frameCount * FRAME_W, position: 'relative' }}>
            <div
              className="ruler"
              onPointerDown={(e) => {
                e.currentTarget.setPointerCapture(e.pointerId);
                if (rangeSelectMode) {
                  const f = frameAt(e.clientX, e.currentTarget);
                  rangeAnchor.current = f;
                  setFrameRange(f, f);
                  return;
                }
                scrub(e.clientX, e.currentTarget);
              }}
              onPointerMove={(e) => {
                if (!e.buttons) return;
                if (rangeSelectMode && rangeAnchor.current !== null) {
                  const f = frameAt(e.clientX, e.currentTarget);
                  setFrameRange(Math.min(rangeAnchor.current, f), Math.max(rangeAnchor.current, f));
                  return;
                }
                scrub(e.clientX, e.currentTarget);
              }}
              onPointerUp={() => {
                rangeAnchor.current = null;
              }}
            >
              {frames.map((f) => (
                <div
                  key={f}
                  className={`tick ${f % doc.fps === 0 ? 'tick--second' : ''}`}
                  style={{ width: FRAME_W }}
                >
                  {f % doc.fps === 0 ? f / doc.fps + 's' : ''}
                </div>
              ))}
            </div>

            {/* Banda del rango marcado para la transformación por lote —
             *  atraviesa la regla y todas las pistas, como el cabezal. */}
            {frameRangeStart !== null && frameRangeEnd !== null && (
              <div
                className="frame-range-band"
                style={{
                  left: frameRangeStart * FRAME_W,
                  width: (frameRangeEnd - frameRangeStart + 1) * FRAME_W,
                }}
              />
            )}

            {doc.audio && <AudioWaveformRow audio={doc.audio} fps={doc.fps} />}

            {layers.map((layer) => (
              <TrackRow
                key={layer.id}
                engine={engine}
                layer={layer}
                frames={frames}
                dragCel={dragCel}
                setDragCel={setDragCel}
              />
            ))}

            <div
              className="playhead"
              style={{ transform: `translateX(${engine.currentFrame * FRAME_W}px)`, width: FRAME_W }}
            />
          </div>
        </div>
      </div>
    </section>
  );
}

/**
 * Forma de onda de la pista de audio — de sólo lectura, dibujada una vez
 * por cambio de pista en un `<canvas>` en vez de con SVG: son cientos de
 * barras y un canvas 2D es mucho más barato de repintar que ese número de
 * nodos DOM. Un `<div>` espaciador antes, en vez de posicionar en
 * absoluto, para encajar en el mismo flujo `display:flex` que ya usan
 * `.tick`/`.cell` — `offset` sólo desplaza dónde EMPIEZA el dibujo, el
 * resto de la fila (regla, cels) no sabe ni le importa que exista.
 */
function AudioWaveformRow({ audio, fps }: { audio: AudioTrack; fps: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const width = Math.max(1, Math.round(audio.duration * fps * FRAME_W));

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = width;
    canvas.height = ROW_H;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, width, ROW_H);
    ctx.fillStyle = 'rgba(110, 168, 254, 0.75)';
    const mid = ROW_H / 2;
    const n = audio.peaks.length;
    for (let i = 0; i < n; i++) {
      const x = (i / n) * width;
      const w = Math.max(1, width / n);
      const { min, max } = audio.peaks[i];
      const y1 = mid + min * (mid - 2);
      const y2 = mid + max * (mid - 2);
      ctx.fillRect(x, y1, w, Math.max(1, y2 - y1));
    }
  }, [audio, width]);

  return (
    <div className="track audio-track" style={{ height: ROW_H }}>
      <div style={{ flex: 'none', width: audio.offset * fps * FRAME_W }} />
      <canvas ref={canvasRef} style={{ flex: 'none', width, height: ROW_H }} />
    </div>
  );
}

function TrackRow({
  engine,
  layer,
  frames,
  dragCel,
  setDragCel,
}: {
  engine: Engine;
  layer: Layer;
  frames: number[];
  dragCel: { layerId: string; from: number } | null;
  setDragCel: (v: { layerId: string; from: number } | null) => void;
}) {
  // Un nodo de intercambio no tiene cels: su pista es una fila de
  // escalones (qué variante se ve en cada tramo), no dibujos sueltos.
  if (layer.swap) return <SwapTrackRow engine={engine} layer={layer} frames={frames} />;

  const celFrames = new Set(sortedCelFrames(layer));
  const keyframeFrames = new Set<number>();
  for (const prop of TRANSFORM_PROPS) {
    for (const k of layer.transform[prop].keys) keyframeFrames.add(k.frame);
  }

  const isActive = layer.id === engine.activeLayerId;
  // A partir del primer dibujo, la capa muestra algo en todos los cuadros:
  // ese es el "hold" que la animación tradicional da por supuesto.
  const firstCel = celFrames.size > 0 ? Math.min(...celFrames) : Infinity;

  return (
    <div className={`track ${isActive ? 'is-active' : ''}`} style={{ height: ROW_H }}>
      {frames.map((f) => {
        const isCel = layer.animated ? celFrames.has(f) : f === 0 && layer.cels.size > 0;
        const hold =
          isCel && layer.animated
            ? celHoldLength(layer, f, engine.doc.frameCount)
            : 0;
        const covered = layer.animated ? f >= firstCel : layer.cels.size > 0;
        return (
          <div
            key={f}
            className={`cell ${covered ? 'is-held' : ''} ${isCel ? 'is-cel' : ''} ${
              f === engine.currentFrame ? 'is-current' : ''
            }`}
            style={{ width: FRAME_W }}
            onPointerDown={(e) => {
              engine.setActiveLayer(layer.id);
              engine.setFrame(f);
              if (isCel) {
                setDragCel({ layerId: layer.id, from: f });
                e.currentTarget.setPointerCapture(e.pointerId);
              }
            }}
            onPointerUp={() => {
              if (dragCel && dragCel.layerId === layer.id && dragCel.from !== f) {
                engine.moveCel(layer.id, dragCel.from, f);
              }
              setDragCel(null);
            }}
            onDoubleClick={() => engine.addCel(layer.id, f, true)}
            title={isCel ? `Dibujo en ${f} (${hold} cuadros)` : `Fotograma ${f}`}
          >
            {isCel && <span className="cel-dot" />}
            {keyframeFrames.has(f) && <span className="key-dot" />}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Pista de un nodo de intercambio: un escalón por variante, no una curva.
 * Coherente con que todos los keyframes de `selected` son `'hold'`
 * (ver `Engine.setSwapSelection`) — aquí sólo se lee ese salto, nunca se
 * dibuja nada a medio camino entre dos variantes.
 */
function SwapTrackRow({
  engine,
  layer,
  frames,
}: {
  engine: Engine;
  layer: Layer;
  frames: number[];
}) {
  const catalog = layer.swap!;
  const isActive = layer.id === engine.activeLayerId;
  const keyFrames = new Set(catalog.selected.keys.map((k) => k.frame));

  return (
    <div className={`track ${isActive ? 'is-active' : ''}`} style={{ height: ROW_H }}>
      {frames.map((f) => {
        const variant = catalog.variants[Math.round(sampleChannel(catalog.selected, f))];
        const isKey = keyFrames.has(f);
        return (
          <div
            key={f}
            className={`cell is-held ${isKey ? 'is-swap-key' : ''} ${f === engine.currentFrame ? 'is-current' : ''}`}
            style={{ width: FRAME_W }}
            onPointerDown={() => {
              engine.setActiveLayer(layer.id);
              engine.setFrame(f);
            }}
            title={variant ? `${variant.label} (fotograma ${f})` : `Fotograma ${f}`}
          >
            {isKey && <span className="key-dot" />}
            {isKey && variant && <span className="swap-label">{variant.label}</span>}
          </div>
        );
      })}
    </div>
  );
}
