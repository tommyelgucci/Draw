import { useSyncExternalStore } from 'react';
import { create } from 'zustand';
import { DEFAULT_BRUSHES, type BrushPreset } from '../core/brush';
import type { Engine } from '../core/engine';
import { clamp, hexToRgb, hsvToRgb } from '../core/math';
import type { SelectionMode } from '../core/selection';
import type { RGB } from '../core/types';

export type Tool =
  | 'brush'
  | 'eraser'
  | 'fill'
  | 'eyedropper'
  | 'selectRect'
  | 'selectLasso'
  | 'selectWand'
  | 'transform'
  | 'rig'
  | 'pan';

/** Herramientas que construyen una máscara de selección. */
export const SELECT_TOOLS: Tool[] = ['selectRect', 'selectLasso', 'selectWand'];

export type PanelId = 'layers' | 'brush' | 'color' | 'export' | 'settings' | 'poses' | null;

export interface PaletteGroup {
  name: string;
  colors: RGB[];
}

/** Paleta creada por el usuario: a diferencia de `PaletteGroup` tiene `id`
 * (el nombre es editable y no sirve como clave) y vive en `localStorage`,
 * no en el documento — es una preferencia de la persona, no del dibujo. */
export interface UserPalette {
  id: string;
  name: string;
  colors: RGB[];
}

const USER_PALETTES_KEY = 'trace:paletas';

