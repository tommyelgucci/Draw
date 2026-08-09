import {
  ANTS_FS,
  COMPOSITE_FS,
  COPY_FS,
  PRESENT_FS,
  QUAD_VS,
  STAMP_FS,
  STAMP_VS,
} from './shaders';
import { generateBrushTexturePixels, type BuiltinTextureId } from '../core/brushTexture';
import { mat3Identity, type Mat3 } from '../core/math';
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
  /** Máscaras de punta de pincel, generadas una vez y cacheadas por id: no
   * dependen del tamaño del documento, así que sobreviven a `setDocumentSize`. */
  private brushTextures = new Map<BuiltinTextureId, WebGLTexture>();
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
   * Textura de máscara para una punta de pincel con textura, generada la
   * primera vez que se pide y cacheada después. `null` (punta lisa) no pasa
   * por aquí: lo resuelve el llamador antes de invocar este método.
   */
  getBrushTexture(id: BuiltinTextureId): WebGLTexture {
    const cached = this.brushTextures.get(id);
    if (cached) return cached;

    const gl = this.gl;
    const size = 128;
    const pixels = generateBrushTexturePixels(id, size);

    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, size, size);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
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
    if (brushTexture) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, brushTexture);
      gl.uniform1i(p.uniforms.uTexture, 0);
    }

    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, stamps.length);

    gl.bindVertexArray(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    target.empty = false;
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

  /** Enlaza la textura fuente y, si la hay, la máscara de recorte. */
  private bindSource(p: ProgramInfo, src: Surface, mask?: Surface | null) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, src.tex);
    gl.uniform1i(p.uniforms.uSource, 0);
    if (mask) {
      this.ensureResident(mask);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, mask.tex);
      gl.uniform1i(p.uniforms.uMask, 1);
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
   * Miniatura de una superficie sin traerse el documento entero a CPU.
   *
   * Reduce por mitades sucesivas en vez de saltar de 1920 px a 64 de golpe:
   * una minificación directa con filtro lineal muestrea cuatro téxeles y se
   * salta el resto, con lo que las líneas finas desaparecen. Encadenando
   * halvings cada paso es un filtro de caja correcto.
   */
  downscaleToCanvas(src: Surface, maxSize: number): HTMLCanvasElement | null {
    if (src.empty && !src.backing) return null;
    const gl = this.gl;
    this.ensureResident(src);

    const scale = Math.min(maxSize / this.docWidth, maxSize / this.docHeight, 1);
    const targetW = Math.max(1, Math.round(this.docWidth * scale));
    const targetH = Math.max(1, Math.round(this.docHeight * scale));

    let curTex = src.tex!;
    let curW = this.docWidth;
    let curH = this.docHeight;

    while (curW > targetW * 2 && curH > targetH * 2) {
      const nw = Math.max(targetW, curW >> 1);
      const nh = Math.max(targetH, curH >> 1);
      const t = this.smallTarget(nw, nh);
      this.blitTo(curTex, t.fbo, nw, nh);
      curTex = t.tex;
      curW = nw;
      curH = nh;
    }

    const final = this.smallTarget(targetW, targetH);
    if (curW !== targetW || curH !== targetH) {
      this.blitTo(curTex, final.fbo, targetW, targetH);
    }

    const readFbo =
      curW === targetW && curH === targetH
        ? this.smallTarget(curW, curH).fbo
        : final.fbo;
    const px = new Uint8Array(targetW * targetH * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, readFbo);
    gl.readPixels(0, 0, targetW, targetH, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

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
