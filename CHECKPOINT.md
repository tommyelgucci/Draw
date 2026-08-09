# Checkpoint

Estado real del proyecto. Se actualiza al cerrar cada tanda de trabajo.

**Fecha:** 9 de agosto de 2026
**Rama:** `claude/trace-app-development-2o45w2`
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
npx oxlint                sin warnings
npm run build             323 kB / 101 kB gzip
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
- Texturas de punta: cuatro máscaras integradas (grano, tiza, lienzo,
  salpicadura) además de la punta lisa de siempre, seleccionables por pincel.
  El generador de píxeles (`core/brushTexture.ts`) es puro cálculo sin DOM:
  el mismo buffer sube como textura a la GPU y pinta la miniatura del
  selector en la interfaz, sin duplicar el algoritmo en dos sitios.
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
- Papel cebolla hasta 3 cuadros por lado, teñido rojo/azul, con caída.
- Reproducción en bucle y arrastre de cels en la línea de tiempo.

### Selección
- Rectángulo y lazo, con modos sustituir / sumar / restar.
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

### Guardar y exportar
- Formato `.trace` (zip con cels en PNG y estructura en JSON); ida y vuelta
  comprobada.
- Autoguardado en IndexedDB cada dos minutos con recuperación al abrir.
- Exportar: PNG del cuadro actual, APNG animado (con chunk `acTL` verificado),
  secuencia de PNG en zip.

### Interfaz
- Gestos de Procreate: dos dedos navegan, toque de dos o tres dedos deshace o
  rehace, rechazo de palma tras usar el lápiz.
- Maquetación en rejilla para móvil: lienzo, botonera y línea de tiempo
  apilados en flujo real, sin posiciones absolutas adivinadas.
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

## Lo siguiente

Por orden, según `RUMBO.md` (Fase 1):

1. **Exportar a MP4/WebM.** El APNG sirve para compartir, no para editar
   después en otro programa.
2. **Perfilar un proyecto real** —muchas capas, cientos de cels— y medir la
   memoria en un iPad físico, no en el emulador.

## Deuda conocida

- **La miniatura de una línea fina es casi invisible.** Es inherente a
  reducir 1920 px a 48; Procreate tiene el mismo problema. Se arreglaría
  recortando a los límites del dibujo en vez de al documento entero.
- **No hay tests unitarios del núcleo**, sólo de integración en navegador. Las
  matemáticas de `math.ts` y la interpolación de `document.ts` se prestan a
  ello y hoy sólo se cubren de rebote.
- **El rendimiento sólo está medido con SwiftShader**, que es correcto pero
  lento. Los números absolutos de un iPad están sin tomar.
- **`floodFill` bloquea el hilo** mientras rellena. En un lienzo grande se
  nota; hay un indicador de ocupado, pero lo correcto sería un worker.
- **`selection.ts` rasteriza con canvas 2D**, lo que obliga a un
  `getImageData` del documento entero para calcular los límites al soltar.
  Aceptable porque ocurre una vez por gesto, pero es el punto más caro del
  flujo de selección.
- **Importar un vídeo largo es lento y sin cancelar.** Cada fotograma se
  extrae con un `seek` + subida a GPU secuenciales; un clip de varios minutos
  tarda en proporción y hoy no hay botón para abortar a medio camino, sólo el
  progreso. Si el evento `seeked` no llega (pasa en algún navegador para un
  fotograma suelto), hay un plazo de 2 s que lo salta duplicando el anterior
  en vez de colgar la importación entera.
- **Las texturas de punta se ven mal en pinceles muy pequeños.** El patrón de
  128×128 se muestrea en todo el UV de la estampa sin importar cuántos
  píxeles ocupe en pantalla: por debajo de ~12 px el resultado es una línea
  casi invisible en vez de grano. Los pinceles del kit que llevan textura
  (lápiz blando, grafito, carboncillo, pintura, acuarela, acrílico, aerógrafo
  salpicado, pastel, textura de lienzo) están todos por encima de ese
  tamaño; se arreglaría de raíz atenuando la textura por debajo de cierto
  diámetro de estampa.
