import { useEffect, useMemo, useRef, useState } from 'react';
import type { Engine } from '../core/engine';
import {
  BLEND_LABELS,
  BLEND_MODES,
  type BlendMode,
  type RGB,
} from '../core/types';
import { BUILTIN_TEXTURES, generateBrushTexturePixels, type BuiltinTextureId } from '../core/brushTexture';
import {
  TRANSFORM_LABELS,
  TRANSFORM_PROPS,
  type Layer,
  type TransformProp,
} from '../core/document';
import { hexToRgb, hsvToRgb, rgbToHex, rgbToHsv } from '../core/math';
import {
  autosave,
  deserializeProject,
  downloadBlob,
  exportAPNG,
  exportFramePNG,
  exportSequenceZip,
  importReferenceImage,
  importReferenceVideo,
  serializeProject,
} from '../core/io';
import { useActiveBrush, useEngineRevision, useUI } from '../state/store';
import { Field, IconButton, Panel, Slider } from './controls';
import {
  IconCopy,
  IconDownload,
  IconEye,
  IconEyeOff,
  IconImage,
  IconKey,
  IconLock,
  IconPlus,
  IconTrash,
  IconVideo,
} from './icons';

/* ================================================================== *
 * Capas
 * ================================================================== */

function LayerThumb({ engine, layer }: { engine: Engine; layer: Layer }) {
  const ref = useRef<HTMLDivElement>(null);
  const rev = useEngineRevision(engine);

  useEffect(() => {
    const host = ref.current;
    if (!host) return;
    const thumb = engine.celThumbnail(layer, engine.currentFrame, 48);
    host.replaceChildren();
    if (thumb) {
      thumb.className = 'layer__thumb-img';
      host.appendChild(thumb);
    }
  }, [engine, layer, rev]);

  return <div className="layer__thumb" ref={ref} />;
}

