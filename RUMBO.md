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

1. **QuickShape.** Mantener el lápiz al final del trazo y ajustarlo a línea,
   círculo, rectángulo o polígono. Es de lo más querido de Procreate y se monta
   encima del `StrokeBuilder` que ya existe. La mejor relación deleite/esfuerzo.
2. **Historial persistente.** Su queja número uno de flujo: al cerrar el
   archivo se pierde el deshacer. Para nosotros es barato porque los pasos ya
   son instantáneas por rectángulo; falta serializarlas en el `.trace`. No lo
   hace nadie.
3. **Time-lapse.** La codificación con WebCodecs ya está; falta capturar un
   fotograma por trazo en un búfer circular.
4. **Capas en disco (OPFS).** Cambiar el respaldo de `Uint8Array` a archivos
   quita el techo de RAM del todo. La maquinaria de expulsión ya existe, así
   que el cambio queda contenido en `gl/renderer.ts`.

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
