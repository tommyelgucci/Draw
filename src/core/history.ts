import type { HistoryOp } from './historyOps';

export interface Command {
  label: string;
  undo(): void;
  redo(): void;
  /** Bytes aproximados retenidos, para presupuestar la pila. */
  cost?: number;
  /**
   * Presente si este paso se puede reconstruir desde disco — ver
   * `historyOps.ts` y `serializeProject` en `io.ts`. La mayoría de los
   * comandos (añadir capa, keyframes, reordenar...) no llevan `op`: sólo
   * viven en memoria, no sobreviven a guardar y volver a abrir.
   */
  op?: HistoryOp;
}

const MAX_STEPS = 120;
/** Presupuesto de memoria del historial. Un iPad no perdona mucho más. */
const MAX_BYTES = 320 * 1024 * 1024;

export class History {
  private past: Command[] = [];
  private future: Command[] = [];
  private bytes = 0;
  private listeners = new Set<() => void>();

  push(cmd: Command) {
    this.past.push(cmd);
    this.bytes += cmd.cost ?? 0;
    // Una acción nueva invalida el futuro.
    for (const c of this.future) this.bytes -= c.cost ?? 0;
    this.future.length = 0;
    this.trim();
    this.emit();
  }

  /** Ejecuta y registra en un solo paso. */
  run(cmd: Command) {
    cmd.redo();
    this.push(cmd);
  }

  private trim() {
    while (this.past.length > MAX_STEPS || (this.bytes > MAX_BYTES && this.past.length > 1)) {
      const dropped = this.past.shift();
      if (!dropped) break;
      this.bytes -= dropped.cost ?? 0;
    }
  }

  undo(): boolean {
    const cmd = this.past.pop();
    if (!cmd) return false;
    cmd.undo();
    this.future.push(cmd);
    this.emit();
    return true;
  }

  redo(): boolean {
    const cmd = this.future.pop();
    if (!cmd) return false;
    cmd.redo();
    this.past.push(cmd);
    this.emit();
    return true;
  }

  clear() {
    this.past.length = 0;
    this.future.length = 0;
    this.bytes = 0;
    this.emit();
  }

  /** Sólo la pila de deshacer, de más antiguo a más reciente — lo que hace
   *  falta para decidir qué persistir en el `.trace` (ver `io.ts`). No
   *  incluye `future`: rehacer después de recargar no se persiste, ver el
   *  comentario de `HistoryOp` en `historyOps.ts`. */
  get pastCommands(): readonly Command[] {
    return this.past;
  }

  /**
   * Repuebla la pila de deshacer con comandos ya reconstruidos (carga de un
   * `.trace`) — a diferencia de `push`, no toca `future` y emite un único
   * evento al final en vez de uno por paso.
   */
  loadPast(cmds: Command[]) {
    this.past = cmds;
    this.bytes = cmds.reduce((n, c) => n + (c.cost ?? 0), 0);
    this.trim();
    this.emit();
  }

  get canUndo() {
    return this.past.length > 0;
  }

  get canRedo() {
    return this.future.length > 0;
  }

  get undoLabel() {
    return this.past[this.past.length - 1]?.label ?? '';
  }

  get redoLabel() {
    return this.future[this.future.length - 1]?.label ?? '';
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    for (const fn of this.listeners) fn();
  }
}
