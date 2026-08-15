import type { BuiltinTextureId } from './brushTexture';
import { OneEuroFilter, clamp, lerp, TAU } from './math';
import type { InputSample, Stamp } from './types';

/** Agrupa los presets en el panel de pincel; no cambia cómo dibuja cada uno. */
export type BrushCategory = 'sketch' | 'ink' | 'paint' | 'texture' | 'eraser';

export const BRUSH_CATEGORIES: BrushCategory[] = ['sketch', 'ink', 'paint', 'texture', 'eraser'];

export const BRUSH_CATEGORY_LABELS: Record<BrushCategory, string> = {
  sketch: 'Boceto',
  ink: 'Entintado',
  paint: 'Pintura',
  texture: 'Texturas',
  eraser: 'Borradores',
};

export interface BrushPreset {
  id: string;
  name: string;
  category: BrushCategory;
  /** Diámetro base en píxeles de documento. */
  size: number;
  /** Opacidad del trazo completo, 0..1. */
  opacity: number;
  /** Alfa de cada estampa individual. Bajo = acumulación gradual. */
  flow: number;
  /** 0 = degradado hasta el centro, 1 = borde duro. */
  hardness: number;
  /** Separación entre estampas como fracción del diámetro. */
  spacing: number;
  /** Cuánto reduce el tamaño la presión mínima, 0..1. */
  pressureSize: number;
  /** Cuánto reduce el alfa la presión mínima, 0..1. */
  pressureOpacity: number;
  /** Achatamiento de la punta al inclinar el lápiz, 0..1. */
  tiltAspect: number;
  /** Positivo adelgaza al acelerar (plumilla), negativo engorda. */
  velocitySize: number;
  /** Estabilización del trazo, 0..1. */
  smoothing: number;
  /** Variación aleatoria del tamaño por estampa, 0..1. */
  jitterSize: number;
  /** Dispersión aleatoria perpendicular, en fracción del diámetro. */
  scatter: number;
  /** La punta gira siguiendo la dirección del trazo. */
  followDirection: boolean;
  /** Giro aleatorio por estampa, 0..1 (fracción de ±90°) — lo que separa un
   *  peine de púas fijas (0) de un mechón de pelo o césped disperso (>0):
   *  misma textura alargada, orientación de cada estampa al azar en vez de
   *  todas alineadas con el trazo. */
  angleJitter: number;
  /** Afina ambos extremos del trazo hasta un punto, 0 = sin afinar. La
   * longitud real en píxeles escala con `size` (ver `taperScale`), así que
   * el mismo valor se ve proporcional en una punta fina que en una gruesa. */
  taper: number;
  /** Achatamiento fijo de la punta, 1 = círculo. */
  aspect: number;
  /** Borra en vez de pintar. */
  erase: boolean;
  /**
   * Máscara de cobertura por estampa; `null` = punta lisa (el círculo de
   * siempre). Un `BuiltinTextureId` referencia una de las integradas;
   * cualquier otro string referencia un `CustomTexture.id` del documento
   * activo (importada por quien dibuja) — ver `Engine.resolveTexturePixels`.
   */
  textureId: BuiltinTextureId | string | null;
  /**
   * 0..1: cuánto se funde el trazo terminado con lo que ya había debajo como
   * pigmento (espacio lineal + mezcla multiplicativa) en vez de superponerse
   * en alfa plano — ver `gl/shaders.ts` (`MIX_FS`). 0 es el comportamiento de
   * siempre. No es una simulación física de pigmento, sólo se aparta de la
   * mezcla digital plana en la misma dirección.
   */
  pigmentMix: number;
  /**
   * 0..1: en vez de depositar el color activo del pincel, arrastra el color
   * que YA está pintado bajo la punta — pintura húmeda que se mezcla al
   * arrastrar el dedo, no un depósito de color fijo. 0 es el comportamiento
   * de siempre. Sólo recoge de lo que ya estaba en el cel ANTES de este
   * trazo (no de lo que el propio trazo lleva pintado hasta ahora) — ver
   * `Engine.sampleSmudgeColor`.
   */
  smudge: number;
  /**
   * 0..1: cuánta "memoria" tiene el color recogido de una estampa a la
   * siguiente — alto lo deja diluirse despacio, bajo lo actualiza casi al
   * instante con lo que haya justo debajo. Sin efecto si `smudge` es 0.
   */
  smudgeLength: number;
}

