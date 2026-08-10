# Checkpoint

Estado real del proyecto. Se actualiza al cerrar cada tanda de trabajo.

**Fecha:** 10 de agosto de 2026
**Rama:** `claude/trace-drawing-animation-app-ov7j6d`
**Fase:** 0 cerrada, 1 en curso (ver `RUMBO.md`)

## Verificación de este checkpoint

Todo lo de abajo está comprobado en un Chromium real, no sólo compilado.

```
npm run test:smoke        TODO EN VERDE   (17 comprobaciones)
npm run test:selection    TODO EN VERDE   (14 comprobaciones)
npm run test:responsive   iPhone y iPad sin desbordes ni controles fuera de pantalla
npm run test:reference    TODO EN VERDE   (14 comprobaciones, imagen + vídeo real vía MediaRecorder)
npm run test:brush-texture TODO EN VERDE  (8 comprobaciones)
npm run test:brushes      TODO EN VERDE   (los 18 pinceles del kit pintan o borran de verdad)
npm run test:video        TODO EN VERDE   (13 comprobaciones; el vídeo se decodifica y se le ven los trazos)
npm run test:canvas-size  TODO EN VERDE   (redimensionar sin perder tinta, controles legibles en tablet)
npm run test:quickshape   TODO EN VERDE   (24 comprobaciones: línea, elipse, rectángulo, triángulo, polígono)
npm run test:fill         TODO EN VERDE   (bote de relleno, acotado a la caja tocada)
npm run test:select-wand  TODO EN VERDE   (varita mágica: tocar, arrastrar tolerancia, sumar/restar)
npm run test:unit         TODO EN VERDE   (83 casos: math.ts, document.ts, selection.ts — núcleo puro, sin navegador)
npm run test:history-persist TODO EN VERDE (guardar/reabrir conserva y deshace los pasos de edición de píxel)
npx oxlint                sin warnings
npm run build             466 kB / 140 kB gzip
```

## Funciona

### Dibujo
- Estampado instanciado en GPU con espaciado por longitud de arco sobre
  splines Catmull-Rom.
- Dinámicas de presión, inclinación (achatado y giro de punta), velocidad,
  dispersión y variación de tamaño.
- Estabilización con filtro One Euro; muestras predichas del navegador para
  recortar latencia.
- **Kit de 18 pinceles** en cinco categorías (Boceto, Entintado, Pintura,
  Texturas, Borradores), agrupadas en el panel: lápiz, lápiz blando, grafito,
  carboncillo · entintado, rotulador fino, caligráfico, marcador · pintura,
  acuarela, gouache, acrílico · aerógrafo, aerógrafo salpicado, pastel,
  textura de lienzo · borrador, borrador suave. Cada uno editable.
- Bote de relleno que respeta líneas de otras capas, con crecimiento
  configurable contra la orla del antialias.
- Cuentagotas sobre la imagen compuesta.
- **QuickShape**: mantener el lápiz quieto al final de un trazo lo reconoce
  como línea, elipse/círculo, rectángulo, triángulo o polígono regular, al
  estilo Procreate. `core/quickshape.ts` ajusta cada primitiva por separado
  (no hay reconocedor de gestos genérico: hacía falta el centro, el radio o
  las esquinas exactas para poder dibujar y editar la forma, no sólo
  reconocerla) y compara el error de la hipótesis curva contra la del
  polígono en vez de decidir en cascada, para que afinar un umbral no voltee
  en silencio la clasificación del otro. Los umbrales tienen un extremo laxo
  y uno estricto calibrados con dedo real en pantalla táctil, no con ratón:
  un círculo dibujado a mano casi nunca cierra el lazo justo donde empezó.
  Precisión ajustable por quien dibuja. Mientras el lápiz sigue apoyado se
  puede seguir arrastrando para ajustar la forma, y un segundo dedo fuerza
  proporción exacta más rotación en incrementos de 15°; al soltar entra en
  un modo de edición con nodos arrastrables antes de confirmar o cancelar
  —el mismo ciclo lift/edit/commit que ya usaba la selección flotante—.
