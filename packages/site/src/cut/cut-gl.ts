const VS = `#version 300 es
in vec2 aP;
void main(){ gl_Position = vec4(aP, 0.0, 1.0); }`

const FS = `#version 300 es
precision highp float;
uniform sampler2D uPlot;
uniform sampler2D uTrace;
uniform sampler2D uGlyph;
uniform sampler2D uOwnPlot;
uniform sampler2D uOwnTrace;
uniform sampler2D uGlow;
uniform float uGlowAmt;
uniform float uDim;
uniform float uFront;
uniform vec2 uRes;
uniform vec4 uFilm;
uniform vec3 uCutA;
uniform vec3 uCutB;
uniform float uThree;
uniform float uBlank;
uniform float uUnder;
uniform float uPlotIn;
uniform float uTime;
uniform float uDpr;
uniform vec3 uPaper;
uniform vec3 uStock;
uniform vec3 uRed;
out vec4 o;

float hash(vec2 p){ p = fract(p * vec2(443.897, 441.423)); p += dot(p, p.yx + 19.19); return fract((p.x + p.y) * p.x); }

vec3 ink(vec3 c, vec2 uv){
  float e = texture(uGlow, uv).r;
  float halo = textureLod(uGlow, uv, 2.0).r * 1.6 + textureLod(uGlow, uv, 4.0).r * 2.6;
  vec3 hot = mix(vec3(1.0, 0.36, 0.26), vec3(1.0, 0.93, 0.84), smoothstep(0.45, 0.95, e));
  return c * (1.0 - 0.5 * uDim * (1.0 - e)) + (hot * e * 1.1 + vec3(1.0, 0.24, 0.15) * halo * 0.55) * uGlowAmt;
}
vec3 lit(vec3 c, vec2 uv){
  float e = texture(uGlow, uv).g;
  float halo = textureLod(uGlow, uv, 2.0).g * 1.6 + textureLod(uGlow, uv, 4.0).g * 2.8;
  return c * (1.0 - 0.34 * uDim) + (vec3(1.0, 0.95, 0.82) * e * 1.2 + vec3(1.0, 0.7, 0.36) * halo * 0.62) * uGlowAmt;
}

void main(){
  vec2 px = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);
  vec2 uv = (px - uFilm.xy) / uFilm.zw;
  bool inFilm = all(greaterThanEqual(uv, vec2(0.0))) && all(lessThanEqual(uv, vec2(1.0)));

  vec2 fe = min(uv, 1.0 - uv) * uFilm.zw;
  float edge = smoothstep(0.0, 3.0 * uDpr, min(fe.x, fe.y));
  vec3 plot = inFilm ? mix(uPaper, texture(uPlot, uv).rgb, edge) : uPaper;
  float sweep = uPlotIn * 1.25 - 0.12 + (hash(vec2(floor(px.y / (3.0 * uDpr)), 7.0)) - 0.5) * 0.04;
  plot = mix(uPaper, plot, smoothstep(sweep, sweep - 0.06, uv.x));

  vec3 trace = inFilm ? mix(uStock, texture(uTrace, uv).rgb, edge) : uStock;

  vec3 glyph = texture(uGlyph, px / uRes).rgb;

  float aa = uDpr;
  float sA = dot(uCutA.xy, px) - uCutA.z;
  float sB = dot(uCutB.xy, px) - uCutB.z;
  float kA = smoothstep(-aa * 0.5, aa * 0.5, sA);
  float kB = smoothstep(-aa * 0.5, aa * 0.5, sB) * uThree;
  vec3 c = mix(mix(plot, trace, kA), glyph, kB);
  vec4 source = texture(uOwnPlot, uv);
  vec4 face = texture(uOwnTrace, uv);
  float front = step(uv.x - (uv.y - 0.5) * 0.24 * uFilm.w / uFilm.z, uFront);
  vec4 base = mix(face, source, front);
  base.rgb = mix(lit(face.rgb, uv), ink(source.rgb, uv), front);
  vec3 under = inFilm ? mix(uPaper, base.rgb * 0.82, base.a * uUnder) : uPaper;
  c = mix(c, under, uBlank);

  float hair = 1.1 * uDpr;
  float lineA = 1.0 - smoothstep(hair * 0.5, hair * 0.5 + aa, abs(sA));
  float lineB = (1.0 - smoothstep(hair * 0.5, hair * 0.5 + aa, abs(sB))) * uThree;
  c = mix(c, uRed, max(lineA * mix(1.0, step(sB, 0.0), uThree), lineB) * 0.92 * (1.0 - uBlank));

  float g = hash(floor(px / uDpr) + floor(uTime * 24.0) * 17.0) - 0.5;
  c += g * 0.028;
  o = vec4(c, 1.0);
}`

