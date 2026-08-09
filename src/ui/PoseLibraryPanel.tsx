import { useEffect, useRef } from 'react';
import type { Engine } from '../core/engine';
import type { Layer } from '../core/document';
import { useEngineRevision, useUI } from '../state/store';
import { Panel } from './controls';
import { IconPlus, IconTrash } from './icons';

/**
 * Miniatura de una variante, calcada de `LayerThumb`: mismo patrón de
 * apéndice de canvas cacheado por versión, sólo que lee de
 * `swapVariantThumbnail` en vez de `celThumbnail`.
 */
function VariantThumb({ engine, layer, index }: { engine: Engine; layer: Layer; index: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const rev = useEngineRevision(engine);

  useEffect(() => {
    const host = ref.current;
    if (!host) return;
    const thumb = engine.swapVariantThumbnail(layer, index, 72);
    host.replaceChildren();
    if (thumb) {
      thumb.className = 'pose-thumb__img';
      host.appendChild(thumb);
    }
  }, [engine, layer, index, rev]);

  return <div className="pose-thumb__canvas" ref={ref} />;
}

/**
 * Librería de poses / intercambio de sprites: el mini-picker visual para
 * elegir la expresión o el visema de la capa activa sin redibujar — tocar
 * una miniatura cambia al instante qué variante se ve en el fotograma
 * actual (`engine.selectSwapVariant`).
 */
export function PoseLibraryPanel({ engine }: { engine: Engine }) {
  useEngineRevision(engine);
  const setPanel = useUI((s) => s.setPanel);
  const active = engine.activeLayer;
  const catalog = active?.swap;
  const selectedIndex = catalog ? Math.round(engine.getSwapSelection(active!)) : -1;

  return (
    <Panel title="Poses" onClose={() => setPanel(null)} width={310}>
      {!active && <p className="hint">Selecciona una capa.</p>}

      {active && !catalog && (
        <div className="panel__section">
          <p className="hint">
            Esta capa no es un nodo de intercambio. Crea uno para reunir variantes de un
            elemento — ojos, cejas, boca — y cambiar entre ellas sin redibujar.
          </p>
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => engine.createSwapNode('Boca')}
          >
            <IconPlus size={16} /> Crear nodo de intercambio
          </button>
        </div>
      )}

      {active && catalog && (
        <div className="panel__section">
          <div className="pose-grid">
            {catalog.variants.map((variant, i) => (
              <div key={variant.id} className="pose-cell">
                <button
                  type="button"
                  className={`pose-thumb ${i === selectedIndex ? 'is-selected' : ''}`}
                  onClick={() => engine.selectSwapVariant(active.id, i)}
                  title={variant.label}
                >
                  <VariantThumb engine={engine} layer={active} index={i} />
                </button>
                <span className="pose-cell__label">{variant.label}</span>
                <button
                  type="button"
                  className="pose-cell__remove"
                  aria-label={`Quitar ${variant.label}`}
                  onClick={() => engine.removeSwapVariant(active.id, variant.id)}
                >
                  <IconTrash size={12} />
                </button>
              </div>
            ))}
            <button
              type="button"
              className="pose-thumb pose-thumb--add"
              onClick={() => engine.addSwapVariant(active.id, `Variante ${catalog.variants.length + 1}`)}
              title="Añadir variante"
            >
              <IconPlus size={20} />
            </button>
          </div>
          <p className="hint">
            Cada variante se pinta como un dibujo aparte, con el pincel de siempre. Tocar una
            miniatura fija esa variante en el fotograma actual — con una sola variante
            marcada se ve igual en toda la animación; marca otra en otro fotograma para que
            cambie de golpe, sin transición.
          </p>
        </div>
      )}
    </Panel>
  );
}