export function LayersPanel({ engine }: { engine: Engine }) {
  useEngineRevision(engine);
  const setPanel = useUI((s) => s.setPanel);
  const setBusy = useUI((s) => s.setBusy);
  const layers = engine.doc.layers.slice().reverse();
  const active = engine.activeLayer;
  const imageInput = useRef<HTMLInputElement>(null);
  const videoInput = useRef<HTMLInputElement>(null);
  const [refProgress, setRefProgress] = useState<string | null>(null);

  return (
    <Panel title="Capas" onClose={() => setPanel(null)} width={310}>
      <div className="panel__actions">
        <IconButton title="Nueva capa" onClick={() => engine.addLayer()}>
          <IconPlus size={18} />
        </IconButton>
        <IconButton
          title="Duplicar capa"
          onClick={() => active && engine.duplicateLayer(active.id)}
          disabled={!active}
        >
          <IconCopy size={18} />
        </IconButton>
        <IconButton
          title="Combinar hacia abajo"
          onClick={() => active && engine.mergeDown(active.id)}
          disabled={!active || engine.activeLayerIndex <= 0}
        >
          <span className="glyph">⌄</span>
        </IconButton>
        <IconButton
          title="Eliminar capa"
          onClick={() => active && engine.deleteLayer(active.id)}
          disabled={!active || engine.doc.layers.length <= 1}
        >
          <IconTrash size={18} />
        </IconButton>
      </div>

      <ul className="layer-list">
        {layers.map((layer) => {
          const isActive = layer.id === engine.activeLayerId;
          return (
            <li
              key={layer.id}
              className={`layer ${isActive ? 'is-active' : ''} ${layer.clipToBelow ? 'is-clipped' : ''}`}
              onClick={() => engine.setActiveLayer(layer.id)}
            >
              <LayerThumb engine={engine} layer={layer} />
              <div className="layer__info">
                <input
                  className="layer__name"
                  value={layer.name}
                  onChange={(e) =>
                    engine.setLayerPropLive(layer.id, 'name', e.target.value)
                  }
                  onClick={(e) => e.stopPropagation()}
                />
                <div className="layer__meta">
                  {layer.kind === 'reference' && <span className="layer__badge">Ref</span>}
                  {BLEND_LABELS[layer.blend]} · {Math.round(layer.opacity * 100)}%
                  {layer.cels.size > 0 &&
                    ` · ${layer.cels.size} ${layer.kind === 'reference' ? 'fotogramas' : 'dib.'}`}
                </div>
              </div>
              <div className="layer__buttons">
                <IconButton
                  title={layer.visible ? 'Ocultar' : 'Mostrar'}
                  className="icon-btn--ghost icon-btn--sm"
                  onClick={() =>
                    engine.setLayerProp(layer.id, 'visible', !layer.visible, 'Visibilidad')
                  }
                >
                  {layer.visible ? <IconEye size={16} /> : <IconEyeOff size={16} />}
                </IconButton>
                <IconButton
                  title={layer.locked ? 'Desbloquear' : 'Bloquear'}
                  className={`icon-btn--ghost icon-btn--sm ${layer.locked ? 'is-active' : ''}`}
                  onClick={() =>
                    engine.setLayerProp(layer.id, 'locked', !layer.locked, 'Bloqueo')
                  }
                >
                  <IconLock size={16} />
                </IconButton>
              </div>
            </li>
          );
        })}
      </ul>

      {active && (
        <div className="panel__section">
          <Slider
            label="Opacidad"
            value={active.opacity}
            min={0}
            max={1}
            format={(v) => `${Math.round(v * 100)}%`}
            onChange={(v) => engine.setLayerPropLive(active.id, 'opacity', v)}
          />
          <Field label="Modo de fusión">
            <select
              value={active.blend}
              onChange={(e) =>
                engine.setLayerProp(
                  active.id,
                  'blend',
                  e.target.value as BlendMode,
                  'Modo de fusión',
                )
              }
            >
              {BLEND_MODES.map((m) => (
                <option key={m} value={m}>
                  {BLEND_LABELS[m]}
                </option>
              ))}
            </select>
          </Field>
          <label className="check">
            <input
              type="checkbox"
              checked={active.clipToBelow}
              onChange={(e) =>
                engine.setLayerProp(
                  active.id,
                  'clipToBelow',
                  e.target.checked,
                  'Máscara de recorte',
                )
              }
            />
            <span>Recortar a la capa inferior</span>
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={active.animated}
              onChange={(e) =>
                engine.setLayerProp(active.id, 'animated', e.target.checked, 'Animar capa')
              }
            />
            <span>Dibujo cuadro por cuadro</span>
          </label>
          <p className="hint">
            Desactívalo para capas de fondo: un solo dibujo visible durante toda la
            animación.
          </p>

          <h3 className="panel__subtitle">Transformación animada</h3>
          {TRANSFORM_PROPS.map((prop) => (
            <TransformRow key={prop} engine={engine} layer={active} prop={prop} />
          ))}
          <p className="hint">
            Con el rombo activas un keyframe en el fotograma actual. Trace interpola el
            movimiento entre keyframes, así que puedes mover un dibujo hecho a mano sin
            redibujarlo.
          </p>
        </div>
      )}

      <div className="panel__section">
        <h3 className="panel__subtitle">Referencia</h3>
        <button
          className="btn btn--ghost"
          disabled={!!refProgress}
          onClick={() => imageInput.current?.click()}
        >
          <IconImage size={16} /> Imagen…
        </button>
        <button
          className="btn btn--ghost"
          disabled={!!refProgress}
          onClick={() => videoInput.current?.click()}
        >
          <IconVideo size={16} /> Vídeo…
        </button>
        <input
          ref={imageInput}
          type="file"
          accept="image/*"
          hidden
          onChange={async (e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (!file) return;
            setBusy('Importando imagen…');
            try {
              await importReferenceImage(engine, file);
            } catch (err) {
              console.error(err);
              alert(`No se pudo importar la imagen: ${(err as Error).message}`);
            } finally {
              setBusy(null);
            }
          }}
        />
        <input
          ref={videoInput}
          type="file"
          accept="video/*"
          hidden
          onChange={async (e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (!file) return;
            setRefProgress('0/0');
            setBusy('Extrayendo fotogramas de vídeo…');
            try {
              await importReferenceVideo(engine, file, (d, t) => setRefProgress(`${d}/${t}`));
            } catch (err) {
              console.error(err);
              alert(`No se pudo importar el vídeo: ${(err as Error).message}`);
            } finally {
              setBusy(null);
              setRefProgress(null);
            }
          }}
        />
        {refProgress && <p className="hint">Extrayendo fotogramas… {refProgress}</p>}
        <p className="hint">
          Se añade como una capa de referencia: no se puede dibujar sobre ella y queda
          fuera de la exportación final. Un vídeo se trocea en un cel por fotograma del
          documento, listo para calcar (rotoscopia).
        </p>
      </div>
    </Panel>
  );
}

