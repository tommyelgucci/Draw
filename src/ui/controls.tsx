import { useCallback, useEffect, useRef, type ReactNode } from 'react';
import { IconClose } from './icons';
import { useDraggable } from './useDraggable';

interface SliderProps {
  value: number;
  min: number;
  max: number;
  step?: number;
  /** >1 comprime el extremo alto: útil para tamaños de pincel. */
  curve?: number;
  label?: string;
  format?: (v: number) => string;
  onChange: (v: number) => void;
  onCommit?: (v: number) => void;
  vertical?: boolean;
}

export function Slider({
  value,
  min,
  max,
  step,
  curve = 1,
  label,
  format,
  onChange,
  onCommit,
  vertical = false,
}: SliderProps) {
  const ref = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const toNorm = useCallback(
    (v: number) => Math.pow((v - min) / (max - min), 1 / curve),
    [min, max, curve],
  );
  const fromNorm = useCallback(
    (t: number) => {
      const raw = min + Math.pow(Math.min(Math.max(t, 0), 1), curve) * (max - min);
      return step ? Math.round(raw / step) * step : raw;
    },
    [min, max, curve, step],
  );

  const handle = (clientX: number, clientY: number) => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const t = vertical
      ? 1 - (clientY - rect.top) / rect.height
      : (clientX - rect.left) / rect.width;
    onChange(fromNorm(t));
  };

  const norm = toNorm(value);
  const pct = `${Math.min(Math.max(norm, 0), 1) * 100}%`;

  return (
    <div className={`slider ${vertical ? 'slider--v' : ''}`}>
      {label && (
        <div className="slider__head">
          <span>{label}</span>
          <span className="slider__value">{format ? format(value) : value.toFixed(2)}</span>
        </div>
      )}
      <div
        ref={ref}
        className="slider__track"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          dragging.current = true;
          handle(e.clientX, e.clientY);
        }}
        onPointerMove={(e) => {
          if (dragging.current) handle(e.clientX, e.clientY);
        }}
        onPointerUp={(e) => {
          dragging.current = false;
          e.currentTarget.releasePointerCapture(e.pointerId);
          onCommit?.(value);
        }}
      >
        <div className="slider__fill" style={vertical ? { height: pct } : { width: pct }} />
        <div className="slider__knob" style={vertical ? { bottom: pct } : { left: pct }} />
      </div>
    </div>
  );
}

interface IconButtonProps {
  onClick?: () => void;
  active?: boolean;
  disabled?: boolean;
  title: string;
  children: ReactNode;
  className?: string;
}

export function IconButton({
  onClick,
  active,
  disabled,
  title,
  children,
  className = '',
}: IconButtonProps) {
  return (
    <button
      type="button"
      className={`icon-btn ${active ? 'is-active' : ''} ${className}`}
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      aria-pressed={active}
    >
      {children}
    </button>
  );
}

interface PanelProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  side?: 'right' | 'left';
  width?: number;
}

export function Panel({ title, onClose, children, side = 'right', width }: PanelProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // La clave de posición es el propio título: cada panel tiene uno fijo y
  // único ("Capas", "Pincel"…), así que sirve de id sin añadir una prop más
  // a los cinco sitios que ya llaman a `Panel`.
  const { position, onHeaderPointerDown, onHeaderPointerMove, onHeaderPointerUp } = useDraggable(title);

  return (
    <div
      className={`panel panel--${side} ${position ? 'is-dragged' : ''}`}
      style={{
        ...(width ? { width } : undefined),
        ...(position ? { left: position.left, top: position.top } : undefined),
      }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <header
        className="panel__head"
        onPointerDown={onHeaderPointerDown}
        onPointerMove={onHeaderPointerMove}
        onPointerUp={onHeaderPointerUp}
        onPointerCancel={onHeaderPointerUp}
      >
        <h2>{title}</h2>
        <IconButton title="Cerrar" onClick={onClose} className="icon-btn--ghost">
          <IconClose size={18} />
        </IconButton>
      </header>
      <div className="panel__body">{children}</div>
    </div>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field__label">{label}</span>
      {children}
    </label>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="segmented" role="tablist">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={o.value === value}
          className={o.value === value ? 'is-active' : ''}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
