import {
  ADJUST_FS,
  ANTS_FS,
  COMPOSITE_FS,
  COPY_FS,
  MAX_SKIN_BONES,
  MIX_FS,
  PRESENT_FS,
  QUAD_VS,
  SKIN_VS,
  STAMP_FS,
  STAMP_VS,
} from './shaders';
import { extractRect } from '../core/flood';
import { mat3Identity, type Mat3 } from '../core/math';
import type { Mesh } from '../core/rig';
import type { RGB, Rect, Stamp } from '../core/types';

/**
 * Una superficie es una textura RGBA8 premultiplicada del tamaño del documento,
 * con su FBO. Puede vivir en GPU o estar respaldada en CPU: el pool expulsa las
 * menos usadas para que un proyecto con cientos de cels no agote la memoria de
 * un iPad.
 */
export class Surface {
  tex: WebGLTexture | null = null;
  fbo: WebGLFramebuffer | null = null;
  /** Copia en CPU cuando la textura fue expulsada. `null` si está residente o vacía. */
  backing: Uint8Array | null = null;
  /** true mientras no se haya dibujado nada: evita reservar textura. */
  empty = true;
  /** Las superficies de trabajo del renderizador nunca se expulsan. */
  pinned = false;
  lastUse = 0;
  /**
   * Se incrementa en cada escritura. Quien cachee algo derivado de esta
   * superficie (miniaturas, por ejemplo) compara este número en vez de
   * recalcular a ciegas.
   */
  version = 0;
  readonly label: string;

  constructor(label: string) {
    this.label = label;
  }
}

interface ProgramInfo {
  program: WebGLProgram;
  uniforms: Record<string, WebGLUniformLocation | null>;
}

export interface CompositeOptions {
  opacity: number;
  blend: number;
  clip?: boolean;
  /** rgb + fuerza de tinte, para el onion skin. */
  tint?: [number, number, number, number];
}

/**
 * Presupuesto de texturas en GPU. Se cuenta en bytes, no en número de
 * superficies: 40 texturas son 13 MB en un lienzo de 512² y 670 MB en uno de
 * 4K, y lo segundo tumba un iPad.
 */
const TEXTURE_BUDGET_BYTES = 192 * 1024 * 1024;
const MIN_RESIDENT = 8;
const MAX_RESIDENT = 64;

export class Renderer {
  readonly canvas: HTMLCanvasElement;
  readonly gl: WebGL2RenderingContext;
  docWidth = 0;
  docHeight = 0;

  private programs = new Map<string, ProgramInfo>();
  private quadVAO!: WebGLVertexArrayObject;
  private stampVAO!: WebGLVertexArrayObject;
  private stampBuffer!: WebGLBuffer;
  private stampData = new Float32Array(0);

  private scratches = new Map<string, Surface>();
  private smallTargets = new Map<string, { tex: WebGLTexture; fbo: WebGLFramebuffer }>();
  /** VAO/VBO/IBO por malla deformable, indexados por `Mesh.id`. Presupuesto
   *  aparte de `TEXTURE_BUDGET_BYTES`: una rejilla de unos pocos cientos de
   *  vértices pesa kilobytes, no megabytes, frente a una superficie del
   *  tamaño del documento — ver plan de diseño del módulo de rig. */
  private meshGPU = new Map<string, { vao: WebGLVertexArrayObject; vbo: WebGLBuffer; ibo: WebGLBuffer; indexCount: number }>();
  /** Máscaras de punta de pincel, generadas o subidas una vez y cacheadas
   * por id (integrada o `CustomTexture.id`): no dependen del tamaño del
   * documento, así que sobreviven a `setDocumentSize`. */
  private brushTextures = new Map<string, WebGLTexture>();
  private resident = new Set<Surface>();
  private clock = 0;
  private maxResident = MAX_RESIDENT;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: true,
      preserveDrawingBuffer: false,
      // Reduce la latencia en navegadores que lo soportan saltándose un
      // paso de sincronización con el compositor.
      desynchronized: true,
      powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('WebGL2 no está disponible en este navegador.');
    this.gl = gl;