function loadUserPalettes(): UserPalette[] {
  try {
    const raw = localStorage.getItem(USER_PALETTES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveUserPalettes(list: UserPalette[]) {
  try {
    localStorage.setItem(USER_PALETTES_KEY, JSON.stringify(list));
  } catch {
    // Cuota llena o almacenamiento bloqueado (navegación privada): la
    // sesión sigue igual, sólo no sobrevive a un recargado.
  }
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
  userPalettes: UserPalette[];
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
  /** 0..1, tolerancia de color de la varita mágica — se reajusta arrastrando
   *  en horizontal durante el gesto, pero el valor de salida de cada toque
   *  nuevo es el que dejó el anterior, como en Procreate. */
  wandTolerance: number;
  showTimeline: boolean;
  busy: string | null;
  /** Hueso activo del gizmo en modo Viewport. Sólo se admite un esqueleto
   *  interactivo a la vez por ahora (`doc.skeletons[0]`), así que no hace
   *  falta guardar también a qué esqueleto pertenece. */
  selectedBoneId: string | null;
  /** Arrastrar en la regla de la línea de tiempo marca un rango en vez de
   *  sólo mover el cabezal — lo que necesita `engine.liftSelectionRange`
   *  para saber qué cuadros incluir en la transformación por lote. */
  rangeSelectMode: boolean;
  frameRangeStart: number | null;
  frameRangeEnd: number | null;
  /** Con IK activada, el tirador de "rotar" de un hueso con padre arrastra
   *  la cadena de 2 huesos entera (`engine.beginBoneIKDrag`) en vez de
   *  rotar sólo ese hueso. */
  ikEnabled: boolean;
  /** Id del hueso que espera nuevo padre: el siguiente toque en el lienzo
   *  (otro hueso, o vacío para desengancharlo a raíz) decide cuál. */
  reparentingBoneId: string | null;
  /** Capas marcadas con la casilla del panel para agruparlas en una
   *  carpeta — vive aquí y no en el documento porque es un gesto de UI a
   *  medias, no contenido. */
  layerGroupSelection: string[];
  /** Posición a la que se arrastró cada panel flotante (clave = `title`,
   *  que ya es único y estable por panel — ver `Panel` en controls.tsx).
   *  Ausente = sin arrastrar todavía, usa la posición por defecto del CSS. */
  panelPositions: Record<string, { left: number; top: number } | undefined>;
  /** Punto de pantalla que debe mostrar la lupa de precisión mientras se
   *  arrastra un tirador fino (nodo de QuickShape, tirador de selección,
   *  de hueso…) — null cuando no hay ningún arrastre de precisión activo. */
  precisionDragAt: { x: number; y: number } | null;

  setEngine: (e: Engine | null) => void;
  setTool: (t: Tool) => void;
  setSelectedBoneId: (id: string | null) => void;
  setBrushIndex: (i: number) => void;
  updateBrush: (patch: Partial<BrushPreset>) => void;
  setSize: (v: number | null) => void;
  setOpacity: (v: number | null) => void;
  setColor: (c: RGB, remember?: boolean) => void;
  createUserPalette: (name: string) => void;
  renameUserPalette: (id: string, name: string) => void;
  deleteUserPalette: (id: string) => void;
  addColorToUserPalette: (id: string, color: RGB) => void;
  removeColorFromUserPalette: (id: string, index: number) => void;
  setPanel: (p: PanelId) => void;
  setSelectionMode: (m: SelectionMode) => void;
  togglePanel: (p: Exclude<PanelId, null>) => void;
  setFingerDraws: (v: boolean) => void;
  setQuickShapeEnabled: (v: boolean) => void;
  setQuickShapePrecision: (v: number) => void;
  setWandTolerance: (v: number) => void;
  setShowTimeline: (v: boolean) => void;
  setBusy: (v: string | null) => void;
  setRangeSelectMode: (v: boolean) => void;
  setFrameRange: (start: number | null, end: number | null) => void;
  setIkEnabled: (v: boolean) => void;
  setReparentingBoneId: (v: string | null) => void;
  toggleLayerGroupSelection: (id: string) => void;
  clearLayerGroupSelection: () => void;
  setPanelPosition: (id: string, pos: { left: number; top: number } | undefined) => void;
  setPrecisionDragAt: (p: { x: number; y: number } | null) => void;
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

/** Convierte una lista de hex en `RGB[]` — más legible que teclear
 *  fracciones a mano para paletas curadas a partir de una imagen de
 *  referencia (no se copia ningún píxel, sólo el juicio de qué color
 *  representa cada mancha). */
const hexList = (hexes: string[]): RGB[] => hexes.map(hexToRgb);

// Las diez paletas de abajo vienen de capturas que trajo quien usa la app
// (varias generadas por Gemini, con el texto del código hex a veces
// equivocado respecto al color real de la mancha — un fallo conocido de
// generación de imagen, no un dato fiable). Los hex de aquí son juicio
// visual sobre el color de cada mancha, no una transcripción del texto
// que traía la imagen.
const FOREST: RGB[] = hexList([
  '#2f4f2f', '#3a6b35', '#4f9d5c', '#0f3d2e', '#6b8f47',
  '#9caf6b', '#c9d94a', '#7a5230', '#5c4030', '#8a8a7a', '#c9a86a', '#d98a8a',
]);
const ANCIENT_ART: RGB[] = hexList([
  '#3d7ea6', '#2f7a7a', '#f0c419', '#d4691e', '#a13d1f', '#4a2e1a', '#c9a876', '#8fa8c9',
]);
const RENAISSANCE_ART: RGB[] = hexList([
  '#7a8a6a', '#a15c4a', '#6a7a8a', '#4a3826', '#c97a3a', '#e8dcc0', '#3a5a6a', '#8a6a8a',
]);
const IMPRESSIONIST_ART: RGB[] = hexList([
  '#d9a521', '#4a7a3a', '#1f4a2f', '#7a8ac9', '#e88a5a', '#f0c8a0', '#8aa87a', '#2f5a8a', '#6a4a8a',
]);
const WINTER: RGB[] = hexList(['#8a1a5c', '#3a1a5c', '#1a2a6c', '#0a5c3a', '#2ab5c9', '#e91e8a']);
const SUMMER: RGB[] = hexList(['#c97a94', '#b0a0c9', '#a0bcd9', '#8fae94', '#a67c94', '#d9c9a0']);
const AUTUMN: RGB[] = hexList(['#a83a1f', '#6a5c1f', '#c98a1f', '#4a3020', '#c9602f']);
const SPRING: RGB[] = hexList(['#e85c6a', '#f0c020', '#4aa83a', '#4a9ad9', '#e88aa8']);
const OCEAN: RGB[] = hexList([
  '#7ab0d9', '#2a6a9a', '#1a3a5c', '#2fae9a', '#0a6a5a', '#f0a888', '#e8654a', '#8a7a6a', '#4a4038',
]);
const TWILIGHT: RGB[] = hexList([
  '#1a1a3a', '#3a2a6a', '#6a4a9a', '#a05a8a', '#c97a5a', '#e8a83a', '#f0d980', '#1a2a1a', '#0a0a0a',
]);
const GOLDEN_HOUR: RGB[] = hexList([
  '#ffd700', '#ffa500', '#ff6a2a', '#d9391f', '#8a1a1a', '#a83a5c', '#6a2a7a', '#4a1a5c',
]);
const MOUNTAIN: RGB[] = hexList([
  '#2f3320', '#5c6a5a', '#515c43', '#9d989a', '#445454', '#8a684c', '#5c768f', '#382a40', '#cc7105', '#b56323',
]);

// Estas dos, en cambio, las trajo quien usa la app desde fuera de Gemini
// (una ficha de pintura real y una lámina de combinaciones pastel) — se
// suman a la paleta "Pasteles" ya existente en vez de abrir una nueva,
// tal como se pidió.
const PASTEL_EXTRA: RGB[] = hexList([
  '#c7c0b4', // beige apagado
  '#54615f', // peltre
  '#c2bc8a', // hierba seca
  '#f2ebd9', // crema
  '#cc8148', // terracota
  '#9cc2a0', '#b8e0bc', '#d4edb0', '#363a54', '#4a8a78', '#f0d0d8',
  '#f4837e', '#f5c79a', '#1a6e7e', '#c9bc9e', '#c0dce0',
  '#90b89a', '#e0a85c', '#9a7268', '#93a8b8',
]);

const DEFAULT_PALETTE_GROUPS: PaletteGroup[] = [
  { name: 'Neutros', colors: NEUTRALS },
  { name: 'Espectro', colors: hueWheel(12, 0.8, 0.92) },
  // Desplazada respecto al espectro para no repetir los mismos tonos
  // aclarados; ampliada con selección de dos láminas de referencia.
  { name: 'Pasteles', colors: [...hueWheel(6, 0.35, 0.98, 0.04), ...PASTEL_EXTRA] },
  { name: 'Tierras y piel', colors: EARTH_SKIN },
  { name: 'Bosque', colors: FOREST },
  { name: 'Arte antiguo', colors: ANCIENT_ART },
  { name: 'Arte renacentista', colors: RENAISSANCE_ART },
  { name: 'Arte impresionista', colors: IMPRESSIONIST_ART },
  { name: 'Invierno', colors: WINTER },
  { name: 'Verano', colors: SUMMER },
  { name: 'Otoño', colors: AUTUMN },
  { name: 'Primavera', colors: SPRING },
  { name: 'Océano', colors: OCEAN },
  { name: 'Crepúsculo', colors: TWILIGHT },
  { name: 'Hora dorada', colors: GOLDEN_HOUR },
  { name: 'Montaña', colors: MOUNTAIN },
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
  userPalettes: loadUserPalettes(),
  recentColors: [],
  panel: null,
  selectionMode: 'replace',
  fingerDraws: true,
  quickShapeEnabled: true,
  quickShapePrecision: 0.6,
  wandTolerance: 0.15,
  showTimeline: true,
  busy: null,
  selectedBoneId: null,
  rangeSelectMode: false,
  frameRangeStart: null,
  frameRangeEnd: null,
  ikEnabled: false,
  reparentingBoneId: null,
  layerGroupSelection: [],
  panelPositions: {},
  precisionDragAt: null,

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
  createUserPalette: (name) =>
    set((s) => {
      const userPalettes = [...s.userPalettes, { id: crypto.randomUUID(), name, colors: [] }];
      saveUserPalettes(userPalettes);
      return { userPalettes };
    }),
  renameUserPalette: (id, name) =>
    set((s) => {
      const userPalettes = s.userPalettes.map((p) => (p.id === id ? { ...p, name } : p));
      saveUserPalettes(userPalettes);
      return { userPalettes };
    }),
  deleteUserPalette: (id) =>
    set((s) => {
      const userPalettes = s.userPalettes.filter((p) => p.id !== id);
      saveUserPalettes(userPalettes);
      return { userPalettes };
    }),
  addColorToUserPalette: (id, color) =>
    set((s) => {
      const userPalettes = s.userPalettes.map((p) =>
        p.id === id ? { ...p, colors: [...p.colors, color] } : p,
      );
      saveUserPalettes(userPalettes);
      return { userPalettes };
    }),
  removeColorFromUserPalette: (id, index) =>
    set((s) => {
      const userPalettes = s.userPalettes.map((p) =>
        p.id === id ? { ...p, colors: p.colors.filter((_, i) => i !== index) } : p,
      );
      saveUserPalettes(userPalettes);
      return { userPalettes };
    }),
  setPanel: (panel) => set({ panel }),
  setSelectionMode: (selectionMode) => set({ selectionMode }),
  togglePanel: (p) => set((s) => ({ panel: s.panel === p ? null : p })),
  setFingerDraws: (fingerDraws) => set({ fingerDraws }),
  setQuickShapeEnabled: (quickShapeEnabled) => set({ quickShapeEnabled }),
  setQuickShapePrecision: (quickShapePrecision) => set({ quickShapePrecision: clamp(quickShapePrecision, 0, 1) }),
  setWandTolerance: (wandTolerance) => set({ wandTolerance: clamp(wandTolerance, 0, 1) }),
  setShowTimeline: (showTimeline) => set({ showTimeline }),
  setBusy: (busy) => set({ busy }),
  setRangeSelectMode: (rangeSelectMode) =>
    set(rangeSelectMode ? { rangeSelectMode } : { rangeSelectMode, frameRangeStart: null, frameRangeEnd: null }),
  setFrameRange: (frameRangeStart, frameRangeEnd) => set({ frameRangeStart, frameRangeEnd }),
  setIkEnabled: (ikEnabled) => set({ ikEnabled }),
  setReparentingBoneId: (reparentingBoneId) => set({ reparentingBoneId }),
  toggleLayerGroupSelection: (id) =>
    set((s) => ({
      layerGroupSelection: s.layerGroupSelection.includes(id)
        ? s.layerGroupSelection.filter((x) => x !== id)
        : [...s.layerGroupSelection, id],
    })),
  clearLayerGroupSelection: () => set({ layerGroupSelection: [] }),
  setPanelPosition: (id, pos) =>
    set((s) => ({ panelPositions: { ...s.panelPositions, [id]: pos } })),
  setPrecisionDragAt: (precisionDragAt) => set({ precisionDragAt }),
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
