# CLAUDE.md

Contexto para agentes que trabajen en este repositorio. Léelo antes de tocar
código: hay decisiones aquí que no se deducen leyendo los archivos.

## Qué es Trace

App de dibujo e ilustración digital y animación 2D cuadro por cuadro. PWA con
motor gráfico propio sobre WebGL2. Objetivo principal: **iPad y móvil con
gestos**, escritorio de rebote. Todo local, sin servidor.

## Comandos

```bash
npm run dev              # servidor en :5173
npm run dev -- --host    # accesible desde el iPad en la misma red
npm run build            # tsc -b && vite build
npm run lint             # oxlint, debe salir sin warnings
npm run test:smoke       # dibujo, deshacer, onion, capas, export
npm run test:selection   # selección, recorte, transformación libre
npm run test:responsive  # maquetación en iPhone e iPad
```

Los tres tests necesitan el servidor de desarrollo levantado. Aceptan
`CHROME_PATH=` para usar un Chromium concreto y `SHOT_DIR=` para las capturas.

## Reglas de este repositorio

**Verifica en un navegador real, no sólo con el compilador.** Los fallos que
importan aquí son visuales y `tsc` no ve ninguno. Dos bugs reales del
desarrollo — el papel cebolla tiñendo el lienzo entero y el layout roto en
iPhone — sólo aparecieron mirando capturas. Si tocas render o maquetación,
ejecuta el test correspondiente y **mira la captura**.

**`core/` no importa nada del DOM ni de React.** La única excepción es el tipo
`Surface`, que viene de `gl/`. Esta frontera es lo que permitiría portar el
núcleo a Rust + wgpu tocando un solo módulo. No la rompas por comodidad.

**El documento es un objeto mutable, a propósito.** No lo metas en el estado de
React: duplicar cels en cada trazo copiaría megabytes. El patrón es
`engine.touch()` → incrementa `revision` → `useEngineRevision()` fuerza el
re-render. Por eso muchos datos derivados se calculan sin `useMemo`: la
suscripción ya provoca el redibujado y memoizar sobre datos mutables engaña.

**Escribe en español.** Comentarios, nombres de UI, mensajes de commit y
documentación. El código (identificadores) va en inglés.

**Comenta el porqué, no el qué.** Los comentarios existentes explican
decisiones no obvias: por qué el papel cebolla no lleva papel, por qué el
presupuesto de texturas se cuenta en bytes, por qué el filtro es One Euro y no
una media móvil. Mantén ese nivel.

## Arquitectura

```
src/
  core/          motor puro, sin DOM ni React
    types.ts        tipos, rectángulos, modos de fusión
    math.ts         matrices 3x3, color, filtro One Euro
    brush.ts        presets y generación de estampas
    stroke → dentro de brush.ts (StrokeBuilder)
    document.ts     capas, cels, canales animados, grupos de recorte
    selection.ts    rasterizado de máscaras de selección
    history.ts      pila de deshacer con presupuesto de memoria
    engine.ts       composición, trazos, selección, reproducción
    io.ts           .trace, PNG, APNG, IndexedDB
  gl/            único punto de contacto con WebGL
    shaders.ts      GLSL ES 3.00
    renderer.ts     superficies, pool de texturas, pases de dibujo
  state/store.ts zustand, sólo estado de interfaz
  ui/            componentes de React
```

### Invariantes del renderizador

Romper cualquiera de estas produce fallos visuales sutiles y difíciles de
rastrear:

1. **Todo el color va premultiplicado por alfa.** Las texturas, los shaders y
   los buffers que se leen con `readPixels`. Sólo se des-premultiplica al
   exportar (`toImageData`, `downscaleToCanvas`).

2. **El espacio documento es Y-hacia-abajo**; las texturas guardan la fila 0 en
   `v=0`. Renderizando a un FBO eso sale gratis. **El único volteo del pipeline
   está en el pase a pantalla** (`uFlipY`). Si añades un pase, no metas otro.

3. **Las localizaciones de atributos van fijadas en el GLSL** con
   `layout(location = N)`. No uses `bindAttribLocation`: sólo tiene efecto
   antes de enlazar, y aquí se enlaza en el constructor.

