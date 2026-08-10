import type { Engine } from '../core/engine';
import { useEngineRevision } from '../state/store';

/**
 * Aviso flotante mientras se pinta la máscara de una capa en vez de su
 * dibujo — sin esto, el modo es invisible en el lienzo: los trazos siguen
 * viéndose (afectan a lo que se compone), pero no dejan tinta nueva en la
 * capa, y eso confunde sin una señal explícita de qué se está tocando.
 */
export function MaskEditBanner({ engine }: { engine: Engine }) {
  useEngineRevision(engine);
  const layerId = engine.editingMaskLayerId;
  if (!layerId) return null;
  const layer = engine.doc.layers.find((l) => l.id === layerId);
  if (!layer) return null;

  return (
    <div className="mask-edit-banner">
      <span>Editando máscara de «{layer.name}» — blanco revela, negro oculta</span>
      <button type="button" onClick={() => engine.setEditingMaskLayer(null)}>
        Listo
      </button>
    </div>
  );
}