const SLAT_VS = `#version 300 es
in vec3 aP;
in float aF;
in vec3 aS;
uniform vec4 uFilm;
uniform vec2 uRes;
uniform float uN;
uniform float uAxis;
uniform float uThick;
uniform float uD;
uniform mat3 uRot;
uniform vec3 uShift;
uniform float uActive;
uniform float uRedAmt;
out vec2 vUv;
out vec3 vN;
out vec3 vW;
out float vLocal;
flat out float vFace;
flat out float vTurn;
flat out float vIdx;

void main(){
  float across = uAxis < 0.5 ? uFilm.z : uFilm.w;
  float along = uAxis < 0.5 ? uFilm.w : uFilm.z;
  float sw = across / uN;
  float a = aP.x * sw * 1.004;
  float b = aP.y * along;
  float dActive = aS.x - uActive;
  float z = aP.z * uThick * (1.0 + 1.6 * exp(-dActive * dActive / 0.35) * uRedAmt);
  float c = cos(aS.y);
  float s = sin(aS.y);
  vec3 n = aF < 0.5 ? vec3(0.0, 0.0, 1.0) : aF < 1.5 ? vec3(0.0, 0.0, -1.0) : aF < 2.5 ? vec3(1.0, 0.0, 0.0) : aF < 3.5 ? vec3(-1.0, 0.0, 0.0) : aF < 4.5 ? vec3(0.0, 1.0, 0.0) : vec3(0.0, -1.0, 0.0);
  vec3 p2 = vec3(a * c + z * s, b, -a * s + z * c + aS.z);
  vec3 n2 = vec3(n.x * c + n.z * s, n.y, -n.x * s + n.z * c);
  float ac = (aS.x + 0.5) * sw;
  float shear = uAxis < 0.5 ? 0.24 : 0.0;
  vec3 local = uAxis < 0.5 ? vec3(ac + p2.x + b * shear, along * 0.5 + p2.y - p2.z * 0.85, p2.z) : vec3(along * 0.5 + p2.y, ac + p2.x, p2.z);
  vec3 nl = uAxis < 0.5 ? n2 : vec3(n2.y, n2.x, n2.z);
  vec3 pivot = vec3(uFilm.xy + uFilm.zw * 0.5, 0.0);
  vec3 w = uRot * (vec3(uFilm.xy, 0.0) + local - pivot) + pivot + uShift;
  vW = w;
  vN = uRot * nl;
  float u = (aS.x + 0.5 + (aF > 0.5 && aF < 1.5 ? -aP.x : aP.x)) / uN + b * shear / across;
  float v = aP.y + 0.5;
  vUv = uAxis < 0.5 ? vec2(u, v) : vec2(v, u);
  vLocal = aP.x + 0.5;
  vFace = aF;
  vTurn = abs(s);
  vIdx = aS.x;
  float ww = (uD - w.z) / uD;
  gl_Position = vec4(2.0 * (w.x - uRes.x * 0.5) / uRes.x, -2.0 * (w.y - uRes.y * 0.5) / uRes.y, -w.z / (4.0 * uD), ww);
}`

