/**
 * Fuentes GLSL ES 3.00.
 *
 * Convención de coordenadas en todo el motor:
 *   - El espacio documento es Y-hacia-abajo, origen arriba-izquierda.
 *   - Las texturas guardan la fila 0 en v=0, o sea v=0 es el borde SUPERIOR.
 *     Renderizando a un FBO eso sale gratis (clip.y = y/H*2-1), así que el
 *     único volteo del pipeline ocurre en el pase a pantalla.
 *   - Todo el color viaje premultiplicado por alfa.
 */

/** Estampas de pincel, dibujadas con `drawArraysInstanced`. */
export const STAMP_VS = /* glsl */ `#version 300 es
precision highp float;

// Las localizaciones van fijadas aquí: dejárselas al enlazador obliga a
// consultarlas en tiempo de ejecución y a mantener el VAO en sincronía.
layout(location = 0) in vec2 aCorner;    // esquina del quad unidad, 0..1
layout(location = 1) in vec2 iPos;       // centro de la estampa, px de documento
layout(location = 2) in float iSize;     // diámetro mayor, px
layout(location = 3) in float iAngle;    // radianes
layout(location = 4) in float iAlpha;    // 0..1
layout(location = 5) in float iHardness; // 0..1
layout(location = 6) in float iAspect;   // 0..1, achatamiento del eje menor

uniform vec2 uResolution;

out vec2 vLocal;      // -1..1 dentro de la estampa, ya circularizado
out float vAlpha;
out float vHardness;

void main() {
  vec2 unit = aCorner * 2.0 - 1.0;
  float r = iSize * 0.5;
  vec2 scaled = vec2(unit.x * r, unit.y * r * iAspect);

  float c = cos(iAngle);
  float s = sin(iAngle);
  vec2 rotated = vec2(scaled.x * c - scaled.y * s, scaled.x * s + scaled.y * c);

  vec2 pos = iPos + rotated;
  gl_Position = vec4((pos / uResolution) * 2.0 - 1.0, 0.0, 1.0);

  // El fragment shader mide distancia en el espacio circular, no en el
  // achatado, para que un pincel elíptico no tenga falloff deformado.
  vLocal = unit;
  vAlpha = iAlpha;
  vHardness = iHardness;
}
`;

export const STAMP_FS = /* glsl */ `#version 300 es
precision highp float;

in vec2 vLocal;
in float vAlpha;
in float vHardness;

uniform vec3 uColor;      // sRGB directo, 0..1
uniform float uUseTexture;
uniform sampler2D uTexture;

out vec4 fragColor;

void main() {
  float d = length(vLocal);
  if (d > 1.0) discard;

  // Con hardness=1 dejamos ~1.5px de antialias en el borde; con 0 el
  // degradado ocupa todo el radio.
  float inner = vHardness * 0.98;
  float coverage = 1.0 - smoothstep(inner, 1.0, d);

  if (uUseTexture > 0.5) {
    coverage *= texture(uTexture, vLocal * 0.5 + 0.5).a;
  }

  float a = coverage * vAlpha;
  fragColor = vec4(uColor * a, a);   // premultiplicado
}
`;

/** Quad texturizado genérico: composición de capas, onion skin y pase a pantalla. */
export const QUAD_VS = /* glsl */ `#version 300 es
precision highp float;

layout(location = 0) in vec2 aCorner;  // 0..1

uniform mat3 uMatrix;     // corner -> píxeles del destino
uniform vec2 uResolution; // tamaño del destino en píxeles
uniform float uFlipY;     // 1.0 al dibujar en la pantalla, 0.0 en un FBO

out vec2 vUV;

void main() {
  vec3 p = uMatrix * vec3(aCorner, 1.0);
  vec2 ndc = (p.xy / uResolution) * 2.0 - 1.0;
  if (uFlipY > 0.5) ndc.y = -ndc.y;
  gl_Position = vec4(ndc, 0.0, 1.0);
  vUV = aCorner;
}
`;

/**
 * Composición capa-sobre-fondo con los modos de fusión separables de la
 * especificación de compositing de la W3C.
 *
 * El backdrop se pasa como textura en vez de usar `gl.blendFunc` porque los
 * modos no-normales necesitan leer el destino, y WebGL2 no expone
 * framebuffer fetch.
 */