- Texturas de punta: cuatro máscaras integradas (grano, tiza, lienzo,
  salpicadura) además de la punta lisa de siempre, seleccionables por pincel.
  El generador de píxeles (`core/brushTexture.ts`) es puro cálculo sin DOM:
  el mismo buffer sube como textura a la GPU y pinta la miniatura del
  selector en la interfaz, sin duplicar el algoritmo en dos sitios. Suben
  con cadena de mipmaps completa (antes un solo nivel), corrigiendo el
  aliasing de minificación en pinceles muy pequeños.
- **Paleta de colores en cuatro grupos**: neutros (rampa de grises), espectro
  (12 tonos vivos), pasteles (6 tonos claros) y tierras y piel (8 tonos
  cálidos), además de los colores recientes. El espectro y los pasteles se
  generan con `hsvToRgb`, no están escritos a mano uno a uno.

### Capas
- Los 13 modos de fusión separables de la especificación de compositing,
  verificados uno a uno.
- Máscaras de recorte con semántica de grupo correcta (la capa recortada se
  ajusta a su base, no al fondo acumulado).
- Opacidad, visibilidad, bloqueo, reordenar, duplicar, combinar hacia abajo.

### Animación
- Cels cuadro por cuadro con sostenido automático. Dibujar sobre un cuadro
  sostenido edita ese dibujo (comprobado en el test).
- Keyframes interpolados con easing para posición, escala, rotación y
  opacidad, sobre la misma capa que lleva los cels.
- Papel cebolla hasta 3 cuadros por lado, teñido rojo/azul, con caída. Su
  popover se cierra con la "x" de la cabecera o con Escape (antes no había
  forma de cerrarlo).
- Reproducción en bucle y arrastre de cels en la línea de tiempo.
- Techo de `frameCount` en 6000 cuadros (antes 2000), medido en navegador
  para no meter un número que congelara la interfaz — la línea de tiempo no
  está virtualizada, así que el límite real es cuánto tarda en pintarse, no
  la memoria (los cels viven en un `Map` disperso). Un vídeo importado se
  trocea al mismo techo, por la misma razón.

### Selección
- Rectángulo, lazo y **varita mágica** (semejanza de color), con modos
  sustituir / sumar / restar. La varita toca para seleccionar la región
  conexa de un color y arrastra para reajustar la tolerancia en vivo, con
  HUD de porcentaje — reutiliza el barrido de líneas de `floodFill`
  (`Engine.floodMatch`, compartido) y entra en el mismo sistema de
  selección de siempre vía `rasterizeMask`.
- Contorno animado ("hormigas marchando") de grosor constante a cualquier zoom.
- **Los trazos se recortan a la selección**: el test mide cero píxeles
  pintados fuera.
- Transformación libre: mover, escalar y girar con tiradores en pantalla.
  Los píxeles se levantan a una capa flotante, así que arrastrar no acumula
  pérdidas de remuestreo.
- Rellenar, borrar, invertir, seleccionar todo, deseleccionar.
- Deshacer restaura exactamente el estado previo al levantado (22 089 px
  antes y después en el test).

### Referencia (rotoscopia)
- Importar una imagen suelta o un vídeo como capa de referencia: reutiliza el
  mismo modelo de cels que la animación normal, así que un vídeo entra como un
  cel por fotograma del documento con sostenido automático — no hizo falta
  inventar un tipo de dato nuevo.
- La capa de referencia no admite trazo, bote ni selección (bloqueado en el
  motor, no sólo en la interfaz) y queda fuera de PNG/APNG/secuencia: es
  material para calcar, no parte de la obra.
- El vídeo se extrae buscando (`seek`) fotograma a fotograma a la fps del
  documento, no reproduciendo en tiempo real: así el cel *n* es el fotograma
  exacto, no lo que caiga a 60 Hz. Si la duración no cabe en el documento
  actual, éste crece para acomodarla.
- Encaja y centra el origen (imagen o vídeo) al lienzo por contención,
  conservando su proporción — nunca lo estira ni lo recorta.
- Importar un vídeo se puede **cancelar a medias** (botón "Cancelar" junto
  al progreso), vía `AbortSignal` — no deja una capa a medio importar ni
  dispara el aviso de error que sí es un fallo real.

### Guardar y exportar
- Formato `.trace` (zip con cels en PNG y estructura en JSON); ida y vuelta
  comprobada.
