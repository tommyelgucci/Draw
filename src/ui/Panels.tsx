import { useEffect, useMemo, useRef, useState } from 'react';
import type { Engine } from '../core/engine';
import {
  BLEND_LABELS,
  BLEND_MODES,
  type BlendMode,
  type RGB,
} from '../core/types';
import {
  BRUSH_TEXTURE_SIZE,
  BUILTIN_TEXTURES,
  generateBrushTexturePixels,
  generateBurstTexturePixels,
  generateParametricTexturePixels,
  generateStreakTexturePixels,
  generateWispTexturePixels,
  type BuiltinTextureId,
  type BurstTextureParams,
  type CustomTexture,
  type ParametricTextureParams,
  type StreakTextureParams,
  type WispTextureParams,
} from '../core/brushTexture';
import { BRUSH_CATEGORIES, BRUSH_CATEGORY_LABELS, type BrushPreset } from '../core/brush';
import {
  MAX_FRAME_COUNT,
  TRANSFORM_LABELS,
  TRANSFORM_PROPS,
  uid,
  type Layer,
  type LayerGroup,
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
  importAudioTrack,
  importCustomBrushTexture,
  importReferenceImage,
  importReferenceVideo,
  serializeProject,
} from '../core/io';
import { describeVideoSupport, exportImageSequenceAsVideo, exportVideo, type VideoSupport } from '../core/video';
import { buildLoopEmbedSnippet, buildScrollEmbedSnippet } from '../core/webExport';
import { useActiveBrush, useEngineRevision, useUI, type UserPalette } from '../state/store';
import { Field, IconButton, Panel, Segmented, Slider } from './controls';
import {
  IconAdjust,
  IconAlphaLock,
  IconAudio,
  IconChevronRight,
  IconClose,
  IconCopy,
  IconDownload,
  IconEye,
  IconEyeOff,
  IconFolder,
  IconImage,
  IconKey,
  IconLock,
  IconMask,
  IconMergeDown,
  IconPlus,
  IconRadial,
  IconResize,
  IconSymmetry,
  IconText,
  IconTrash,
  IconVideo,
  IconWand,
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

/**
 * Una fila de capa — se usa tanto suelta en la lista de arriba como dentro
 * de una carpeta (con `nested` para el sangrado). La casilla de la
 * izquierda no cambia la capa activa, sólo la marca para agrupar: son dos
 * selecciones independientes, como en cualquier gestor de archivos.
 */
function LayerRow({ engine, layer, nested }: { engine: Engine; layer: Layer; nested?: boolean }) {
  const isActive = layer.id === engine.activeLayerId;
  const selection = useUI((s) => s.layerGroupSelection);
  const toggleSelection = useUI((s) => s.toggleLayerGroupSelection);
  const checked = selection.includes(layer.id);

  return (
    <li
      className={`layer ${isActive ? 'is-active' : ''} ${layer.clipToBelow ? 'is-clipped' : ''} ${nested ? 'is-nested' : ''}`}
      data-layer-id={layer.id}
      onClick={() => engine.setActiveLayer(layer.id)}
    >
      <input
        type="checkbox"
        className="layer__check"
        checked={checked}
        aria-label={`Marcar ${layer.name} para agrupar`}
        onClick={(e) => e.stopPropagation()}
        onChange={() => toggleSelection(layer.id)}
      />
      <LayerThumb engine={engine} layer={layer} />
      <div className="layer__info">
        <input
          className="layer__name"
          value={layer.name}
          onChange={(e) => engine.setLayerPropLive(layer.id, 'name', e.target.value)}
          onClick={(e) => e.stopPropagation()}
        />
        <div className="layer__meta">
          {layer.kind === 'reference' && <span className="layer__badge">Ref</span>}
          {layer.kind === 'adjustment' && <span className="layer__badge">Ajuste</span>}
          {layer.text && <span className="layer__badge">Texto</span>}
          {BLEND_LABELS[layer.blend]} · {Math.round(layer.opacity * 100)}%
          {layer.cels.size > 0 &&
            ` · ${layer.cels.size} ${layer.kind === 'reference' ? 'fotogramas' : 'dib.'}`}
        </div>
      </div>
      <div className="layer__buttons">
        <button
          type="button"
          className={`layer__toggle ${layer.visible ? '' : 'is-off'}`}
          title={layer.visible ? 'Ocultar capa' : 'Mostrar capa'}
          aria-label={layer.visible ? 'Ocultar capa' : 'Mostrar capa'}
          aria-pressed={!layer.visible}
          onClick={(e) => {
            e.stopPropagation();
            engine.setLayerProp(layer.id, 'visible', !layer.visible, 'Visibilidad');
          }}
        >
          {layer.visible ? <IconEye size={17} /> : <IconEyeOff size={17} />}
        </button>
        <button
          type="button"
          className={`layer__toggle ${layer.locked ? 'is-on' : ''}`}
          title={layer.locked ? 'Desbloquear capa' : 'Bloquear capa'}
          aria-label={layer.locked ? 'Desbloquear capa' : 'Bloquear capa'}
          aria-pressed={layer.locked}
          onClick={(e) => {
            e.stopPropagation();
            engine.setLayerProp(layer.id, 'locked', !layer.locked, 'Bloqueo');
          }}
        >
          <IconLock size={17} />
        </button>
        {layer.kind === 'reference' && (
          <button
            type="button"
            className={`layer__toggle ${layer.includeInExport ? 'is-on' : ''}`}
            title={
              layer.includeInExport
                ? 'Quitar de la exportación: vuelve a ser sólo una guía para calcar'
                : 'Incluir en la exportación: sale de fondo en el PNG/vídeo final, no sólo como guía'
            }
            aria-label={layer.includeInExport ? 'Quitar de la exportación' : 'Incluir en la exportación'}
            aria-pressed={!!layer.includeInExport}
            onClick={(e) => {
              e.stopPropagation();
              engine.setLayerProp(
                layer.id,
                'includeInExport',
                !layer.includeInExport,
                'Incluir referencia en exportación',
              );
            }}
          >
            <IconDownload size={17} />
          </button>
        )}
        {/* Una capa de ajuste no tiene alfa ni dibujo propios que bloquear o
            recortar — `rasterizeLayer` (de donde salen ambos) ni se llama
            para ella, así que estos botones no harían nada de verdad. */}
        {layer.kind !== 'adjustment' && (
          <button
            type="button"
            className={`layer__toggle ${layer.alphaLock ? 'is-on' : ''}`}
            title={
              layer.alphaLock
                ? 'Quitar bloqueo de alfa: se puede volver a pintar fuera del contorno'
                : 'Bloquear alfa: sólo se puede repintar dentro del contorno ya pintado'
            }
            aria-label={layer.alphaLock ? 'Quitar bloqueo de alfa' : 'Bloquear alfa'}
            aria-pressed={layer.alphaLock}
            onClick={(e) => {
              e.stopPropagation();
              engine.setLayerProp(layer.id, 'alphaLock', !layer.alphaLock, 'Bloqueo de alfa');
            }}
          >
            <IconAlphaLock size={17} />
          </button>
        )}
        {layer.kind !== 'adjustment' &&
          (() => {
            const editing = engine.editingMaskLayerId === layer.id;
            const title = !layer.mask
              ? 'Añadir máscara'
              : editing
                ? 'Dejar de editar la máscara — volver a pintar la capa'
                : 'Editar máscara: blanco revela, negro oculta';
            return (
              <button
                type="button"
                className={`layer__toggle ${layer.mask ? 'is-on' : ''} ${editing ? 'is-editing' : ''}`}
                title={title}
                aria-label={title}
                aria-pressed={editing}
                onClick={(e) => {
                  e.stopPropagation();
                  if (!layer.mask) engine.addLayerMask(layer.id);
                  else engine.setEditingMaskLayer(editing ? null : layer.id);
                }}
              >
                <IconMask size={17} />
              </button>
            );
          })()}
        {layer.mask && (
          <button
            type="button"
            className="layer__toggle"
            title="Quitar máscara"
            aria-label="Quitar máscara"
            onClick={(e) => {
              e.stopPropagation();
              engine.removeLayerMask(layer.id);
            }}
          >
            <IconClose size={17} />
          </button>
        )}
      </div>
    </li>
  );
}

/** Cabecera de una carpeta de capas: colapsar, renombrar, mostrar/ocultar
 *  el grupo entero y desagrupar — mismo lugar donde vive todo eso para una
 *  capa suelta, pero operando sobre el lote. */
function LayerGroupHeader({
  engine,
  group,
  members,
}: {
  engine: Engine;
  group: LayerGroup;
  members: Layer[];
}) {
  const allVisible = members.every((l) => l.visible);
  return (
    <div
      className="layer-group__header"
      onClick={() => engine.setLayerGroupCollapsed(group.id, !group.collapsed)}
    >
      <IconChevronRight size={14} className={`layer-group__chevron ${group.collapsed ? '' : 'is-open'}`} />
      <IconFolder size={16} />
      <input
        className="layer__name"
        value={group.name}
        onChange={(e) => engine.renameLayerGroup(group.id, e.target.value)}
        onClick={(e) => e.stopPropagation()}
      />
      <span className="layer-group__count">{members.length}</span>
      <div className="layer__buttons">
        <button
          type="button"
          className={`layer__toggle ${allVisible ? '' : 'is-off'}`}
          title={allVisible ? 'Ocultar grupo' : 'Mostrar grupo'}
          aria-label={allVisible ? 'Ocultar grupo' : 'Mostrar grupo'}
          onClick={(e) => {
            e.stopPropagation();
            engine.setLayerGroupVisible(group.id, !allVisible);
          }}
        >
          {allVisible ? <IconEye size={17} /> : <IconEyeOff size={17} />}
        </button>
        <button
          type="button"
          className="layer__toggle"
          title="Desagrupar"
          aria-label="Desagrupar"
          onClick={(e) => {
            e.stopPropagation();
            engine.ungroupLayers(group.id);
          }}
        >
          <IconClose size={17} />
        </button>
      </div>
    </div>
  );
}

/**
 * Tipografías del selector de capa de texto. Nombres "web-safe" con su
 * familia genérica de reserva (`, serif`/`, sans-serif`/...) — si el
 * dispositivo no tiene la fuente nombrada, Canvas 2D cae a esa categoría en
 * vez de a lo que sea que el navegador use por defecto, así que el texto
 * sigue pareciéndose a lo que se eligió aunque no sea pixel-idéntico.
 */
const TEXT_FONT_OPTIONS: { label: string; value: string }[] = [
  { label: 'Predeterminada', value: 'sans-serif' },
  { label: 'Serif', value: 'Georgia, serif' },
  { label: 'Elegante', value: '"Times New Roman", serif' },
  { label: 'Redondeada', value: '"Trebuchet MS", sans-serif' },
  { label: 'Monoespaciada', value: '"Courier New", monospace' },
  { label: 'Manuscrita', value: '"Comic Sans MS", cursive' },
  { label: 'Impacto', value: 'Impact, sans-serif' },
];

export function LayersPanel({ engine }: { engine: Engine }) {
  useEngineRevision(engine);
  const setPanel = useUI((s) => s.setPanel);
  const setBusy = useUI((s) => s.setBusy);
  const layerGroupSelection = useUI((s) => s.layerGroupSelection);
  const clearLayerGroupSelection = useUI((s) => s.clearLayerGroupSelection);
  const layers = engine.doc.layers.slice().reverse();
  const active = engine.activeLayer;
  const imageInput = useRef<HTMLInputElement>(null);
  const videoInput = useRef<HTMLInputElement>(null);
  const audioInput = useRef<HTMLInputElement>(null);
  const [refProgress, setRefProgress] = useState<string | null>(null);
  const videoAbort = useRef<AbortController | null>(null);
  const audio = engine.doc.audio;

  // Tramos contiguos de capas con el mismo `groupId` se pintan como una
  // sola carpeta; si por algún motivo dejaron de ser contiguas (reordenar
  // capas no las mantiene juntas a propósito, ver `groupLayers`), aparecen
  // como dos carpetas con el mismo nombre en vez de romper — degradado, no roto.
  const groupsById = new Map(engine.doc.layerGroups.map((g) => [g.id, g]));
  type Row = { type: 'layer'; layer: Layer } | { type: 'group'; group: LayerGroup; members: Layer[] };
  const rows: Row[] = [];
  for (const layer of layers) {
    const group = layer.groupId ? groupsById.get(layer.groupId) : undefined;
    if (!group) {
      rows.push({ type: 'layer', layer });
      continue;
    }
    const last = rows[rows.length - 1];
    if (last && last.type === 'group' && last.group.id === group.id) {
      last.members.push(layer);
    } else {
      rows.push({ type: 'group', group, members: [layer] });
    }
  }

  return (
    <Panel title="Capas" onClose={() => setPanel(null)} width={310}>
      {/*
        Con etiqueta debajo del icono, y no sólo en `title`: en una tablet no
        hay puntero, así que un tooltip no llega a mostrarse nunca.
      */}
      <div className="panel__actions">
        <button
          type="button"
          className="action"
          aria-label="Nueva capa"
          onClick={() => engine.addLayer()}
        >
          <IconPlus size={18} />
          <span>Nueva</span>
        </button>
        <button
          type="button"
          className="action"
          aria-label="Añadir texto"
          onClick={() => engine.createTextLayer()}
        >
          <IconText size={18} />
          <span>Texto</span>
        </button>
        <button
          type="button"
          className="action"
          aria-label="Añadir capa de ajuste"
          onClick={() => engine.createAdjustmentLayer()}
        >
          <IconAdjust size={18} />
          <span>Ajuste</span>
        </button>
        <button
          type="button"
          className="action"
          aria-label="Duplicar capa"
          onClick={() => active && engine.duplicateLayer(active.id)}
          disabled={!active}
        >
          <IconCopy size={18} />
          <span>Duplicar</span>
        </button>
        <button
          type="button"
          className="action"
          aria-label="Nueva capa"
          onClick={() => active && engine.mergeDown(active.id)}
          disabled={!active || engine.activeLayerIndex <= 0}
        >
          <IconMergeDown size={18} />
          <span>Combinar</span>
        </button>
        <button
          type="button"
          className="action action--danger"
          aria-label="Eliminar capa"
          onClick={() => active && engine.deleteLayer(active.id)}
          disabled={!active || engine.doc.layers.length <= 1}
        >
          <IconTrash size={18} />
          <span>Eliminar</span>
        </button>
      </div>

      {layerGroupSelection.length > 0 && (
        <div className="panel__actions">
          <button
            type="button"
            className="action"
            aria-label="Agrupar capas marcadas"
            disabled={layerGroupSelection.length < 2}
            onClick={() => {
              engine.groupLayers(layerGroupSelection, 'Grupo');
              clearLayerGroupSelection();
            }}
          >
            <IconFolder size={18} />
            <span>Agrupar ({layerGroupSelection.length})</span>
          </button>
          <button type="button" className="action" aria-label="Cancelar selección" onClick={clearLayerGroupSelection}>
            <IconClose size={18} />
            <span>Cancelar</span>
          </button>
        </div>
      )}

      <ul className="layer-list">
        {rows.map((row) =>
          row.type === 'layer' ? (
            <LayerRow key={row.layer.id} engine={engine} layer={row.layer} />
          ) : (
            <li key={row.group.id} className="layer-group">
              <LayerGroupHeader engine={engine} group={row.group} members={row.members} />
              {!row.group.collapsed && (
                <ul className="layer-group__members">
                  {row.members.map((layer) => (
                    <LayerRow key={layer.id} engine={engine} layer={layer} nested />
                  ))}
                </ul>
              )}
            </li>
          ),
        )}
      </ul>

      {active?.text && (
        <div className="panel__section">
          <h3 className="panel__subtitle">Texto</h3>
          <Field label="Contenido">
            <textarea
              className="text-layer__content"
              rows={3}
              value={active.text.text}
              onChange={(e) => engine.setTextLayerProps(active.id, { text: e.target.value })}
            />
          </Field>
          <Field label="Tipografía">
            <select
              value={active.text.fontFamily}
              onChange={(e) => engine.setTextLayerProps(active.id, { fontFamily: e.target.value })}
            >
              {TEXT_FONT_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value} style={{ fontFamily: opt.value }}>
                  {opt.label}
                </option>
              ))}
            </select>
          </Field>
          <Slider
            label="Tamaño"
            value={active.text.fontSize}
            min={8}
            max={Math.max(8, Math.round(engine.doc.height * 0.5))}
            step={1}
            format={(v) => `${Math.round(v)}px`}
            onChange={(v) => engine.setTextLayerProps(active.id, { fontSize: Math.round(v) })}
          />
          <Field label="Alineación">
            <Segmented
              value={active.text.align}
              options={[
                { value: 'left', label: 'Izq.' },
                { value: 'center', label: 'Centro' },
                { value: 'right', label: 'Der.' },
              ]}
              onChange={(align) => engine.setTextLayerProps(active.id, { align })}
            />
          </Field>
          <label className="check">
            <input
              type="checkbox"
              checked={active.text.bold}
              onChange={(e) => engine.setTextLayerProps(active.id, { bold: e.target.checked })}
            />
            <span>Negrita</span>
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={active.text.italic}
              onChange={(e) => engine.setTextLayerProps(active.id, { italic: e.target.checked })}
            />
            <span>Cursiva</span>
          </label>
          <Field label="Color del texto">
            <input
              type="color"
              value={rgbToHex(active.text.color)}
              onChange={(e) => engine.setTextLayerProps(active.id, { color: hexToRgb(e.target.value) })}
            />
          </Field>
          <p className="hint">
            Para moverlo, usa la herramienta Transformar — el texto se mueve, escala y
            rota como cualquier otra capa.
          </p>
        </div>
      )}

      {active?.adjustment && (
        <div className="panel__section">
          <h3 className="panel__subtitle">Ajuste</h3>
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
                engine.setLayerProp(active.id, 'blend', e.target.value as BlendMode, 'Modo de fusión')
              }
            >
              {BLEND_MODES.map((m) => (
                <option key={m} value={m}>
                  {BLEND_LABELS[m]}
                </option>
              ))}
            </select>
          </Field>
          <Slider
            label="Tono"
            value={(active.adjustment.hue * 180) / Math.PI}
            min={-180}
            max={180}
            format={(v) => `${Math.round(v)}°`}
            onChange={(v) =>
              engine.setLayerAdjustment(active.id, { hue: (v * Math.PI) / 180 })
            }
          />
          <Slider
            label="Saturación"
            value={active.adjustment.saturation}
            min={-1}
            max={1}
            format={(v) => `${Math.round(v * 100)}%`}
            onChange={(v) => engine.setLayerAdjustment(active.id, { saturation: v })}
          />
          <Slider
            label="Brillo"
            value={active.adjustment.brightness}
            min={-1}
            max={1}
            format={(v) => `${Math.round(v * 100)}%`}
            onChange={(v) => engine.setLayerAdjustment(active.id, { brightness: v })}
          />
          <Slider
            label="Contraste"
            value={active.adjustment.contrast}
            min={-1}
            max={1}
            format={(v) => `${Math.round(v * 100)}%`}
            onChange={(v) => engine.setLayerAdjustment(active.id, { contrast: v })}
          />
          <p className="hint">
            Afecta a todo lo que hay por debajo, no a un dibujo propio — como cualquier
            capa, se puede ocultar, reordenar o borrar sin tocar las de abajo.
          </p>
        </div>
      )}

      {active && !active.adjustment && (
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
            const controller = new AbortController();
            videoAbort.current = controller;
            setRefProgress('0/0');
            setBusy('Extrayendo fotogramas de vídeo…');
            try {
              await importReferenceVideo(
                engine,
                file,
                (d, t) => setRefProgress(`${d}/${t}`),
                controller.signal,
              );
            } catch (err) {
              // Cancelar no es un error: lo pidió quien dibuja, no hace
              // falta ni un aviso ni un console.error por ello.
              if ((err as Error).name !== 'AbortError') {
                console.error(err);
                alert(`No se pudo importar el vídeo: ${(err as Error).message}`);
              }
            } finally {
              videoAbort.current = null;
              setBusy(null);
              setRefProgress(null);
            }
          }}
        />
        {refProgress && (
          <p className="hint hint--row">
            <span>Extrayendo fotogramas… {refProgress}</span>
            <button
              type="button"
              className="link-btn"
              onClick={() => videoAbort.current?.abort()}
            >
              Cancelar
            </button>
          </p>
        )}
        <p className="hint">
          Se añade como una capa de referencia: no se puede dibujar sobre ella y queda
          fuera de la exportación final. Un vídeo se trocea en un cel por fotograma del
          documento, listo para calcar (rotoscopia).
        </p>
      </div>

      <div className="panel__section">
        <h3 className="panel__subtitle">Audio</h3>
        {audio ? (
          <>
            <div className="audio-track-info">
              <span className="layer__name">{audio.name}</span>
              <span className="layer__meta">{audio.duration.toFixed(1)} s</span>
            </div>
            <Field label="Inicio (segundos desde el cuadro 0)">
              <input
                type="number"
                step={0.1}
                value={audio.offset}
                onChange={(e) => engine.setAudioOffset(Number(e.target.value) || 0)}
              />
            </Field>
            <label className="check">
              <input
                type="checkbox"
                checked={audio.muted}
                onChange={(e) => engine.setAudioMuted(e.target.checked)}
              />
              <span>Silenciar</span>
            </label>
            <button className="btn btn--ghost" onClick={() => engine.removeAudio()}>
              <IconTrash size={16} /> Quitar audio
            </button>
          </>
        ) : (
          <button className="btn btn--ghost" onClick={() => audioInput.current?.click()}>
            <IconAudio size={16} /> Importar audio…
          </button>
        )}
        <input
          ref={audioInput}
          type="file"
          accept="audio/*"
          hidden
          onChange={async (e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (!file) return;
            setBusy('Analizando audio…');
            try {
              await importAudioTrack(engine, file);
            } catch (err) {
              console.error(err);
              alert(`No se pudo importar el audio: ${(err as Error).message}`);
            } finally {
              setBusy(null);
            }
          }}
        />
        <p className="hint">
          Se reproduce en sincronía al pulsar "Reproducir" — para calzar el movimiento de
          la boca (panel de Poses) contra un diálogo grabado.
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

