# Rumbo

Hacia dónde va Trace y por qué. Este documento es para decidir; el estado
concreto de cada cosa está en `CHECKPOINT.md`.

## La apuesta

**Una app de dibujo y animación tradicional que se sienta nativa en un iPad,
construida sobre web.**

Eso implica aceptar una desventaja de entrada y compensarla con otra cosa. La
desventaja es la latencia: Procreate está en torno a 9 ms y una PWA está en
30-50 ms percibidos. No hay truco que cierre esa brecha por completo, sólo
mitigaciones (predicción de trazo, capa de tinta húmeda separada, presentación
desincronizada).

Lo que se gana a cambio: un solo código para iPad, iPhone, Android y
escritorio; iterar abriendo una URL en vez de compilar en Xcode; nada de
cuentas de desarrollador ni revisiones de tienda; y privacidad real, porque no
hay servidor al que mandar nada.

**El criterio para reconsiderar:** si al dibujar en el iPad la latencia es lo
primero que molesta —por encima de features que falten— toca la Fase 3.

## Principios

1. **Se prueba dibujando, no compilando.** Los fallos de esta app son
   visuales. Cada cambio de render o maquetación se verifica con una captura.

2. **La animación tradicional manda sobre la comodidad de implementación.** El
   sostenido de cels, dibujar sobre un cuadro sostenido, el papel cebolla
   teñido: son convenciones que un animador da por supuestas y no se negocian
   para simplificar el código.

3. **El núcleo se mantiene portable.** `core/` sin DOM, `gl/` como única
   frontera con WebGL. Es lo que hace la Fase 3 un cambio de módulo y no una
   reescritura.

4. **Nada sale del dispositivo.** No hay telemetría, no hay cuentas, no hay
   nube. Si algún día hay sincronización, será opcional y cifrada de extremo a
   extremo.

5. **Gratis y sin fricción.** Nada de funciones bloqueadas ni marcas de agua.

## Fases

### Fase 0 — Motor y flujo completo `hecho`

Dibujo en GPU, capas con fusión y recorte, animación híbrida (cels +
keyframes), papel cebolla, selección con transformación libre, guardar y
exportar. Es utilizable de punta a punta.

### Fase 1 — Que aguante un proyecto real `en curso`

El objetivo no es añadir features, es que un corto de 30 segundos no se caiga
ni se vuelva lento. Lo que falta ya no es código:

- Dibujar en un iPad de verdad y ver qué molesta.
- Perfilar con muchas capas y cientos de cels; medir el consumo de memoria en
  el dispositivo, no en un emulador.

Ya resuelto en esta fase (ver `CHECKPOINT.md`): importar imágenes y vídeo
como referencia para rotoscopia; texturas de punta de pincel; kit completo
de 18 pinceles categorizados y paleta de colores en cuatro grupos; y
exportación a vídeo con WebCodecs.

### Fase 2 — Instalable de verdad

Empaquetado con Capacitor: acceso al sistema de archivos, presencia en la
pantalla de inicio sin depender del navegador, mejor integración con el Apple
Pencil. Mismo código.

### Fase 3 — Sólo si la latencia lo justifica

Dos caminos, no excluyentes:

- **Núcleo en Rust + wgpu.** El trabajo queda contenido en `gl/` porque `core/`
  no depende del DOM. Ataca la latencia de raíz.
- **libmypaint compilado a WebAssembly.** Licencia ISC (permisiva) y es la base
  histórica de los pinceles de Krita. Ojo: es CPU, trabaja por tiles con
  callbacks, así que hay que puentear memoria WASM y texturas WebGL cada
  fotograma. Se hace por *fidelidad del trazo*, no por velocidad.

## Frente a Procreate

Procreate es el estándar en iPad y conviene saber exactamente dónde se le puede
ganar y dónde no. Perseguirlo función por función es la estrategia equivocada;
las oportunidades están donde su arquitectura no le deja llegar.

### Lo que ya tenemos resuelto y a ellos les cuesta