- Autoguardado en IndexedDB cada dos minutos con recuperación al abrir.
- Exportar: **vídeo (MP4 H.264 o WebM VP9)**, PNG del cuadro actual, APNG
  animado (con chunk `acTL` verificado) y secuencia de PNG en zip.
- El vídeo se codifica con WebCodecs, que va tan rápido como pueda la máquina
  y pone tiempos exactos por fotograma. Hay dos rutas de reserva encadenadas:
  si falta el codificador H.264 se usa VP9 en WebM, y si no hay WebCodecs se
  graba con `MediaRecorder` en tiempo real. La interfaz avisa cuál toca antes
  de empezar, porque la última tarda lo que dure la animación.

### Lienzo
- El tamaño se cambia cuando se quiera desde *Proyecto → Tamaño del lienzo*,
  con seis medidas predefinidas o a medida y anclaje de nueve posiciones. Los
  cels se sacan a memoria de CPU antes de tocar el tamaño del documento —en
  cuanto cambia, las texturas se reservan con las medidas nuevas y lo de
  dentro se pierde— y se recolocan según el anclaje. Al encoger se recorta lo
  que sobresalga; deshacer lo devuelve entero.

### Interfaz
- Gestos de Procreate: dos dedos navegan, toque de dos o tres dedos deshace o
  rehace, rechazo de palma tras usar el lápiz.
- Maquetación en rejilla para móvil: lienzo, botonera y línea de tiempo
  apilados en flujo real, sin posiciones absolutas adivinadas.
- Acciones de capa (nueva, duplicar, combinar, eliminar, ocultar, bloquear)
  con su nombre a la vista, no sólo en `title`: en una tablet no hay puntero,
  así que un tooltip nunca llega a mostrarse.
- PWA instalable con service worker.

## Rendimiento resuelto en esta tanda

| Qué | Antes | Ahora |
| --- | --- | --- |
| Miniatura de capa (primera vez) | 146 ms | 17 ms |
| Miniatura de capa (cacheada) | 146 ms | 0,001 ms |

El camino anterior traía el documento entero a CPU en cada cambio y por cada
capa: con 5 capas eran ~730 ms por trazo. Ahora se reduce en GPU por halvings
sucesivos y se cachea por versión de contenido de la superficie.

## Bugs encontrados y corregidos

Todos salieron de mirar capturas, no del compilador:

1. **El papel cebolla teñía el lienzo entero de azul.** El fantasma incluía la
   hoja blanca del documento en vez de sólo el dibujo.
2. **La intensidad del papel cebolla mentía**: se pedía 35 % y salía 25 %, por
   un factor de caída que empezaba en 0,71 para el cuadro contiguo.
3. **`bindAttribLocation` llamado después de enlazar**: no tenía efecto y los
   shaders funcionaban por suerte del compilador. Ahora las localizaciones van
   fijadas en el GLSL.
4. **Maquetación rota en iPhone**: la barra de herramientas se desbordaba por
   ambos lados y flotaba en mitad del lienzo.
5. **El lienzo no se centraba en el área libre**: la vista se calculaba antes
   de que la rejilla diera el tamaño final y nunca se recalculaba.
6. **Deshacer de la transformación libre no reconstruía el estado previo.**
   Detectado escribiendo el paso de historial; ahora usa el rectángulo unión
   de origen y destino.
7. **Presupuesto de texturas por número en vez de por memoria**: 40 texturas
   son 13 MB en un lienzo de 512² y 670 MB en uno de 4K.
9. **La ruta de vídeo suponía que WebCodecs implica H.264.** Chromium
   compilado sin códecs propietarios —el de muchas distribuciones de Linux y
   varios Android— decodifica H.264 pero no lo codifica: `isConfigSupported`
   dice que no a los cinco perfiles AVC y sí a VP8, VP9 y AV1. La versión
   inicial caía en silencio a la grabación en tiempo real (1855 ms para 1 s de
   animación) teniendo WebCodecs delante. Con la ruta VP9/WebM añadida, el
   mismo caso tarda 434 ms. Encontrado porque el test comprobaba *qué* ruta se
   usó, no sólo que saliera un archivo.
