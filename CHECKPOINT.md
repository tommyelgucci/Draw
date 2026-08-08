# Checkpoint

Estado real del proyecto. Se actualiza al cerrar cada tanda de trabajo.

**Fecha:** 8 de agosto de 2026
**Rama:** `claude/trace-drawing-animation-app-ov7j6d`
**Fase:** 0 cerrada, 1 empezando (ver `RUMBO.md`)

## Verificación de este checkpoint

Todo lo de abajo está comprobado en un Chromium real, no sólo compilado.

```
npm run test:smoke        TODO EN VERDE   (17 comprobaciones)
npm run test:selection    TODO EN VERDE   (14 comprobaciones)
npm run test:responsive   iPhone y iPad sin desbordes ni controles fuera de pantalla
npx oxlint                sin warnings
npm run build             310 kB / 98 kB gzip
```

## Funciona

### Dibujo
- Estampado instanciado en GPU con espaciado por longitud de arco sobre
  splines Catmull-Rom.
- Dinámicas de presión, inclinación (achatado y giro de punta), velocidad,
  dispersión y variación de tamaño.
- Estabilización con filtro One Euro; muestras predichas del navegador para
  recortar latencia.
- Seis pinceles editables: lápiz, entintado, marcador, aerógrafo, pintura,
  borrador.
- Bote de relleno que respeta líneas de otras capas, con crecimiento
  configurable contra la orla del antialias.
- Cuentagotas sobre la imagen compuesta.

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

## Lo siguiente

Por orden, según `RUMBO.md` (Fase 1):

1. **Importar imágenes y vídeo como referencia.** Es el hueco más grande para
   trabajo serio: sin esto no hay rotoscopia.
2. **Exportar a MP4/WebM.** El APNG sirve para compartir, no para editar
   después en otro programa.
3. **Texturas de punta de pincel.** El shader ya tiene el sampler y el
   uniforme `uUseTexture`; falta generar o cargar las texturas y exponerlo en
   el panel de pincel.
4. **Perfilar un proyecto real** —muchas capas, cientos de cels— y medir la
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