function TransformRow({
  engine,
  layer,
  prop,
}: {
  engine: Engine;
  layer: Layer;
  prop: TransformProp;
}) {
  useEngineRevision(engine);
  const channel = layer.transform[prop];
  const value = engine.getTransformValue(layer, prop);
  const hasKey = channel.keys.some((k) => k.frame === engine.currentFrame);

  const config: Record<TransformProp, { min: number; max: number; fmt: (v: number) => string }> =
    {
      x: { min: -engine.doc.width, max: engine.doc.width, fmt: (v) => `${Math.round(v)} px` },
      y: { min: -engine.doc.height, max: engine.doc.height, fmt: (v) => `${Math.round(v)} px` },
      scale: { min: 0.05, max: 4, fmt: (v) => `${Math.round(v * 100)}%` },
      rotation: {
        min: -Math.PI,
        max: Math.PI,
        fmt: (v) => `${Math.round((v * 180) / Math.PI)}°`,
      },
      opacity: { min: 0, max: 1, fmt: (v) => `${Math.round(v * 100)}%` },
    };
  const c = config[prop];

  return (
    <div className="transform-row">
      <IconButton
        title={hasKey ? 'Quitar keyframe' : 'Añadir keyframe'}
        className={`icon-btn--ghost icon-btn--sm key-btn ${hasKey ? 'is-key' : ''} ${channel.keys.length ? 'has-track' : ''}`}
        onClick={() => engine.toggleKeyframe(layer.id, prop)}
      >
        <IconKey size={14} />
      </IconButton>
      <Slider
        label={TRANSFORM_LABELS[prop]}
        value={value}
        min={c.min}
        max={c.max}
        format={c.fmt}
        onChange={(v) => engine.setTransformValue(layer.id, prop, v)}
      />
    </div>
  );
}

/* ================================================================== *
 * Pincel
 * ================================================================== */

