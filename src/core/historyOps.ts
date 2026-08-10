import type { Renderer } from '../gl/renderer';
import type { Cel, TraceDocument } from './document';
import type { Command } from './history';
import type { Rect } from './types';

/**
 * Deshacer/rehacer un trazo, una forma de QuickShape, un bote de relleno o
 * rellenar/borrar la selección son todos el mismo patrón: leer un rect antes
 * y después de escribir sobre un cel. Ese patrón es lo único que se persiste
 * en el `.trace` (ver `io.ts`) — el resto de comandos (añadir capa,
 * keyframes, reordenar...) sólo viven en memoria, no sobreviven a guardar y
 * volver a abrir. Es la misma idea que apuntaba `RUMBO.md`: la mayoría de
 * los pasos ya son diffs por rectángulo, así que persistir justo ésos cubre
 * el caso real sin tener que serializar cuarenta formas de comando distintas.
 */
export interface RasterEditOp {
  type: 'rasterEdit';
  label: string;
  layerId: string;
  frame: number;
  /** -1 si el cel ya existía. Si no, el fotograma que este paso creó — el
   *  redo lo vuelve a insertar en `layer.cels`, el undo lo quita. */
  createdFrame: number;
  rect: Rect;
  before: Uint8Array;
  after: Uint8Array;
}

/** Igual que `RasterEditOp` pero para un lote de cels con la misma región —
 *  la transformación libre por lotes (`commitFloating`). */
export interface RasterEditBatchOp {
  type: 'rasterEditBatch';
  label: string;
  layerId: string;
  region: Rect;
  steps: { frame: number; before: Uint8Array; after: Uint8Array }[];
}

export type HistoryOp = RasterEditOp | RasterEditBatchOp;

export function historyOpByteLength(op: HistoryOp): number {
  if (op.type === 'rasterEdit') return op.before.byteLength + op.after.byteLength;
  return op.steps.reduce((n, s) => n + s.before.byteLength + s.after.byteLength, 0);
}

/**
 * Reconstruye un `Command` ejecutable a partir de un paso guardado en disco,
 * resolviendo capa y cel por id contra el documento YA CARGADO, no contra
 * objetos capturados en el momento de grabar el paso (esos ya no existen: el
 * documento se acaba de recrear desde cero al abrir el archivo).
 *
 * El documento y su historial se serializan juntos describiendo cómo se
 * llegó al mismo estado, así que en el momento de cargar la capa y el cel de
 * cada paso siempre deberían existir. Si no (archivo tocado a mano, o de una
 * versión anterior sin ese id), el paso se descarta en vez de romper la
 * carga entera — un historial más corto es preferible a un archivo que no
 * abre.
 */
export function rehydrateHistoryOp(
  doc: TraceDocument,
  renderer: Renderer,
  touch: () => void,
  op: HistoryOp,
): Command | null {
  const layer = doc.layers.find((l) => l.id === op.layerId);
  if (!layer) return null;

  if (op.type === 'rasterEdit') {
    const { frame, createdFrame, rect, before, after } = op;
    const cel = layer.cels.get(frame);
    if (!cel) return null;
    return {
      label: op.label,
      op,
      cost: historyOpByteLength(op),
      redo: () => {
        if (createdFrame >= 0) layer.cels.set(frame, cel);
        renderer.writeRect(cel.surface, rect, after);
        touch();
      },
      undo: () => {
        renderer.writeRect(cel.surface, rect, before);
        if (createdFrame >= 0) layer.cels.delete(frame);
        touch();
      },
    };
  }

  const { region, steps } = op;
  const resolved: { cel: Cel; before: Uint8Array; after: Uint8Array }[] = [];
  for (const s of steps) {
    const cel = layer.cels.get(s.frame);
    if (cel) resolved.push({ cel, before: s.before, after: s.after });
  }
  if (resolved.length === 0) return null;
  return {
    label: op.label,
    op,
    cost: historyOpByteLength(op),
    redo: () => {
      for (const s of resolved) renderer.writeRect(s.cel.surface, region, s.after);
      touch();
    },
    undo: () => {
      for (const s of resolved) renderer.writeRect(s.cel.surface, region, s.before);
      touch();
    },
  };
}