export const COMPOSITE_FS = /* glsl */ `#version 300 es
precision highp float;

in vec2 vUV;

uniform sampler2D uSource;    // premultiplicado
uniform sampler2D uBackdrop;  // premultiplicado
uniform float uOpacity;
uniform int uBlend;
uniform float uClip;          // 1.0 = recortar a la alfa del backdrop
uniform vec4 uTint;           // rgb + fuerza; se usa para el onion skin

out vec4 fragColor;

vec3 unpremul(vec4 c) { return c.a > 0.0 ? c.rgb / c.a : vec3(0.0); }

float blendChannel(int mode, float cb, float cs) {
  if (mode == 1) return cb * cs;                                   // multiply
  if (mode == 2) return cb + cs - cb * cs;                         // screen
  if (mode == 3) return cb <= 0.5 ? 2.0 * cb * cs                  // overlay
                                  : 1.0 - 2.0 * (1.0 - cb) * (1.0 - cs);
  if (mode == 4) return min(cb, cs);                               // darken
  if (mode == 5) return max(cb, cs);                               // lighten
  if (mode == 6) return cs >= 1.0 ? 1.0 : min(1.0, cb / (1.0 - cs));   // dodge
  if (mode == 7) return cs <= 0.0 ? 0.0 : 1.0 - min(1.0, (1.0 - cb) / cs); // burn
  if (mode == 8) return cs <= 0.5 ? 2.0 * cs * cb                  // hard-light
                                  : 1.0 - 2.0 * (1.0 - cs) * (1.0 - cb);
  if (mode == 9) {                                                 // soft-light
    float d = cb <= 0.25 ? ((16.0 * cb - 12.0) * cb + 4.0) * cb : sqrt(cb);
    return cs <= 0.5 ? cb - (1.0 - 2.0 * cs) * cb * (1.0 - cb)
                     : cb + (2.0 * cs - 1.0) * (d - cb);
  }
  if (mode == 10) return abs(cb - cs);                             // difference
  if (mode == 11) return cb + cs - 2.0 * cb * cs;                  // exclusion
  if (mode == 12) return min(1.0, cb + cs);                        // add
  return cs;                                                       // normal
}

void main() {
  vec4 src = texture(uSource, vUV);
  vec4 bd = texture(uBackdrop, vUV);

  float as = src.a * uOpacity;
  if (uClip > 0.5) as *= bd.a;

  vec3 cs = unpremul(src);
  vec3 cb = unpremul(bd);

  cs = mix(cs, uTint.rgb, uTint.a);

  vec3 blended = vec3(
    blendChannel(uBlend, cb.r, cs.r),
    blendChannel(uBlend, cb.g, cs.g),
    blendChannel(uBlend, cb.b, cs.b)
  );

  // Fórmula estándar: el resultado del blend sólo aparece donde hay backdrop.
  vec3 co = as * (1.0 - bd.a) * cs + as * bd.a * blended + (1.0 - as) * bd.a * cb;
  float ao = as + bd.a * (1.0 - as);

  fragColor = vec4(co, ao);
}
`;

/**
 * Cota de huesos por esqueleto que puede subir un solo `uniform mat3[]` sin
 * pasar a texturas — de sobra para un rig de personaje 2D. Si algún rig la
 * excede, la alternativa es un UBO o una textura de matrices; no merece la
 * pena antes de tener un caso real (ver plan de diseño del módulo de rig).
 */
export const MAX_SKIN_BONES = 64;

/**
 * Deformación de malla por huesos (GPU skinning). Cada vértice mezcla hasta
 * 4 matrices de piel según `aBoneWeights` — la misma matriz "pose *
 * inverso(reposo)" que ya usa el transform rígido del hueso individual
 * (`boneRigidMatrix`), sólo que aquí hay una por vértice en vez de una para
 * la capa entera. El fragment shader es `COPY_FS`: sólo cambia de dónde
 * sale la posición, no cómo se colorea.
 */
export const SKIN_VS = /* glsl */ `#version 300 es
precision highp float;

layout(location = 0) in vec2 aRestPos;     // px de documento, posición de reposo
layout(location = 1) in vec2 aUV;          // 0..1 dentro del cel de origen
layout(location = 2) in vec4 aBoneIndices; // hasta 4 huesos, índices en Skeleton.bones
layout(location = 3) in vec4 aBoneWeights; // deberían sumar 1

uniform mat3 uBoneMatrices[${MAX_SKIN_BONES}];
uniform vec2 uResolution;
uniform float uFlipY;

out vec2 vUV;

void main() {
  vec2 skinned = vec2(0.0);
  for (int i = 0; i < 4; i++) {
    mat3 m = uBoneMatrices[int(aBoneIndices[i])];
    vec3 p = m * vec3(aRestPos, 1.0);
    skinned += p.xy * aBoneWeights[i];
  }
  vec2 ndc = (skinned / uResolution) * 2.0 - 1.0;
  if (uFlipY > 0.5) ndc.y = -ndc.y;
  gl_Position = vec4(ndc, 0.0, 1.0);
  vUV = aUV;
}
`;