export function BrushPanel() {
  const setPanel = useUI((s) => s.setPanel);
  const { brushes, brushIndex, setBrushIndex, updateBrush } = useUI();
  const brush = useActiveBrush();

  return (
    <Panel title="Pincel" onClose={() => setPanel(null)} width={310}>
      <div className="brush-grid">
        {brushes.map((b, i) => (
          <button
            key={b.id}
            type="button"
            className={`brush-chip ${i === brushIndex ? 'is-active' : ''}`}
            onClick={() => setBrushIndex(i)}
          >
            <BrushPreview brush={b} />
            <span>{b.name}</span>
          </button>
        ))}
      </div>

      <div className="panel__section">
        <Slider
          label="Tamaño"
          value={brush.size}
          min={0.5}
          max={400}
          curve={2.2}
          format={(v) => `${v.toFixed(1)} px`}
          onChange={(v) => updateBrush({ size: v })}
        />
        <Slider
          label="Opacidad"
          value={brush.opacity}
          min={0}
          max={1}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={(v) => updateBrush({ opacity: v })}
        />
        <Slider
          label="Flujo"
          value={brush.flow}
          min={0.01}
          max={1}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={(v) => updateBrush({ flow: v })}
        />
        <Slider
          label="Dureza"
          value={brush.hardness}
          min={0}
          max={1}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={(v) => updateBrush({ hardness: v })}
        />
        <Slider
          label="Estabilización"
          value={brush.smoothing}
          min={0}
          max={1}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={(v) => updateBrush({ smoothing: v })}
        />
        <Slider
          label="Espaciado"
          value={brush.spacing}
          min={0.01}
          max={0.5}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={(v) => updateBrush({ spacing: v })}
        />

        <h3 className="panel__subtitle">Dinámicas</h3>
        <Slider
          label="Presión → tamaño"
          value={brush.pressureSize}
          min={0}
          max={1}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={(v) => updateBrush({ pressureSize: v })}
        />
        <Slider
          label="Presión → opacidad"
          value={brush.pressureOpacity}
          min={0}
          max={1}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={(v) => updateBrush({ pressureOpacity: v })}
        />
        <Slider
          label="Inclinación → achatado"
          value={brush.tiltAspect}
          min={0}
          max={1}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={(v) => updateBrush({ tiltAspect: v })}
        />
        <Slider
          label="Velocidad → adelgazar"
          value={brush.velocitySize}
          min={0}
          max={0.9}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={(v) => updateBrush({ velocitySize: v })}
        />
        <Slider
          label="Dispersión"
          value={brush.scatter}
          min={0}
          max={1}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={(v) => updateBrush({ scatter: v })}
        />
        <Slider
          label="Punta achatada"
          value={brush.aspect}
          min={0.05}
          max={1}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={(v) => updateBrush({ aspect: v })}
        />

        <h3 className="panel__subtitle">Textura de punta</h3>
        <div className="texture-grid">
          <TextureSwatch
            id={null}
            label="Lisa"
            active={brush.textureId === null}
            onClick={() => updateBrush({ textureId: null })}
          />
          {BUILTIN_TEXTURES.map((t) => (
            <TextureSwatch
              key={t.id}
              id={t.id}
              label={t.label}
              active={brush.textureId === t.id}
              onClick={() => updateBrush({ textureId: t.id })}
            />
          ))}
        </div>
        <p className="hint">
          Cada estampa lleva esta máscara de cobertura en vez de un círculo liso: es lo
          que da la textura granulada del lápiz o la salpicadura del aerógrafo.
        </p>
      </div>
    </Panel>
  );
}

/** Miniatura de una textura de punta: dibuja el mismo buffer de píxeles que sube a la GPU. */
function TextureSwatch({
  id,
  label,
  active,
  onClick,
}: {
  id: BuiltinTextureId | null;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const size = 40;

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, size, size);
    if (!id) {
      // "Lisa" no tiene máscara: un círculo sólido representa la punta de siempre.
      ctx.fillStyle = '#f0f0f5';
      ctx.beginPath();
      ctx.arc(size / 2, size / 2, size / 2 - 2, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    const pixels = generateBrushTexturePixels(id, size);
    ctx.putImageData(
      new ImageData(new Uint8ClampedArray(pixels.buffer as ArrayBuffer), size, size),
      0,
      0,
    );
  }, [id]);

  return (
    <button
      type="button"
      className={`brush-chip ${active ? 'is-active' : ''}`}
      onClick={onClick}
      title={label}
    >
      <canvas className="texture-chip__canvas" ref={ref} width={size} height={size} />
      <span>{label}</span>
    </button>
  );
}

function BrushPreview({ brush }: { brush: { hardness: number; aspect: number } }) {
  const stop = Math.round(brush.hardness * 70);
  return (
    <span
      className="brush-preview"
      style={{
        background: `radial-gradient(circle, rgba(240,240,245,1) ${stop}%, rgba(240,240,245,0) 100%)`,
        transform: `scaleY(${Math.max(brush.aspect, 0.25)})`,
      }}
    />
  );
}

/* ================================================================== *
 * Color
 * ================================================================== */