| Su límite | Nuestra situación |
| --- | --- |
| Tope de capas atado a la RAM (~20 en 4K) | Presupuesto en bytes con expulsión a CPU: ~23 texturas residentes y del orden de 100-200 cels en 1080p. El techo se corrió, no desapareció. |
| Redimensionar el lienzo pixela los trazos | `resizeCanvas` recorta o amplía, nunca reescala: copia 1:1. |
| Animación caótica pasados unos segundos | Cels con sostenido, línea de tiempo y keyframes interpolados en la misma capa. |
| Dreams salió sin lazo ni transformación libre | Ambas desde la Fase 0. |
| Sólo iPad, sólo Apple | iPad, iPhone, Android y escritorio con el mismo código. |
| Pago único, pero pago | Gratis y sin cuentas. |

### Lo que sigue siendo suyo

- **Latencia.** ~9 ms con Metal y ProMotion contra nuestros 30-50 ms. No se
  gana en web; ver la Fase 3.
- **Hover del Apple Pencil.** Safari no lo expone.
- **Madurez del motor de pinceles.** Sus más de 100 ajustes y los pinceles
  duales son años de pulido.

### Oportunidades, por valor entre coste

1. **QuickShape.** `hecho`. Mantener el lápiz al final del trazo y ajustarlo a
   línea, círculo, rectángulo, triángulo o polígono, con edición de nodos y
   segundo dedo para forzar proporción. Precisión ajustable porque la
   calibración inicial (probada con ratón) fallaba con dedo real en pantalla
   táctil — ver commits de recalibración.
2. **Historial persistente.** `hecho`, parcial y a propósito. Su queja número
   uno de flujo es al cerrar el archivo se pierde el deshacer. No todos los
   comandos del historial son igual de baratos de serializar: los que editan
   píxeles (trazo, QuickShape, bote, rellenar/borrar selección, transformar
   por lotes) ya eran un diff de rectángulo — antes/después — así que
   persistirlos es directo (`historyOps.ts`: `RasterEditOp`/
   `RasterEditBatchOp`, reconstruidos contra el documento recién cargado por
   id de capa/cel, no por referencia). Los que tocan estructura (añadir
   capa, keyframes, reordenar...) siguen sin persistir — reescribir cada uno
   como una operación serializable es una superficie de cuarenta sitios
   distintos, desproporcionada frente al caso real: la inmensa mayoría de
   los pasos que un animador acumula dibujando SÍ son ediciones de píxel.
   `serializeProject` guarda la racha más reciente de pasos serializables
   desde la cima de la pila (se corta, no se salta, en el primer paso sin
   persistir) hasta un techo de 24 MB comprimidos; `deserializeProject` +
   `engine.loadHistoryOps` la reconstruyen al abrir. Mismo camino para el
   `.trace` manual y el autoguardado en IndexedDB, porque ambos pasan por
   `serializeProject`/`deserializeProject`.
3. **Time-lapse.** `hecho`. Grabación manual (empezar/detener/descartar):
   mientras está activa, captura una miniatura del compuesto (máx. 480px de
   ancho) cada segundo en el que el documento cambió de verdad, enganchada a
   `onAfterRender` en vez de a un `setInterval` propio — así sólo se intenta
   cuando el lienzo cambió, no a ciegas. Tope de 600 fotogramas
   (`Engine.timelapseFrames`); al llegar diezma a la mitad y dobla el
   intervalo de captura, para que una sesión larga no crezca sin límite. Se
   exporta con `exportImageSequenceAsVideo`, un codificador (WebCodecs con
   reserva en `MediaRecorder`) separado a propósito del de `exportVideo`: la
   fuente de fotogramas es un array de lienzos ya capturados, no algo que se
   pueda expresar como la `FrameSource` de la animación (que renderiza
   cuadro a cuadro bajo demanda).
