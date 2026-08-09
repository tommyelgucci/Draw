import { useEffect, useMemo, useRef, useState } from 'react';
import type { Engine } from '../core/engine';
import {
  celHoldLength,
  frameToTimecode,
  sampleChannel,
  sortedCelFrames,
  TRANSFORM_PROPS,
  type Layer,
} from '../core/document';
import { useEngineRevision, useUI } from '../state/store';
import { IconButton, Slider } from './controls';
import {
  IconCopy,
  IconNext,
  IconOnion,
  IconPause,
  IconPlay,
  IconPlus,
  IconPrev,
  IconTrash,
} from './icons';

const FRAME_W = 26;
const ROW_H = 34;

export function Timeline({ engine }: { engine: Engine }) {
  // El documento es un objeto mutable; esta suscripción es lo que provoca el
  // re-render, así que los datos derivados se calculan sin memoizar.
  const rev = useEngineRevision(engine);
  const showTimeline = useUI((s) => s.showTimeline);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [onionOpen, setOnionOpen] = useState(false);
  const [dragCel, setDragCel] = useState<{ layerId: string; from: number } | null>(null);

  const doc = engine.doc;
  const layers = doc.layers.slice().reverse();
  const frames = useMemo(
    () => Array.from({ length: doc.frameCount }, (_, i) => i),
    [doc.frameCount],
  );

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
            max={2000}
            value={doc.frameCount}
            onChange={(e) => engine.setFrameCount(Number(e.target.value) || 1)}
          />
        </label>
      </header>

      {onionOpen && (
        <div className="onion-popover">
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
                scrub(e.clientX, e.currentTarget);
              }}
              onPointerMove={(e) => {
                if (e.buttons) scrub(e.clientX, e.currentTarget);
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