const SLAT_FS = `#version 300 es
precision highp float;
uniform sampler2D uOwnPlot;
uniform sampler2D uOwnTrace;
uniform sampler2D uGlow;
uniform float uGlowAmt;
uniform float uDim;
uniform vec2 uRes;
uniform float uD;
uniform float uActive;
uniform float uRedAmt;
uniform float uShadow;
uniform float uPlotIn;
uniform float uTime;
uniform float uDpr;
uniform vec3 uRed;
uniform vec3 uEdge;
uniform vec3 uPaper;
in vec2 vUv;
in vec3 vN;
in vec3 vW;
in float vLocal;
flat in float vFace;
flat in float vTurn;
flat in float vIdx;
out vec4 o;

float hash(vec2 p){ p = fract(p * vec2(443.897, 441.423)); p += dot(p, p.yx + 19.19); return fract((p.x + p.y) * p.x); }

vec3 ink(vec3 c, vec2 uv){
  float e = texture(uGlow, uv).r;
  float halo = textureLod(uGlow, uv, 2.0).r * 1.6 + textureLod(uGlow, uv, 4.0).r * 2.6;
  vec3 hot = mix(vec3(1.0, 0.36, 0.26), vec3(1.0, 0.93, 0.84), smoothstep(0.45, 0.95, e));
  return c * (1.0 - 0.5 * uDim * (1.0 - e)) + (hot * e * 1.1 + vec3(1.0, 0.24, 0.15) * halo * 0.55) * uGlowAmt;
}
vec3 lit(vec3 c, vec2 uv){
  float e = texture(uGlow, uv).g;
  float halo = textureLod(uGlow, uv, 2.0).g * 1.6 + textureLod(uGlow, uv, 4.0).g * 2.8;
  return c * (1.0 - 0.34 * uDim) + (vec3(1.0, 0.95, 0.82) * e * 1.2 + vec3(1.0, 0.7, 0.36) * halo * 0.62) * uGlowAmt;
}

void main(){
  if (any(lessThan(vUv, vec2(0.0))) || any(greaterThan(vUv, vec2(1.0)))) discard;
  vec4 src = texture(uOwnPlot, vUv);
  vec4 back = texture(uOwnTrace, vUv);
  float silhouette = max(src.a, back.a);
  vec3 N = normalize(vN);
  vec3 V = normalize(vec3(uRes * 0.5, uD) - vW);
  if (dot(N, V) < 0.0) discard;
  if (vFace > 1.5 && vTurn < 0.02) discard;
  if (uShadow > 0.5) {
    float a = (vFace < 0.5 ? src.a : vFace < 1.5 ? back.a : silhouette);
    if (a < 0.01) discard;
    o = vec4(0.10, 0.08, 0.06, a * 0.075);
    return;
  }
  float alpha = vFace < 0.5 ? src.a : vFace < 1.5 ? back.a : silhouette;
  if (alpha < 0.025) discard;
  vec3 L = normalize(vec3(-0.5, -0.8, 0.55));
  float lam = max(dot(N, L), 0.0);
  float lam0 = L.z;
  float spec = pow(max(dot(reflect(-L, N), V), 0.0), 28.0);
  float dActive = vIdx - uActive;
  float red = exp(-dActive * dActive / 0.35) * uRedAmt;
  vec3 c;
  if (vFace < 1.5) {
    c = vFace < 0.5
      ? ink(mix(uPaper, src.rgb, uPlotIn), vUv)
      : lit(back.rgb, vUv);
    float gap = 1.0 - smoothstep(0.0, 0.32, min(vLocal, 1.0 - vLocal));
    c *= clamp(1.0 - (lam0 - lam) * 0.8, 0.32, 1.0) * (1.0 - 0.16 * vTurn * gap);
    c += spec * 0.12 * vTurn;
    c = mix(c, uRed, red * 0.12 * vTurn * vTurn);
  } else {
    c = uEdge * (0.35 + 1.1 * lam) + vec3(1.0, 0.64, 0.42) * spec * 0.5;
    c = mix(c, uRed * 1.12, clamp(red * 1.4, 0.0, 1.0));
  }
  vec2 px = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);
  c += (hash(floor(px / uDpr) + floor(uTime * 24.0) * 17.0) - 0.5) * 0.028;
  o = vec4(c, alpha);
}`