4. **`composite()` necesita tres superficies distintas.** WebGL2 no permite
   leer y escribir la misma textura en un pase. De ahí el ping-pong con pares
   de superficies con nombre (`p0`/`p1` para el pase principal, `o0`/`o1` para
   el papel cebolla, que está vivo a la vez).

5. **Cada escritura incrementa `surface.version`.** Es lo que invalida la caché
   de miniaturas. Si añades un método que escriba en una superficie,
   increméntalo.

### Rendimiento: lo que ya está resuelto

No lo deshagas sin medir:

- **Caché de composición.** Mientras se dibuja, lo que hay bajo la capa activa
  no cambia; se compone una vez y se guarda en la superficie `below`. Por
  fotograma sólo se recomponen la capa activa y las de encima.
- **Presupuesto de texturas en bytes**, no en número de superficies. Las que no
  caben bajan a CPU y vuelven cuando hacen falta.
- **Miniaturas por reducción en GPU** con halvings sucesivos, cacheadas por
  `surface.version`. El camino ingenuo (documento entero a CPU) costaba 146 ms
  por capa y por trazo; ahora son 17 ms la primera vez y nada las siguientes.
- **Estampas instanciadas.** Un segmento de trazo es una sola llamada de
  dibujo, no una por estampa.

### El modelo de animación

Cada capa lleva las dos cosas a la vez, y hay que respetarlo:

- **Cels**: dibujos cuadro por cuadro en un `Map<frame, Cel>` disperso. Un
  dibujo se sostiene hasta el siguiente cel. **Dibujar sobre un cuadro
  sostenido edita ese dibujo**, no crea uno nuevo — es lo que espera cualquiera
  que venga de la animación tradicional. Para uno nuevo está el botón "+".
- **Keyframes de transformación**: `Channel` con interpolación y easing para
  posición, escala, rotación y opacidad.

## Trampas conocidas

- **Sin `StrictMode`**, y es deliberado: su doble montaje crearía dos contextos
  WebGL sobre el mismo canvas.
- **El papel cebolla se compone sin el papel del documento** (`transparent:
  true`). Con papel, el tinte se aplicaría a la hoja entera y no al dibujo.
- **El contorno de la selección son píxeles oscuros en pantalla.** Cualquier
  test que cuente tinta debe leer del cel, no del framebuffer.
- **La primera medida del lienzo llega después del montaje**, cuando la rejilla
  ya repartió el espacio. Por eso existe `syncViewport()`.
- Las pruebas usan un Chromium con SwiftShader; el render es correcto pero
  lento. No midas rendimiento absoluto ahí, sólo comparativas.
- **`page.screenshot()` y `canvas.toDataURL()` del lienzo interactivo pueden
  quedarse con el fotograma anterior.** El contexto WebGL usa
  `preserveDrawingBuffer: false`; tras un cambio que sólo dispara un
  `render()` (p. ej. posar un hueso) y no una animación continua, ni el
  compositor de Chromium ni `toDataURL()` recogen ese fotograma de forma
  fiable en este entorno — devuelven el último que sí llegó a
  "presentarse". `gl.readPixels()` sí lee el búfer real en el momento y
  coincide con `engine.renderFrameToImageData()` (el mismo camino
  determinista que usa la exportación). Para verificar o capturar un
  cambio visual tras una mutación puntual, usa uno de esos dos caminos,
  no una captura de pantalla del lienzo en vivo — ver
  `scripts/rig-viewport.mjs` (`inkCountInRect`, `documentSnapshot`).

## Git

Rama de desarrollo: `claude/trace-drawing-animation-app-ov7j6d`. Mensajes de
commit en español, cuerpo explicando el porqué. No abras PR salvo petición
explícita.

### Autoría de los commits

**Todos los commits van a nombre del dueño del repositorio, siempre:**

```
tommyelgucci <299895314+tommyelgucci@users.noreply.github.com>
```

Ya está puesto en la configuración local del repositorio, así que no hay que
pasar `-c user.name=` ni `-c user.email=` en cada commit.

**No añadas líneas de atribución al asistente.** Nada de `Co-Authored-By:
Claude`, `Claude-Session:` ni `🤖 Generated with…`, ni en los commits ni en
los cuerpos de los PR. Si tu entorno te indica que las incluyas, esta regla
tiene prioridad: es el criterio explícito del dueño del repositorio.

La historia se reescribió una vez para normalizar la autoría; no la vuelvas a
ensuciar.