export const DEFAULT_BRUSHES: BrushPreset[] = [
  // --- Boceto ---------------------------------------------------------
  {
    id: 'pencil',
    name: 'Lápiz',
    category: 'sketch',
    size: 6,
    opacity: 0.95,
    flow: 0.55,
    hardness: 0.55,
    spacing: 0.07,
    pressureSize: 0.55,
    pressureOpacity: 0.7,
    tiltAspect: 0.5,
    velocitySize: 0.15,
    smoothing: 0.35,
    jitterSize: 0.12,
    scatter: 0.05,
    followDirection: true,
    angleJitter: 0,
    taper: 0.3,
    aspect: 1,
    erase: false,
    pigmentMix: 0,
    smudge: 0,
    smudgeLength: 0.5,
    // Lisa por defecto: es el pincel activo al abrir la app y no debe
    // cambiar el trazo de siempre. La textura queda disponible para quien
    // la busque en el panel.
    textureId: null,
  },
  {
    id: 'pencil-soft',
    name: 'Lápiz blando',
    category: 'sketch',
    size: 14,
    opacity: 0.7,
    flow: 0.4,
    hardness: 0.35,
    spacing: 0.08,
    pressureSize: 0.5,
    pressureOpacity: 0.6,
    tiltAspect: 0.6,
    velocitySize: 0.1,
    smoothing: 0.3,
    jitterSize: 0.15,
    scatter: 0.08,
    followDirection: true,
    angleJitter: 0,
    taper: 0.15,
    aspect: 1,
    erase: false,
    pigmentMix: 0,
    smudge: 0,
    smudgeLength: 0.5,
    // A este tamaño el grano ya se lee: por debajo de ~12px se pierde (ver
    // CHECKPOINT.md, deuda conocida).
    textureId: 'grain',
  },
  {
    id: 'graphite',
    name: 'Grafito',
    category: 'sketch',
    size: 18,
    opacity: 0.85,
    flow: 0.6,
    hardness: 0.45,
    spacing: 0.06,
    pressureSize: 0.4,
    pressureOpacity: 0.5,
    tiltAspect: 0.4,
    velocitySize: 0.1,
    smoothing: 0.3,
    jitterSize: 0.1,
    scatter: 0.04,
    followDirection: true,
    angleJitter: 0,
    taper: 0.25,
    aspect: 0.9,
    erase: false,
    pigmentMix: 0,
    smudge: 0,
    smudgeLength: 0.5,
    textureId: 'grain',
  },
  {
    id: 'charcoal',
    name: 'Carboncillo',
    category: 'sketch',
    size: 22,
    opacity: 0.6,
    flow: 0.5,
    hardness: 0.15,
    spacing: 0.07,
    pressureSize: 0.3,
    pressureOpacity: 0.5,
    tiltAspect: 0.7,
    velocitySize: 0,
    smoothing: 0.25,
    jitterSize: 0.2,
    scatter: 0.15,
    followDirection: true,
    angleJitter: 0,
    taper: 0.1,
    aspect: 0.7,
    erase: false,
    pigmentMix: 0,
    smudge: 0,
    smudgeLength: 0.5,
    textureId: 'chalk',
  },

  // --- Entintado --------------------------------------------------------
  {
    id: 'ink',
    name: 'Entintado',
    category: 'ink',
    size: 8,
    opacity: 1,
    flow: 1,
    hardness: 0.95,
    spacing: 0.04,
    pressureSize: 0.85,
    pressureOpacity: 0.1,
    tiltAspect: 0,
    velocitySize: 0.35,
    smoothing: 0.6,
    jitterSize: 0,
    scatter: 0,
    followDirection: true,
    angleJitter: 0,
    taper: 0.45,
    aspect: 1,
    erase: false,
    pigmentMix: 0,
    smudge: 0,
    smudgeLength: 0.5,
    textureId: null,
  },
  {
    id: 'fineliner',
    name: 'Rotulador fino',
    category: 'ink',
    size: 4,
    opacity: 1,
    flow: 1,
    hardness: 1,
    spacing: 0.03,
    // Grosor casi constante: es lo que distingue un rotulador técnico de la
    // plumilla de "Entintado", que sí reacciona a la presión.
    pressureSize: 0.1,
    pressureOpacity: 0.05,
    tiltAspect: 0,
    velocitySize: 0,
    smoothing: 0.5,
    jitterSize: 0,
    scatter: 0,
    followDirection: true,
    angleJitter: 0,
    taper: 0.2,
    aspect: 1,
    erase: false,
    pigmentMix: 0,
    smudge: 0,
    smudgeLength: 0.5,
    textureId: null,
  },
  {
    id: 'calligraphy',
    name: 'Caligráfico',
    category: 'ink',
    size: 16,
    opacity: 1,
    flow: 1,
    hardness: 0.9,
    spacing: 0.03,
    pressureSize: 0.6,
    pressureOpacity: 0.2,
    // La punta va muy achatada y no sigue la dirección del trazo, sino el
    // ángulo del lápiz: es lo que da el contraste grueso/fino de una pluma.
    tiltAspect: 0.9,
    velocitySize: 0.2,
    smoothing: 0.5,
    jitterSize: 0,
    scatter: 0,
    followDirection: false,
    angleJitter: 0,
    taper: 0.15,
    aspect: 0.15,
    erase: false,
    pigmentMix: 0,
    smudge: 0,
    smudgeLength: 0.5,
    textureId: null,
  },
  {
    id: 'marker',
    name: 'Marcador',
    category: 'ink',
    size: 28,
    opacity: 0.85,
    flow: 0.9,
    hardness: 0.8,
    spacing: 0.05,
    pressureSize: 0.15,
    pressureOpacity: 0.25,
    tiltAspect: 0.2,
    velocitySize: 0,
    smoothing: 0.4,
    jitterSize: 0,
    scatter: 0,
    followDirection: true,
    angleJitter: 0,
    taper: 0,
    aspect: 0.35,
    erase: false,
    pigmentMix: 0,
    smudge: 0,
    smudgeLength: 0.5,
    textureId: null,
  },

  // --- Pintura ------------------------------------------------------
  {
    id: 'paint',
    name: 'Pintura',
    category: 'paint',
    size: 40,
    opacity: 1,
    flow: 0.75,
    hardness: 0.35,
    spacing: 0.06,
    pressureSize: 0.4,
    pressureOpacity: 0.5,
    tiltAspect: 0.6,
    velocitySize: 0,
    smoothing: 0.45,
    jitterSize: 0.08,
    scatter: 0.12,
    followDirection: true,
    angleJitter: 0,
    taper: 0.15,
    aspect: 0.85,
    erase: false,
    pigmentMix: 0,
    smudge: 0,
    smudgeLength: 0.5,
    textureId: 'canvas',
  },
  {
    id: 'watercolor',
    name: 'Acuarela',
    category: 'paint',
    size: 50,
    // Opacidad y flujo bajos a propósito: la acuarela se acumula pasada a
    // pasada, no llega opaca de un solo trazo.
    opacity: 0.4,
    flow: 0.12,
    hardness: 0,
    spacing: 0.08,
    pressureSize: 0.2,
    pressureOpacity: 0.6,
    tiltAspect: 0,
    velocitySize: 0,
    smoothing: 0.5,
    jitterSize: 0.05,
    scatter: 0.05,
    followDirection: false,
    angleJitter: 0,
    taper: 0.1,
    aspect: 1,
    erase: false,
    pigmentMix: 0,
    smudge: 0,
    smudgeLength: 0.5,
    // La textura de tiza, a baja intensidad, se lee como el granulado del
    // pigmento asentándose en el papel húmedo.
    textureId: 'chalk',
  },
  {
    id: 'gouache',
    name: 'Gouache',
    category: 'paint',
    size: 30,
    opacity: 0.95,
    flow: 0.85,
    hardness: 0.6,
    spacing: 0.05,
    pressureSize: 0.25,
    pressureOpacity: 0.3,
    tiltAspect: 0.3,
    velocitySize: 0,
    smoothing: 0.35,
    jitterSize: 0.05,
    scatter: 0.03,
    followDirection: true,
    angleJitter: 0,
    taper: 0.1,
    aspect: 0.9,
    erase: false,
    pigmentMix: 0,
    smudge: 0,
    smudgeLength: 0.5,
    // Mate y opaco, sin grano: la acuarela ya cubre ese territorio.
    textureId: null,
  },
  {
    id: 'acrylic',
    name: 'Acrílico',
    category: 'paint',
    size: 45,
    opacity: 1,
    flow: 0.9,
    hardness: 0.5,
    spacing: 0.05,
    pressureSize: 0.2,
    pressureOpacity: 0.2,
    tiltAspect: 0.4,
    velocitySize: 0,
    smoothing: 0.3,
    jitterSize: 0.05,
    scatter: 0.05,
    followDirection: true,
    angleJitter: 0,
    taper: 0.1,
    aspect: 0.8,
    erase: false,
    pigmentMix: 0,
    smudge: 0,
    smudgeLength: 0.5,
    textureId: 'canvas',
  },

  // --- Texturas -------------------------------------------------------
  {
    id: 'airbrush',
    name: 'Aerógrafo',
    category: 'texture',
    size: 70,
    opacity: 0.6,
    flow: 0.06,
    hardness: 0,
    spacing: 0.03,
    pressureSize: 0.3,
    pressureOpacity: 0.9,
    tiltAspect: 0,
    velocitySize: 0,
    smoothing: 0.3,
    jitterSize: 0,
    scatter: 0,
    followDirection: false,
    angleJitter: 0,
    taper: 0,
    aspect: 1,
    erase: false,
    pigmentMix: 0,
    smudge: 0,
    smudgeLength: 0.5,
    // Con flujo tan bajo, cualquier textura lo deja casi invisible: liso.
    textureId: null,
  },
  {
    id: 'airbrush-splatter',
    name: 'Aerógrafo salpicado',
    category: 'texture',
    size: 60,
    // Más opaco y con más flujo que el aerógrafo liso: si no, la máscara de
    // salpicadura lo deja casi invisible, como pasó al probarlo en el liso.
    opacity: 0.7,
    flow: 0.2,
    hardness: 0,
    spacing: 0.04,
    pressureSize: 0.25,
    pressureOpacity: 0.6,
    tiltAspect: 0,
    velocitySize: 0,
    smoothing: 0.35,
    jitterSize: 0,
    scatter: 0.1,
    followDirection: false,
    angleJitter: 0,
    taper: 0,
    aspect: 1,
    erase: false,
    pigmentMix: 0,
    smudge: 0,
    smudgeLength: 0.5,
    textureId: 'splatter',
  },
  {
    id: 'pastel',
    name: 'Pastel',
    category: 'texture',
    size: 34,
    opacity: 0.75,
    flow: 0.5,
    hardness: 0.2,
    spacing: 0.08,
    pressureSize: 0.3,
    pressureOpacity: 0.4,
    tiltAspect: 0.6,
    velocitySize: 0,
    smoothing: 0.3,
    jitterSize: 0.2,
    scatter: 0.2,
    followDirection: false,
    angleJitter: 0,
    taper: 0,
    aspect: 0.7,
    erase: false,
    pigmentMix: 0,
    smudge: 0,
    smudgeLength: 0.5,
    textureId: 'chalk',
  },
  {
    id: 'canvas-weave',
    name: 'Textura de lienzo',
    category: 'texture',
    size: 55,
    opacity: 0.5,
    flow: 0.35,
    hardness: 0.4,
    spacing: 0.1,
    pressureSize: 0.15,
    pressureOpacity: 0.3,
    tiltAspect: 0.2,
    velocitySize: 0,
    smoothing: 0.3,
    jitterSize: 0.05,
    scatter: 0.05,
    followDirection: true,
    angleJitter: 0,
    taper: 0,
    aspect: 0.6,
    erase: false,
    pigmentMix: 0,
    smudge: 0,
    smudgeLength: 0.5,
    textureId: 'canvas',
  },
  {
    id: 'grass-scatter',
    name: 'Césped disperso',
    category: 'texture',
    size: 26,
    opacity: 1,
    flow: 0.9,
    hardness: 0.75,
    spacing: 0.05,
    pressureSize: 0.2,
    pressureOpacity: 0.2,
    tiltAspect: 0,
    velocitySize: 0,
    smoothing: 0.2,
    jitterSize: 0.15,
    scatter: 0.55,
    followDirection: false,
    // Punta elíptica muy alargada + giro al azar en cada estampa, sin
    // ninguna textura: la misma combinación que usan classic/long_grass y
    // classic/short_grass de MyPaint (CC0) para el mismo efecto — aspect
    // aquí es el inverso de su elliptical_dab_ratio (3.8-3.9).
    angleJitter: 0.8,
    taper: 0,
    aspect: 0.22,
    erase: false,
    pigmentMix: 0,
    smudge: 0,
    smudgeLength: 0.5,
    textureId: null,
  },
  {
    id: 'hair-scatter',
    name: 'Pelo disperso',
    category: 'texture',
    size: 16,
    opacity: 1,
    flow: 0.95,
    hardness: 0.65,
    spacing: 0.04,
    pressureSize: 0.15,
    pressureOpacity: 0.15,
    tiltAspect: 0,
    velocitySize: 0,
    smoothing: 0.2,
    jitterSize: 0.2,
    scatter: 0.4,
    followDirection: false,
    // Misma mecánica que "Césped disperso" con hebras más finas y algo
    // menos de dispersión — como experimental/fur de MyPaint
    // (elliptical_dab_ratio 10, hardness 0.6).
    angleJitter: 0.6,
    taper: 0,
    aspect: 0.12,
    erase: false,
    pigmentMix: 0,
    smudge: 0,
    smudgeLength: 0.5,
    textureId: null,
  },
  {
    id: 'flat-brush',
    name: 'Pincel plano',
    category: 'paint',
    size: 90,
    opacity: 1,
    flow: 0.85,
    hardness: 0.85,
    spacing: 0.12,
    pressureSize: 0.2,
    pressureOpacity: 0.2,
    tiltAspect: 0,
    velocitySize: 0,
    smoothing: 0.25,
    jitterSize: 0.05,
    scatter: 0,
    // `followDirection: false` es lo que hace que sea plano de verdad, no
    // sólo una elipse achatada: mantiene el mismo ángulo fijo sin importar
    // hacia dónde se arrastre, así que un trazo de canto sale ancho y uno
    // de perfil sale fino — el filo de una brocha plana sostenida quieta,
    // no una punta que gira con el trazo.
    followDirection: false,
    angleJitter: 0,
    taper: 0,
    // aspect en 1 a propósito: la textura "flat" YA lleva la forma de barra
    // horqueada (ver `generateBrushTexturePixels`, caso 'flat'). El shader
    // mapea la textura sobre el espacio SIN achatar de la estampa (`vLocal`
    // se calcula antes de aplicar `aspect`, ver STAMP_VS) — así que un
    // `aspect` bajo aquí no "aplana más" la barra, la aplana DOS VECES:
    // una por la propia forma de la textura, otra por el achatamiento de
    // la estampa. El resultado salía como una ranura casi invisible, con
    // huecos entre estampa y estampa en vez de un trazo continuo.
    aspect: 1,
    erase: false,
    pigmentMix: 0,
    smudge: 0,
    smudgeLength: 0.5,
    textureId: 'flat',
  },
  {
    id: 'wide-wash',
    name: 'Brocha ancha',
    category: 'paint',
    size: 130,
    opacity: 0.85,
    flow: 0.6,
    hardness: 0.5,
    spacing: 0.15,
    pressureSize: 0.15,
    pressureOpacity: 0.25,
    tiltAspect: 0.1,
    velocitySize: 0,
    smoothing: 0.3,
    jitterSize: 0.08,
    scatter: 0.03,
    followDirection: false,
    angleJitter: 0,
    taper: 0,
    // aspect en 1 — ver el comentario largo en "flat-brush": la textura
    // "flat" ya trae su propia forma de barra, aplanarla otra vez con
    // `aspect` la deja en una ranura casi invisible.
    aspect: 1,
    erase: false,
    // Un poco de mezcla de pigmento: cubrir mucha área de una pasada pide
    // que se note dónde se solapa, no sólo un alfa plano encima.
    pigmentMix: 0.15,
    smudge: 0,
    smudgeLength: 0.5,
    textureId: 'flat',
  },
  {
    id: 'smudge',
    name: 'Difuminar',
    category: 'paint',
    size: 50,
    opacity: 1,
    flow: 1,
    hardness: 0.35,
    // Espaciado apretado a propósito: "Difuminar" recoge color de nuevo
    // en cada tanda de estampas (ver `Engine.updateSmudgeColor`), así que
    // un espaciado amplio se notaría como saltos de color en vez de un
    // arrastre continuo.
    spacing: 0.06,
    pressureSize: 0.2,
    pressureOpacity: 0,
    tiltAspect: 0,
    velocitySize: 0,
    smoothing: 0.3,
    jitterSize: 0,
    scatter: 0,
    followDirection: false,
    angleJitter: 0,
    taper: 0,
    aspect: 1,
    erase: false,
    pigmentMix: 0,
    // smudge=0.9: casi todo lo que sale es lo que ya había pintado bajo la
    // punta, no el color activo — igual que arrastrar pintura húmeda con el
    // dedo. smudgeLength moderado: cambia con soltura al cruzar de un color
    // a otro sin temblar de una estampa a la siguiente.
    smudge: 0.9,
    smudgeLength: 0.55,
    textureId: null,
  },

  // --- Borradores -------------------------------------------------------
  {
    id: 'eraser',
    name: 'Borrador',
    category: 'eraser',
    size: 40,
    opacity: 1,
    flow: 1,
    hardness: 0.6,
    spacing: 0.05,
    pressureSize: 0.4,
    pressureOpacity: 0.5,
    tiltAspect: 0,
    velocitySize: 0,
    smoothing: 0.4,
    jitterSize: 0,
    scatter: 0,
    followDirection: false,
    angleJitter: 0,
    taper: 0,
    aspect: 1,
    erase: true,
    pigmentMix: 0,
    smudge: 0,
    smudgeLength: 0.5,
    textureId: null,
  },
  {
    id: 'eraser-soft',
    name: 'Borrador suave',
    category: 'eraser',
    size: 40,
    // Cobertura parcial por estampa: cada pasada aclara en vez de vaciar de
    // golpe, útil para difuminar un borde en vez de recortarlo.
    opacity: 0.5,
    flow: 0.6,
    hardness: 0.15,
    spacing: 0.05,
    pressureSize: 0.3,
    pressureOpacity: 0.4,
    tiltAspect: 0,
    velocitySize: 0,
    smoothing: 0.4,
    jitterSize: 0,
    scatter: 0,
    followDirection: false,
    angleJitter: 0,
    taper: 0,
    aspect: 1,
    erase: true,
    pigmentMix: 0,
    smudge: 0,
    smudgeLength: 0.5,
    textureId: null,
  },
];

