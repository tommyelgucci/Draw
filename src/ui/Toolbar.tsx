import { useEffect, useState } from 'react';
import type { Engine } from '../core/engine';
import { rgbToHex } from '../core/math';
import { useActiveBrush, useEngineRevision, useUI, type Tool } from '../state/store';
import { IconButton, Slider } from './controls';
import { useCompact } from './useCompact';
import {
  IconBrush,
  IconDropper,
  IconEraser,
  IconFill,
  IconFit,
  IconHand,
  IconLayers,
  IconMenu,
  IconLasso,
  IconRedo,
  IconSelectRect,
  IconTransform,
  IconUndo,
} from './icons';
import type { SelectionMode } from '../core/selection';

const TOOLS: { id: Tool; label: string; icon: React.ReactNode }[] = [
  { id: 'brush', label: 'Pincel', icon: <IconBrush /> },
  { id: 'eraser', label: 'Borrador', icon: <IconEraser /> },
  { id: 'fill', label: 'Relleno', icon: <IconFill /> },
  { id: 'eyedropper', label: 'Cuentagotas', icon: <IconDropper /> },
  { id: 'selectRect', label: 'Seleccionar rectángulo', icon: <IconSelectRect /> },
  { id: 'selectLasso', label: 'Lazo', icon: <IconLasso /> },
  { id: 'transform', label: 'Transformar capa', icon: <IconTransform /> },
  { id: 'pan', label: 'Mover lienzo', icon: <IconHand /> },
];

const SELECTION_MODES: { id: SelectionMode; label: string; glyph: string }[] = [
  { id: 'replace', label: 'Selección nueva', glyph: '□' },
  { id: 'add', label: 'Añadir a la selección', glyph: '+' },
  { id: 'subtract', label: 'Restar de la selección', glyph: '−' },
];

export function Toolbar({ engine }: { engine: Engine }) {
  useEngineRevision(engine);
  const {
    tool,
    setTool,
    color,
    togglePanel,
    panel,
    sizeOverride,
    setSize,
    opacityOverride,
    setOpacity,
    selectionMode,
    setSelectionMode,
  } = useUI();
  const selecting = tool === 'selectRect' || tool === 'selectLasso';
  const brush = useActiveBrush();
  const compact = useCompact();
  const [, force] = useState(0);

  // El historial cambia sin tocar el documento, así que se avisa aparte.
  useEffect(() => engine.history.subscribe(() => force((n) => n + 1)), [engine]);

  return (
    <>
      <div className="rail rail--left">
        <div className="rail__group">
          {TOOLS.map((t) => (
            <IconButton
              key={t.id}
              title={t.label}
              active={tool === t.id}
              onClick={() => setTool(t.id)}
            >
              {t.icon}
            </IconButton>
          ))}
          <button
            type="button"
            className="color-well"
            style={{ background: rgbToHex(color) }}
            onClick={() => togglePanel('color')}
            title="Color"
            aria-label="Elegir color"
          />
        </div>

        {selecting && (
          <div className="mode-row" role="group" aria-label="Modo de selección">
            {SELECTION_MODES.map((m) => (
              <button
                key={m.id}
                type="button"
                className={selectionMode === m.id ? 'is-active' : ''}
                onClick={() => setSelectionMode(m.id)}
                title={m.label}
                aria-label={m.label}
                aria-pressed={selectionMode === m.id}
              >
                {m.glyph}
              </button>
            ))}
          </div>
        )}

        <div className="rail__sliders">
          <Slider
            vertical={!compact}
            value={sizeOverride ?? brush.size}
            min={0.5}
            max={400}
            curve={2.2}
            onChange={setSize}
          />
          <Slider
            vertical={!compact}
            value={opacityOverride ?? brush.opacity}
            min={0}
            max={1}
            onChange={setOpacity}
          />
        </div>
      </div>

      <div className="rail rail--top">
        <IconButton
          title="Deshacer"
          onClick={() => engine.history.undo()}
          disabled={!engine.history.canUndo}
        >
          <IconUndo />
        </IconButton>
        <IconButton
          title="Rehacer"
          onClick={() => engine.history.redo()}
          disabled={!engine.history.canRedo}
        >
          <IconRedo />
        </IconButton>
        <span className="rail__divider" />
        <IconButton title="Encajar lienzo" onClick={() => engine.resetView()}>
          <IconFit />
        </IconButton>
        <span className="zoom-readout">{Math.round(engine.view.zoom * 100)}%</span>
        <span className="rail__divider" />
        <IconButton
          title="Pincel"
          active={panel === 'brush'}
          onClick={() => togglePanel('brush')}
        >
          <IconBrush />
        </IconButton>
        <IconButton
          title="Capas"
          active={panel === 'layers'}
          onClick={() => togglePanel('layers')}
        >
          <IconLayers />
        </IconButton>
        <IconButton
          title="Proyecto"
          active={panel === 'export'}
          onClick={() => togglePanel('export')}
        >
          <IconMenu />
        </IconButton>
      </div>
    </>
  );
}
