export interface Command {
  label: string;
  undo(): void;
  redo(): void;
  /** Bytes aproximados retenidos, para presupuestar la pila. */
  cost?: number;
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