4. **Capas en disco (OPFS).** `hecho`, parcial y a propósito — resultó ser un
   problema más fino que "cambiar `Uint8Array` por archivos en
   `gl/renderer.ts`", que es como se describía aquí antes.

   `ensureResident` (la subida a GPU) se llama de forma SÍNCRONA en decenas
   de sitios de `engine.ts` — cada trazo, cada deshacer/rehacer, un lote de
   transformación, redimensionar. Leer OPFS es necesariamente asíncrono (no
   hay API síncrona desde el hilo principal, sólo desde un Worker con
   `FileSystemSyncAccessHandle`, que exige cabeceras COOP/COEP en toda la
   app). Un respaldo "en disco" genérico para `Surface` habría dejado
   superficies a medio cargar visibles para deshacer/rehacer: `writeRect`
   (lo que reproduce cada paso del historial) parchea un rectángulo pequeño
   asumiendo que el resto del cel ya es correcto — si `ensureResident`
   devolviera un lienzo en blanco mientras carga de fondo, el parche se
   escribiría sobre ese blanco y el resto del dibujo se perdería de verdad,
   sin forma de detectarlo desde `writeRect` (a diferencia de una
   sobreescritura completa, donde `Surface.version` sí basta para descartar
   una carga de disco que llegó tarde).

   Alcance elegido en su lugar, deliberadamente menor pero seguro de
   verdad: OPFS sólo entra en juego dentro de `serializeProject`
   (`core/io.ts` — cubre tanto ".trace" manual como el autoguardado, que es
   el camino con más probabilidad de disparar el fallo porque corre solo
   cada dos minutos). Cada cel/máscara/variante se suelta de la GPU/RAM
   justo después de codificarse a PNG (`spillAfterEncode`, volcando una
   copia cruda a un archivo de usar-y-tirar) y TODAS se restauran a RAM
   antes de que la función devuelva el control — nunca queda nada a medio
   cargar cuando el resto de la app puede volver a tocar el documento. Esa
   garantía depende de que nada más toque el documento mientras dura: el
   guardado bloquea atajos de teclado (`App.tsx`) y el lienzo
   (`CanvasView.tsx`) mientras `busy` está activo — algo que antes no
   bloqueaba nada (la misma laguna que permitía el bote de relleno
   concurrente, ver más abajo) — y `engine.whenIdle()` espera a que un
   trazo en curso termine antes de activar el candado, en vez de cortarlo a
   la mitad o saltarse el guardado dos minutos enteros.

   Resuelve el fallo más grave y más fácil de disparar (guardar/exportar un
   proyecto grande se queda sin memoria porque la expulsión de GPU no tenía
   techo en RAM) sin arriesgar la integridad de deshacer/rehacer. Lo que NO
   resuelve: el techo de RAM mientras se dibuja en un proyecto grande
   todavía abierto sigue siendo el de siempre — eso necesitaría o (a)
   aislamiento COOP/COEP + un Worker dedicado para lectura realmente
   síncrona desde cualquier punto (deshacer incluido), o (b) repensar cómo
   se ejecutan los comandos del historial para tolerar reproducción
   asíncrona. Cualquiera de las dos es un cambio de infraestructura mayor,
   deliberado y aparte — no algo para colar en el mismo lote. Se revisita
   si medir con un proyecto real (siguiente punto de `CHECKPOINT.md`)
   muestra que el techo en vivo es de verdad un problema, no sólo el de
   guardar.
5. **Presets de lienzo con nombre y tipo de proyecto.** `hecho`. Botón
   "Nuevo proyecto" en el panel Proyecto, con confirmación: tipo
   (Animación/Pintura, sólo decide valores por defecto — cuadros y si la
   línea de tiempo arranca visible, no se guarda en el documento) y tamaño
   con nombre reutilizando los presets que ya existían para redimensionar.
   De paso corrigió una fuga real: "Abrir proyecto" cambiaba de documento
   sin soltar las superficies GPU del anterior.
6. **Paletas de usuario con nombre.** `hecho`. Sección "Mis paletas" en el
   panel Color: crear, renombrar en línea, añadir el color activo, quitar un
   color suelto y borrar la paleta entera (con confirmación, a diferencia de
   quitar un color). Vive en `localStorage`, no en el `.trace`: es preferencia
   de la persona, no del dibujo — por eso sobrevive a abrir otro proyecto.
7. **Taper de extremo + rotación de estampa según dirección del trazo.** `hecho`.
   La rotación ya existía (`followDirection`); lo nuevo es el afinado. El de
   arranque se resuelve en caliente dentro de `StrokeBuilder` porque se sabe
   al instante (distancia recorrida desde el primer punto); el de cierre no
   se puede saber hasta soltar el lápiz, así que `Engine` mantiene una cola
   corta con las últimas estampas del trazo (acotada por la longitud de
   afinado, no por el trazo entero) y las reescala en vivo cada fotograma
   contra la punta actual — mismo mecanismo que ya existía para las estampas
   especulativas de predicción. Slider "Afinado de extremos" por pincel.
