# Trace

Dibujo e ilustración digital y animación 2D cuadro por cuadro. Corre en el
navegador, se instala en la pantalla de inicio del iPad o del móvil, y no manda
nada a ningún servidor: los proyectos viven en tu dispositivo.

## Por qué está hecho así

El objetivo era poder dibujar en iPad y en celular con una interfaz gestual, no
una de escritorio apretujada. Eso descartó portar el motor de pinceles de Krita
(GPL-3.0, y acoplado a `KisPaintDevice`, su sistema de tiles, su gestión de
color y Qt) y llevó a implementar los algoritmos desde cero sobre WebGL2.

La contrapartida honesta: **la latencia web no iguala a la de una app nativa.**
Procreate está en torno a 9 ms; aquí se está en el rango de 30-50 ms percibidos.
Se compensa con las muestras predichas del navegador (`getPredictedEvents`) y
con una capa de tinta húmeda separada, pero la diferencia existe y se nota en
trazos rápidos.

A cambio: un solo código para iPad, Android, iPhone y escritorio, y puedes
probar un cambio abriendo una URL.

## Qué hace

**Dibujo**

- Motor de pinceles en GPU con estampado instanciado y espaciado por longitud
  de arco sobre splines Catmull-Rom.
- Dinámicas de presión, inclinación (achatado y giro de la punta), velocidad,
  dispersión y variación de tamaño.
- Estabilización de trazo con filtro One Euro: suaviza sin añadir el retardo
  fijo de una media móvil.
- Seis pinceles de partida: lápiz, entintado, marcador, aerógrafo, pintura y
  borrador. Todos los parámetros son editables.
- Bote de relleno que respeta las líneas dibujadas en otras capas, con
  crecimiento configurable para que no quede orla blanca.
- Cuentagotas sobre la imagen compuesta.

**Selección y transformación**

- Selección por rectángulo y por lazo, con modos sustituir, sumar y restar.
- Los trazos se recortan a la selección activa.
- Transformación libre: mover, escalar y girar con tiradores. Los píxeles se
  levantan a una capa flotante, así que arrastrar no acumula pérdidas de
  remuestreo.
- Rellenar, borrar, invertir y seleccionar todo.

**Capas**

- Los 13 modos de fusión separables de la especificación de compositing.
- Máscaras de recorte con la semántica correcta de grupo (la capa recortada se
  ajusta a su capa base, no al fondo acumulado).
- Opacidad, visibilidad, bloqueo, reordenar, duplicar y combinar hacia abajo.

**Animación — el modelo híbrido**

Cada capa puede llevar las dos cosas a la vez:

- **Cels**: dibujos cuadro por cuadro con sostenido automático. Un dibujo se
  mantiene en pantalla hasta el siguiente cel, y dibujar sobre un cuadro
  sostenido edita ese dibujo, como en la animación tradicional.
- **Keyframes de transformación**: posición, escala, rotación y opacidad
  interpoladas con easing. Así puedes desplazar o escalar un dibujo hecho a
  mano sin volver a dibujarlo.

Más papel cebolla con hasta 3 cuadros a cada lado y teñido rojo/azul,
reproducción en bucle, y arrastre de cels en la línea de tiempo.

**Gestos (iPad y móvil)**

| Gesto | Acción |
| --- | --- |
| Un dedo o lápiz | Dibujar |
| Dos dedos | Desplazar, zoom y rotar |
| Toque con dos dedos | Deshacer |
| Toque con tres dedos | Rehacer |

Con la herramienta de transformación activa, el gesto de dos dedos mueve la
capa en vez de la vista. El rechazo de palma desactiva el dibujo con dedo
durante 700 ms después de usar el lápiz.

**Guardar y exportar**

- Formato `.trace` (zip con los cels en PNG y la estructura en JSON).
- Autoguardado en IndexedDB cada dos minutos, con recuperación al abrir.
- Exportar el cuadro actual a PNG, la animación a APNG, o la secuencia
  completa a un zip de PNG.

El APNG se ensambla reempaquetando los chunks de los PNG que ya genera el
canvas, así que conserva transparencia y color sin pérdida y sin arrastrar un
codificador de vídeo.

## Atajos de teclado

