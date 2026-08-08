import { useSyncExternalStore } from 'react';
import { create } from 'zustand';
import { DEFAULT_BRUSHES, type BrushPreset } from '../core/brush';
import type { Engine } from '../core/engine';
import type { RGB } from '../core/types';

export type Tool = 'brush' | 'eraser' | 'transform' | 'pan' | 'eyedropper' | 'fill';

export type PanelId = 'layers' | 'brush' | 'color' | 'export' | 'settings' | null;

interface UIState {
  engine: Engine | null;
  tool: Tool;
  /** Índice del preset activo dentro de `brushes`. */
  brushIndex: number;
  brushes: BrushPreset[];
  /** Ajustes de tamaño/opacidad que el usuario mueve sin tocar el preset. */
  sizeOverride: number | null;
  opacityOverride: number | null;
  color: RGB;
  palette: RGB[];
  recentColors: RGB[];
  panel: PanelId;
  /** Un dedo dibuja; con lápiz conectado suele preferirse desactivado. */
  fingerDraws: boolean;
  showTimeline: boolean;
  busy: string | null;

  setEngine: (e: Engine | null) => void;
  setTool: (t: Tool) => void;
  setBrushIndex: (i: number) => void;
  updateBrush: (patch: Partial<BrushPreset>) => void;
  setSize: (v: number | null) => void;
  setOpacity: (v: number | null) => void;
  setColor: (c: RGB, remember?: boolean) => void;
  setPanel: (p: PanelId) => void;
  togglePanel: (p: Exclude<PanelId, null>) => void;
  setFingerDraws: (v: boolean) => void;
  setShowTimeline: (v: boolean) => void;
  setBusy: (v: string | null) => void;
}

const DEFAULT_PALETTE: RGB[] = [
  { r: 0.07, g: 0.07, b: 0.09 },
  { r: 1, g: 1, b: 1 },
  { r: 0.85, g: 0.22, b: 0.25 },
  { r: 0.95, g: 0.55, b: 0.15 },
  { r: 0.96, g: 0.83, b: 0.25 },
  { r: 0.35, g: 0.72, b: 0.4 },
  { r: 0.2, g: 0.55, b: 0.85 },
  { r: 0.45, g: 0.35, b: 0.75 },
  { r: 0.9, g: 0.6, b: 0.7 },
  { r: 0.55, g: 0.4, b: 0.3 },
];

export const useUI = create<UIState>((set, get) => ({
  engine: null,
  tool: 'brush',
  brushIndex: 0,
  brushes: DEFAULT_BRUSHES.map((b) => ({ ...b })),
  sizeOverride: null,
  opacityOverride: null,
  color: { r: 0.07, g: 0.07, b: 0.09 },
  palette: DEFAULT_PALETTE,
  recentColors: [],
  panel: null,
  fingerDraws: true,
  showTimeline: true,
  busy: null,

  setEngine: (engine) => set({ engine }),
  setTool: (tool) => {
    // El borrador es un preset, no un modo aparte: cambiar de herramienta
    // sólo cambia qué pincel está activo.
    if (tool === 'eraser') {
      const i = get().brushes.findIndex((b) => b.erase);
      if (i >= 0) set({ brushIndex: i, sizeOverride: null, opacityOverride: null });
    } else if (tool === 'brush' && get().brushes[get().brushIndex]?.erase) {
      const i = get().brushes.findIndex((b) => !b.erase);
      if (i >= 0) set({ brushIndex: i, sizeOverride: null, opacityOverride: null });
    }
    set({ tool });
  },
  setBrushIndex: (brushIndex) =>
    set({ brushIndex, sizeOverride: null, opacityOverride: null }),
  updateBrush: (patch) =>
    set((s) => {
      const brushes = s.brushes.slice();
      brushes[s.brushIndex] = { ...brushes[s.brushIndex], ...patch };
      return { brushes };
    }),
  setSize: (sizeOverride) => set({ sizeOverride }),
  setOpacity: (opacityOverride) => set({ opacityOverride }),
  setColor: (color, remember = false) =>
    set((s) => {
      if (!remember) return { color };
      const key = (c: RGB) => `${c.r.toFixed(3)}|${c.g.toFixed(3)}|${c.b.toFixed(3)}`;
      const recent = [color, ...s.recentColors.filter((c) => key(c) !== key(color))];
      return { color, recentColors: recent.slice(0, 12) };
    }),
  setPanel: (panel) => set({ panel }),
  togglePanel: (p) => set((s) => ({ panel: s.panel === p ? null : p })),
  setFingerDraws: (fingerDraws) => set({ fingerDraws }),
  setShowTimeline: (showTimeline) => set({ showTimeline }),
  setBusy: (busy) => set({ busy }),
}));

/** Pincel activo con los ajustes rápidos de tamaño y opacidad aplicados. */
export function useActiveBrush(): BrushPreset {
  const { brushes, brushIndex, sizeOverride, opacityOverride } = useUI();
  const base = brushes[brushIndex] ?? brushes[0];
  return {
    ...base,
    size: sizeOverride ?? base.size,
    opacity: opacityOverride ?? base.opacity,
  };
}

/**
 * Re-renderiza cuando el motor cambia. El documento es un objeto mutable a
 * propósito: duplicar cels y capas en el store de React sólo serviría para
 * copiar megabytes en cada trazo.
 */
export function useEngineRevision(engine: Engine | null): number {
  return useSyncExternalStore(
    (cb) => (engine ? engine.subscribe(cb) : () => {}),
    () => engine?.revision ?? 0,
    () => 0,
  );
}
