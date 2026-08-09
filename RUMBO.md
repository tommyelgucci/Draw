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
ni se vuelva lento. Lo que falta:

- Exportar a MP4/WebM. El APNG sirve para compartir, no para editar después.
- Perfilar con muchas capas y cientos de cels; medir el consumo de memoria en
  un iPad de verdad, no en un emulador.

Ya resuelto en esta fase (ver `CHECKPOINT.md`): importar imágenes y vídeo
como referencia para rotoscopia; texturas de punta de pincel; kit completo
de 18 pinceles categorizados y paleta de colores en cuatro grupos.

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
- **Vectores.** Hoy todo es ráster. Meter trazos vectoriales editables cambia
  el modelo de documento y es donde Skia sí empezaría a valer la pena.
- **Audio.** Sin audio no hay sincronización de labios ni timing sobre música.
  Es un módulo grande.
- **Colaboración.** Choca con "nada sale del dispositivo". Si se hace, con
  cifrado extremo a extremo y opt-in explícito.