interface Anchor {
  x: number;
  y: number;
  pressure: number;
  altitude: number;
  azimuth: number;
  time: number;
  /** Velocidad en px/ms, ya suavizada. */
  speed: number;
}

/**
 * Convierte muestras de puntero en estampas espaciadas uniformemente.
 *
 * El recorrido usa Catmull-Rom sobre los puntos ya filtrados, así que la curva
 * pasa exactamente por donde estuvo el lápiz. El coste es un punto de retardo
 * (necesitamos el siguiente ancla para calcular la tangente), que compensamos
 * con las muestras predichas del navegador.
 */
export class StrokeBuilder {
  private anchors: Anchor[] = [];
  private filterX = new OneEuroFilter();
  private filterY = new OneEuroFilter();
  private leftover = 0;
  private emittedUpTo = 0;
  private speed = 0;
  private lastEmit: { x: number; y: number } | null = null;
  /** Distancia recorrida desde el primer punto del trazo: es lo único que
   * hace falta para el afinado de arranque, que por eso se resuelve aquí en
   * caliente. El de cierre no puede — no se sabe cuánto falta para soltar el
   * lápiz — y lo resuelve `Engine` reescalando la cola en cada fotograma. */
  private distFromStart = 0;

  private brush: BrushPreset;

  constructor(brush: BrushPreset) {
    this.brush = brush;
    this.configureFilters();
  }