const BOX = (() => {
  const v: number[] = []
  const quad = (f: number, corners: number[][]) => {
    for (const k of [0, 1, 2, 0, 2, 3]) v.push(...(corners[k] as number[]), f)
  }
  const h = 0.5
  quad(0, [[-h, -h, h], [h, -h, h], [h, h, h], [-h, h, h]])
  quad(1, [[h, -h, -h], [-h, -h, -h], [-h, h, -h], [h, h, -h]])
  quad(2, [[h, -h, h], [h, -h, -h], [h, h, -h], [h, h, h]])
  quad(3, [[-h, -h, -h], [-h, -h, h], [-h, h, h], [-h, h, -h]])
  quad(4, [[-h, h, h], [h, h, h], [h, h, -h], [-h, h, -h]])
  quad(5, [[-h, -h, -h], [h, -h, -h], [h, -h, h], [-h, -h, h]])
  return new Float32Array(v)
})()

export interface ShutterFrame {
  film: { x: number; y: number; w: number; h: number }
  axis: 0 | 1
  /** index, angle, lift per slat */
  slats: Float32Array
  thick: number
  rot: Float32Array
  shift: [number, number, number]
  active: number
  red: number
  plotIn: number
  time: number
  glow?: number
  dim?: number
}

export interface CutLine { nx: number; ny: number; d: number }
export interface CutFrame {
  film: { x: number; y: number; w: number; h: number }
  a: CutLine
  b: CutLine
  three: number
  blank?: number
  dark?: number
  under?: number
  front?: number
  plotIn: number
  time: number
  glow?: number
  dim?: number
}

const hex = (c: string): [number, number, number] => [1, 3, 5].map((i) => Number.parseInt(c.slice(i, i + 2), 16) / 255) as [number, number, number]

export class CutGL {
  readonly gl: WebGL2RenderingContext
  private readonly prog: WebGLProgram
  private readonly tex: WebGLTexture[]
  private readonly loc: Record<string, WebGLUniformLocation | null> = {}

