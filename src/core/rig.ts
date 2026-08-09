import { channel, sampleChannel, uid, type Channel } from './document';
import { mat3Apply, mat3FromTRS, mat3Identity, mat3Invert, mat3Multiply, type Mat3 } from './math';
import type { Vec2 } from './types';

/**
 * Pista animable de un hueso: los mismos Channel/Keyframe que ya usa
 * TransformTrack, sin tipo nuevo — cada propiedad es un escalar con easing.
 * Base 0 para x/y/rotation, base 1 para scaleX/scaleY: la pose de reposo es
 * "todos los canales en su valor base" (delta nulo sobre restX/restY/restRotation).
 */
export interface BoneTrack {
  x: Channel;
  y: Channel;
  rotation: Channel;
  scaleX: Channel;
  scaleY: Channel;
}

export function newBoneTrack(): BoneTrack {
  return {
    x: channel(0),
    y: channel(0),
    rotation: channel(0),
    scaleX: channel(1),
    scaleY: channel(1),
  };
}

/**
 * Un hueso. `restX/restY/restRotation` son la pose de reposo en el espacio
 * LOCAL del padre (o del documento si `parentId` es null), como en Spine.
 * `length` sólo posiciona el tirador de la cola en el gizmo — la
 * deformación de malla no la usa, sólo los pesos por vértice.
 */
export interface Bone {
  id: string;
  name: string;
  parentId: string | null;
  length: number;
  restX: number;
  restY: number;
  restRotation: number;
  track: BoneTrack;
}

/**
 * `bones` se mantiene en orden topológico (todo padre antes que sus hijos)
 * por `addBone`/`removeBone`: así evaluar la pose entera es una sola pasada
 * lineal sin recursión ni reordenar nada en caliente.
 */
export interface Skeleton {
  id: string;
  name: string;
  bones: Bone[];
}

export function newSkeleton(name = 'Esqueleto'): Skeleton {
  return { id: uid('skel'), name, bones: [] };
}

/** Construye un hueso sin tocar ningún esqueleto — el `Engine` lo usa para
 *  poder envolver la inserción real en un `Command` de deshacer/rehacer. */
export function createBone(
  name: string,
  parentId: string | null,
  rest: { x: number; y: number; rotation?: number; length?: number },
): Bone {
  return {
    id: uid('bone'),
    name,
    parentId,
    length: rest.length ?? 80,
    restX: rest.x,
    restY: rest.y,
    restRotation: rest.rotation ?? 0,
    track: newBoneTrack(),
  };
}

/** Conveniencia para contextos sin historial (tests, scripts): crea y añade. */
export function addBone(
  skel: Skeleton,
  name: string,
  parentId: string | null,
  rest: { x: number; y: number; rotation?: number; length?: number },
): Bone {
  const bone = createBone(name, parentId, rest);
  skel.bones.push(bone);
  return bone;
}

/**
 * Quita un hueso. Sus hijos directos se reengancian al padre del hueso
 * eliminado en vez de quedar huérfanos — mantiene `bones` como un árbol
 * válido sin que el llamador tenga que ocuparse de la reparentación.
 */
export function removeBone(skel: Skeleton, boneId: string) {
  const bone = skel.bones.find((b) => b.id === boneId);
  if (!bone) return;
  for (const b of skel.bones) {
    if (b.parentId === boneId) b.parentId = bone.parentId;
  }
  skel.bones = skel.bones.filter((b) => b.id !== boneId);
}

export function findBone(skel: Skeleton, boneId: string): Bone | null {
  return skel.bones.find((b) => b.id === boneId) ?? null;
}

/** Matriz local del hueso en reposo (padre→hijo), sin animación. */
function restLocalMatrix(b: Bone): Mat3 {
  return mat3FromTRS(b.restX, b.restY, b.restRotation, 1, 1);
}

/** Matriz local del hueso en `frame`: reposo compuesto con el delta animado. */
function poseLocalMatrix(b: Bone, frame: number): Mat3 {
  const delta = mat3FromTRS(
    sampleChannel(b.track.x, frame),
    sampleChannel(b.track.y, frame),
    sampleChannel(b.track.rotation, frame),
    sampleChannel(b.track.scaleX, frame),
    sampleChannel(b.track.scaleY, frame),
  );
  return mat3Multiply(restLocalMatrix(b), delta);
}

function evaluateWorldMatrices(skel: Skeleton, localOf: (b: Bone) => Mat3): Map<string, Mat3> {
  const out = new Map<string, Mat3>();
  for (const b of skel.bones) {
    const local = localOf(b);
    const parent = b.parentId ? out.get(b.parentId) : undefined;
    out.set(b.id, parent ? mat3Multiply(parent, local) : local);
  }
  return out;
}

/** Matrices de mundo por hueso en reposo — la bind pose para el skinning. */
export function evaluateRestWorldMatrices(skel: Skeleton): Map<string, Mat3> {
  return evaluateWorldMatrices(skel, restLocalMatrix);
}

/** Matrices de mundo por hueso en `frame` — la pose actual. */
export function evaluatePoseWorldMatrices(skel: Skeleton, frame: number): Map<string, Mat3> {
  return evaluateWorldMatrices(skel, (b) => poseLocalMatrix(b, frame));
}

/**
 * Matriz de "piel" por hueso: pose * inverso(reposo). Aplicada a un punto en
 * su posición de reposo (espacio documento) da la posición deformada — es
 * lo que sube como uniform al vertex shader de skinning (Sprint 3) y,
 * aplicada a un solo hueso, es también el transform rígido del Sprint 2.
 */