  private configureFilters() {
    // Más suavizado = frecuencia de corte más baja = más inercia.
    const cutoff = lerp(6.0, 0.4, this.brush.smoothing);
    this.filterX = new OneEuroFilter(cutoff, 0.006);
    this.filterY = new OneEuroFilter(cutoff, 0.006);
  }

  get isEmpty() {
    return this.anchors.length === 0;
  }

  begin(sample: InputSample): Stamp[] {
    this.anchors = [];
    this.leftover = 0;
    this.emittedUpTo = 0;
    this.speed = 0;
    this.lastEmit = null;
    this.distFromStart = 0;
    this.configureFilters();
    this.addAnchor(sample);
    // Un toque sin arrastre debe dejar una marca: emitimos la primera estampa ya.
    const a = this.anchors[0];
    this.lastEmit = { x: a.x, y: a.y };
    return [this.makeStamp(a, 0, 0)];
  }

  /** Añade una muestra real y devuelve las estampas nuevas confirmadas. */
  push(sample: InputSample): Stamp[] {
    this.addAnchor(sample);
    return this.emitPending(false);
  }

  /**
   * Estampas especulativas a partir de las muestras predichas del navegador.
   * No modifican el estado: se dibujan en una capa aparte que se descarta.
   */
  speculate(predicted: InputSample[]): Stamp[] {
    if (predicted.length === 0 || this.anchors.length === 0) return [];
    const saved = {
      anchors: this.anchors.slice(),
      leftover: this.leftover,
      emittedUpTo: this.emittedUpTo,
      speed: this.speed,
      lastEmit: this.lastEmit ? { ...this.lastEmit } : null,
    };
    // Los filtros son stateful; los clonamos vía recalculo barato: aceptamos
    // que la especulación use posiciones sin filtrar, es material desechable.
    const out: Stamp[] = [];
    for (const p of predicted) {
      const last = this.anchors[this.anchors.length - 1];
      const dt = Math.max(p.time - last.time, 1);
      const dist = Math.hypot(p.x - last.x, p.y - last.y);
      this.anchors.push({
        x: p.x,
        y: p.y,
        pressure: p.pressure,
        altitude: p.altitude,
        azimuth: p.azimuth,
        time: p.time,
        speed: dist / dt,
      });
      out.push(...this.emitPending(false));
    }
    this.anchors = saved.anchors;
    this.leftover = saved.leftover;
    this.emittedUpTo = saved.emittedUpTo;
    this.speed = saved.speed;
    this.lastEmit = saved.lastEmit;
    return out;
  }