  static create(canvas: HTMLCanvasElement): CutGL | null {
    const gl = canvas.getContext('webgl2', { antialias: true, alpha: false, premultipliedAlpha: false, preserveDrawingBuffer: false })
    if (!gl) return null
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)
      if (!s) return null
      gl.shaderSource(s, src)
      gl.compileShader(s)
      return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null
    }
    const link = (vsrc: string, fsrc: string) => {
      const vs = sh(gl.VERTEX_SHADER, vsrc)
      const fs = sh(gl.FRAGMENT_SHADER, fsrc)
      const prog = gl.createProgram()
      if (!vs || !fs) return null
      gl.attachShader(prog, vs)
      gl.attachShader(prog, fs)
      gl.linkProgram(prog)
      return gl.getProgramParameter(prog, gl.LINK_STATUS) ? prog : null
    }
    const prog = link(VS, FS)
    const slat = link(SLAT_VS, SLAT_FS)
    if (!prog || !slat) return null
    return new CutGL(gl, prog, slat)
  }

  private readonly slat: WebGLProgram
  private readonly slatVao: WebGLVertexArrayObject
  private readonly slatBuf: WebGLBuffer
  private slatCap = 0
  private readonly sloc: Record<string, WebGLUniformLocation | null> = {}

  private constructor(gl: WebGL2RenderingContext, prog: WebGLProgram, slat: WebGLProgram) {
    this.gl = gl
    this.prog = prog
    this.slat = slat
    gl.useProgram(prog)
    const buf = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
    const a = gl.getAttribLocation(prog, 'aP')
    gl.enableVertexAttribArray(a)
    gl.vertexAttribPointer(a, 2, gl.FLOAT, false, 0, 0)
    for (const n of ['uRes', 'uFilm', 'uCutA', 'uCutB', 'uThree', 'uBlank', 'uUnder', 'uFront', 'uPlotIn', 'uTime', 'uDpr', 'uPaper', 'uStock', 'uRed', 'uGlowAmt', 'uDim']) this.loc[n] = gl.getUniformLocation(prog, n)
    this.tex = ['uPlot', 'uTrace', 'uGlyph', 'uOwnPlot', 'uOwnTrace', 'uGlow'].map((name, i) => {
      const t = gl.createTexture()
      gl.activeTexture(gl.TEXTURE0 + i)
      gl.bindTexture(gl.TEXTURE_2D, t)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(i === 0 || i === 3 ? [236, 237, 233, 255] : i === 5 ? [0, 0, 0, 255] : [11, 11, 11, 255]))
      gl.uniform1i(gl.getUniformLocation(prog, name), i)
      return t
    })
    gl.uniform3fv(this.loc.uPaper ?? null, hex('#ecede9'))
    gl.uniform3fv(this.loc.uStock ?? null, hex('#0b0b0b'))
    gl.uniform3fv(this.loc.uRed ?? null, hex('#c4221a'))

    this.slatVao = gl.createVertexArray()
    gl.bindVertexArray(this.slatVao)
    const box = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, box)
    gl.bufferData(gl.ARRAY_BUFFER, BOX, gl.STATIC_DRAW)
    const aP = gl.getAttribLocation(slat, 'aP')
    const aF = gl.getAttribLocation(slat, 'aF')
    gl.enableVertexAttribArray(aP)
    gl.vertexAttribPointer(aP, 3, gl.FLOAT, false, 16, 0)
    gl.enableVertexAttribArray(aF)
    gl.vertexAttribPointer(aF, 1, gl.FLOAT, false, 16, 12)
    this.slatBuf = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, this.slatBuf)
    const aS = gl.getAttribLocation(slat, 'aS')
    gl.enableVertexAttribArray(aS)
    gl.vertexAttribPointer(aS, 3, gl.FLOAT, false, 0, 0)
    gl.vertexAttribDivisor(aS, 1)
    gl.bindVertexArray(null)
    gl.useProgram(slat)
    for (const n of ['uFilm', 'uRes', 'uN', 'uAxis', 'uThick', 'uD', 'uRot', 'uShift', 'uActive', 'uRedAmt', 'uShadow', 'uPlotIn', 'uTime', 'uDpr', 'uGlowAmt', 'uDim']) this.sloc[n] = gl.getUniformLocation(slat, n)
    gl.uniform1i(gl.getUniformLocation(slat, 'uOwnPlot'), 3)
    gl.uniform1i(gl.getUniformLocation(slat, 'uOwnTrace'), 4)
    gl.uniform1i(gl.getUniformLocation(slat, 'uGlow'), 5)
    gl.uniform3fv(gl.getUniformLocation(slat, 'uRed'), hex('#e0261c'))
    gl.uniform3fv(gl.getUniformLocation(slat, 'uEdge'), hex('#1c1b1a'))
    gl.uniform3fv(gl.getUniformLocation(slat, 'uPaper'), hex('#ecede9'))
  }

  upload(slot: 0 | 1 | 2 | 3 | 4 | 5, src: TexImageSource): void {
    const gl = this.gl
    gl.activeTexture(gl.TEXTURE0 + slot)
    gl.bindTexture(gl.TEXTURE_2D, this.tex[slot] ?? null)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src)
    if (slot !== 2) {
      gl.generateMipmap(gl.TEXTURE_2D)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR)
    }
  }

  /** the film as a shutter of slats: plot on their fronts, the lit film on their backs, seen through a perspective camera */
  shutter(f: ShutterFrame, dpr: number): void {
    const gl = this.gl
    const { width, height } = gl.canvas
    const n = f.slats.length / 3
    gl.useProgram(this.slat)
    gl.bindVertexArray(this.slatVao)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.slatBuf)
    if (n > this.slatCap) { gl.bufferData(gl.ARRAY_BUFFER, f.slats, gl.DYNAMIC_DRAW); this.slatCap = n } else gl.bufferSubData(gl.ARRAY_BUFFER, 0, f.slats)
    const L = this.sloc
    gl.uniform4f(L.uFilm ?? null, f.film.x, f.film.y, f.film.w, f.film.h)
    gl.uniform2f(L.uRes ?? null, width, height)
    gl.uniform1f(L.uN ?? null, n)
    gl.uniform1f(L.uAxis ?? null, f.axis)
    gl.uniform1f(L.uThick ?? null, f.thick)
    gl.uniform1f(L.uD ?? null, height * 1.5)
    gl.uniformMatrix3fv(L.uRot ?? null, false, f.rot)
    gl.uniform3f(L.uShift ?? null, ...f.shift)
    gl.uniform1f(L.uActive ?? null, f.active)
    gl.uniform1f(L.uRedAmt ?? null, f.red)
    gl.uniform1f(L.uPlotIn ?? null, f.plotIn)
    gl.uniform1f(L.uTime ?? null, f.time)
    gl.uniform1f(L.uDpr ?? null, dpr)
    gl.uniform1f(L.uGlowAmt ?? null, f.glow ?? 0)
    gl.uniform1f(L.uDim ?? null, f.dim ?? 0)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
    gl.disable(gl.DEPTH_TEST)
    gl.depthMask(false)
    gl.uniform1f(L.uShadow ?? null, 1)
    gl.uniform3f(L.uShift ?? null, f.shift[0], f.shift[1] + 8 * dpr, f.shift[2])
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 36, n)
    gl.uniform1f(L.uShadow ?? null, 0)
    gl.uniform3f(L.uShift ?? null, ...f.shift)
    gl.enable(gl.DEPTH_TEST)
    gl.depthMask(true)
    gl.clear(gl.DEPTH_BUFFER_BIT)
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 36, n)
    gl.disable(gl.DEPTH_TEST)
    gl.disable(gl.BLEND)
    gl.bindVertexArray(null)
  }

  draw(f: CutFrame, dpr: number): void {
    const gl = this.gl
    const { width, height } = gl.canvas
    gl.viewport(0, 0, width, height)
    gl.useProgram(this.prog)
    const L = this.loc
    gl.uniform2f(L.uRes ?? null, width, height)
    gl.uniform4f(L.uFilm ?? null, f.film.x, f.film.y, f.film.w, f.film.h)
    gl.uniform3f(L.uCutA ?? null, f.a.nx, f.a.ny, f.a.d)
    gl.uniform3f(L.uCutB ?? null, f.b.nx, f.b.ny, f.b.d)
    gl.uniform1f(L.uThree ?? null, f.three)
    const dark = f.dark ?? 0
    gl.uniform3f(L.uPaper ?? null, (236 - 231 * dark) / 255, (237 - 232 * dark) / 255, (233 - 228 * dark) / 255)
    gl.uniform1f(L.uUnder ?? null, f.under ?? 1)
    gl.uniform1f(L.uBlank ?? null, f.blank ?? 0)
    gl.uniform1f(L.uFront ?? null, f.front ?? 0)
    gl.uniform1f(L.uPlotIn ?? null, f.plotIn)
    gl.uniform1f(L.uTime ?? null, f.time)
    gl.uniform1f(L.uDpr ?? null, dpr)
    gl.uniform1f(L.uGlowAmt ?? null, f.glow ?? 0)
    gl.uniform1f(L.uDim ?? null, f.dim ?? 0)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }
}