export function evaluateSkinMatrices(skel: Skeleton, frame: number): Map<string, Mat3> {
  const rest = evaluateRestWorldMatrices(skel);
  const pose = evaluatePoseWorldMatrices(skel, frame);
  const out = new Map<string, Mat3>();
  for (const [id, poseM] of pose) {
    const restM = rest.get(id);
    out.set(id, restM ? mat3Multiply(poseM, mat3Invert(restM)) : mat3Identity());
  }
  return out;
}

/**
 * Matriz rígida de un solo hueso relativa a su propia pose de reposo, en
 * espacio documento — mismo tipo `Mat3` que ya consume `renderer.drawOver`.
 * Es el caso particular de skinning con un hueso y peso 1.0: el Sprint 3 no
 * sustituye esto, sólo le añade una rama alternativa en `rasterizeLayer`.
 */
export function boneRigidMatrix(skel: Skeleton, boneId: string, frame: number): Mat3 {
  return evaluateSkinMatrices(skel, frame).get(boneId) ?? mat3Identity();
}

/**
 * Traduce un punto en espacio documento a los valores (x,y) de `track` que
 * pondrían la cabeza del hueso exactamente ahí, dado el mundo actual de su
 * padre (`parentWorld`, ya en `frame`). Es la inversa de `poseLocalMatrix`
 * aplicada al origen: primero pasa el punto al espacio local del padre,
 * luego deshace la rotación de reposo, porque la traslación de `track` se
 * aplica ANTES de esa rotación — ver `poseLocalMatrix`. Con esto el gizmo
 * de "mover" puede colocar la cabeza exactamente bajo el dedo sin tener que
 * arrastrar por delta acumulado.
 */
export function worldPointToBoneOffset(bone: Bone, parentWorld: Mat3, worldPoint: Vec2): Vec2 {
  const local = mat3Apply(mat3Invert(parentWorld), worldPoint);
  const restRot = mat3FromTRS(0, 0, bone.restRotation, 1, 1);
  return mat3Apply(mat3Invert(restRot), { x: local.x - bone.restX, y: local.y - bone.restY });
}

/**
 * Rotación de `track` que apuntaría la cola del hueso hacia `worldPoint`,
 * dada su posición de cabeza actual (`currentOffset` = track.x/y ya
 * muestreados). No normaliza el salto de ±π al cruzar el eje — eso es
 * responsabilidad de quien arrastra el gizmo frame a frame, comparando
 * contra la rotación anterior, igual que ya hace el gesto de dos dedos.
 */
export function worldPointToBoneRotation(
  bone: Bone,
  parentWorld: Mat3,
  currentOffset: Vec2,
  worldPoint: Vec2,
): number {
  const local = mat3Apply(mat3Invert(parentWorld), worldPoint);
  const restRot = mat3FromTRS(0, 0, bone.restRotation, 1, 1);
  const head = mat3Apply(restRot, currentOffset);
  const headX = head.x + bone.restX;
  const headY = head.y + bone.restY;
  return Math.atan2(local.y - headY, local.x - headX) - bone.restRotation;
}

function distanceToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  const t = lenSq < 1e-9 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq));
  const cx = a.x + t * dx;
  const cy = a.y + t * dy;
  return Math.hypot(p.x - cx, p.y - cy);
}

/**
 * Hueso más cercano al punto `p` (espacio documento), dentro de `tolerance`
 * píxeles del segmento cabeza→cola. Recorre en orden inverso: los huesos
 * añadidos después quedan "encima" en el gizmo y ganan el hit-test.
 */
export function hitTestBone(
  skel: Skeleton,
  worldMatrices: Map<string, Mat3>,
  p: Vec2,
  tolerance = 12,
): Bone | null {
  for (let i = skel.bones.length - 1; i >= 0; i--) {
    const b = skel.bones[i];
    const m = worldMatrices.get(b.id);
    if (!m) continue;
    const head: Vec2 = { x: m[6], y: m[7] };
    const tail: Vec2 = { x: m[0] * b.length + m[6], y: m[1] * b.length + m[7] };
    if (distanceToSegment(p, head, tail) <= tolerance) return b;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Malla deformable
 * ------------------------------------------------------------------ */

/**
 * Hasta 4 huesos por vértice. `boneWeights` debería sumar 1; el editor de
 * pesos (Sprint 3) es responsable de normalizar, no se fuerza aquí.
 */
export interface MeshVertex {
  /** Posición de reposo en píxeles de documento (mismo espacio que Cel). */
  x: number;
  y: number;
  /** UV de reposo, 0..1, dentro del cel al que está unida la malla. */
  u: number;
  v: number;
  boneIndices: [number, number, number, number];
  boneWeights: [number, number, number, number];
}

export interface Mesh {
  id: string;
  /** Malla en reposo; las posiciones deformadas se calculan en el vertex
   *  shader del Sprint 3, nunca se escriben de vuelta aquí. */
  vertices: MeshVertex[];
  /** Triángulos, 3 índices por cara, en `vertices`. */
  triangles: number[];
  skeletonId: string;
}

/** Vínculo entre una capa y el rig que la controla. */
export interface LayerRig {
  skeletonId: string;
  /** Sprint 2: la capa entera sigue este hueso (transform rígido). */
  boneId: string | null;
  /** Sprint 3: si está presente, sustituye a `boneId` en la composición. */
  meshId: string | null;
}