| Tecla | Acción |
| --- | --- |
| `B` `E` `G` `I` | Pincel, borrador, relleno, cuentagotas |
| `M` `L` `V` `H` | Selección, lazo, transformar capa, mano |
| `Ctrl/Cmd + A` `D` | Seleccionar todo / deseleccionar |
| `Ctrl/Cmd + Shift + I` | Invertir selección |
| `Supr` | Borrar la selección |
| `Enter` `Esc` | Confirmar / cancelar la transformación |
| `Espacio` | Reproducir / pausar |
| `←` `→` | Cuadro anterior / siguiente (con `Shift`, un segundo) |
| `,` `.` | Cel anterior / siguiente de la capa activa |
| `N` | Nuevo cuadro vacío |
| `O` | Papel cebolla |
| `F` | Encajar el lienzo |
| `Tab` | Ocultar la línea de tiempo |
| `Ctrl/Cmd + Z` | Deshacer (con `Shift`, rehacer) |

## Desarrollo

```bash
npm install
npm run dev          # http://localhost:5173
npm run build
```

Para probar en el iPad estando en la misma red:

```bash
npm run dev -- --host
```

y abre la IP que imprime. Safari pide HTTPS para instalar la PWA, pero para
dibujar basta con HTTP.

### Pruebas

Se manejan con un navegador de verdad, porque los fallos que importan en una
app de dibujo son visuales:

```bash
npm run test:smoke        # dibujo, deshacer, sostenido, onion, capas, export
npm run test:selection    # selección, recorte, transformación libre
npm run test:responsive   # maquetación en iPhone e iPad
```

Ambos esperan un servidor de desarrollo en el puerto 5173. Con
`CHROME_PATH=/ruta/al/chrome` se usa un binario concreto en lugar del que
descarga Playwright.

## Arquitectura

```
src/
  core/       motor puro: sin React, sin DOM
    types.ts      tipos compartidos, rectángulos, modos de fusión
    math.ts       matrices 3x3, color, filtro One Euro
    brush.ts      presets y generación de estampas
    document.ts   capas, cels, canales animados, grupos de recorte
    selection.ts  rasterizado de máscaras de selección
    history.ts    pila de deshacer con presupuesto de memoria
    engine.ts     composición, trazos, reproducción, herramientas
    io.ts         .trace, PNG, APNG, IndexedDB
  gl/         la única parte específica de WebGL
    shaders.ts    GLSL ES 3.00
    renderer.ts   superficies, pool de texturas, pases de dibujo
  state/      store de zustand para la interfaz
  ui/         componentes de React
```

`core/` no importa nada de `gl/` salvo el tipo `Surface`, y `gl/` no sabe qué
es una capa. Si en algún momento la latencia obliga a pasar el núcleo a Rust +
wgpu o a meter [libmypaint](https://github.com/mypaint/libmypaint) (licencia
ISC, permisiva) compilado a WebAssembly, el cambio queda contenido en `gl/`.

### Notas de implementación que no son obvias

**Coordenadas.** El espacio documento es Y-hacia-abajo. Las texturas guardan la
fila 0 en `v=0`, lo que sale gratis al renderizar a un FBO; el único volteo del
pipeline ocurre en el pase a pantalla. Todo el color viaja premultiplicado.

**Caché de composición.** Mientras dibujas, todo lo que está por debajo de la
capa activa no cambia, así que se compone una vez y se guarda. Por fotograma
sólo se recomponen la capa activa y las de encima.

**Presupuesto de texturas.** Las superficies se cuentan en bytes, no en número:
40 texturas son 13 MB en un lienzo de 512² y 670 MB en uno de 4K. Las que no
caben se bajan a memoria de CPU y se vuelven a subir cuando hacen falta.

**Deshacer.** Cada trazo guarda sólo el rectángulo que ensució, antes y
después. La pila se recorta por número de pasos y por memoria total.

**Miniaturas.** Se reducen en GPU por halvings sucesivos y se cachean por
versión de contenido. El camino ingenuo costaba 146 ms por capa y por trazo.

## Estado y siguientes pasos

El estado detallado está en `CHECKPOINT.md` y la dirección del proyecto en
`RUMBO.md`. En corto, lo siguiente es:

- Importar imágenes y vídeo como referencia para rotoscopia.
- Exportar a MP4/WebM.
- Texturas de punta de pincel (el shader ya las soporta, falta la interfaz).
- Empaquetado con Capacitor para instalación nativa y acceso a archivos.
