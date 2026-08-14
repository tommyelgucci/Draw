import type { Engine } from './engine';

/**
 * Nombre de fichero de un fotograma dentro del zip que produce
 * `exportSequenceZip` — mismo padding (`String(frameCount).length`), para que
 * el snippet generado aquí apunte a los ficheros que de verdad hay en el zip.
 */
export function sequenceFrameName(baseName: string, frame: number, frameCount: number): string {
  const pad = String(frameCount).length;
  return `${baseName}_${String(frame).padStart(pad, '0')}.png`;
}

/**
 * Evita que un nombre de proyecto con `</script>` dentro cierre la etiqueta
 * a medias cuando el snippet generado se pega en una página real — el mismo
 * problema de siempre al incrustar JSON dentro de HTML.
 */
function jsonForInlineScript(value: string): string {
  return JSON.stringify(value).replace(/<\//g, '<\\/');
}

/**
 * Loop transparente que se reproduce solo: un APNG en un `<img>` no necesita
 * ni una línea de JS, el propio navegador lo anima.
 */
export function buildLoopEmbedSnippet(engine: Engine, imageFileName: string): string {
  const { width, height } = engine.doc;
  return `<!-- Trace: loop transparente. Sube "${imageFileName}" (exportado como
     Animación APNG) junto a este HTML. -->
<img
  src="${imageFileName}"
  width="${width}"
  height="${height}"
  alt=""
  style="max-width: 100%; height: auto; display: block;"
/>
`;
}

/**
 * Efecto de scroll (estilo "scrollytelling"): dibuja la secuencia de PNG en
 * un `<canvas>` fijado con `position: sticky` y avanza el fotograma según
 * cuánto se ha desplazado un contenedor alto — la misma técnica que usan las
 * páginas de producto con scroll-scrubbing. No usa vídeo: mover `currentTime`
 * a mano no es preciso al fotograma y tiembla; aquí cada fotograma es una
 * imagen exacta.
 */
export function buildScrollEmbedSnippet(engine: Engine, framesFolder: string): string {
  const { width, height, frameCount, name } = engine.doc;
  const folder = framesFolder.replace(/\/+$/, '') || '.';
  const pad = String(frameCount).length;
  const id = `trace-scroll-${Math.random().toString(36).slice(2, 8)}`;

  return `<!-- Trace: secuencia con scroll. Descomprime el zip de "Secuencia de PNG"
     en "${folder}/" junto a este HTML antes de publicar. -->
<div id="${id}" style="position: relative; height: 400vh;">
  <canvas
    width="${width}"
    height="${height}"
    style="position: sticky; top: 0; width: 100%; height: 100vh; object-fit: contain; display: block;"
  ></canvas>
</div>
<script>
(() => {
  const root = document.getElementById(${jsonForInlineScript(id)});
  const canvas = root.querySelector('canvas');
  const ctx = canvas.getContext('2d');
  const frameCount = ${frameCount};
  const pad = ${pad};
  const folder = ${jsonForInlineScript(folder)};
  const base = ${jsonForInlineScript(name)};

  const frames = new Array(frameCount);
  for (let f = 0; f < frameCount; f++) {
    const img = new Image();
    img.src = folder + '/' + base + '_' + String(f).padStart(pad, '0') + '.png';
    if (f === 0) img.onload = () => draw(0);
    frames[f] = img;
  }

  // Progreso 0..1 de cuánto se ha desplazado el contenedor alto por debajo
  // de la ventana: -rect.top crece de 0 a "altura del contenedor menos la
  // ventana" mientras se hace scroll a través de él.
  function frameForScroll() {
    const rect = root.getBoundingClientRect();
    const scrollable = rect.height - window.innerHeight;
    if (scrollable <= 0) return 0;
    const progress = Math.min(1, Math.max(0, -rect.top / scrollable));
    return Math.min(frameCount - 1, Math.round(progress * (frameCount - 1)));
  }

  function draw(index) {
    const img = frames[index];
    if (!img || !img.complete) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0);
  }

  let ticking = false;
  function onScroll() {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      draw(frameForScroll());
      ticking = false;
    });
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
})();
</script>
`;
}