8. **`drawStamps` podía formar un feedback loop de WebGL y fallar en
   silencio.** Si un trazo anterior dejaba la textura del scratch `wet`
   enlazada en la unidad 0 (lo que hace `drawOver` al volcarlo sobre el cel)
   y el siguiente trazo no pedía textura de pincel, esa unidad seguía
   apuntando a `wet` justo cuando `wet` era también el destino del
   framebuffer: WebGL rechaza el draw call entero, sin excepción en JS, y la
   estampa no pintaba nada. En el uso normal el siguiente fotograma de render
   ya pisaba esa unidad con otra textura, así que no se notaba; en dos trazos
   seguidos sin que se dibuje un fotograma de por medio (como al probar los
   18 pinceles del kit uno detrás de otro, sin ratón de por medio), sí.
   Encontrado por `test:brushes`, que dejó de fiarse del compilador y miró
   los píxeles resultantes. Ahora `drawStamps` siempre fija la unidad 0,
   incluso a `null` cuando no hay textura.
10. **Duplicar, ocultar y bloquear eran indescifrables en un iPad.** Existían,
    pero como iconos mudos cuyo único texto vivía en `title`, que no se
    muestra nunca sin puntero. Encontrado dibujando en un iPad real, no con
    ningún test.
11. **El tamaño del lienzo no se podía cambiar.** Estaba fijo desde la
    creación del documento; el panel sólo lo mostraba como dato. Mismo origen
    que el anterior: sólo aparece al usar la app de verdad.
12. **QuickShape calibrado con ratón fallaba con dedo real**: un círculo
    dibujado con el dedo casi nunca cierra el lazo justo donde empezó, y una
    "línea recta" tiembla bastante más del 6 % de su longitud que asumía la
    primera pasada. Los umbrales de aceptación se recalibraron con touch real
    en pantalla, no con trazos de ratón en mesa.
13. **Un rectángulo con lados algo planos y un pequeño cruce al cerrar el
    lazo no se reconocía.** El ajuste de elipse y de polígono usaba el error
    *máximo* entre todos los puntos: un solo punto raro (el cruce al cerrar)
    bastaba para tumbar un ajuste que era bueno en el resto. Reportado con
    una captura de pantalla real, no encontrado por un test.
14. **Dos sesiones construyeron QuickShape en paralelo**, sin saber una de la
    otra. La de esta rama era más simple (línea, rectángulo, elipse, sin
    edición); la otra reconocía también triángulo y polígono, con edición de
    nodos, modificador de dos dedos y cinco commits de pulido sobre reportes
    reales. Se descartó la más simple y se adoptó la más completa; las nueve
    suites de test pasan igual sobre el resultado fusionado.
15. **Los commits de esa otra sesión volvían a ir a nombre de `Claude
    <noreply@anthropic.com>`**, pese a la regla explícita en `CLAUDE.md`. Ya
    había pasado una vez con un lote anterior de PRs (ver el historial de
    `RUMBO.md`/commits de esta rama). Se reescribió la autoría de los 14
    commits nuevos por segunda vez, con el mismo procedimiento verificado
    (`merge-base --is-ancestor`, `diff --stat` vacío antes de forzar el
    push). La regla en `CLAUDE.md` sigue siendo la salvaguarda correcta; el
    fallo está en que la sesión de turno no la aplicó, no en la regla misma.

## Lo siguiente

Con QuickShape (línea, elipse, rectángulo, triángulo, polígono, con edición
de nodos) y el tamaño de lienzo resueltos, la Fase 1 sólo tiene pendiente lo
que no se puede hacer desde aquí:

1. **Seguir usándolo en un iPad de verdad** y reportando lo que no se
   encuentra o no funciona como se espera — así salieron los bugs de
   interfaz y de calibración táctil de esta tanda, y ningún test los habría
   visto antes que un dedo real.
2. **Perfilar un proyecto real** —muchas capas, cientos de cels— y medir la
   memoria en el dispositivo, no en el emulador.
3. **Verificar la ruta MP4.** El Chromium de las pruebas no codifica H.264, así
   que sólo se ha ejercitado la ruta VP9/WebM. El código de MP4 compila y usa
   un muxer probado, pero no se ha visto producir un archivo aquí; en Safari,
   que sí trae H.264, debería tomar esa rama.
4. **Capas en disco (OPFS)**, según `RUMBO.md` — el historial ya persiste
   (ver deuda conocida, resuelta).