    this.buildPrograms();
    this.buildGeometry();
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.DITHER);
  }

  /* ---------------------------------------------------------------- *
   * Programas y geometría
   * ---------------------------------------------------------------- */

  private compile(type: number, src: string): WebGLShader {
    const gl = this.gl;
    const sh = gl.createShader(type)!;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh);
      gl.deleteShader(sh);
      throw new Error(`Error compilando shader: ${log}`);
    }
    return sh;
  }

  private link(name: string, vs: string, fs: string, uniforms: string[]) {
    const gl = this.gl;
    const program = gl.createProgram()!;
    const v = this.compile(gl.VERTEX_SHADER, vs);
    const f = this.compile(gl.FRAGMENT_SHADER, fs);
    gl.attachShader(program, v);
    gl.attachShader(program, f);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`Error enlazando ${name}: ${gl.getProgramInfoLog(program)}`);
    }
    gl.deleteShader(v);
    gl.deleteShader(f);
    const locs: Record<string, WebGLUniformLocation | null> = {};
    for (const u of uniforms) locs[u] = gl.getUniformLocation(program, u);
    this.programs.set(name, { program, uniforms: locs });
  }

  private buildPrograms() {
    this.link('stamp', STAMP_VS, STAMP_FS, [
      'uResolution',
      'uColor',
      'uUseTexture',
      'uTexture',
    ]);
    this.link('composite', QUAD_VS, COMPOSITE_FS, [
      'uMatrix',
      'uResolution',
      'uFlipY',
      'uSource',
      'uBackdrop',
      'uOpacity',
      'uBlend',
      'uClip',
      'uTint',
    ]);
    this.link('copy', QUAD_VS, COPY_FS, [
      'uMatrix',
      'uResolution',
      'uFlipY',
      'uSource',
      'uMask',
      'uOpacity',
      'uUseMask',
    ]);
    this.link('mix', QUAD_VS, MIX_FS, [
      'uMatrix',
      'uResolution',
      'uFlipY',
      'uSource',
      'uBackdrop',
      'uOpacity',
      'uPigmentMix',
    ]);
    this.link('ants', QUAD_VS, ANTS_FS, [
      'uMatrix',
      'uResolution',
      'uFlipY',
      'uMask',
      'uEdgeStep',
      'uTime',
    ]);
    this.link('present', QUAD_VS, PRESENT_FS, [
      'uMatrix',
      'uResolution',
      'uFlipY',
      'uSource',
      'uDocSize',
      'uCheckerScale',
      'uPaper',
      'uPaperAlpha',
    ]);
    this.link('skin', SKIN_VS, COPY_FS, [
      'uBoneMatrices[0]',
      'uResolution',
      'uFlipY',
      'uSource',
      'uMask',
      'uOpacity',
      'uUseMask',
    ]);
    this.link('adjust', QUAD_VS, ADJUST_FS, [
      'uMatrix',
      'uResolution',
      'uFlipY',
      'uSource',
      'uHue',
      'uSaturation',
      'uBrightness',
      'uContrast',
    ]);
  }

  private buildGeometry() {
    const gl = this.gl;
    const corners = new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]);

    const cornerBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, cornerBuf);
    gl.bufferData(gl.ARRAY_BUFFER, corners, gl.STATIC_DRAW);

    this.quadVAO = gl.createVertexArray()!;
    gl.bindVertexArray(this.quadVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, cornerBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    this.stampVAO = gl.createVertexArray()!;
    gl.bindVertexArray(this.stampVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, cornerBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    this.stampBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.stampBuffer);
    // iPos(2) iSize iAngle iAlpha iHardness iAspect = 7 floats
    const stride = 7 * 4;
    const layout: [number, number, number][] = [
      [1, 2, 0], // iPos
      [2, 1, 8], // iSize
      [3, 1, 12], // iAngle
      [4, 1, 16], // iAlpha
      [5, 1, 20], // iHardness
      [6, 1, 24], // iAspect
    ];
    for (const [loc, size, offset] of layout) {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, offset);
      gl.vertexAttribDivisor(loc, 1);
    }
    gl.bindVertexArray(null);
  }

  /* ---------------------------------------------------------------- *
   * Ciclo de vida de superficies
   * ---------------------------------------------------------------- */

  setDocumentSize(w: number, h: number) {
    if (w === this.docWidth && h === this.docHeight) return;
    this.docWidth = w;
    this.docHeight = h;
    const perSurface = w * h * 4;
    this.maxResident = Math.max(
      MIN_RESIDENT,
      Math.min(MAX_RESIDENT, Math.floor(TEXTURE_BUDGET_BYTES / perSurface)),
    );
    for (const s of this.scratches.values()) this.release(s, false);
    this.scratches.clear();
    for (const t of this.smallTargets.values()) {
      this.gl.deleteFramebuffer(t.fbo);
      this.gl.deleteTexture(t.tex);
    }
    this.smallTargets.clear();
    // Las posiciones de reposo de cada malla están en píxeles de este
    // tamaño de documento; si cambia, hay que regenerarlas desde el core,
    // no sólo resubir el mismo buffer.
    for (const m of this.meshGPU.values()) {
      this.gl.deleteVertexArray(m.vao);
      this.gl.deleteBuffer(m.vbo);
      this.gl.deleteBuffer(m.ibo);
    }
    this.meshGPU.clear();
  }

  /** Cuántas superficies caben en GPU con el lienzo actual. */
  get residentBudget() {
    return this.maxResident;
  }

  createSurface(label = 'cel'): Surface {
    return new Surface(label);
  }

  /** Asegura que la superficie tenga textura y FBO en GPU, restaurando el respaldo. */
  ensureResident(s: Surface): Surface {
    const gl = this.gl;
    s.lastUse = ++this.clock;
    if (s.tex) return s;

    if (!s.pinned) this.evictIfNeeded();

    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, this.docWidth, this.docHeight);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);

    s.tex = tex;
    s.fbo = fbo;

    if (s.backing) {
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        0,
        0,
        this.docWidth,
        this.docHeight,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        s.backing,
      );
      s.backing = null;
    } else {
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }

    this.resident.add(s);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return s;
  }

  private evictIfNeeded() {
    if (this.resident.size < this.maxResident) return;
    let victim: Surface | null = null;
    for (const s of this.resident) {
      if (s.pinned) continue;
      if (!victim || s.lastUse < victim.lastUse) victim = s;
    }
    if (victim) this.evict(victim);
  }

  /** Baja la textura a CPU y libera la memoria de GPU. */
  private evict(s: Surface) {
    const gl = this.gl;
    if (!s.tex) return;
    if (!s.empty) {
      const pixels = new Uint8Array(this.docWidth * this.docHeight * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, s.fbo);
      gl.readPixels(
        0,
        0,
        this.docWidth,
        this.docHeight,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        pixels,
      );
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      s.backing = pixels;
    }
    gl.deleteFramebuffer(s.fbo);
    gl.deleteTexture(s.tex);
    s.tex = null;
    s.fbo = null;
    this.resident.delete(s);
  }

  release(s: Surface, keepBacking = false) {
    const gl = this.gl;
    if (s.tex) {
      gl.deleteFramebuffer(s.fbo);
      gl.deleteTexture(s.tex);
      s.tex = null;
      s.fbo = null;
      this.resident.delete(s);
    }
    if (!keepBacking) s.backing = null;
  }

  /** Superficie de trabajo reutilizable, nunca expulsada. */
  scratch(name: string): Surface {
    let s = this.scratches.get(name);
    if (!s) {
      s = new Surface(`scratch:${name}`);
      s.pinned = true;
      this.scratches.set(name, s);
    }
    this.ensureResident(s);
    return s;
  }

  clear(s: Surface) {
    const gl = this.gl;
    this.ensureResident(s);
    gl.bindFramebuffer(gl.FRAMEBUFFER, s.fbo);
    gl.disable(gl.BLEND);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    s.empty = true;
    s.version++;
  }

  fill(s: Surface, color: RGB, alpha: number) {
    const gl = this.gl;
    this.ensureResident(s);
    gl.bindFramebuffer(gl.FRAMEBUFFER, s.fbo);
    gl.disable(gl.BLEND);
    gl.clearColor(color.r * alpha, color.g * alpha, color.b * alpha, alpha);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    s.empty = alpha === 0;
    s.version++;
  }

  /* ---------------------------------------------------------------- *
   * Dibujo
   * ---------------------------------------------------------------- */

  /**
   * Textura de máscara para una punta de pincel con textura, generada o
   * subida la primera vez que se pide y cacheada después. `null` (punta
   * lisa) no pasa por aquí: lo resuelve el llamador antes de invocar este
   * método. `resolvePixels` sólo se llama en un fallo de caché — así una
   * textura integrada (cara de generar, con cientos de `paintDot`) no se
   * recalcula en cada estampa, sólo la primera vez.
   */
  getBrushTexture(id: string, resolvePixels: () => Uint8Array): WebGLTexture {
    const cached = this.brushTextures.get(id);
    if (cached) return cached;

    const gl = this.gl;
    const size = 128;
    const pixels = resolvePixels();
    const levels = Math.floor(Math.log2(size)) + 1;

    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, levels, gl.RGBA8, size, size);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    // Sin mipmaps, una estampa pequeña en pantalla minifica el patrón de
    // 128×128 con muestreo bilineal simple — aliasing, no un promedio del
    // patrón — que es la causa más probable del grano casi invisible en
    // puntas pequeñas (deuda conocida). Es la corrección de manual para
    // minificación de texturas, sin contrapartida; en SwiftShader (las
    // pruebas) el efecto no sale limpio de medir — dos umbrales de "cuánto
    // se ve" distintos dieron resultados contradictorios entre sí, así que
    // el test de abajo no afirma una mejora medida, sólo que sigue
    // dejando grano visible.
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    // El UV de la estampa (vLocal*0.5+0.5) siempre cae en 0..1 exacto: no hay
    // que envolver el borde, así que CLAMP evita cualquier fuga entre bordes.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    this.brushTextures.set(id, tex);
    return tex;
  }

  /**
   * Estampa un lote de puntos de pincel. Todas las estampas de un segmento van
   * en una sola llamada instanciada: en un trazo rápido con spacing bajo esto
   * es la diferencia entre 400 draw calls y una.
   */
  drawStamps(target: Surface, stamps: Stamp[], color: RGB, brushTexture?: WebGLTexture) {
    if (stamps.length === 0) return;
    const gl = this.gl;
    this.ensureResident(target);

    const needed = stamps.length * 7;
    if (this.stampData.length < needed) {
      this.stampData = new Float32Array(Math.max(needed, this.stampData.length * 2, 1024));
    }
    const data = this.stampData;
    for (let i = 0; i < stamps.length; i++) {
      const s = stamps[i];
      const o = i * 7;
      data[o] = s.x;
      data[o + 1] = s.y;
      data[o + 2] = s.size;
      data[o + 3] = s.angle;
      data[o + 4] = s.alpha;
      data[o + 5] = s.hardness;
      data[o + 6] = s.aspect;
    }

    const p = this.programs.get('stamp')!;
    gl.useProgram(p.program);
    gl.bindVertexArray(this.stampVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.stampBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, data.subarray(0, needed), gl.DYNAMIC_DRAW);

    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    gl.viewport(0, 0, this.docWidth, this.docHeight);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    gl.uniform2f(p.uniforms.uResolution, this.docWidth, this.docHeight);
    gl.uniform3f(p.uniforms.uColor, color.r, color.g, color.b);
    gl.uniform1f(p.uniforms.uUseTexture, brushTexture ? 1 : 0);
    // Siempre se toca la unidad 0, incluso sin textura: si se deja lo que
    // hubiera antes, puede ser justo la textura de este mismo `target` (por
    // ejemplo, la de `drawOver` al volcar el trazo anterior sobre el cel), y
    // WebGL2 rechaza el draw call entero como feedback loop entre el
    // framebuffer activo y una textura enlazada, aunque el shader nunca la
    // lea. En el uso interactivo normal el siguiente fotograma de render ya
    // pisa esa unidad con otra cosa, así que no se notaba; en dos trazos
    // seguidos sin que se dibuje un fotograma de por medio, sí.
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, brushTexture ?? null);
    if (brushTexture) gl.uniform1i(p.uniforms.uTexture, 0);

    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, stamps.length);

    gl.bindVertexArray(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    target.empty = false;
    target.version++;
  }

  /**
   * Sube (o resube, sin condición) los vértices/índices de `mesh` al VAO
   * cacheado para su id. Sin control de versión a propósito: una malla de
   * unas pocas decenas o cientos de vértices cuesta lo mismo volver a subir
   * entera que comprobar si cambió, y así no hace falta que `Mesh` lleve su
   * propio contador — mismo criterio que `drawStamps`, que ya resube su
   * buffer entero en cada llamada.
   */
  private ensureMeshGPU(mesh: Mesh) {
    const gl = this.gl;
    let gpu = this.meshGPU.get(mesh.id);
    if (!gpu) {
      gpu = { vao: gl.createVertexArray()!, vbo: gl.createBuffer()!, ibo: gl.createBuffer()!, indexCount: 0 };
      this.meshGPU.set(mesh.id, gpu);
    }

    gl.bindVertexArray(gpu.vao);

    // aRestPos(2) aUV(2) aBoneIndices(4) aBoneWeights(4) = 12 floats/vértice.
    const stride = 12 * 4;
    const data = new Float32Array(mesh.vertices.length * 12);
    for (let i = 0; i < mesh.vertices.length; i++) {
      const v = mesh.vertices[i];
      const o = i * 12;
      data[o] = v.x;
      data[o + 1] = v.y;
      data[o + 2] = v.u;
      data[o + 3] = v.v;
      data[o + 4] = v.boneIndices[0];
      data[o + 5] = v.boneIndices[1];
      data[o + 6] = v.boneIndices[2];
      data[o + 7] = v.boneIndices[3];
      data[o + 8] = v.boneWeights[0];
      data[o + 9] = v.boneWeights[1];
      data[o + 10] = v.boneWeights[2];
      data[o + 11] = v.boneWeights[3];
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, gpu.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, stride, 8);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.FLOAT, false, stride, 16);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 4, gl.FLOAT, false, stride, 32);

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gpu.ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(mesh.triangles), gl.DYNAMIC_DRAW);
    gpu.indexCount = mesh.triangles.length;

    gl.bindVertexArray(null);
    return gpu;
  }

  /**
   * Deforma `src` con `mesh` según `boneMatrices` (una por hueso, en el
   * mismo orden que `Skeleton.bones` — así `MeshVertex.boneIndices` puede
   * indexarlas con un entero pequeño). Es el único pase que dibuja
   * triángulos arbitrarios en vez del quad unidad o las estampas
   * instanciadas; el resto del pipeline (premultiplicado, `uFlipY=0` al
   * escribir a un FBO) sigue las mismas invariantes que cualquier otro pase.
   */
  drawSkinned(target: Surface, src: Surface, mesh: Mesh, boneMatrices: Mat3[]) {
    if (mesh.vertices.length === 0 || mesh.triangles.length === 0) return;
    const gl = this.gl;
    this.ensureResident(target);
    this.ensureResident(src);
    const gpu = this.ensureMeshGPU(mesh);

    const p = this.programs.get('skin')!;
    gl.useProgram(p.program);
    gl.bindVertexArray(gpu.vao);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    gl.viewport(0, 0, this.docWidth, this.docHeight);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    const count = Math.min(boneMatrices.length, MAX_SKIN_BONES);
    const flat = new Float32Array(Math.max(count, 1) * 9);
    for (let i = 0; i < count; i++) flat.set(boneMatrices[i], i * 9);
    gl.uniformMatrix3fv(p.uniforms['uBoneMatrices[0]'], false, flat);
    gl.uniform2f(p.uniforms.uResolution, this.docWidth, this.docHeight);
    gl.uniform1f(p.uniforms.uFlipY, 0);
    gl.uniform1f(p.uniforms.uOpacity, 1);
    gl.uniform1f(p.uniforms.uUseMask, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, src.tex);
    gl.uniform1i(p.uniforms.uSource, 0);

    gl.drawElements(gl.TRIANGLES, gpu.indexCount, gl.UNSIGNED_SHORT, 0);

    gl.bindVertexArray(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (!src.empty) target.empty = false;
    target.version++;
  }

  /** Rectángulo completo del documento como matriz para el quad unidad. */
  private docMatrix(): Mat3 {
    return new Float32Array([this.docWidth, 0, 0, 0, this.docHeight, 0, 0, 0, 1]);
  }

  /** `dst = src` (con opacidad y máscara opcionales), sobrescribiendo el destino. */
  copy(dst: Surface, src: Surface, opacity = 1, matrix?: Mat3, mask?: Surface | null) {
    const gl = this.gl;
    this.ensureResident(dst);
    this.ensureResident(src);
    const p = this.programs.get('copy')!;
    gl.useProgram(p.program);
    gl.bindVertexArray(this.quadVAO);
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
    gl.viewport(0, 0, this.docWidth, this.docHeight);
    gl.disable(gl.BLEND);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.uniformMatrix3fv(p.uniforms.uMatrix, false, matrix ?? this.docMatrix());
    gl.uniform2f(p.uniforms.uResolution, this.docWidth, this.docHeight);
    gl.uniform1f(p.uniforms.uFlipY, 0);
    gl.uniform1f(p.uniforms.uOpacity, opacity);
    this.bindSource(p, src, mask);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    dst.empty = src.empty;
    dst.version++;
  }

  /**
   * Enlaza la textura fuente y, si la hay, la máscara de recorte.
   *
   * `uMask` está declarado sin condición en el shader `copy` (se lee dentro
   * de un `if (uUseMask > 0.5)`, pero eso no lo saca de la lista de samplers
   * activos del programa enlazado): WebGL valida el feedback loop
   * framebuffer/textura contra CUALQUIER unidad que el programa pueda
   * muestrear, sin mirar si la rama que la usa se ejecuta de verdad. Sin
   * máscara hay que dejar la unidad 1 explícitamente desenlazada — si se
   * deja tal cual, conserva la textura de la última llamada que sí pasó
   * máscara, y si esa textura resulta ser la misma que el framebuffer de
   * destino de una llamada posterior sin máscara, salta "Feedback loop
   * formed between Framebuffer and active Texture" en consola aunque el
   * resultado sea correcto (ver CHECKPOINT.md).
   */
  private bindSource(p: ProgramInfo, src: Surface, mask?: Surface | null) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, src.tex);
    gl.uniform1i(p.uniforms.uSource, 0);
    gl.activeTexture(gl.TEXTURE1);
    if (mask) {
      this.ensureResident(mask);
      gl.bindTexture(gl.TEXTURE_2D, mask.tex);
      gl.uniform1i(p.uniforms.uMask, 1);
    } else {
      gl.bindTexture(gl.TEXTURE_2D, null);
    }
    gl.uniform1f(p.uniforms.uUseMask, mask ? 1 : 0);
  }

  /** Dibuja `src` encima de lo que ya haya en `dst`, con src-over simple. */
  drawOver(
    dst: Surface,
    src: Surface,
    opacity = 1,
    matrix?: Mat3,
    erase = false,
    mask?: Surface | null,
  ) {
    const gl = this.gl;
    this.ensureResident(dst);
    this.ensureResident(src);
    const p = this.programs.get('copy')!;
    gl.useProgram(p.program);
    gl.bindVertexArray(this.quadVAO);
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
    gl.viewport(0, 0, this.docWidth, this.docHeight);
    gl.enable(gl.BLEND);
    if (erase) gl.blendFunc(gl.ZERO, gl.ONE_MINUS_SRC_ALPHA);
    else gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    gl.uniformMatrix3fv(p.uniforms.uMatrix, false, matrix ?? this.docMatrix());
    gl.uniform2f(p.uniforms.uResolution, this.docWidth, this.docHeight);
    gl.uniform1f(p.uniforms.uFlipY, 0);
    gl.uniform1f(p.uniforms.uOpacity, opacity);
    this.bindSource(p, src, mask);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (!erase && !src.empty) dst.empty = false;
    dst.version++;
  }

  /**
   * `dst = blend(backdrop, src)`. Necesita tres superficies distintas porque
   * WebGL2 no permite leer y escribir la misma textura en un pase.
   */
  composite(dst: Surface, backdrop: Surface, src: Surface, opts: CompositeOptions) {
    const gl = this.gl;
    this.ensureResident(dst);
    this.ensureResident(backdrop);
    this.ensureResident(src);
    const p = this.programs.get('composite')!;
    gl.useProgram(p.program);
    gl.bindVertexArray(this.quadVAO);
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
    gl.viewport(0, 0, this.docWidth, this.docHeight);
    gl.disable(gl.BLEND);

    gl.uniformMatrix3fv(p.uniforms.uMatrix, false, this.docMatrix());
    gl.uniform2f(p.uniforms.uResolution, this.docWidth, this.docHeight);
    gl.uniform1f(p.uniforms.uFlipY, 0);
    gl.uniform1f(p.uniforms.uOpacity, opts.opacity);
    gl.uniform1i(p.uniforms.uBlend, opts.blend);
    gl.uniform1f(p.uniforms.uClip, opts.clip ? 1 : 0);
    const t = opts.tint ?? [0, 0, 0, 0];
    gl.uniform4f(p.uniforms.uTint, t[0], t[1], t[2], t[3]);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, src.tex);
    gl.uniform1i(p.uniforms.uSource, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, backdrop.tex);
    gl.uniform1i(p.uniforms.uBackdrop, 1);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    dst.empty = backdrop.empty && src.empty;
    dst.version++;
  }

  /**
   * `dst = mezclaDePigmento(backdrop, src)` — mismo requisito de tres
   * superficies distintas que `composite()`, y por la misma razón: el
   * shader de `MIX_FS` necesita leer el color de debajo a la vez que
   * escribe el resultado, así que `backdrop` no puede ser `dst`. Quien
   * llama es responsable de haber copiado el `dst` de antes ahí (ver
   * `Engine.mergeStroke`) — este método no lo hace por si el llamador ya
   * tiene esa copia hecha por otra razón.
   */
  mixOver(dst: Surface, backdrop: Surface, src: Surface, opts: { opacity: number; pigmentMix: number }) {
    const gl = this.gl;
    this.ensureResident(dst);
    this.ensureResident(backdrop);
    this.ensureResident(src);
    const p = this.programs.get('mix')!;
    gl.useProgram(p.program);
    gl.bindVertexArray(this.quadVAO);
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
    gl.viewport(0, 0, this.docWidth, this.docHeight);
    gl.disable(gl.BLEND);

    gl.uniformMatrix3fv(p.uniforms.uMatrix, false, this.docMatrix());
    gl.uniform2f(p.uniforms.uResolution, this.docWidth, this.docHeight);
    gl.uniform1f(p.uniforms.uFlipY, 0);
    gl.uniform1f(p.uniforms.uOpacity, opts.opacity);
    gl.uniform1f(p.uniforms.uPigmentMix, opts.pigmentMix);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, src.tex);
    gl.uniform1i(p.uniforms.uSource, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, backdrop.tex);
    gl.uniform1i(p.uniforms.uBackdrop, 1);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (!src.empty) dst.empty = false;
    dst.version++;
  }

  /**
   * Tono/saturación/brillo/contraste sobre `src` entero, escrito en `dst` —
   * usado por las capas de ajuste sobre el acumulador de composición, no
   * sobre un cel. Reemplaza el contenido de `dst` sin blending: quien llama
   * decide aparte cómo mezclarlo con opacidad (ver `Engine.compositeGroups`,
   * que lo funde con `composite()` normal contra el acumulador original).
   */
  applyAdjustment(
    dst: Surface,
    src: Surface,
    adjustment: { hue: number; saturation: number; brightness: number; contrast: number },
  ) {
    const gl = this.gl;
    this.ensureResident(dst);
    this.ensureResident(src);
    const p = this.programs.get('adjust')!;
    gl.useProgram(p.program);
    gl.bindVertexArray(this.quadVAO);
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
    gl.viewport(0, 0, this.docWidth, this.docHeight);
    gl.disable(gl.BLEND);

    gl.uniformMatrix3fv(p.uniforms.uMatrix, false, this.docMatrix());
    gl.uniform2f(p.uniforms.uResolution, this.docWidth, this.docHeight);
    gl.uniform1f(p.uniforms.uFlipY, 0);
    gl.uniform1f(p.uniforms.uHue, adjustment.hue);
    gl.uniform1f(p.uniforms.uSaturation, adjustment.saturation);
    gl.uniform1f(p.uniforms.uBrightness, adjustment.brightness);
    gl.uniform1f(p.uniforms.uContrast, adjustment.contrast);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, src.tex);
    gl.uniform1i(p.uniforms.uSource, 0);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    dst.empty = src.empty;
    dst.version++;
  }

  /** Pase final a pantalla, con la transformación de vista y el tablero. */
  present(
    src: Surface,
    viewMatrix: Mat3,
    paper: RGB,
    paperAlpha: number,
    checkerScale: number,
  ) {
    const gl = this.gl;
    this.ensureResident(src);
    const p = this.programs.get('present')!;
    gl.useProgram(p.program);
    gl.bindVertexArray(this.quadVAO);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.disable(gl.BLEND);
    gl.clearColor(0.09, 0.09, 0.1, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.uniformMatrix3fv(p.uniforms.uMatrix, false, viewMatrix);
    gl.uniform2f(p.uniforms.uResolution, this.canvas.width, this.canvas.height);
    gl.uniform1f(p.uniforms.uFlipY, 1);
    gl.uniform2f(p.uniforms.uDocSize, this.docWidth, this.docHeight);
    gl.uniform1f(p.uniforms.uCheckerScale, checkerScale);
    gl.uniform3f(p.uniforms.uPaper, paper.r, paper.g, paper.b);
    gl.uniform1f(p.uniforms.uPaperAlpha, paperAlpha);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, src.tex);
    gl.uniform1i(p.uniforms.uSource, 0);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
  }

  /** Contorno animado de la selección, encima de la imagen ya presentada. */
  drawSelectionOutline(mask: Surface, viewMatrix: Mat3, zoom: number, timeSeconds: number) {
    const gl = this.gl;
    this.ensureResident(mask);
    const p = this.programs.get('ants')!;
    gl.useProgram(p.program);
    gl.bindVertexArray(this.quadVAO);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    gl.uniformMatrix3fv(p.uniforms.uMatrix, false, viewMatrix);
    gl.uniform2f(p.uniforms.uResolution, this.canvas.width, this.canvas.height);
    gl.uniform1f(p.uniforms.uFlipY, 1);
    // Un píxel del framebuffer, convertido a distancia en UV del documento.
    const dpr = this.canvas.width / (this.canvas.clientWidth || 1);
    const step = 1 / Math.max(zoom * dpr, 0.0001);
    gl.uniform2f(p.uniforms.uEdgeStep, step / this.docWidth, step / this.docHeight);
    gl.uniform1f(p.uniforms.uTime, timeSeconds);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, mask.tex);
    gl.uniform1i(p.uniforms.uMask, 0);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
  }

  /* ---------------------------------------------------------------- *
   * Transferencia CPU <-> GPU
   * ---------------------------------------------------------------- */

  readRect(s: Surface, r: Rect): Uint8Array {
    const gl = this.gl;
    const w = r.x2 - r.x;
    const h = r.y2 - r.y;
    const out = new Uint8Array(w * h * 4);
    if (w <= 0 || h <= 0) return out;
    if (!s.tex && !s.backing) return out;
    this.ensureResident(s);
    gl.bindFramebuffer(gl.FRAMEBUFFER, s.fbo);
    gl.readPixels(r.x, r.y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, out);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return out;
  }

  writeRect(s: Surface, r: Rect, pixels: Uint8Array) {
    const gl = this.gl;
    const w = r.x2 - r.x;
    const h = r.y2 - r.y;
    if (w <= 0 || h <= 0) return;
    this.ensureResident(s);
    gl.bindTexture(gl.TEXTURE_2D, s.tex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, r.x, r.y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    s.empty = false;
    s.version++;
  }

  /** Sube una imagen decodificada a una superficie (usado al abrir proyectos). */
  uploadImage(s: Surface, source: ImageBitmap | HTMLCanvasElement) {
    const gl = this.gl;
    this.ensureResident(s);
    gl.bindTexture(gl.TEXTURE_2D, s.tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      0,
      Math.min(source.width, this.docWidth),
      Math.min(source.height, this.docHeight),
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      source as unknown as TexImageSource,
    );
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    s.empty = false;
    s.version++;
  }

  /**
   * Objetivo de render pequeño y reutilizable, fuera del tamaño del documento.
   * Los tamaños se repiten entre llamadas, así que la caché se estabiliza en
   * unas pocas entradas.
   */
  private smallTarget(w: number, h: number): { tex: WebGLTexture; fbo: WebGLFramebuffer } {
    const key = `${w}x${h}`;
    let t = this.smallTargets.get(key);
    if (t) return t;

    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    t = { tex, fbo };
    this.smallTargets.set(key, t);
    return t;
  }

  /** Dibuja una textura llenando un destino de tamaño arbitrario. */
  private blitTo(srcTex: WebGLTexture, fbo: WebGLFramebuffer | null, w: number, h: number) {
    const gl = this.gl;
    const p = this.programs.get('copy')!;
    gl.useProgram(p.program);
    gl.bindVertexArray(this.quadVAO);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.viewport(0, 0, w, h);
    gl.disable(gl.BLEND);
    gl.uniformMatrix3fv(p.uniforms.uMatrix, false, new Float32Array([w, 0, 0, 0, h, 0, 0, 0, 1]));
    gl.uniform2f(p.uniforms.uResolution, w, h);
    gl.uniform1f(p.uniforms.uFlipY, 0);
    gl.uniform1f(p.uniforms.uOpacity, 1);
    gl.uniform1f(p.uniforms.uUseMask, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, srcTex);
    gl.uniform1i(p.uniforms.uSource, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /**
   * Reduce `srcTex` (tamaño `curW`x`curH`) hasta `targetW`x`targetH` por
   * mitades sucesivas en vez de saltar de golpe: una minificación directa
   * con filtro lineal muestrea cuatro téxeles y se salta el resto, con lo
   * que las líneas finas desaparecen. Encadenando halvings cada paso es un
   * filtro de caja correcto. Siempre termina con un blit a `final` aunque ya
   * esté al tamaño pedido (documento más pequeño que el destino): `final` es
   * una textura de scratch aparte, no la fuente, y sin ese blit se leería lo
   * que hubiera de una miniatura anterior del mismo tamaño.
   */
  private reduceByHalving(
    srcTex: WebGLTexture,
    curW: number,
    curH: number,
    targetW: number,
    targetH: number,
  ): { tex: WebGLTexture; fbo: WebGLFramebuffer } {
    let tex = srcTex;
    let w = curW;
    let h = curH;
    while (w > targetW * 2 && h > targetH * 2) {
      const nw = Math.max(targetW, w >> 1);
      const nh = Math.max(targetH, h >> 1);
      const t = this.smallTarget(nw, nh);
      this.blitTo(tex, t.fbo, nw, nh);
      tex = t.tex;
      w = nw;
      h = nh;
    }
    const final = this.smallTarget(targetW, targetH);
    this.blitTo(tex, final.fbo, targetW, targetH);
    return final;
  }

  /** Tamaño del sondeo usado para localizar el dibujo dentro del documento
   *  — sólo hace falta saber DÓNDE está, no verlo con nitidez, así que no
   *  hace falta acercarse al tamaño real del documento. Fijo, no derivado de
   *  `maxSize`: así el sondeo reutiliza siempre las mismas entradas de
   *  `smallTargets` (que sólo crecen por tamaño de textura distinto pedido,
   *  nunca se expulsan salvo al cambiar el tamaño del documento) en vez de
   *  crear una nueva por cada aspecto de recorte distinto. */
  private static readonly INK_PROBE_MAX = 128;

  /**
   * Caja del dibujo dentro del documento, en coordenadas de documento y con
   * margen — o `null` si no hay tinta, o si el dibujo ya ocupa casi todo el
   * documento (ahí recortar no ayuda y sólo cambia un halving de calidad
   * probada por un blit de un solo paso). Se mide sobre una reducción
   * barata (`INK_PROBE_MAX`), no a resolución completa: para saber dónde
   * recortar no hace falta precisión de píxel.
   */
  private findInkBounds(src: Surface): Rect | null {
    const gl = this.gl;
    const scale = Math.min(
      Renderer.INK_PROBE_MAX / this.docWidth,
      Renderer.INK_PROBE_MAX / this.docHeight,
      1,
    );
    const probeW = Math.max(1, Math.round(this.docWidth * scale));
    const probeH = Math.max(1, Math.round(this.docHeight * scale));
    const probe = this.reduceByHalving(src.tex!, this.docWidth, this.docHeight, probeW, probeH);

    const px = new Uint8Array(probeW * probeH * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, probe.fbo);
    gl.readPixels(0, 0, probeW, probeH, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    let minX = probeW;
    let minY = probeH;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < probeH; y++) {
      for (let x = 0; x < probeW; x++) {
        if (px[(y * probeW + x) * 4 + 3] === 0) continue;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    if (maxX < 0) return null;

    const area = (maxX - minX + 1) * (maxY - minY + 1);
    if (area > probeW * probeH * 0.85) return null;

    // Vuelve a coordenadas de documento con margen: al menos un téxel de
    // sondeo (la caja es tan precisa como su resolución) más un 8% del lado
    // mayor, para no recortar al ras del trazo.
    const sx = this.docWidth / probeW;
    const sy = this.docHeight / probeH;
    const bboxW = (maxX - minX + 1) * sx;
    const bboxH = (maxY - minY + 1) * sy;
    const pad = Math.max(sx, sy, Math.max(bboxW, bboxH) * 0.08);
    return {
      x: Math.max(0, Math.floor(minX * sx - pad)),
      y: Math.max(0, Math.floor(minY * sy - pad)),
      x2: Math.min(this.docWidth, Math.ceil((maxX + 1) * sx + pad)),
      y2: Math.min(this.docHeight, Math.ceil((maxY + 1) * sy + pad)),
    };
  }

  /**
   * Miniatura de una superficie sin traerse el documento entero a CPU.
   *
   * Antes de reducir, recorta a la caja del dibujo (`findInkBounds`): un
   * boceto pequeño en un documento grande, reducido sin recortar, se queda
   * en unos pocos téxeles de la miniatura entera y una línea fina se vuelve
   * casi invisible — inherente a reducir 1920 px a 64, no un bug de
   * muestreo. El recorte usa `blitFramebuffer` (recorte + escala en un solo
   * paso de GPU, sin tocar el pipeline de shaders compartido) hacia una
   * textura fija de `maxSize`x`maxSize` — fija para no crear una entrada
   * nueva en `smallTargets` por cada aspecto de recorte distinto, que
   * crecería sin límite a lo largo de una sesión de dibujo — y se recorta
   * en CPU al tamaño real tras leerla, con `extractRect` (mismo camino que
   * ya usa `floodFill` para recortar un buffer).
   *
   * Sin caja que recortar (sin tinta, o el dibujo ya ocupa casi todo el
   * documento) sigue el camino de siempre: reducir por mitades sucesivas,
   * el filtro de caja correcto para minificaciones grandes.
   */
  downscaleToCanvas(src: Surface, maxSize: number): HTMLCanvasElement | null {
    if (src.empty && !src.backing) return null;
    const gl = this.gl;
    this.ensureResident(src);

    const inkRect = this.findInkBounds(src);
    let targetW: number;
    let targetH: number;
    let px: Uint8Array;

    if (inkRect) {
      const rectW = inkRect.x2 - inkRect.x;
      const rectH = inkRect.y2 - inkRect.y;
      const scale = Math.min(maxSize / rectW, maxSize / rectH, 1);
      targetW = Math.max(1, Math.round(rectW * scale));
      targetH = Math.max(1, Math.round(rectH * scale));

      const slot = this.smallTarget(maxSize, maxSize);
      gl.bindFramebuffer(gl.FRAMEBUFFER, slot.fbo);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, src.fbo);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, slot.fbo);
      gl.blitFramebuffer(
        inkRect.x,
        inkRect.y,
        inkRect.x2,
        inkRect.y2,
        0,
        0,
        targetW,
        targetH,
        gl.COLOR_BUFFER_BIT,
        gl.LINEAR,
      );
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);

      const full = new Uint8Array(maxSize * maxSize * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, slot.fbo);
      gl.readPixels(0, 0, maxSize, maxSize, gl.RGBA, gl.UNSIGNED_BYTE, full);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      px = extractRect(full, maxSize, { x: 0, y: 0, x2: targetW, y2: targetH });
    } else {
      const scale = Math.min(maxSize / this.docWidth, maxSize / this.docHeight, 1);
      targetW = Math.max(1, Math.round(this.docWidth * scale));
      targetH = Math.max(1, Math.round(this.docHeight * scale));
      const final = this.reduceByHalving(src.tex!, this.docWidth, this.docHeight, targetW, targetH);
      px = new Uint8Array(targetW * targetH * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, final.fbo);
      gl.readPixels(0, 0, targetW, targetH, gl.RGBA, gl.UNSIGNED_BYTE, px);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }

    unpremultiply(px);
    const canvas = document.createElement('canvas');
    canvas.width = targetW;
    canvas.height = targetH;
    canvas
      .getContext('2d')!
      .putImageData(
        new ImageData(new Uint8ClampedArray(px.buffer as ArrayBuffer), targetW, targetH),
        0,
        0,
      );
    return canvas;
  }

  /**
   * Extrae la superficie como ImageData con alfa recta (des-premultiplicada),
   * que es lo que esperan tanto PNG como `canvas.putImageData`.
   */
  toImageData(s: Surface): ImageData {
    const px = this.readRect(s, { x: 0, y: 0, x2: this.docWidth, y2: this.docHeight });
    unpremultiply(px);
    return new ImageData(
      new Uint8ClampedArray(px.buffer as ArrayBuffer),
      this.docWidth,
      this.docHeight,
    );
  }

  identity(): Mat3 {
    return mat3Identity();
  }
}

/** Convierte RGBA premultiplicado a alfa recta, en el sitio. */
function unpremultiply(px: Uint8Array) {
  for (let i = 0; i < px.length; i += 4) {
    const a = px[i + 3];
    if (a !== 0 && a !== 255) {
      const inv = 255 / a;
      px[i] = Math.min(255, px[i] * inv);
      px[i + 1] = Math.min(255, px[i + 1] * inv);
      px[i + 2] = Math.min(255, px[i + 2] * inv);
    }
  }
}
