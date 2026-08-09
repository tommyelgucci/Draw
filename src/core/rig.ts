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

/**
 * Hueso cuya COLA de reposo cae dentro de `tolerance` de `p` — más
 * estricto que `hitTestBone` (que mide contra el segmento entero): es lo
 * que decide si un toque en el lienzo arranca un hueso hijo encadenado en
 * vez de seleccionar el hueso que se tocó.
 */
export function hitTestBoneTail(
  skel: Skeleton,
  worldMatrices: Map<string, Mat3>,
  p: Vec2,
  tolerance = 16,
): Bone | null {
  for (let i = skel.bones.length - 1; i >= 0; i--) {
    const b = skel.bones[i];
    const m = worldMatrices.get(b.id);
    if (!m) continue;
    const tail: Vec2 = { x: m[0] * b.length + m[6], y: m[1] * b.length + m[7] };
    if (Math.hypot(p.x - tail.x, p.y - tail.y) <= tolerance) return b;
  }
  return null;
}

/** Ángulo (radianes) de la parte rotacional de una matriz de mundo,
 *  asumiendo que es rígida (sin cizalla) — cierto para toda matriz de
 *  reposo de este motor, que nunca combina escala no uniforme. */
export function matRotation(m: Mat3): number {
  return Math.atan2(m[1], m[0]);
}

/**
 * Longitud y rotación de reposo que harían que un hueso naciera en
 * `worldHead` y su cola apuntara a `worldPoint`, dado el ángulo de mundo
 * del espacio en el que vive (0 para un hueso raíz; la rotación de mundo
 * del padre para un hijo, porque `restRotation` se compone DENTRO de ese
 * marco — ver `restLocalMatrix`). Es la base de la creación táctil de
 * huesos: arrastrar de un punto a otro define un hueso entero de una vez,
 * sin tener que teclear valores.
 */
export function boneRestFromDrag(
  parentWorldRotation: number,
  worldHead: Vec2,
  worldPoint: Vec2,
): { length: number; restRotation: number } {
  const dx = worldPoint.x - worldHead.x;
  const dy = worldPoint.y - worldHead.y;
  const length = Math.max(1, Math.hypot(dx, dy));
  const restRotation = Math.atan2(dy, dx) - parentWorldRotation;
  return { length, restRotation };
}

/* ------------------------------------------------------------------ *
 * Malla deformable
 * ------------------------------------------------------------------ */

/**
 * Hasta 4 huesos por vértice. `boneWeights` debería sumar 1; el auto-peso
 * inicial (`autoWeightMesh`) es responsable de eso, no se fuerza aquí.
 * `boneIndices` son índices POSICIONALES en `Skeleton.bones` (no ids) — es
 * el mismo orden en el que `rasterizeLayer` sube las matrices de piel al
 * shader, para poder indexarlas con un entero pequeño en vez de un string.
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

/**
 * Rejilla regular cubriendo todo el documento, en espacio documento con UV
 * 0..1 correspondiente — la fuente que se deforma (`src` en `rasterizeLayer`)
 * es siempre el cel entero, igual que ya asume el camino rígido del Sprint 2,
 * así que la malla por defecto cubre ese mismo rectángulo completo en vez de
 * recortarse al contorno de la tinta (que exigiría leer píxeles).
 */
export function newGridMesh(
  skeletonId: string,
  docWidth: number,
  docHeight: number,
  cols = 8,
  rows = 8,
): Mesh {
  const vertices: MeshVertex[] = [];
  for (let r = 0; r <= rows; r++) {
    for (let c = 0; c <= cols; c++) {
      const u = c / cols;
      const v = r / rows;
      vertices.push({ x: u * docWidth, y: v * docHeight, u, v, boneIndices: [0, 0, 0, 0], boneWeights: [1, 0, 0, 0] });
    }
  }
  const triangles: number[] = [];
  const stride = cols + 1;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i0 = r * stride + c;
      const i1 = i0 + 1;
      const i2 = i0 + stride;
      const i3 = i2 + 1;
      triangles.push(i0, i2, i1, i1, i2, i3);
    }
  }
  return { id: uid('mesh'), vertices, triangles, skeletonId };
}

/**
 * Auto-peso por distancia: cada vértice se asigna entero (peso 1.0) al
 * hueso cuyo segmento cabeza→cola de REPOSO tiene más cerca. No es un
 * skinning suave (sin mezcla entre huesos vecinos), pero evita exigir un
 * editor de pesos pintado a mano para el primer corte — ver nota de riesgo
 * del plan de diseño.
 */
export function autoWeightMesh(mesh: Mesh, skel: Skeleton) {
  const rest = evaluateRestWorldMatrices(skel);
  for (const v of mesh.vertices) {
    let bestIndex = 0;
    let bestDist = Infinity;
    skel.bones.forEach((b, i) => {
      const m = rest.get(b.id);
      if (!m) return;
      const head: Vec2 = { x: m[6], y: m[7] };
      const tail: Vec2 = { x: m[0] * b.length + m[6], y: m[1] * b.length + m[7] };
      const d = distanceToSegment({ x: v.x, y: v.y }, head, tail);
      if (d < bestDist) {
        bestDist = d;
        bestIndex = i;
      }
    });
    v.boneIndices = [bestIndex, 0, 0, 0];
    v.boneWeights = [1, 0, 0, 0];
  }
}

/** Malla de rejilla con auto-peso ya aplicado — lo que crea el modo Viewport
 *  al convertir una capa rígida en deformable. */
export function newMesh(skel: Skeleton, docWidth: number, docHeight: number, cols = 8, rows = 8): Mesh {
  const mesh = newGridMesh(skel.id, docWidth, docHeight, cols, rows);
  autoWeightMesh(mesh, skel);
  return mesh;
}

/**
 * Posiciones de los vértices de `mesh` deformadas en `frame`, en espacio
 * documento — la misma mezcla ponderada de matrices de piel que hace el
 * vertex shader de skinning, pero en CPU. Sirve para el wireframe de la UI
 * (`BoneGizmoOverlay`), donde recalcular unas pocas decenas de vértices en
 * JS es más simple que leer de vuelta lo que dibujó la GPU.
 */
export function evaluateSkinnedMeshPositions(mesh: Mesh, skel: Skeleton, frame: number): Vec2[] {
  const skin = evaluateSkinMatrices(skel, frame);
  const mats = skel.bones.map((b) => skin.get(b.id) ?? mat3Identity());
  return mesh.vertices.map((v) => {
    let x = 0;
    let y = 0;
    for (let i = 0; i < 4; i++) {
      const w = v.boneWeights[i];
      if (w === 0) continue;
      const m = mats[v.boneIndices[i]] ?? mats[0];
      const p = mat3Apply(m, { x: v.x, y: v.y });
      x += p.x * w;
      y += p.y * w;
    }
    return { x, y };
  });
}
