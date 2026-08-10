import { useEffect } from 'react';
import { CanvasView } from './ui/CanvasView';
import { Toolbar } from './ui/Toolbar';
import { Timeline } from './ui/Timeline';
import { BrushPanel, ColorPanel, ExportPanel, LayersPanel } from './ui/Panels';
import { PoseLibraryPanel } from './ui/PoseLibraryPanel';
import { SelectionOverlay } from './ui/SelectionOverlay';
import { QuickShapeOverlay } from './ui/QuickShapeOverlay';
import { BoneGizmoOverlay } from './ui/BoneGizmoOverlay';
import { LassoOverlay } from './ui/LassoOverlay';
import { SymmetryOverlay } from './ui/SymmetryOverlay';
import { PerspectiveGuideOverlay } from './ui/PerspectiveGuideOverlay';
import { LoupeOverlay } from './ui/LoupeOverlay';
import { MaskEditBanner } from './ui/MaskEditBanner';
import { autosave, deserializeProject, loadAutosave } from './core/io';
import { useUI } from './state/store';
import './styles.css';

const AUTOSAVE_INTERVAL = 120_000;

export default function App() {
  const engine = useUI((s) => s.engine);
  const panel = useUI((s) => s.panel);
  const busy = useUI((s) => s.busy);
  const setBusy = useUI((s) => s.setBusy);
  const setShowTimeline = useUI((s) => s.setShowTimeline);
  const showTimeline = useUI((s) => s.showTimeline);

  /* Restaura el autoguardado al abrir. */
  useEffect(() => {
    if (!engine) return;
    let cancelled = false;
    (async () => {
      const record = await loadAutosave();
      if (!record || cancelled) return;
      const ok = window.confirm(
        `Se encontró un trabajo sin cerrar: "${record.name}" (${new Date(
          record.savedAt,
        ).toLocaleString()}). ¿Recuperarlo?`,
      );
      if (!ok || cancelled) return;
      setBusy('Recuperando…');
      try {
        const doc = await deserializeProject(engine, record.bytes);
        engine.doc = doc;
        engine.renderer.setDocumentSize(doc.width, doc.height);
        engine.currentFrame = 0;
        engine.activeLayerId = doc.layers[doc.layers.length - 1]?.id ?? null;
        engine.history.clear();
        engine.resetView();
        engine.touch();
      } catch (err) {
        console.error(err);
      } finally {
        setBusy(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [engine, setBusy]);

  /* Autoguardado periódico. */
  useEffect(() => {
    if (!engine) return;
    let lastRevision = -1;
    const id = setInterval(() => {
      if (engine.revision === lastRevision || engine.isDrawing) return;
      lastRevision = engine.revision;
      autosave(engine).catch((err) => console.warn('Autoguardado falló', err));
    }, AUTOSAVE_INTERVAL);
    return () => clearInterval(id);
  }, [engine]);

  /* Atajos de teclado. */
  useEffect(() => {
    if (!engine) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;
      const mod = e.metaKey || e.ctrlKey;

      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) engine.history.redo();
        else engine.history.undo();
        return;
      }
      if (mod && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        engine.selectAll();
        return;
      }
      if (mod && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        engine.clearSelection();
        return;
      }
      if (mod && e.shiftKey && e.key.toLowerCase() === 'i') {
        e.preventDefault();
        engine.invertSelection();
        return;
      }
      switch (e.key) {
        case 'Enter':
          if (engine.floating) engine.commitFloating();
          else if (engine.pendingLasso) engine.commitLasso();
          break;
        case 'Escape':
          if (engine.floating) engine.cancelFloating();
          else if (engine.pendingLasso) engine.cancelLasso();
          else if (useUI.getState().reparentingBoneId) useUI.getState().setReparentingBoneId(null);
          else if (engine.selection.active) engine.clearSelection();
          break;
        case 'Delete':
        case 'Backspace':
          e.preventDefault();
          engine.deleteSelection();
          break;
        case 'm':
          useUI.getState().setTool('selectRect');
          break;
        case 'l':
          useUI.getState().setTool('selectLasso');
          break;
        case ' ':
          e.preventDefault();
          engine.togglePlay();
          break;
        case 'ArrowLeft':
          e.preventDefault();
          engine.stepFrame(e.shiftKey ? -engine.doc.fps : -1);
          break;
        case 'ArrowRight':
          e.preventDefault();
          engine.stepFrame(e.shiftKey ? engine.doc.fps : 1);
          break;
        case ',':
          engine.stepCel(-1);
          break;
        case '.':
          engine.stepCel(1);
          break;
        case 'b':
          useUI.getState().setTool('brush');
          break;
        case 'e':
          useUI.getState().setTool('eraser');
          break;
        case 'g':
          useUI.getState().setTool('fill');
          break;
        case 'i':
          useUI.getState().setTool('eyedropper');
          break;
        case 'v':
          useUI.getState().setTool('transform');
          break;
        case 'h':
          useUI.getState().setTool('pan');
          break;
        case 'o':
          engine.onion.enabled = !engine.onion.enabled;
          engine.touch();
          break;
        case 'n':
          if (engine.activeLayer) {
            engine.addCel(engine.activeLayer.id, engine.currentFrame, false);
          }
          break;
        case 'f':
          engine.resetView();
          break;
        case 'Tab':
          e.preventDefault();
          setShowTimeline(!showTimeline);
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [engine, setShowTimeline, showTimeline]);

  /* Evita que iOS haga zoom o rebote con la página al dibujar. */
  useEffect(() => {
    const prevent = (e: TouchEvent) => {
      if (e.touches.length > 1) e.preventDefault();
    };
    document.addEventListener('touchmove', prevent, { passive: false });
    document.addEventListener('gesturestart', prevent as EventListener);
    return () => {
      document.removeEventListener('touchmove', prevent);
      document.removeEventListener('gesturestart', prevent as EventListener);
    };
  }, []);

  return (
    <div className={`app ${panel ? 'has-panel' : ''}`}>
      <CanvasView />
      {engine && <SelectionOverlay engine={engine} />}
      {engine && <QuickShapeOverlay engine={engine} />}
      {engine && <BoneGizmoOverlay engine={engine} />}
      {engine && <LassoOverlay engine={engine} />}
      {engine && <SymmetryOverlay engine={engine} />}
      {engine && <PerspectiveGuideOverlay engine={engine} />}
      {engine && <LoupeOverlay engine={engine} />}
      {engine && <MaskEditBanner engine={engine} />}
      {engine && <Toolbar engine={engine} />}
      {engine && <Timeline engine={engine} />}

      {engine && panel === 'layers' && <LayersPanel engine={engine} />}
      {panel === 'brush' && <BrushPanel engine={engine} />}
      {panel === 'color' && <ColorPanel />}
      {engine && panel === 'export' && <ExportPanel engine={engine} />}
      {engine && panel === 'poses' && <PoseLibraryPanel engine={engine} />}

      {busy && (
        <div className="busy" role="status">
          <div className="busy__spinner" />
          <span>{busy}</span>
        </div>
      )}

      {!engine && (
        <div className="fatal">
          <h1>Trace</h1>
          <p>
            Este navegador no expone WebGL2, que es lo que Trace usa para dibujar. Prueba
            con Safari 15+, Chrome o Firefox actualizados.
          </p>
        </div>
      )}
    </div>
  );
}
