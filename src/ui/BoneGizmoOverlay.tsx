import { useRef } from 'react';
import type { Engine } from '../core/engine';
import { clamp } from '../core/math';
import { evaluateSkinnedMeshPositions, type Bone } from '../core/rig';
import type { Vec2 } from '../core/types';
import { useEngineRevision, useUI } from '../state/store';
import { IconKey } from './icons';

type DragKind = 'move' | 'rotate' | 'scale' | 'ik';

interface DragState {
  kind: DragKind;
  boneId: string;
  headScreen: Vec2;
  startDistance: number;
  startScaleX: number;
  startScaleY: number;
}

/**
 * Tiradores del modo Viewport: mover, rotar y escalar huesos, en DOM sobre
 * el lienzo — mismo patrón que `SelectionOverlay`. Cada tirador hace
 * `stopPropagation` y captura su propio puntero, así que `CanvasView` nunca
 * ve esos toques: el pipeline de dibujo y el de rig son mutuamente
 * excluyentes por z-order y captura, no por un flag de modo que sincronizar.
 */
export function BoneGizmoOverlay({ engine }: { engine: Engine }) {
  useEngineRevision(engine);
  const tool = useUI((s) => s.tool);
  const selectedBoneId = useUI((s) => s.selectedBoneId);
  const setSelectedBoneId = useUI((s) => s.setSelectedBoneId);
  const ikEnabled = useUI((s) => s.ikEnabled);
  const setIkEnabled = useUI((s) => s.setIkEnabled);
  const reparentingBoneId = useUI((s) => s.reparentingBoneId);
  const setReparentingBoneId = useUI((s) => s.setReparentingBoneId);
  const drag = useRef<DragState | null>(null);

  if (tool !== 'rig') return null;
  // Sólo se soporta interactuar con un esqueleto activo por documento —
  // varios personajes en el mismo lienzo llegarán cuando haga falta.
  const skeleton = engine.doc.skeletons[0];
  if (!skeleton) return null;

  const endpoints = engine.boneEndpoints(skeleton.id);
  const selected = endpoints.find((ep) => ep.bone.id === selectedBoneId) ?? null;
  // La capa que sigue al hueso seleccionado, rígida o por malla — attachLayerToMesh
  // conserva `boneId` aunque ya haya `meshId`, así que este único campo basta.
  const attachedLayer = selected
    ? engine.doc.layers.find((l) => l.rig?.boneId === selected.bone.id)
    : undefined;
  const attachedMesh = attachedLayer?.rig?.meshId
    ? engine.doc.meshes.find((m) => m.id === attachedLayer.rig!.meshId)
    : undefined;

  const localPoint = (e: React.PointerEvent): Vec2 => {
    const rect = engine.renderer.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const begin = (kind: DragKind, bone: Bone, headScreen: Vec2) => (e: React.PointerEvent) => {
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setSelectedBoneId(bone.id);
    // Con IK activada y un padre del que tirar, el tirador de "rotar" mueve
    // la cadena de 2 huesos entera en vez de rotar sólo este hueso — más
    // natural para posar una mano/pie que rotar hombro y codo por separado.
    if (kind === 'rotate' && ikEnabled && engine.beginBoneIKDrag(skeleton.id, bone.id)) {
      drag.current = { kind: 'ik', boneId: bone.id, headScreen, startDistance: 1, startScaleX: 1, startScaleY: 1 };
      return;
    }
    const local = localPoint(e);
    drag.current = {
      kind,
      boneId: bone.id,
      headScreen,
      startDistance: Math.hypot(local.x - headScreen.x, local.y - headScreen.y) || 1,
      startScaleX: engine.getBoneValue(bone, 'scaleX'),
      startScaleY: engine.getBoneValue(bone, 'scaleY'),
    };
  };

  const move = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    e.stopPropagation();
    const bone = skeleton.bones.find((b) => b.id === d.boneId);
    if (!bone) return;
    const local = localPoint(e);

    if (d.kind === 'ik') {
      engine.updateBoneIKDrag(engine.screenToDoc(local));
      return;
    }
    if (d.kind === 'move') {
      const offset = engine.boneOffsetForWorldPoint(skeleton.id, bone, engine.screenToDoc(local));
      engine.setBonePose(skeleton.id, bone.id, offset);
      return;
    }
    if (d.kind === 'rotate') {
      const next = engine.boneRotationForWorldPoint(skeleton.id, bone, engine.screenToDoc(local));
      const current = engine.getBoneValue(bone, 'rotation');
      let delta = next - current;
      // Normaliza el salto de ±π al cruzar el eje, igual que el gesto de dos dedos.
      if (delta > Math.PI) delta -= Math.PI * 2;
      if (delta < -Math.PI) delta += Math.PI * 2;
      engine.setBonePose(skeleton.id, bone.id, { rotation: current + delta });
      return;
    }
    const dist = Math.hypot(local.x - d.headScreen.x, local.y - d.headScreen.y);
    const ratio = clamp(dist / d.startDistance, 0.05, 20);
    engine.setBonePose(skeleton.id, bone.id, {
      scaleX: d.startScaleX * ratio,
      scaleY: d.startScaleY * ratio,
    });
  };

  const end = (e: React.PointerEvent) => {
    if (drag.current?.kind === 'ik') engine.endBoneIKDrag();
    drag.current = null;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
  };

  let wireframe: React.ReactNode = null;
  if (attachedMesh) {
    const skinned = evaluateSkinnedMeshPositions(attachedMesh, skeleton, engine.currentFrame).map(
      (p) => engine.docToScreen(p),
    );
    const edges: React.ReactNode[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < attachedMesh.triangles.length; i += 3) {
      const tri = [attachedMesh.triangles[i], attachedMesh.triangles[i + 1], attachedMesh.triangles[i + 2]];
      for (let k = 0; k < 3; k++) {
        const a = tri[k];
        const b = tri[(k + 1) % 3];
        const key = a < b ? `${a}-${b}` : `${b}-${a}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push(
          <line key={key} x1={skinned[a].x} y1={skinned[a].y} x2={skinned[b].x} y2={skinned[b].y} />,
        );
      }
    }
    wireframe = (
      <svg className="bone-mesh-wire" aria-hidden="true">
        {edges}
      </svg>
    );
  }

  let handles: React.ReactNode = null;
  if (selected) {
    const headScreen = engine.docToScreen(selected.head);
    const tailScreen = engine.docToScreen(selected.tail);
    const dx = tailScreen.x - headScreen.x;
    const dy = tailScreen.y - headScreen.y;
    const len = Math.hypot(dx, dy) || 1;
    // Perpendicular a la cola, como el tirador de giro de SelectionOverlay
    // sale perpendicular al borde superior: evita que se solape con "rotar".
    const scaleHandle = {
      x: tailScreen.x + (-dy / len) * 18,
      y: tailScreen.y + (dx / len) * 18,
    };
    handles = (
      <>
        <button
          type="button"
          className="bone-handle bone-handle--move"
          style={{ left: headScreen.x, top: headScreen.y }}
          onPointerDown={begin('move', selected.bone, headScreen)}
          onPointerMove={move}
          onPointerUp={end}
          aria-label={`Mover ${selected.bone.name}`}
        />
        <button
          type="button"
          className="bone-handle bone-handle--rotate"
          style={{ left: tailScreen.x, top: tailScreen.y }}
          onPointerDown={begin('rotate', selected.bone, headScreen)}
          onPointerMove={move}
          onPointerUp={end}
          aria-label={`Rotar ${selected.bone.name}`}
        />
        <button
          type="button"
          className="bone-handle bone-handle--scale"
          style={{ left: scaleHandle.x, top: scaleHandle.y }}
          onPointerDown={begin('scale', selected.bone, headScreen)}
          onPointerMove={move}
          onPointerUp={end}
          aria-label={`Escalar ${selected.bone.name}`}
        />
      </>
    );
  }

  let actionBar: React.ReactNode = null;
  if (selected) {
    const anchor = engine.docToScreen(selected.head);
    const hasKeyframe = engine.boneHasKeyframeHere(selected.bone);
    const isReparenting = reparentingBoneId === selected.bone.id;
    actionBar = (
      <div
        className="sel-bar"
        style={{ left: anchor.x, top: Math.max(52, anchor.y - 52) }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        {isReparenting ? (
          <>
            <span className="sel-bar__readout">Toca el nuevo padre (o el lienzo vacío)</span>
            <button type="button" onClick={() => setReparentingBoneId(null)}>
              Cancelar
            </button>
          </>
        ) : (
          <>
            <span className="sel-bar__readout">{selected.bone.name}</span>
            <button
              type="button"
              onClick={() => setReparentingBoneId(selected!.bone.id)}
              title="Cambiar de qué hueso cuelga, sin que se mueva de sitio"
            >
              Reparentar
            </button>
            {selected.bone.parentId && (
              <button
                type="button"
                className={ikEnabled ? 'is-key' : ''}
                onClick={() => setIkEnabled(!ikEnabled)}
                title={
                  ikEnabled
                    ? 'IK activada: arrastrar la cola dobla también el hueso padre'
                    : 'Activar IK: arrastrar la cola dobla la cadena de 2 huesos'
                }
              >
                IK
              </button>
            )}
            {attachedLayer && !attachedMesh && (
              <button
                type="button"
                onClick={() => {
                  const mesh = engine.createMesh(skeleton.id);
                  if (mesh) engine.attachLayerToMesh(attachedLayer.id, skeleton.id, mesh.id);
                }}
                title="Deformar esta capa con una malla en vez de moverla entera"
              >
                Convertir a malla
              </button>
            )}
            <button
              type="button"
              className={hasKeyframe ? 'is-key' : ''}
              onClick={() => engine.toggleBonePoseKeyframe(skeleton.id, selected.bone.id)}
              title={hasKeyframe ? 'Quitar fotograma clave' : 'Añadir fotograma clave'}
            >
              <IconKey size={14} />
            </button>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="bone-overlay">
      {wireframe}
      <svg className="bone-outline" aria-hidden="true">
        {endpoints.map(({ bone, head, tail }) => {
          const a = engine.docToScreen(head);
          const b = engine.docToScreen(tail);
          return (
            <line
              key={bone.id}
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
              className={bone.id === selectedBoneId ? 'is-selected' : undefined}
            />
          );
        })}
      </svg>
      {handles}
      {actionBar}
    </div>
  );
}