export function BrushPanel({ engine }: { engine: Engine | null }) {
  useEngineRevision(engine);
  const setPanel = useUI((s) => s.setPanel);
  const { brushes, brushIndex, setBrushIndex, updateBrush } = useUI();
  const brush = useActiveBrush();
  const quickShapeEnabled = useUI((s) => s.quickShapeEnabled);
  const quickShapePrecision = useUI((s) => s.quickShapePrecision);
  const setQuickShapePrecision = useUI((s) => s.setQuickShapePrecision);
  const textureFileInput = useRef<HTMLInputElement>(null);

  return (
    <Panel title="Pincel" onClose={() => setPanel(null)} width={310}>
      {BRUSH_CATEGORIES.map((cat) => {
        const items = brushes
          .map((b, i) => ({ b, i }))
          .filter(({ b }) => b.category === cat);
        if (items.length === 0) return null;
        return (
          <div key={cat} className="brush-category">
            <h3 className="panel__subtitle">{BRUSH_CATEGORY_LABELS[cat]}</h3>
            <div className="brush-grid">
              {items.map(({ b, i }) => (
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
          </div>
        );
      })}

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
        <Slider
          label="Afinado de extremos"
          value={brush.taper}
          min={0}
          max={1}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={(v) => updateBrush({ taper: v })}
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
          {(engine?.doc.customTextures ?? []).map((t) => (
            <CustomTextureSwatch
              key={t.id}
              texture={t}
              active={brush.textureId === t.id}
              onClick={() => updateBrush({ textureId: t.id })}
              onRemove={() => {
                if (brush.textureId === t.id) updateBrush({ textureId: null });
                engine?.removeCustomTexture(t.id);
              }}
            />
          ))}
        </div>
        <p className="hint">
          Cada estampa lleva esta máscara de cobertura en vez de un círculo liso: es lo
          que da la textura granulada del lápiz o la salpicadura del aerógrafo.
        </p>
        <button
          type="button"
          className="btn btn--ghost"
          disabled={!engine}
          onClick={() => textureFileInput.current?.click()}
        >
          <IconImage size={16} /> Importar textura…
        </button>
        <input
          ref={textureFileInput}
          type="file"
          accept="image/*"
          hidden
          onChange={async (e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (!file || !engine) return;
            const label = file.name.replace(/\.[^.]+$/, '');
            const tex = await importCustomBrushTexture(file, label);
            engine.addCustomTexture(tex);
            updateBrush({ textureId: tex.id });
          }}
        />
        <p className="hint">
          Se guarda con este proyecto (viaja en el .trace), no con la app: cada quien
          importa las suyas. Usa el canal de transparencia del PNG como forma de la
          estampa — una imagen sin transparencia entra como un cuadrado sólido.
        </p>
        <TextureGeneratorSection engine={engine} updateBrush={updateBrush} />
        <StreakGeneratorSection engine={engine} updateBrush={updateBrush} />
        <WispGeneratorSection engine={engine} updateBrush={updateBrush} />
        <BurstGeneratorSection engine={engine} updateBrush={updateBrush} />

        <h3 className="panel__subtitle">QuickShape</h3>
        <Slider
          label="Precisión de forma"
          value={quickShapePrecision}
          min={0}
          max={1}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={setQuickShapePrecision}
        />
        <p className="hint">
          Cuánto tiene que parecerse un trazo a una línea, círculo o polígono para que se
          enderece solo al mantener el lápiz quieto. Baja si dibujas con el dedo o te tiembla
          el pulso; al 100% casi nada encaja salvo algo ya perfecto. Se activa o desactiva
          del todo con el botón de la barra superior.
          {!quickShapeEnabled && ' (Ahora mismo está desactivado.)'}
        </p>

        <h3 className="panel__subtitle">Simetría</h3>
        <div className="panel__actions">
          <button
            type="button"
            className={`action ${engine?.symmetry.vertical ? 'is-active' : ''}`}
            disabled={!engine}
            onClick={() => {
              if (!engine) return;
              // Vertical/horizontal y radial son excluyentes — ver el
              // comentario del campo `symmetry` en engine.ts.
              engine.symmetry = { vertical: !engine.symmetry.vertical, horizontal: engine.symmetry.horizontal, radial: 0 };
              engine.touch();
            }}
          >
            <IconSymmetry size={18} />
            <span>Vertical</span>
          </button>
          <button
            type="button"
            className={`action ${engine?.symmetry.horizontal ? 'is-active' : ''}`}
            disabled={!engine}
            onClick={() => {
              if (!engine) return;
              engine.symmetry = { vertical: engine.symmetry.vertical, horizontal: !engine.symmetry.horizontal, radial: 0 };
              engine.touch();
            }}
          >
            <IconSymmetry size={18} className="icon-symmetry--h" />
            <span>Horizontal</span>
          </button>
          <button
            type="button"
            className={`action ${engine && engine.symmetry.radial >= 2 ? 'is-active' : ''}`}
            disabled={!engine}
            title="Simetría radial: repite el trazo en corona alrededor del centro"
            onClick={() => {
              if (!engine) return;
              const steps = [0, 4, 6, 8, 12];
              const i = steps.indexOf(engine.symmetry.radial);
              const radial = steps[(i + 1) % steps.length];
              engine.symmetry = { vertical: false, horizontal: false, radial };
              engine.touch();
            }}
          >
            <IconRadial size={18} />
            <span>{engine && engine.symmetry.radial >= 2 ? `Radial ×${engine.symmetry.radial}` : 'Radial'}</span>
          </button>
        </div>
        <p className="hint">
          Cada estampa del trazo se refleja también al otro lado del eje activo, en tiempo
          real — como dibujar los dos lados de una cara a la vez. La radial reparte el
          trazo en corona alrededor del centro del documento, como un mandala.
        </p>

        <h3 className="panel__subtitle">Guía de perspectiva</h3>
        <label className="check">
          <input
            type="checkbox"
            checked={engine?.perspectiveGuide.enabled ?? false}
            disabled={!engine}
            onChange={(e) => engine?.setPerspectiveGuide({ enabled: e.target.checked })}
          />
          <span>Activar</span>
        </label>
        {engine?.perspectiveGuide.enabled && (
          <>
            <Field label="Puntos de fuga">
              <Segmented
                value={engine.perspectiveGuide.mode}
                options={[
                  { value: '1pt', label: '1 punto' },
                  { value: '2pt', label: '2 puntos' },
                  { value: '3pt', label: '3 puntos' },
                ]}
                onChange={(mode) => engine.setPerspectiveGuide({ mode })}
              />
            </Field>
            <p className="hint">
              Arrastra los puntos de fuga sobre el lienzo para moverlos. Al dibujar cerca de
              uno de sus radios, el trazo se endereza hacia él solo.
            </p>
          </>
        )}
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

/** Igual que `TextureSwatch`, pero lee el buffer guardado en el documento en
 *  vez de generarlo — mismo tamaño fijo (`BRUSH_TEXTURE_SIZE`) para todas,
 *  reescalado al tamaño de la miniatura con el propio canvas. */
function CustomTextureSwatch({
  texture,
  active,
  onClick,
  onRemove,
}: {
  texture: CustomTexture;
  active: boolean;
  onClick: () => void;
  onRemove: () => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const size = 40;

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const full = Math.round(Math.sqrt(texture.pixels.length / 4));
    const src = document.createElement('canvas');
    src.width = full;
    src.height = full;
    src
      .getContext('2d')!
      .putImageData(new ImageData(new Uint8ClampedArray(texture.pixels.buffer as ArrayBuffer), full, full), 0, 0);
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, size, size);
    ctx.drawImage(src, 0, 0, full, full, 0, 0, size, size);
  }, [texture]);

  return (
    <div className="pose-cell">
      <button
        type="button"
        className={`brush-chip ${active ? 'is-active' : ''}`}
        onClick={onClick}
        title={texture.label}
      >
        <canvas className="texture-chip__canvas" ref={ref} width={size} height={size} />
        <span>{texture.label}</span>
      </button>
      <button
        type="button"
        className="pose-cell__remove"
        aria-label={`Quitar ${texture.label}`}
        onClick={onRemove}
      >
        <IconTrash size={12} />
      </button>
    </div>
  );
}

/** Los 5 mandos simples que expone el panel, ya traducidos a los campos finos
 *  de `ParametricTextureParams` — así "Tamaño" y "Opacidad" siguen dando una
 *  mota con algo de variedad propia (min≠max) en vez de un tamaño exacto. */
function paramsFromSliders(s: {
  seed: number;
  weave: number;
  density: number;
  size: number;
  opacity: number;
  dust: number;
}): ParametricTextureParams {
  return {
    seed: s.seed,
    weave: s.weave,
    dotDensity: s.density,
    dotCells: 14,
    dotSizeMin: s.size * 0.4,
    dotSizeMax: Math.min(1, s.size * 0.4 + 0.35),
    dotOpacityMin: s.opacity * 0.5,
    dotOpacityMax: Math.min(1, s.opacity * 0.5 + 0.5),
    dustCount: Math.round(s.dust * 300),
    dustOpacityMax: s.dust * 0.6,
  };
}

/**
 * Puntos de partida para los cinco mandos — no cambian lo que puede hacer el
 * generador, sólo ahorran encontrar a tientas la zona de valores de un
 * estilo reconocible. Ajustados a mano contra el aspecto general de esa
 * clase de textura, no calcados de ninguna imagen concreta.
 */
const TEXTURE_PRESETS: {
  label: string;
  values: { weave: number; density: number; size: number; opacity: number; dust: number };
}[] = [
  { label: 'Salpicadura', values: { weave: 0, density: 0.22, size: 0.85, opacity: 0.9, dust: 0.55 } },
  { label: 'Luciérnagas', values: { weave: 0, density: 0.12, size: 0.2, opacity: 0.8, dust: 0.25 } },
  { label: 'Destellos', values: { weave: 0, density: 0.06, size: 0.15, opacity: 1, dust: 0.5 } },
];

/**
 * Generador procedural por parámetros: en vez de elegir entre las 4 texturas
 * integradas o importar un PNG ajeno, se ajustan cuatro mandos continuos
 * (trama, densidad, tamaño, opacidad de mota, más polvo suelto) y se ve el
 * resultado en vivo — cálculo puro sobre una semilla, no mira ninguna imagen
 * de nadie. "Crear textura" guarda el resultado con el mismo mecanismo que
 * ya usa el importador (`engine.addCustomTexture`), así que hereda gratis el
 * guardado con el proyecto, la miniatura y el botón de quitar.
 */
function TextureGeneratorSection({
  engine,
  updateBrush,
}: {
  engine: Engine | null;
  updateBrush: (patch: Partial<BrushPreset>) => void;
}) {
  const [open, setOpen] = useState(false);
  const [seed, setSeed] = useState(1);
  const [weave, setWeave] = useState(0);
  const [density, setDensity] = useState(0.5);
  const [size, setSize] = useState(0.4);
  const [opacity, setOpacity] = useState(0.7);
  const [dust, setDust] = useState(0);
  const [label, setLabel] = useState('Generada');
  const previewRef = useRef<HTMLCanvasElement>(null);

  const params = paramsFromSliders({ seed, weave, density, size, opacity, dust });
  const previewSize = 96;

  useEffect(() => {
    if (!open) return;
    const canvas = previewRef.current;
    if (!canvas) return;
    const pixels = generateParametricTexturePixels(params, previewSize);
    canvas
      .getContext('2d')!
      .putImageData(new ImageData(new Uint8ClampedArray(pixels.buffer as ArrayBuffer), previewSize, previewSize), 0, 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, seed, weave, density, size, opacity, dust]);

  if (!open) {
    return (
      <button type="button" className="btn btn--ghost" disabled={!engine} onClick={() => setOpen(true)}>
        <IconWand size={16} /> Generar textura…
      </button>
    );
  }

  return (
    <div className="panel__section texture-generator">
      <button
        type="button"
        className="texture-generator__close"
        aria-label="Cerrar generador"
        onClick={() => setOpen(false)}
      >
        <IconClose size={14} />
      </button>
      <div className="texture-generator__preview">
        <canvas ref={previewRef} width={previewSize} height={previewSize} />
      </div>
      <div className="preset-row">
        {TEXTURE_PRESETS.map((p) => (
          <button
            key={p.label}
            type="button"
            className="chip"
            onClick={() => {
              setWeave(p.values.weave);
              setDensity(p.values.density);
              setSize(p.values.size);
              setOpacity(p.values.opacity);
              setDust(p.values.dust);
              setLabel(p.label);
            }}
          >
            {p.label}
          </button>
        ))}
      </div>
      <Slider label="Trama" value={weave} min={0} max={1} format={(v) => `${Math.round(v * 100)}%`} onChange={setWeave} />
      <Slider label="Densidad de motas" value={density} min={0} max={1} format={(v) => `${Math.round(v * 100)}%`} onChange={setDensity} />
      <Slider label="Tamaño de mota" value={size} min={0.05} max={1} format={(v) => `${Math.round(v * 100)}%`} onChange={setSize} />
      <Slider label="Opacidad de mota" value={opacity} min={0} max={1} format={(v) => `${Math.round(v * 100)}%`} onChange={setOpacity} />
      <Slider label="Polvo" value={dust} min={0} max={1} format={(v) => `${Math.round(v * 100)}%`} onChange={setDust} />
      <div className="panel__actions">
        <button type="button" className="action" onClick={() => setSeed(Math.floor(Math.random() * 1e9))}>
          <IconWand size={16} />
          <span>Aleatorizar</span>
        </button>
        <button
          type="button"
          className="action"
          disabled={!engine}
          onClick={() => {
            if (!engine) return;
            const pixels = generateParametricTexturePixels(params, BRUSH_TEXTURE_SIZE);
            const tex: CustomTexture = { id: uid('tex'), label, pixels };
            engine.addCustomTexture(tex);
            updateBrush({ textureId: tex.id });
            setOpen(false);
            setLabel('Generada');
          }}
        >
          <IconPlus size={16} />
          <span>Crear textura</span>
        </button>
      </div>
      <p className="hint">
        Matemática pura sobre una semilla al azar: no mira ni copia ninguna imagen, así
        que el resultado es tan tuyo como cualquiera de las 4 integradas.
      </p>
    </div>
  );
}

const STREAK_PRESETS: {
  label: string;
  values: { length: number; thickness: number; taper: number; roughness: number; opacity: number };
}[] = [
  { label: 'Cicatriz', values: { length: 0.7, thickness: 0.12, taper: 0.6, roughness: 0.6, opacity: 0.9 } },
  { label: 'Subrayado', values: { length: 0.85, thickness: 0.08, taper: 0.05, roughness: 0.05, opacity: 1 } },
];

/**
 * Segundo generador, con forma de base distinta al de motas: una marca
 * alargada a lo largo de un eje (longitud, grosor, cuánto se afinan las
 * puntas, cuánto tiembla el borde) en vez de dispersión radial — cicatrices,
 * subrayados o arañazos son el mismo mando de aspereza en extremos
 * opuestos, no dos moldes cerrados. Mismo mecanismo de guardado que el
 * generador de motas y el importador (`engine.addCustomTexture`).
 */
function StreakGeneratorSection({
  engine,
  updateBrush,
}: {
  engine: Engine | null;
  updateBrush: (patch: Partial<BrushPreset>) => void;
}) {
  const [open, setOpen] = useState(false);
  const [seed, setSeed] = useState(1);
  const [length, setLength] = useState(0.7);
  const [thickness, setThickness] = useState(0.12);
  const [taper, setTaper] = useState(0.4);
  const [roughness, setRoughness] = useState(0.4);
  const [opacity, setOpacity] = useState(0.9);
  const [label, setLabel] = useState('Trazo');
  const previewRef = useRef<HTMLCanvasElement>(null);

  const params: StreakTextureParams = { seed, length, thickness, taper, roughness, opacity };
  const previewSize = 96;

  useEffect(() => {
    if (!open) return;
    const canvas = previewRef.current;
    if (!canvas) return;
    const pixels = generateStreakTexturePixels(params, previewSize);
    canvas
      .getContext('2d')!
      .putImageData(new ImageData(new Uint8ClampedArray(pixels.buffer as ArrayBuffer), previewSize, previewSize), 0, 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, seed, length, thickness, taper, roughness, opacity]);

  if (!open) {
    return (
      <button type="button" className="btn btn--ghost" disabled={!engine} onClick={() => setOpen(true)}>
        <IconWand size={16} /> Generar trazo…
      </button>
    );
  }

  return (
    <div className="panel__section texture-generator">
      <button
        type="button"
        className="texture-generator__close"
        aria-label="Cerrar generador"
        onClick={() => setOpen(false)}
      >
        <IconClose size={14} />
      </button>
      <div className="texture-generator__preview">
        <canvas ref={previewRef} width={previewSize} height={previewSize} />
      </div>
      <div className="preset-row">
        {STREAK_PRESETS.map((p) => (
          <button
            key={p.label}
            type="button"
            className="chip"
            onClick={() => {
              setLength(p.values.length);
              setThickness(p.values.thickness);
              setTaper(p.values.taper);
              setRoughness(p.values.roughness);
              setOpacity(p.values.opacity);
              setLabel(p.label);
            }}
          >
            {p.label}
          </button>
        ))}
      </div>
      <Slider label="Longitud" value={length} min={0.1} max={1} format={(v) => `${Math.round(v * 100)}%`} onChange={setLength} />
      <Slider label="Grosor" value={thickness} min={0.02} max={0.6} format={(v) => `${Math.round(v * 100)}%`} onChange={setThickness} />
      <Slider label="Puntas afiladas" value={taper} min={0} max={1} format={(v) => `${Math.round(v * 100)}%`} onChange={setTaper} />
      <Slider label="Aspereza del borde" value={roughness} min={0} max={1} format={(v) => `${Math.round(v * 100)}%`} onChange={setRoughness} />
      <Slider label="Opacidad" value={opacity} min={0} max={1} format={(v) => `${Math.round(v * 100)}%`} onChange={setOpacity} />
      <div className="panel__actions">
        <button type="button" className="action" onClick={() => setSeed(Math.floor(Math.random() * 1e9))}>
          <IconWand size={16} />
          <span>Aleatorizar</span>
        </button>
        <button
          type="button"
          className="action"
          disabled={!engine}
          onClick={() => {
            if (!engine) return;
            const pixels = generateStreakTexturePixels(params, BRUSH_TEXTURE_SIZE);
            const tex: CustomTexture = { id: uid('tex'), label, pixels };
            engine.addCustomTexture(tex);
            updateBrush({ textureId: tex.id });
            setOpen(false);
            setLabel('Trazo');
          }}
        >
          <IconPlus size={16} />
          <span>Crear textura</span>
        </button>
      </div>
      <p className="hint">
        Se orienta con la rotación de cada estampa — recta por defecto. Aspereza al
        mínimo y puntas romas da un subrayado limpio; al máximo, un borde rasgado de
        cicatriz o arañazo.
      </p>
    </div>
  );
}

const WISP_PRESETS: {
  label: string;
  values: { spread: number; turbulence: number; density: number; opacity: number };
}[] = [
  { label: 'Humo', values: { spread: 0.55, turbulence: 0.6, density: 0.5, opacity: 0.8 } },
  { label: 'Niebla', values: { spread: 0.9, turbulence: 0.25, density: 0.65, opacity: 0.5 } },
];

/**
 * Tercer generador: contorno redondeado deformado por ruido en vez de
 * dispersión de motas o marca alargada — humo, niebla, nube.
 */
function WispGeneratorSection({
  engine,
  updateBrush,
}: {
  engine: Engine | null;
  updateBrush: (patch: Partial<BrushPreset>) => void;
}) {
  const [open, setOpen] = useState(false);
  const [seed, setSeed] = useState(1);
  const [spread, setSpread] = useState(0.6);
  const [turbulence, setTurbulence] = useState(0.5);
  const [density, setDensity] = useState(0.5);
  const [opacity, setOpacity] = useState(0.7);
  const [label, setLabel] = useState('Humo');
  const previewRef = useRef<HTMLCanvasElement>(null);

  const params: WispTextureParams = { seed, spread, turbulence, density, opacity };
  const previewSize = 96;

  useEffect(() => {
    if (!open) return;
    const canvas = previewRef.current;
    if (!canvas) return;
    const pixels = generateWispTexturePixels(params, previewSize);
    canvas
      .getContext('2d')!
      .putImageData(new ImageData(new Uint8ClampedArray(pixels.buffer as ArrayBuffer), previewSize, previewSize), 0, 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, seed, spread, turbulence, density, opacity]);

  if (!open) {
    return (
      <button type="button" className="btn btn--ghost" disabled={!engine} onClick={() => setOpen(true)}>
        <IconWand size={16} /> Generar humo…
      </button>
    );
  }

  return (
    <div className="panel__section texture-generator">
      <button
        type="button"
        className="texture-generator__close"
        aria-label="Cerrar generador"
        onClick={() => setOpen(false)}
      >
        <IconClose size={14} />
      </button>
      <div className="texture-generator__preview">
        <canvas ref={previewRef} width={previewSize} height={previewSize} />
      </div>
      <div className="preset-row">
        {WISP_PRESETS.map((p) => (
          <button
            key={p.label}
            type="button"
            className="chip"
            onClick={() => {
              setSpread(p.values.spread);
              setTurbulence(p.values.turbulence);
              setDensity(p.values.density);
              setOpacity(p.values.opacity);
              setLabel(p.label);
            }}
          >
            {p.label}
          </button>
        ))}
      </div>
      <Slider label="Extensión" value={spread} min={0.15} max={1} format={(v) => `${Math.round(v * 100)}%`} onChange={setSpread} />
      <Slider label="Turbulencia" value={turbulence} min={0} max={1} format={(v) => `${Math.round(v * 100)}%`} onChange={setTurbulence} />
      <Slider label="Densidad interna" value={density} min={0} max={1} format={(v) => `${Math.round(v * 100)}%`} onChange={setDensity} />
      <Slider label="Opacidad" value={opacity} min={0} max={1} format={(v) => `${Math.round(v * 100)}%`} onChange={setOpacity} />
      <div className="panel__actions">
        <button type="button" className="action" onClick={() => setSeed(Math.floor(Math.random() * 1e9))}>
          <IconWand size={16} />
          <span>Aleatorizar</span>
        </button>
        <button
          type="button"
          className="action"
          disabled={!engine}
          onClick={() => {
            if (!engine) return;
            const pixels = generateWispTexturePixels(params, BRUSH_TEXTURE_SIZE);
            const tex: CustomTexture = { id: uid('tex'), label, pixels };
            engine.addCustomTexture(tex);
            updateBrush({ textureId: tex.id });
            setOpen(false);
            setLabel('Humo');
          }}
        >
          <IconPlus size={16} />
          <span>Crear textura</span>
        </button>
      </div>
      <p className="hint">
        Turbulencia baja da una nube redondeada; alta, zarcillos sueltos que se
        deshilachan por el borde.
      </p>
    </div>
  );
}

const BURST_PRESETS: {
  label: string;
  values: { spokeCount: number; length: number; thickness: number; irregularity: number; coreSize: number; opacity: number };
}[] = [
  { label: 'Destello', values: { spokeCount: 8, length: 0.85, thickness: 0.08, irregularity: 0.3, coreSize: 0.15, opacity: 1 } },
  { label: 'Chispa', values: { spokeCount: 16, length: 0.6, thickness: 0.04, irregularity: 0.7, coreSize: 0.08, opacity: 0.9 } },
];

/**
 * Cuarto generador: rayos que salen de un núcleo, medidos en polar — lente,
 * chispa, estrella, sol. Ni motas ni un eje recto ni un contorno de ruido.
 */
function BurstGeneratorSection({
  engine,
  updateBrush,
}: {
  engine: Engine | null;
  updateBrush: (patch: Partial<BrushPreset>) => void;
}) {
  const [open, setOpen] = useState(false);
  const [seed, setSeed] = useState(1);
  const [spokeCount, setSpokeCount] = useState(8);
  const [length, setLength] = useState(0.8);
  const [thickness, setThickness] = useState(0.06);
  const [irregularity, setIrregularity] = useState(0.3);
  const [coreSize, setCoreSize] = useState(0.12);
  const [opacity, setOpacity] = useState(1);
  const [label, setLabel] = useState('Destello');
  const previewRef = useRef<HTMLCanvasElement>(null);

  const params: BurstTextureParams = { seed, spokeCount, length, thickness, irregularity, coreSize, opacity };
  const previewSize = 96;

  useEffect(() => {
    if (!open) return;
    const canvas = previewRef.current;
    if (!canvas) return;
    const pixels = generateBurstTexturePixels(params, previewSize);
    canvas
      .getContext('2d')!
      .putImageData(new ImageData(new Uint8ClampedArray(pixels.buffer as ArrayBuffer), previewSize, previewSize), 0, 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, seed, spokeCount, length, thickness, irregularity, coreSize, opacity]);

  if (!open) {
    return (
      <button type="button" className="btn btn--ghost" disabled={!engine} onClick={() => setOpen(true)}>
        <IconWand size={16} /> Generar destello…
      </button>
    );
  }

  return (
    <div className="panel__section texture-generator">
      <button
        type="button"
        className="texture-generator__close"
        aria-label="Cerrar generador"
        onClick={() => setOpen(false)}
      >
        <IconClose size={14} />
      </button>
      <div className="texture-generator__preview">
        <canvas ref={previewRef} width={previewSize} height={previewSize} />
      </div>
      <div className="preset-row">
        {BURST_PRESETS.map((p) => (
          <button
            key={p.label}
            type="button"
            className="chip"
            onClick={() => {
              setSpokeCount(p.values.spokeCount);
              setLength(p.values.length);
              setThickness(p.values.thickness);
              setIrregularity(p.values.irregularity);
              setCoreSize(p.values.coreSize);
              setOpacity(p.values.opacity);
              setLabel(p.label);
            }}
          >
            {p.label}
          </button>
        ))}
      </div>
      <Slider label="Número de rayos" value={spokeCount} min={3} max={24} step={1} format={(v) => `${Math.round(v)}`} onChange={setSpokeCount} />
      <Slider label="Longitud" value={length} min={0.1} max={1} format={(v) => `${Math.round(v * 100)}%`} onChange={setLength} />
      <Slider label="Grosor" value={thickness} min={0.01} max={0.25} format={(v) => `${Math.round(v * 100)}%`} onChange={setThickness} />
      <Slider label="Irregularidad" value={irregularity} min={0} max={1} format={(v) => `${Math.round(v * 100)}%`} onChange={setIrregularity} />
      <Slider label="Núcleo" value={coreSize} min={0} max={0.4} format={(v) => `${Math.round(v * 100)}%`} onChange={setCoreSize} />
      <Slider label="Opacidad" value={opacity} min={0} max={1} format={(v) => `${Math.round(v * 100)}%`} onChange={setOpacity} />
      <div className="panel__actions">
        <button type="button" className="action" onClick={() => setSeed(Math.floor(Math.random() * 1e9))}>
          <IconWand size={16} />
          <span>Aleatorizar</span>
        </button>
        <button
          type="button"
          className="action"
          disabled={!engine}
          onClick={() => {
            if (!engine) return;
            const pixels = generateBurstTexturePixels(params, BRUSH_TEXTURE_SIZE);
            const tex: CustomTexture = { id: uid('tex'), label, pixels };
            engine.addCustomTexture(tex);
            updateBrush({ textureId: tex.id });
            setOpen(false);
            setLabel('Destello');
          }}
        >
          <IconPlus size={16} />
          <span>Crear textura</span>
        </button>
      </div>
      <p className="hint">
        Irregularidad baja da un asterisco regular; alta, un estallido de rayos
        desiguales — más rayos y menos grosor da algo más parecido a una chispa.
      </p>
    </div>
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
  const {
    color,
    setColor,
    paletteGroups,
    userPalettes,
    createUserPalette,
    renameUserPalette,
    deleteUserPalette,
    addColorToUserPalette,
    removeColorFromUserPalette,
    recentColors,
  } = useUI();
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

      <div className="panel__subtitle-row">
        <h3 className="panel__subtitle">Mis paletas</h3>
        <IconButton
          title="Nueva paleta"
          className="icon-btn--ghost"
          onClick={() => createUserPalette(`Paleta ${userPalettes.length + 1}`)}
        >
          <IconPlus size={16} />
        </IconButton>
      </div>
      {userPalettes.length === 0 && (
        <p className="hint">Crea una paleta propia y guarda ahí los colores que uses a menudo.</p>
      )}
      {userPalettes.map((p) => (
        <UserPaletteBlock
          key={p.id}
          palette={p}
          onPick={(c) => setColor(c, true)}
          onRename={(name) => renameUserPalette(p.id, name)}
          onDelete={() => deleteUserPalette(p.id)}
          onAddCurrent={() => addColorToUserPalette(p.id, color)}
          onRemoveColor={(i) => removeColorFromUserPalette(p.id, i)}
        />
      ))}

      {paletteGroups.map((group) => (
        <div key={group.name}>
          <h3 className="panel__subtitle">{group.name}</h3>
          <Swatches colors={group.colors} onPick={(c) => setColor(c, true)} />
        </div>
      ))}
    </Panel>
  );
}

/**
 * Paleta propia: nombre editable igual que `.layer__name`, un botón para
 * añadir el color activo y una "x" por color para quitarlo — sin modo
 * "editar" aparte, mismo criterio directo que el resto del panel. Borrar la
 * paleta entera sí pide confirmación (calco de `NewProjectControls`): a
 * diferencia de un color suelto, no hay forma de recuperarla después.
 */
function UserPaletteBlock({
  palette,
  onPick,
  onRename,
  onDelete,
  onAddCurrent,
  onRemoveColor,
}: {
  palette: UserPalette;
  onPick: (c: RGB) => void;
  onRename: (name: string) => void;
  onDelete: () => void;
  onAddCurrent: () => void;
  onRemoveColor: (index: number) => void;
}) {
  const [confirming, setConfirming] = useState(false);

  return (
    <div className="user-palette">
      {confirming ? (
        <div className="user-palette__confirm">
          <span>¿Eliminar "{palette.name}"?</span>
          <div className="field-row">
            <button className="btn btn--danger" onClick={onDelete}>
              Eliminar
            </button>
            <button className="btn btn--ghost" onClick={() => setConfirming(false)}>
              Cancelar
            </button>
          </div>
        </div>
      ) : (
        <div className="user-palette__head">
          <input
            className="user-palette__name"
            value={palette.name}
            onChange={(e) => onRename(e.target.value)}
            aria-label="Nombre de la paleta"
          />
          <IconButton
            title="Eliminar paleta"
            className="icon-btn--ghost"
            onClick={() => setConfirming(true)}
          >
            <IconTrash size={15} />
          </IconButton>
        </div>
      )}
      <div className="swatches">
        {palette.colors.map((c, i) => (
          <div key={`${rgbToHex(c)}-${i}`} className="swatch-wrap">
            <button
              type="button"
              className="swatch"
              style={{ background: rgbToHex(c) }}
              onClick={() => onPick(c)}
              title={rgbToHex(c)}
              aria-label={`Color ${rgbToHex(c)}`}
            />
            <button
              type="button"
              className="swatch-remove"
              onClick={() => onRemoveColor(i)}
              aria-label={`Quitar ${rgbToHex(c)} de "${palette.name}"`}
              title="Quitar de la paleta"
            >
              <IconClose size={10} />
            </button>
          </div>
        ))}
        <button
          type="button"
          className="swatch swatch--add"
          onClick={onAddCurrent}
          aria-label={`Añadir color activo a "${palette.name}"`}
          title="Añadir color activo"
        >
          <IconPlus size={14} />
        </button>
      </div>
    </div>
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
 * Tamaño del lienzo
 * ================================================================== */

const SIZE_PRESETS: { label: string; w: number; h: number }[] = [
  { label: 'HD 16:9', w: 1920, h: 1080 },
  { label: 'Cuadrado', w: 1500, h: 1500 },
  { label: 'Vertical 9:16', w: 1080, h: 1920 },
  { label: '4K 16:9', w: 3840, h: 2160 },
  { label: 'A4 300 ppp', w: 2480, h: 3508 },
  { label: 'Cómic', w: 1988, h: 3056 },
];

/** Las nueve posiciones del contenido antiguo dentro del lienzo nuevo. */
const ANCHORS: { x: number; y: number }[] = [
  { x: 0, y: 0 },
  { x: 0.5, y: 0 },
  { x: 1, y: 0 },
  { x: 0, y: 0.5 },
  { x: 0.5, y: 0.5 },
  { x: 1, y: 0.5 },
  { x: 0, y: 1 },
  { x: 0.5, y: 1 },
  { x: 1, y: 1 },
];

function CanvasSizeControls({ engine }: { engine: Engine }) {
  useEngineRevision(engine);
  const [width, setWidth] = useState(String(engine.doc.width));
  const [height, setHeight] = useState(String(engine.doc.height));
  const [anchor, setAnchor] = useState(4);
  const [linked, setLinked] = useState(false);

  // Si el documento cambia por otra vía (abrir, deshacer), los campos siguen.
  useEffect(() => {
    setWidth(String(engine.doc.width));
    setHeight(String(engine.doc.height));
  }, [engine.doc.width, engine.doc.height]);

  const w = Number(width);
  const h = Number(height);
  const valid = Number.isFinite(w) && Number.isFinite(h) && w >= 16 && h >= 16;
  const changed = valid && (w !== engine.doc.width || h !== engine.doc.height);
  const shrinking = changed && (w < engine.doc.width || h < engine.doc.height);
  const ratio = engine.doc.width / engine.doc.height;

  const apply = () => {
    if (!changed) return;
    const a = ANCHORS[anchor];
    engine.resizeCanvas(w, h, a.x, a.y);
  };

  return (
    <>
      <div className="preset-grid">
        {SIZE_PRESETS.map((p) => (
          <button
            key={p.label}
            type="button"
            className={
              p.w === engine.doc.width && p.h === engine.doc.height ? 'is-active' : ''
            }
            onClick={() => {
              setWidth(String(p.w));
              setHeight(String(p.h));
            }}
          >
            <strong>{p.label}</strong>
            <span>
              {p.w} × {p.h}
            </span>
          </button>
        ))}
      </div>

      <div className="field-row">
        <Field label="Ancho (px)">
          <input
            type="number"
            min={16}
            max={8192}
            value={width}
            onChange={(e) => {
              setWidth(e.target.value);
              if (linked) setHeight(String(Math.round(Number(e.target.value) / ratio)));
            }}
          />
        </Field>
        <Field label="Alto (px)">
          <input
            type="number"
            min={16}
            max={8192}
            value={height}
            onChange={(e) => {
              setHeight(e.target.value);
              if (linked) setWidth(String(Math.round(Number(e.target.value) * ratio)));
            }}
          />
        </Field>
      </div>

      <label className="check">
        <input
          type="checkbox"
          checked={linked}
          onChange={(e) => setLinked(e.target.checked)}
        />
        <span>Mantener la proporción actual</span>
      </label>

      <span className="field__label">Dónde queda el dibujo</span>
      <div className="anchor-grid" role="group" aria-label="Anclaje del contenido">
        {ANCHORS.map((a, i) => (
          <button
            key={i}
            type="button"
            className={i === anchor ? 'is-active' : ''}
            onClick={() => setAnchor(i)}
            aria-label={`Anclar en ${a.x === 0 ? 'izquierda' : a.x === 1 ? 'derecha' : 'centro'}, ${a.y === 0 ? 'arriba' : a.y === 1 ? 'abajo' : 'medio'}`}
            aria-pressed={i === anchor}
          />
        ))}
      </div>

      <button className="btn" disabled={!changed} onClick={apply}>
        <IconResize size={16} /> Aplicar {valid ? `${w} × ${h}` : 'tamaño'}
      </button>
      {shrinking && (
        <p className="hint">
          El lienzo se hace más pequeño en algún eje: lo que quede fuera se recorta.
          Deshacer lo devuelve.
        </p>
      )}
      <p className="hint">
        Puedes cambiarlo cuando quieras; los dibujos de todas las capas y fotogramas se
        conservan y se recolocan según el anclaje.
      </p>
    </>
  );
}

/* ================================================================== *
 * Proyecto nuevo
 * ================================================================== */

type ProjectType = 'animation' | 'painting';

/**
 * Tipo de proyecto: Trace siempre tiene línea de tiempo (a diferencia de
 * Procreate, no hay un modo "sólo pintura" distinto de verdad), así que
 * esto no es más que un atajo de valores por defecto sensatos — cuántos
 * fotogramas arranca teniendo el documento y si la línea de tiempo se ve
 * de entrada. Nada se guarda como "tipo" en el documento: nada impide
 * añadir fotogramas después a un proyecto que empezó como "Pintura".
 */
const PROJECT_TYPES: { id: ProjectType; label: string; frameCount: number }[] = [
  { id: 'animation', label: 'Animación', frameCount: 24 },
  { id: 'painting', label: 'Pintura', frameCount: 1 },
];

function NewProjectControls({ engine }: { engine: Engine }) {
  const setShowTimeline = useUI((s) => s.setShowTimeline);
  const [type, setType] = useState<ProjectType>('animation');
  const [preset, setPreset] = useState(SIZE_PRESETS[0]);
  const [confirming, setConfirming] = useState(false);

  const create = () => {
    const t = PROJECT_TYPES.find((p) => p.id === type)!;
    engine.newProject(preset.w, preset.h, 12, t.frameCount);
    setShowTimeline(type === 'animation');
    setConfirming(false);
  };

  return (
    <>
      <div className="mode-row" role="group" aria-label="Tipo de proyecto">
        {PROJECT_TYPES.map((t) => (
          <button
            key={t.id}
            type="button"
            className={type === t.id ? 'is-active' : ''}
            onClick={() => setType(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="preset-grid">
        {SIZE_PRESETS.map((p) => (
          <button
            key={p.label}
            type="button"
            className={p === preset ? 'is-active' : ''}
            onClick={() => setPreset(p)}
          >
            <strong>{p.label}</strong>
            <span>
              {p.w} × {p.h}
            </span>
          </button>
        ))}
      </div>
      {confirming ? (
        <>
          <p className="hint">
            Esto descarta el proyecto actual. Descárgalo antes si te importa — no hay
            forma de recuperarlo después.
          </p>
          <div className="field-row">
            <button className="btn" onClick={create}>
              Sí, empezar de cero
            </button>
            <button className="btn btn--ghost" onClick={() => setConfirming(false)}>
              Cancelar
            </button>
          </div>
        </>
      ) : (
        <button className="btn" onClick={() => setConfirming(true)}>
          <IconPlus size={16} /> Nuevo proyecto
        </button>
      )}
    </>
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
  const [videoQuality, setVideoQuality] = useState(0.7);
  const [framesFolder, setFramesFolder] = useState('frames');
  const [copied, setCopied] = useState<string | null>(null);
  // Consultar los códecs es asíncrono, pero el resultado no cambia durante la
  // sesión. Hasta que responde se muestra el botón deshabilitado.
  const [videoSupport, setVideoSupport] = useState<VideoSupport>({
    available: false,
    realtime: false,
    label: 'comprobando…',
  });
  useEffect(() => {
    let cancelled = false;
    describeVideoSupport(engine.doc.width, engine.doc.height, engine.doc.fps).then((s) => {
      if (!cancelled) setVideoSupport(s);
    });
    return () => {
      cancelled = true;
    };
  }, [engine.doc.width, engine.doc.height, engine.doc.fps]);
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

  const copySnippet = async (which: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(which);
      setTimeout(() => setCopied(null), 2000);
    } catch (err) {
      console.error(err);
      alert('No se pudo copiar al portapapeles.');
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
            max={MAX_FRAME_COUNT}
            value={engine.doc.frameCount}
            onChange={(e) => engine.setFrameCount(Number(e.target.value) || 1)}
          />
        </Field>
      </div>

      <h3 className="panel__subtitle">Tamaño del lienzo</h3>
      <CanvasSizeControls engine={engine} />

      <h3 className="panel__subtitle">Proyecto nuevo</h3>
      <NewProjectControls engine={engine} />

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
            const { doc, historyOps } = await deserializeProject(engine, bytes);
            engine.loadDocument(doc);
            engine.loadHistoryOps(historyOps);
          });
        }}
      />

      <h3 className="panel__subtitle">Exportar</h3>
      <button
        className="btn"
        disabled={!videoSupport.available}
        onClick={() =>
          run('Exportando vídeo…', async () => {
            const result = await exportVideo(engine, {
              quality: videoQuality,
              onProgress: (d, t) => setProgress(`${d}/${t}`),
            });
            downloadBlob(result.blob, `${safeName}.${result.extension}`);
          })
        }
      >
        <IconDownload size={16} /> Vídeo · {videoSupport.label}
      </button>
      <div className="field-row">
        <Field label="Calidad del vídeo">
          <select
            value={videoQuality}
            onChange={(e) => setVideoQuality(Number(e.target.value))}
          >
            <option value={0.35}>Ligera</option>
            <option value={0.7}>Normal</option>
            <option value={1}>Alta</option>
          </select>
        </Field>
      </div>
      {videoSupport.realtime && (
        <p className="hint">
          Este navegador no expone WebCodecs, así que el vídeo se graba en tiempo real:
          una animación de {(engine.doc.frameCount / engine.doc.fps).toFixed(1)} s tardará
          eso mismo en exportarse. No cambies de pestaña mientras tanto.
        </p>
      )}
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
        El vídeo es lo que sirve para publicar y para montar en un editor. El APNG
        conserva transparencia y color sin pérdida pero pesa mucho más; la secuencia de
        PNG es la opción sin pérdidas para seguir trabajando en otro programa.
      </p>

      <h3 className="panel__subtitle">Exportar para web</h3>
      <p className="hint">
        Descarga primero el APNG o la secuencia de PNG de arriba; estos botones sólo
        copian el fragmento HTML que los incrusta, no generan un archivo nuevo.
      </p>
      <button
        className="btn btn--ghost"
        onClick={() =>
          copySnippet('loop', buildLoopEmbedSnippet(engine, `${safeName}.png`))
        }
      >
        <IconCopy size={16} /> Código de inserción · loop transparente (APNG)
      </button>
      <div className="field-row">
        <Field label="Carpeta de fotogramas en tu web">
          <input value={framesFolder} onChange={(e) => setFramesFolder(e.target.value)} />
        </Field>
      </div>
      <button
        className="btn btn--ghost"
        onClick={() =>
          copySnippet('scroll', buildScrollEmbedSnippet(engine, framesFolder || 'frames'))
        }
      >
        <IconCopy size={16} /> Código de inserción · animación con el scroll
      </button>
      {copied && <p className="hint">Copiado al portapapeles.</p>}
      <p className="hint">
        El loop es un simple {'<img>'}: el navegador anima el APNG solo. El de scroll
        dibuja la secuencia de PNG en un {'<canvas>'} fijo y avanza el fotograma según
        cuánto se ha desplazado la página — descomprime el .zip de la secuencia en la
        carpeta indicada, junto al HTML donde pegues el código.
      </p>

      <h3 className="panel__subtitle">Time-lapse</h3>
      {!engine.timelapseRecording && engine.timelapseFrameCount === 0 && (
        <button className="btn btn--ghost" onClick={() => engine.startTimelapseRecording()}>
          Empezar a grabar
        </button>
      )}
      {engine.timelapseRecording && (
        <button className="btn" onClick={() => engine.stopTimelapseRecording()}>
          Detener · {engine.timelapseFrameCount} fotogramas
        </button>
      )}
      {!engine.timelapseRecording && engine.timelapseFrameCount > 0 && (
        <>
          <p className="hint">{engine.timelapseFrameCount} fotogramas grabados.</p>
          <button
            className="btn"
            onClick={() =>
              run('Exportando time-lapse…', async () => {
                const result = await exportImageSequenceAsVideo(
                  [...engine.timelapseFramesSnapshot],
                  24,
                  videoQuality,
                  (d, t) => setProgress(`${d}/${t}`),
                );
                downloadBlob(result.blob, `${safeName}_timelapse.${result.extension}`);
              })
            }
          >
            <IconDownload size={16} /> Exportar time-lapse
          </button>
          <button className="btn btn--ghost" onClick={() => engine.discardTimelapse()}>
            Descartar y empezar de nuevo
          </button>
        </>
      )}
      <p className="hint">
        Graba capturas periódicas mientras dibujas y expórtalas como un vídeo acelerado —
        como el time-lapse de Procreate. No se guarda con el proyecto: se pierde si cierras
        o recargas la página.
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