  /** Cierra el trazo vaciando el último segmento. */
  end(): Stamp[] {
    if (this.anchors.length === 0) return [];
    return this.emitPending(true);
  }

  private addAnchor(sample: InputSample) {
    const x = this.filterX.filter(sample.x, sample.time);
    const y = this.filterY.filter(sample.y, sample.time);
    const prev = this.anchors[this.anchors.length - 1];
    if (prev) {
      const dt = Math.max(sample.time - prev.time, 1);
      const dist = Math.hypot(x - prev.x, y - prev.y);
      // Suavizamos la velocidad: si no, la dinámica de tamaño tiembla.
      this.speed = lerp(this.speed, dist / dt, 0.3);
      // Descartamos muestras que no aportan curvatura ni distancia.
      if (dist < 0.02) return;
    }
    this.anchors.push({
      x,
      y,
      pressure: sample.pressure,
      altitude: sample.altitude,
      azimuth: sample.azimuth,
      time: sample.time,
      speed: this.speed,
    });
  }

  /**
   * Recorre los segmentos aún no emitidos a paso constante de arco.
   * `flush` procesa también el último segmento duplicando el punto final.
   */
  private emitPending(flush: boolean): Stamp[] {
    const stamps: Stamp[] = [];
    const pts = this.anchors;
    const lastSegment = flush ? pts.length - 1 : pts.length - 2;

    for (let i = this.emittedUpTo; i < lastSegment; i++) {
      const p0 = pts[Math.max(0, i - 1)];
      const p1 = pts[i];
      const p2 = pts[Math.min(pts.length - 1, i + 1)];
      const p3 = pts[Math.min(pts.length - 1, i + 2)];
      this.emitSegment(p0, p1, p2, p3, stamps);
      this.emittedUpTo = i + 1;
    }
    return stamps;
  }

