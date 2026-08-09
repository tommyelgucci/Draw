import { useSyncExternalStore } from 'react';
import { create } from 'zustand';
import { DEFAULT_BRUSHES, type BrushPreset } from '../core/brush';
import type { Engine } from '../core/engine';
import { clamp, hsvToRgb } from '../core/math';
import type { SelectionMode } from '../core/selection';
import type { RGB } from '../core/types';

export type Tool =
  | 'brush'
  | 'eraser'
  | 'fill'
  | 'eyedropper'
  | 'selectRect'
  | 'selectLasso'
  | 'transform'
  | 'rig'
  | 'pan';

/** Herramientas que construyen una máscara de selección. */
export const SELECT_TOOLS: Tool[] = ['selectRect', 'selectLasso'];

export type PanelId = 'layers' | 'brush' | 'color' | 'export' | 'settings' | null;

export interface PaletteGroup {
  name: string;
  colors: RGB[];
}

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
  paletteGroups: PaletteGroup[];
  recentColors: RGB[];
  panel: PanelId;
  /** Cómo combina el siguiente gesto de selección con la máscara actual. */
  selectionMode: SelectionMode;
  /** Un dedo dibuja; con lápiz conectado suele preferirse desactivado. */
  fingerDraws: boolean;
  /** Mantener el lápiz quieto al final de un trazo lo convierte en una
   * forma perfecta (línea, círculo, rectángulo...). Se puede apagar porque
   * sin aviso previo un trazo lento se sentiría "corregido" sin permiso. */
  quickShapeEnabled: boolean;
  /** 0..1, cuánto tiene que parecerse el trazo a la forma para que encaje.
   * Bajo perdona manos temblorosas o dedos en pantalla táctil; alto exige
   * casi perfección — igual que el ajuste equivalente de Procreate, cuyo
   * punto dulce ronda 0.5-0.8, no el máximo. */
  quickShapePrecision: number;
  showTimeline: boolean;
  busy: string | null;
  /** Hueso activo del gizmo en modo Viewport. Sólo se admite un esqueleto
   *  interactivo a la vez por ahora (`doc.skeletons[0]`), así que no hace
   *  falta guardar también a qué esqueleto pertenece. */
  selectedBoneId: string | null;

  setEngine: (e: Engine | null) => void;
  setTool: (t: Tool) => void;
  setSelectedBoneId: (id: string | null) => void;
  setBrushIndex: (i: number) => void;
  updateBrush: (patch: Partial<BrushPreset>) => void;
  setSize: (v: number | null) => void;
  setOpacity: (v: number | null) => void;
  setColor: (c: RGB, remember?: boolean) => void;
  setPanel: (p: PanelId) => void;
  setSelectionMode: (m: SelectionMode) => void;
  togglePanel: (p: Exclude<PanelId, null>) => void;
  setFingerDraws: (v: boolean) => void;
  setQuickShapeEnabled: (v: boolean) => void;
  setQuickShapePrecision: (v: number) => void;
  setShowTimeline: (v: boolean) => void;
  setBusy: (v: string | null) => void;
}

/** Rueda de tonos uniformemente repartidos, mismo brillo y saturación. */
function hueWheel(count: number, s: number, v: number, offset = 0): RGB[] {
  return Array.from({ length: count }, (_, i) => hsvToRgb((i / count + offset) % 1, s, v));
}

/** Rampa de grises de negro a blanco, con más pasos en el medio que en los extremos. */
const NEUTRALS: RGB[] = [
  { r: 0.05, g: 0.05, b: 0.06 },
  { r: 0.22, g: 0.22, b: 0.24 },
  { r: 0.42, g: 0.42, b: 0.44 },
  { r: 0.62, g: 0.62, b: 0.64 },
  { r: 0.82, g: 0.82, b: 0.84 },
  { r: 1, g: 1, b: 1 },
];

/**
 * Tonos tierra y piel: no salen de la rueda de tonos porque necesitan su
 * propia combinación de saturación y brillo, no un desplazamiento uniforme.
 */
const EARTH_SKIN: RGB[] = [
  { r: 0.8, g: 0.6, b: 0.28 }, // ocre
  { r: 0.7, g: 0.4, b: 0.22 }, // siena tostada
  { r: 0.78, g: 0.35, b: 0.28 }, // terracota
  { r: 0.38, g: 0.25, b: 0.18 }, // sombra tostada
  { r: 0.9, g: 0.78, b: 0.58 }, // arena
  { r: 0.96, g: 0.8, b: 0.68 }, // melocotón
  { r: 0.92, g: 0.78, b: 0.68 }, // beige rosado
  { r: 0.28, g: 0.16, b: 0.11 }, // chocolate
];

const DEFAULT_PALETTE_GROUPS: PaletteGroup[] = [
  { name: 'Neutros', colors: NEUTRALS },
  { name: 'Espectro', colors: hueWheel(12, 0.8, 0.92) },
  // Desplazada respecto al espectro para no repetir los mismos tonos aclarados.
  { name: 'Pasteles', colors: hueWheel(6, 0.35, 0.98, 0.04) },
  { name: 'Tierras y piel', colors: EARTH_SKIN },
];

export const useUI = create<UIState>((set, get) => ({
  engine: null,
  tool: 'brush',
  brushIndex: 0,
  brushes: DEFAULT_BRUSHES.map((b) => ({ ...b })),
  sizeOverride: null,
  opacityOverride: null,
  color: { r: 0.07, g: 0.07, b: 0.09 },
  paletteGroups: DEFAULT_PALETTE_GROUPS,
  recentColors: [],
  panel: null,
  selectionMode: 'replace',
  fingerDraws: true,
  quickShapeEnabled: true,
  quickShapePrecision: 0.6,
  showTimeline: true,
  busy: null,
  selectedBoneId: null,

  setEngine: (engine) => set({ engine }),
  setSelectedBoneId: (selectedBoneId) => set({ selectedBoneId }),
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
  setSelectionMode: (selectionMode) => set({ selectionMode }),
  togglePanel: (p) => set((s) => ({ panel: s.panel === p ? null : p })),
  setFingerDraws: (fingerDraws) => set({ fingerDraws }),
  setQuickShapeEnabled: (quickShapeEnabled) => set({ quickShapeEnabled }),
  setQuickShapePrecision: (quickShapePrecision) => set({ quickShapePrecision: clamp(quickShapePrecision, 0, 1) }),
  setShowTimeline: (showTimeline) => set({ showTimeline }),
  setBusy: (busy) => set({ busy }),
}));

if (import.meta.env.DEV) {
  // Igual que `window.__trace` para el motor: punto de entrada para las
  // pruebas de navegador y para inspeccionar el store desde la consola.
  (window as unknown as { __uiStore: typeof useUI }).__uiStore = useUI;
}

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