export function ColorPanel() {
  const setPanel = useUI((s) => s.setPanel);
  const { color, setColor, palette, recentColors } = useUI();
  const hsv = useMemo(() => rgbToHsv(color), [color]);
  const [hue, setHue] = useState(hsv.h);
  const areaRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  useEffect(() => {
    // Un gris puro no tiene tono definido: conservamos el que ya había.
    if (hsv.s > 0.001) setHue(hsv.h);
  }, [hsv.h, hsv.s]);

  const pick = (clientX: number, clientY: number) => {
    const el = areaRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const s = Math.min(Math.max((clientX - rect.left) / rect.width, 0), 1);
    const v = 1 - Math.min(Math.max((clientY - rect.top) / rect.height, 0), 1);
    setColor(hsvToRgb(hue, s, v));
  };

  return (
    <Panel title="Color" onClose={() => setPanel(null)} width={300}>
      <div
        ref={areaRef}
        className="sv-area"
        style={{ '--hue': rgbToHex(hsvToRgb(hue, 1, 1)) } as React.CSSProperties}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          dragging.current = true;
          pick(e.clientX, e.clientY);
        }}
        onPointerMove={(e) => dragging.current && pick(e.clientX, e.clientY)}
        onPointerUp={(e) => {
          dragging.current = false;
          e.currentTarget.releasePointerCapture(e.pointerId);
          setColor(color, true);
        }}
      >
        <div
          className="sv-cursor"
          style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%` }}
        />
      </div>

      <Slider
        label="Tono"
        value={hue}
        min={0}
        max={0.9999}
        format={(v) => `${Math.round(v * 360)}°`}
        onChange={(h) => {
          setHue(h);
          setColor(hsvToRgb(h, hsv.s, hsv.v));
        }}
        onCommit={() => setColor(color, true)}
      />

      <Field label="Hexadecimal">
        <input
          className="hex-input"
          value={rgbToHex(color)}
          onChange={(e) => setColor(hexToRgb(e.target.value))}
          onBlur={() => setColor(color, true)}
          spellCheck={false}
        />
      </Field>

      {recentColors.length > 0 && (
        <>
          <h3 className="panel__subtitle">Recientes</h3>
          <Swatches colors={recentColors} onPick={(c) => setColor(c, true)} />
        </>
      )}

      <h3 className="panel__subtitle">Paleta</h3>
      <Swatches colors={palette} onPick={(c) => setColor(c, true)} />
    </Panel>
  );
}

function Swatches({ colors, onPick }: { colors: RGB[]; onPick: (c: RGB) => void }) {
  return (
    <div className="swatches">
      {colors.map((c, i) => (
        <button
          key={`${rgbToHex(c)}-${i}`}
          type="button"
          className="swatch"
          style={{ background: rgbToHex(c) }}
          onClick={() => onPick(c)}
          title={rgbToHex(c)}
          aria-label={`Color ${rgbToHex(c)}`}
        />
      ))}
    </div>
  );
}

/* ================================================================== *
 * Exportar / proyecto
 * ================================================================== */

export function ExportPanel({ engine }: { engine: Engine }) {
  const setPanel = useUI((s) => s.setPanel);
  const setBusy = useUI((s) => s.setBusy);
  useEngineRevision(engine);
  const [progress, setProgress] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const safeName = (engine.doc.name || 'trace').replace(/[^\w-]+/g, '_');

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    try {
      await fn();
    } catch (err) {
      console.error(err);
      alert(`No se pudo completar: ${(err as Error).message}`);
    } finally {
      setBusy(null);
      setProgress(null);
    }
  };

  return (
    <Panel title="Proyecto" onClose={() => setPanel(null)} width={310}>
      <Field label="Nombre">
        <input
          value={engine.doc.name}
          onChange={(e) => {
            engine.doc.name = e.target.value;
            engine.touch(false);
          }}
        />
      </Field>

      <div className="stat-row">
        <div>
          <strong>
            {engine.doc.width} × {engine.doc.height}
          </strong>
          <span>Lienzo</span>
        </div>
        <div>
          <strong>
            {(engine.doc.frameCount / engine.doc.fps).toFixed(1)} s
          </strong>
          <span>Duración</span>
        </div>
        <div>
          <strong>{engine.doc.layers.length}</strong>
          <span>Capas</span>
        </div>
      </div>

      <div className="field-row">
        <Field label="Fotogramas por segundo">
          <input
            type="number"
            min={1}
            max={60}
            value={engine.doc.fps}
            onChange={(e) => {
              engine.doc.fps = Math.max(1, Math.min(60, Number(e.target.value) || 12));
              engine.touch(false);
            }}
          />
        </Field>
        <Field label="Total de cuadros">
          <input
            type="number"
            min={1}
            max={2000}
            value={engine.doc.frameCount}
            onChange={(e) => engine.setFrameCount(Number(e.target.value) || 1)}
          />
        </Field>
      </div>

      <h3 className="panel__subtitle">Guardar</h3>
      <button
        className="btn"
        onClick={() =>
          run('Guardando proyecto…', async () => {
            const bytes = await serializeProject(engine);
            downloadBlob(
              new Blob([bytes as BlobPart], { type: 'application/zip' }),
              `${safeName}.trace`,
            );
          })
        }
      >
        <IconDownload size={16} /> Descargar proyecto (.trace)
      </button>
      <button className="btn btn--ghost" onClick={() => fileInput.current?.click()}>
        Abrir proyecto…
      </button>
      <input
        ref={fileInput}
        type="file"
        accept=".trace,.zip"
        hidden
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (!file) return;
          await run('Abriendo proyecto…', async () => {
            const bytes = new Uint8Array(await file.arrayBuffer());
            const doc = await deserializeProject(engine, bytes);
            engine.doc = doc;
            engine.renderer.setDocumentSize(doc.width, doc.height);
            engine.currentFrame = 0;
            engine.activeLayerId = doc.layers[doc.layers.length - 1]?.id ?? null;
            engine.history.clear();
            engine.resetView();
            engine.touch();
          });
        }}
      />

      <h3 className="panel__subtitle">Exportar</h3>
      <button
        className="btn btn--ghost"
        onClick={() =>
          run('Exportando PNG…', async () => {
            const blob = await exportFramePNG(engine, engine.currentFrame);
            downloadBlob(blob, `${safeName}_${engine.currentFrame}.png`);
          })
        }
      >
        Fotograma actual (PNG)
      </button>
      <button
        className="btn btn--ghost"
        onClick={() =>
          run('Exportando animación…', async () => {
            const blob = await exportAPNG(engine, (d, t) => setProgress(`${d}/${t}`));
            downloadBlob(blob, `${safeName}.png`);
          })
        }
      >
        Animación (APNG)
      </button>
      <button
        className="btn btn--ghost"
        onClick={() =>
          run('Exportando secuencia…', async () => {
            const blob = await exportSequenceZip(engine, (d, t) => setProgress(`${d}/${t}`));
            downloadBlob(blob, `${safeName}_png.zip`);
          })
        }
      >
        Secuencia de PNG (.zip)
      </button>
      {progress && <p className="hint">Fotograma {progress}</p>}
      <p className="hint">
        El APNG conserva transparencia y color sin pérdida, y se reproduce en cualquier
        navegador y en Fotos de iOS. Para editar en otro programa, usa la secuencia PNG.
      </p>

      <h3 className="panel__subtitle">Copia local</h3>
      <button
        className="btn btn--ghost"
        onClick={() => run('Guardando…', () => autosave(engine))}
      >
        Guardar en este dispositivo
      </button>
      <p className="hint">
        Trace guarda solo, cada dos minutos, en el almacenamiento del navegador. Nada sale
        de tu dispositivo. Aun así, descarga el .trace si el trabajo te importa: el
        navegador puede vaciar su almacenamiento sin avisar.
      </p>
    </Panel>
  );
}
