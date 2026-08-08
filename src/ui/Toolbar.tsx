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
  IconRedo,
  IconTransform,
  IconUndo,
} from './icons';

const TOOLS: { id: Tool; label: string; icon: React.ReactNode }[] = [
  { id: 'brush', label: 'Pincel', icon: <IconBrush /> },
  { id: 'eraser', label: 'Borrador', icon: <IconEraser /> },
  { id: 'fill', label: 'Relleno', icon: <IconFill /> },
  { id: 'eyedropper', label: 'Cuentagotas', icon: <IconDropper /> },
  { id: 'transform', label: 'Transformar capa', icon: <IconTransform /> },
  { id: 'pan', label: 'Mover lienzo', icon: <IconHand /> },
];

export function Toolbar({ engine }: { engine: Engine }) {
  useEngineRevision(engine);
  const { tool, setTool, color, togglePanel, panel, sizeOverride, setSize, opacityOverride, setOpacity } =
    useUI();
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
