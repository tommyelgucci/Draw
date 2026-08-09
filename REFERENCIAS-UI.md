# Referencias de UI de otras apps

Catálogo de un PDF de 54 capturas de pantalla (subido por el dueño del
repo) de patrones de interfaz de otras apps de dibujo, revisado para sacar
ideas de backlog. No es una fuente que se vaya a volver a consultar tal
cual — lo que valía la pena ya está movido a `RUMBO.md` → "Frente a
Procreate" → "Oportunidades, por valor entre coste". Esto queda como
archivo de las notas completas, incluido lo que se miró y se descartó.

## Resumen

El PDF mezcla capturas de tres apps distintas, sin orden temático fijo:
**Procreate** (UI en inglés y en alemán — probablemente dos móviles con
idioma distinto), **Artstudio Pro** (capturas tomadas directamente de su
ficha en el App Store, en alemán, incluyendo un anuncio de un pack de
paletas de terceros llamado "Artist Brushes") y una tercera app de dibujo
vectorial de trazo libre sin logo visible, identificable por su categoría
de pincel "Rapidógrafo" y por tener lienzo infinito con guías de
perspectiva y trazo predictivo — todo apunta a **Concepts (TopHatch)**,
aunque no hay ninguna captura con el nombre de marca a la vista, así que
queda como identificación probable, no confirmada. La mayoría del
contenido es el panel de pinceles y el estudio de pincel de las tres apps;
hay bastante menos sobre lienzo, capas/animación o exportación.

## 1. Librerías de pinceles

- **Panel de biblioteca con categorías colapsables + importar/nuevo set**
  (Procreate inglés y alemán, con "+" y nube de descarga). Trace no tiene
  panel de biblioteca organizada por categorías con importación — carencia
  real, hoy es una lista plana.
- **Categorías granulares en la app vectorial:** Básico, Heredado,
  Conceptos básicos de textura, Pintura sintética, Tradicional, Bellas
  artes, Medio tono, Textura, Forma, Salpicado, Brillo, Difuminado,
  Diseñador, Artista, Pastel, Incoloro. Sobre-ingeniería para Trace: 16
  categorías para lo que Trace resuelve con un selector de textura.
- **Artstudio Pro:** categorías por herramienta física (Pencils,
  Lettering, Charcoals, Erasers, Inking, Ink Rakes, Airbrushes, Painting).
  "Ink Rakes" no aporta a Trace.
- **Pinceles "generadores de color"** (opacidad con presión fuerte/ligera
  100%/5%): idea nicho, ya cubierta por presión→opacidad genérico de
  Trace.

## 2. Estudio de pincel / parámetros

- **Procreate alemán, "Pfadkontur":** Abstand (Spacing), StreamLine,
  Jitter, **Abnahme (Taper)**. Trace ya cubre los tres primeros; falta
  Taper — parámetro barato, buen payoff.
- **App vectorial, pestañas Presión/Sello/Punta/Aleatoriedad:** pares de
  valores fuerte/ligera para tamaño y flujo; **Sello** con Espaciado,
  Redondez, Rotación y **Dinámica de rotación** (Desactivado / Rotar
  conforme al trazo / Controlado por inclinación) — encaja bien con las
  estampas instanciadas de Trace, falta hoy; **Punta** con Dureza/Forma
  editable a mano/Omitir bordes/Textura — el editor de forma custom es más
  ambicioso de lo que Trace necesita ahora; **Aleatoriedad** separada por
  canal (tamaño/flujo/rotación) — bajo impacto salvo demanda concreta.
- **Brush editor con Forma/Textura + Invertir + Escala**: añadir
  "invertir" y "escala" sobre la textura de punta actual de Trace es
  barato.
- **"Tipos de pinceles" como metadato de familia aparte de la categoría de
  biblioteca**: capa de metadatos que Trace no necesita.

## 3. Paletas y gestión de color

- **Procreate: paletas con nombre creadas por el usuario** (ej. "Flower
  Fairy", "Forest Fairy"), con "+" para crear y añadir color, pestañas
  Palettes/Colors/Lines. Confirma el hueco ya anotado en Trace — buena
  relación esfuerzo/valor.
- **Artstudio Pro: Curves por canal (Master/R/G/B/Alpha)** sobre
  imagen/foto — es edición de imagen importada, no gestión de paleta para
  pintar; fuera de alcance, no lo propondría.
- **"Color palettes for Procreate"**: no es función de app de dibujo, es
  el anuncio de otra app (marketplace de paletas de pago). Señal de
  mercado, no patrón de UI.

## 4. Tamaño y tipo de lienzo al crear documento

- **Pestañas Painting / Animation / Tracing** antes de elegir tamaño —
  confirma tal cual el hueco ya anotado en Trace.
- **Presets con nombre y resolución/ppi:** 9x16, Basic size, Double size,
  Square, A4, Comic, Pixel Art 50x50, 4K. Varios (A4, Comic) apuntan a
  impresión, fuera de la promesa actual de Trace; los relevantes serían
  Square/4K/verticales de story y quizá uno de animación (loop cuadrado).
- **"Set mark"**: aparece cortado en el PDF, sin detalle suficiente para
  contarlo como hallazgo.

## 5. Capas y línea de tiempo de animación

- **Procreate Animation Assist**: capa = fotograma con pestaña "Frames" y
  tira de miniaturas numeradas debajo del lienzo. Forma de visualizar
  distinta al modelo de cels dispersos de Trace, pero no aporta nada nuevo
  a nivel de dato.
- **"Imágenes secuenciales"** en la app vectorial: sólo entrada de menú,
  sin captura de su interior — no hay suficiente detalle para sacar algo
  accionable.

## 6. Selección / transformación

- **Procreate Transform en 4 modos:** Freeform, Uniform, **Distort**,
  **Warp**. Trace ya tiene libre con tiradores; le faltan Distort (barato,
  4 esquinas libres) y Warp (caro, rejilla deformable). Si se persigue
  algo, Distort primero.
- Nada nuevo sobre Liquify/ColorDrop en este PDF (ya investigados aparte,
  ver la conversación que dio pie a este catálogo).

## 7. Exportación

- Apenas material: sólo una entrada de menú "Compartir/Exportar" sin
  desplegar. No hay patrones nuevos que sacar.

## 8. Otras cosas

- **Guías de perspectiva 2/3 puntos, rejilla restringida/infinita,
  densidad/opacidad, snap a puntos de fuga** — herramienta de dibujo
  técnico, feature grande para un caso de uso lateral en Trace; no la
  pondría en el radar salvo demanda explícita.
- **Simetría, Estilos de dibujo, Regular trazo, Traza predictiva**: sólo
  entradas de menú sin desplegar; posible solape con el StreamLine que
  Trace ya tiene, sin evidencia suficiente para justificar algo nuevo.
- **Menú con "Preferencias"/"Pásate a Prémium"**: patrón de monetización,
  irrelevante para el catálogo funcional.

## Si tuviera que elegir 3

1. **Presets de lienzo con nombre + tipo de proyecto (Pintura/Animación/
   Tracing) al crear documento** — menor esfuerzo, hueco ya identificado y
   confirmado por dos apps.
2. **Paletas de usuario con nombre** — estructura de datos trivial, UI de
   color ya casi resuelta en Trace, sólo falta la capa "mis paletas"
   editable.
3. **Taper de extremo + rotación de estampa según dirección del trazo** en
   el estudio de pincel — encajan en el modelo de estampas instanciadas
   existente sin arquitectura nueva; mejora con más impacto visual por el
   esfuerzo más bajo de toda la lista.