## Deuda conocida

Resuelta desde el checkpoint anterior (quedan documentadas, no repetir):

- ~~No hay tests unitarios del núcleo~~. `math.test.ts`, `document.test.ts` y
  `selection.test.ts` (83 casos, `npm run test:unit`, Node nativo con
  `node --test`, sin dependencia nueva).
- ~~`selection.ts` hace un `getImageData` del documento entero por gesto~~.
  `commitSelectionCanvas` acota el escaneo a la caja realmente tocada
  (exacto, no aproximado — ver el commit). Queda pendiente el resto del
  camino (subida de la máscara a GPU, restaurar el respaldo del canvas 2D),
  que sigue siendo O(lienzo).
- ~~`floodFill` recorre el lienzo entero para el crecimiento y el color~~.
  Acotado a la caja de lo rellenado. Sigue leyendo el lienzo completo por
  GPU dos veces como referencia (coste fijo, no depende del tamaño del
  relleno) — moverlo a un worker sigue pendiente, ver abajo.
- ~~Importar un vídeo largo no se puede cancelar~~. Botón "Cancelar" +
  `AbortSignal`. Sigue siendo lento en proporción a la duración (`seek` +
  subida a GPU secuenciales, sin cambiar) — cancelar no acelera la
  importación, sólo permite abortarla.
- ~~Texturas de punta con aliasing en pinceles pequeños~~. Cadena de mipmaps
  completa. Corrección de manual, sin contrapartida; el efecto no salió
  limpio de medir en el Chromium de pruebas (SwiftShader), así que el test
  es una comprobación de sanidad, no una comparación antes/después.
- ~~Historial persistente~~. Parcial y a propósito — ver `RUMBO.md`,
  oportunidad 2, para el porqué del alcance. `historyOps.ts` +
  `Engine.loadHistoryOps` + `serializeProject`/`deserializeProject` en
  `io.ts`. Sólo los pasos que editan píxeles (trazo, QuickShape, bote,
  rellenar/borrar selección, transformar por lotes) sobreviven guardar y
  volver a abrir; los estructurales (capas, keyframes...) siguen sin
  persistir y cortan la racha donde aparecen. Mismo camino para el
  `.trace` manual y el autoguardado. Test en
  `scripts/history-persist.mjs` (`npm run test:history-persist`).

Todavía abierta:

- **La miniatura de una línea fina es casi invisible.** Es inherente a
  reducir 1920 px a 48; Procreate tiene el mismo problema. Se arreglaría
  recortando a los límites del dibujo en vez de al documento entero.
- **El rendimiento sólo está medido con SwiftShader**, que es correcto pero
  lento. Los números absolutos de un iPad están sin tomar — no se puede
  resolver desde aquí, hace falta el dispositivo real.
- **`floodFill` sigue bloqueando el hilo** mientras rellena (la lectura de
  referencia por GPU, ver arriba). En un lienzo grande se nota; hay un
  indicador de ocupado, pero lo correcto sería un worker.
- **Capas en disco (OPFS)**, de `RUMBO.md` — cambia el respaldo de
  `Uint8Array` a archivos y quita el techo de RAM del todo; la maquinaria
  de expulsión ya existe, así que el cambio queda contenido en
  `gl/renderer.ts`.
- **Time-lapse**, de `RUMBO.md` — la codificación con WebCodecs ya existe;
  falta capturar un fotograma por trazo en un búfer circular.
- **Lote de transformación + selección rectangular: aviso de WebGL en
  consola, sin efecto visible.** Al levantar un lote de varios cels
  (`liftSelectionRange`) tras crear la selección, la consola muestra
  "Feedback loop formed between Framebuffer and active Texture" varias
  veces. No es una regresión de esta tanda —ninguno de los cambios de
  historial persistente toca `liftCel`/`commitFloating`/`renderer.ts`— y
  no se ha visto que estropee el resultado (medido con `readRect` en la
  región exacta de origen y destino, no con una captura de pantalla): el
  origen queda vacío y el destino recibe la tinta, en ambos cels del
  lote, antes y después de recargar. Encontrado mientras se escribía el
  test de historial; queda para revisar aparte porque un warning de GPU
  sin efecto medible no es zona seguro para asumir que no importa en un
  dispositivo real.