  private emitSegment(p0: Anchor, p1: Anchor, p2: Anchor, p3: Anchor, out: Stamp[]) {
    const chord = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    if (chord < 1e-4) return;

    // Subdividimos el spline en pasos de ~1px y avanzamos por longitud de arco:
    // así el spacing es uniforme aunque la curva sea cerrada.
    const steps = Math.max(2, Math.min(256, Math.ceil(chord * 1.5)));
    let prevX = p1.x;
    let prevY = p1.y;

    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      const x = catmullRom(p0.x, p1.x, p2.x, p3.x, t);
      const y = catmullRom(p0.y, p1.y, p2.y, p3.y, t);
      const segLen = Math.hypot(x - prevX, y - prevY);
      if (segLen <= 0) continue;

      const interp: Anchor = {
        x,
        y,
        pressure: lerp(p1.pressure, p2.pressure, t),
        altitude: lerp(p1.altitude, p2.altitude, t),
        azimuth: lerp(p1.azimuth, p2.azimuth, t),
        time: lerp(p1.time, p2.time, t),
        speed: lerp(p1.speed, p2.speed, t),
      };
      const spacingPx = Math.max(
        0.5,
        this.stampSize(interp, this.distFromStart) * this.brush.spacing,
      );

      let travelled = 0;
      while (this.leftover + (segLen - travelled) >= spacingPx) {
        const need = spacingPx - this.leftover;
        travelled += need;
        this.leftover = 0;
        const f = travelled / segLen;
        const sx = lerp(prevX, x, f);
        const sy = lerp(prevY, y, f);
        const dir = this.lastEmit
          ? Math.atan2(sy - this.lastEmit.y, sx - this.lastEmit.x)
          : 0;
        if (this.lastEmit) {
          this.distFromStart += Math.hypot(sx - this.lastEmit.x, sy - this.lastEmit.y);
        }
        out.push(this.makeStamp({ ...interp, x: sx, y: sy }, dir, this.distFromStart));
        this.lastEmit = { x: sx, y: sy };
      }
      this.leftover += segLen - travelled;
      prevX = x;
      prevY = y;
    }
  }

  private stampSize(a: Anchor, distFromStart: number): number {
    const b = this.brush;
    let size = b.size;

    const pressureFactor = 1 - b.pressureSize * (1 - a.pressure);
    size *= pressureFactor;

    if (b.velocitySize !== 0) {
      // La velocidad típica de un trazo cómodo ronda 1 px/ms.
      const norm = clamp(a.speed / 2.5, 0, 1);
      size *= 1 - b.velocitySize * norm;
    }
    if (b.taper > 0) size *= taperScale(distFromStart, b);
    return Math.max(0.4, size);
  }

  private makeStamp(a: Anchor, direction: number, distFromStart: number): Stamp {
    const b = this.brush;
    let size = this.stampSize(a, distFromStart);

    if (b.jitterSize > 0) {
      size *= 1 - b.jitterSize * Math.random();
    }

    let alpha = b.flow * (1 - b.pressureOpacity * (1 - a.pressure));

    let x = a.x;
    let y = a.y;
    if (b.scatter > 0) {
      const r = (Math.random() - 0.5) * 2 * b.scatter * size;
      const ang = Math.random() * TAU;
      x += Math.cos(ang) * r;
      y += Math.sin(ang) * r;
    }

    // La inclinación achata la punta perpendicular a la dirección del lápiz,
    // que es lo que hace que un lápiz tumbado sombree en vez de trazar línea.
    let aspect = b.aspect;
    let angle = b.followDirection ? direction : 0;
    if (b.tiltAspect > 0) {
      const tilt = clamp(1 - a.altitude / (Math.PI / 2), 0, 1);
      aspect *= 1 - b.tiltAspect * tilt;
      if (tilt > 0.15) {
        angle = a.azimuth;
        size *= 1 + tilt * 0.6;
      }
    }
    if (b.angleJitter > 0) {
      angle += (Math.random() - 0.5) * 2 * b.angleJitter * (Math.PI / 2);
    }

    return {
      x,
      y,
      size,
      angle,
      alpha: clamp(alpha, 0, 1),
      hardness: b.hardness,
      aspect: clamp(aspect, 0.05, 1),
    };
  }
}