/**
 * Copia directa premultiplicada, con opacidad y máscara opcionales.
 *
 * La máscara es lo que hace que un trazo respete la selección: como todo va
 * premultiplicado, recortar es multiplicar el color y el alfa por la
 * cobertura, sin ningún caso especial.
 */
export const COPY_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uSource;
uniform sampler2D uMask;
uniform float uOpacity;
uniform float uUseMask;
out vec4 fragColor;
void main() {
  vec4 c = texture(uSource, vUV) * uOpacity;
  if (uUseMask > 0.5) c *= texture(uMask, vUV).a;
  fragColor = c;
}
`;

/**
 * Capa de ajuste: tono/saturación/brillo/contraste sobre TODO lo compuesto
 * hasta aquí (no sobre un cel propio — una capa de ajuste no tiene
 * dibujo). Hay que despremultiplicar antes de tocar el color: HSV sobre
 * canales premultiplicados por un alfa parcial no tiene sentido (el color
 * ya viene atenuado hacia negro). Se puebre-multiplica otra vez al final
 * para mantener la invariante del resto del pipeline.
 */
export const ADJUST_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uSource;
uniform float uHue;        // radianes
uniform float uSaturation; // -1..1, 0 = sin cambio
uniform float uBrightness; // -1..1
uniform float uContrast;   // -1..1
out vec4 fragColor;

vec3 rgb2hsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  float e = 1.0e-10;
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}

vec3 hsv2rgb(vec3 c) {
  vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}

void main() {
  vec4 src = texture(uSource, vUV);
  if (src.a < 1.0e-5) { fragColor = src; return; }
  vec3 straight = src.rgb / src.a;

  vec3 hsv = rgb2hsv(straight);
  hsv.x = fract(hsv.x + uHue / 6.28318530718);
  hsv.y = clamp(hsv.y * (1.0 + uSaturation), 0.0, 1.0);
  vec3 rgb = hsv2rgb(hsv);

  rgb = clamp(rgb + uBrightness, 0.0, 1.0);
  rgb = clamp((rgb - 0.5) * (1.0 + uContrast) + 0.5, 0.0, 1.0);

  fragColor = vec4(rgb * src.a, src.a);
}
`;

/**
 * Contorno animado de la selección ("hormigas marchando").
 *
 * El borde se detecta comparando la máscara con sus vecinos a una distancia
 * de un píxel *de pantalla*, no de documento: así el contorno mantiene su
 * grosor con cualquier zoom. El patrón discontinuo usa gl_FragCoord para que
 * las rayas no se deformen al rotar el lienzo.
 */
export const ANTS_FS = /* glsl */ `#version 300 es
precision highp float;

in vec2 vUV;

uniform sampler2D uMask;
uniform vec2 uEdgeStep;   // un píxel de pantalla, expresado en UV
uniform float uTime;

out vec4 fragColor;

void main() {
  float c = texture(uMask, vUV).a;
  float l = texture(uMask, vUV - vec2(uEdgeStep.x, 0.0)).a;
  float r = texture(uMask, vUV + vec2(uEdgeStep.x, 0.0)).a;
  float u = texture(uMask, vUV - vec2(0.0, uEdgeStep.y)).a;
  float d = texture(uMask, vUV + vec2(0.0, uEdgeStep.y)).a;

  float edge = max(max(abs(c - l), abs(c - r)), max(abs(c - u), abs(c - d)));
  if (edge < 0.25) discard;

  float dash = mod((gl_FragCoord.x + gl_FragCoord.y) * 0.16 - uTime * 3.0, 2.0);
  vec3 color = dash < 1.0 ? vec3(1.0) : vec3(0.05);
  fragColor = vec4(color, 1.0);
}
`;

/** Pase final: tablero de transparencia + documento, con la vista aplicada. */
export const PRESENT_FS = /* glsl */ `#version 300 es
precision highp float;

in vec2 vUV;

uniform sampler2D uSource;
uniform vec2 uDocSize;
uniform float uCheckerScale;  // tamaño de casilla en píxeles de documento
uniform vec3 uPaper;          // color de papel bajo el documento
uniform float uPaperAlpha;    // 0 = mostrar tablero, 1 = papel opaco

out vec4 fragColor;

void main() {
  vec4 src = texture(uSource, vUV);

  vec2 cell = floor(vUV * uDocSize / uCheckerScale);
  float checker = mod(cell.x + cell.y, 2.0) < 0.5 ? 0.22 : 0.28;
  vec3 under = mix(vec3(checker), uPaper, uPaperAlpha);

  vec3 outColor = src.rgb + under * (1.0 - src.a);
  fragColor = vec4(outColor, 1.0);
}
`;