8. **Varita mágica (selección por semejanza de color).** `hecho`, fuera del
   repaso del PDF. De la lista de funciones "lápiz mágico" de Procreate (los
   pinceles de ajuste con varita, los pinceles de luminosidad, licuar y la
   selección automática), la única que no tenía ya equivalente directo en
   Trace era la de "Selección automática": tocar un color
   selecciona la región conexa que se le parece, arrastrar el dedo hacia un
   lado u otro reajusta la tolerancia en vivo — igual gesto que Procreate.
   Reutiliza el `floodFill` ya existente (compartido vía `floodMatch` de
   `core/flood.ts`, extraído para no duplicar el barrido de líneas) pero
   escribe en la máscara
   de selección en vez de pintar: la referencia compuesta se lee una sola vez
   al tocar y se cachea, así que reajustar la tolerancia arrastrando sólo
   repite el flood-fill barato en CPU, sin otra lectura de GPU por muestra de
   arrastre. Se integra en el mismo sistema de selección de siempre
   (`rasterizeMask` en `selection.ts`, mismo criterio add/subtract/replace
   que las formas geométricas), así que el resto del motor —transformar,
   levantar, contorno animado— no distingue una selección por forma de una
   por color.

Los tres últimos salieron de un repaso más amplio (no sólo Procreate: también
Artstudio Pro y una app de dibujo vectorial sin identificar con certeza,
probablemente Concepts) — catálogo completo, con lo que se miró y se
descartó, en `REFERENCIAS-UI.md`.

### Lo que no perseguir

- **Los 9 ms.** No se gana en web, y perseguirlo desvía de lo que sí se gana.
- **Pinceles duales.** Bonito, pero nadie cambia de app por eso.
- **Vectores como añadido.** Ver la pregunta abierta más abajo: no es una
  función, es otra arquitectura.

## Descartado, y por qué

Para no volver sobre lo mismo:

| Opción | Por qué no |
| --- | --- |
| Extraer el motor de pinceles de **Krita** | GPL-3.0, y acoplado a `KisPaintDevice`, su sistema de tiles, `KoColorSpace` y Qt. No es una librería, es un órgano. |
| **Synfig** | GPL-2.0, mismo problema de licencia. |
| **OpenToonz** | BSD, pero su código de animación asume su propio modelo de documento. |
| **Skia / CanvasKit** | No da un motor de pinceles, da una API de canvas 2D: seguiríamos escribiendo el estampado y las dinámicas. A cambio, ~7 MB de WASM y una abstracción justo donde queremos control fino. |
| **PixiJS** | Grafo de escena de sprites. Aquí se hacen pases de composición a pantalla completa, no lotes de sprites. |
| **Three.js** | Es 3D. |
| **Rive / ThorVG / Lottie** | Runtimes para *reproducir* animación vectorial ya autorizada, con rigging o sin él. No sirven para dibujar. Rive podría interesar algún día como un tercer modo de animación por marionetas, no para el núcleo. |
| **Swift + Metal nativo** | La menor latencia posible, pero sólo Apple, requiere Mac y Xcode, y cada iteración es lenta. Es la opción si algún día Trace deja de ser multiplataforma. |

## Cosas que hay que decidir

Abiertas, sin respuesta todavía:

- **El nombre.** "Trace" es provisional.
- **Vectores.** Hoy todo es ráster. No es una función que se añade: cambia el
  modelo de documento, el renderizador, las herramientas, el formato de archivo
  y el historial. Meses de trabajo, y es donde Skia sí empezaría a valer la
  pena. Además aporta menos de lo que parece al caso de uso principal: en
  animación cuadro por cuadro el dibujo se rehace en cada fotograma, así que la
  ventaja de escalar sin pérdida pesa en ilustración, no aquí. La pregunta real
  que hay debajo es si Trace quiere ser sobre todo una app de ilustración o de
  animación.
- **Audio.** Sin audio no hay sincronización de labios ni timing sobre música.
  Es un módulo grande.
- **Colaboración.** Choca con "nada sale del dispositivo". Si se hace, con
  cifrado extremo a extremo y opt-in explícito.