function catmullRom(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    0.5 *
    (2 * p1 +
      (-p0 + p2) * t +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
      (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
  );
}

/** A `taper = 1` afina a lo largo de esta cantidad de diámetros de la punta:
 * así el afinado se ve proporcional al tamaño del pincel en vez de a un
 * número fijo de píxeles que resultaría invisible en una punta gruesa o
 * desproporcionado en una fina. */
export const TAPER_LENGTH_FACTOR = 6;

/** El extremo nunca cierra a tamaño cero: un pincel real deja de tocar el
 * papel antes de desaparecer del todo, y en píxeles un 0 exacto además
 * dispara el `Math.max(0.4, size)` de `stampSize`, que rompería la curva. */
const TAPER_MIN_SCALE = 0.1;

/**
 * Factor 0..1 según qué tan cerca está una estampa de un extremo que se
 * afina. `dist` es la distancia en píxeles de documento a ese extremo —
 * desde el arranque para la punta inicial, desde el final para la de
 * cierre — así que la misma función sirve para ambas.
 */
export function taperScale(dist: number, brush: BrushPreset): number {
  if (brush.taper <= 0) return 1;
  const len = brush.size * TAPER_LENGTH_FACTOR * brush.taper;
  if (len <= 0) return 1;
  const t = clamp(dist / len, 0, 1);
  // Ease-out: crece rápido nada más despegar del punto y se estabiliza
  // pronto, como la punta real de un lápiz apoyándose en el papel.
  return TAPER_MIN_SCALE + (1 - TAPER_MIN_SCALE) * (1 - (1 - t) * (1 - t));
}
