const VS = `#version 300 es
in vec3 aP;
in float aF;
in vec4 aS;
in float aR;
uniform vec4 uFilm;
uniform vec2 uRes;
uniform float uN;
uniform float uThick;
uniform float uD;
uniform float uShear;
uniform float uDrop;
out vec2 vUv;
out vec3 vN;
out vec3 vW;
out float vLocal;
flat out float vFace;
flat out float vTurn;
flat out float vPair;
flat out float vRed;

void main(){
  float sw = uFilm.z / uN;
  float a = aP.x * sw * 1.004;
  float b = aP.y * uFilm.w;
  float z = aP.z * uThick * (1.0 + 1.6 * aR);
  float c = cos(aS.y);
  float s = sin(aS.y);
  vec3 n = aF < 0.5 ? vec3(0.0, 0.0, 1.0) : aF < 1.5 ? vec3(0.0, 0.0, -1.0) : aF < 2.5 ? vec3(1.0, 0.0, 0.0) : aF < 3.5 ? vec3(-1.0, 0.0, 0.0) : aF < 4.5 ? vec3(0.0, 1.0, 0.0) : vec3(0.0, -1.0, 0.0);
  vec3 p = vec3(a * c + z * s, b, -a * s + z * c + aS.z);
  vN = vec3(n.x * c + n.z * s, n.y, -n.x * s + n.z * c);
  vec3 w = vec3(uFilm.x + (aS.x + 0.5) * sw + p.x + b * uShear, uFilm.y + uFilm.w * 0.5 + p.y - p.z * 0.22 + uDrop, p.z);
  vW = w;
  vUv = vec2((aS.x + 0.5 + (aF > 0.5 && aF < 1.5 ? -aP.x : aP.x)) / uN + b * uShear / uFilm.z, aP.y + 0.5);
  vLocal = aP.x + 0.5;
  vFace = aF;
  vTurn = abs(s);
  vPair = aS.w;
  vRed = aR;
  gl_Position = vec4(2.0 * (w.x - uRes.x * 0.5) / uRes.x, -2.0 * (w.y - uRes.y * 0.5) / uRes.y, -w.z / (4.0 * uD), (uD - w.z) / uD);
}`

const FS = `#version 300 es
precision highp float;
uniform sampler2D uA;
uniform sampler2D uB;
uniform sampler2D uC;
uniform sampler2D uE;
uniform vec2 uRes;
uniform float uD;
uniform float uShadow;
in vec2 vUv;
in vec3 vN;
in vec3 vW;
in float vLocal;
flat in float vFace;
flat in float vTurn;
flat in float vPair;
flat in float vRed;
out vec4 o;

vec4 look(vec4 a, vec4 b, vec4 c, vec4 e, float i){
  return i < 0.5 ? a : i < 1.5 ? b : i < 2.5 ? c : e;
}

void main(){
  if (any(lessThan(vUv, vec2(0.0))) || any(greaterThan(vUv, vec2(1.0)))) discard;
  vec4 a = texture(uA, vUv);
  vec4 b = texture(uB, vUv);
  vec4 c3 = texture(uC, vUv);
  vec4 e = texture(uE, vUv);
  vec4 front = look(a, b, c3, e, vPair);
  vec4 back = look(a, b, c3, e, vPair + 1.0);
  vec3 N = normalize(vN);
  vec3 V = normalize(vec3(uRes * 0.5, uD) - vW);
  if (dot(N, V) < 0.0) discard;
  if (vFace > 1.5 && vTurn < 0.02) discard;
  float alpha = vFace < 0.5 ? front.a : vFace < 1.5 ? back.a : max(front.a, back.a);
  if (alpha < 0.025) discard;
  if (uShadow > 0.5) { o = vec4(0.0, 0.0, 0.0, alpha * 0.08); return; }
  vec3 L = normalize(vec3(-0.5, -0.8, 0.55));
  float lam = max(dot(N, L), 0.0);
  float spec = pow(max(dot(reflect(-L, N), V), 0.0), 28.0);
  vec3 red = vec3(0.878, 0.149, 0.11);
  vec3 c;
  if (vFace < 1.5) {
    c = vFace < 0.5 ? front.rgb : back.rgb;
    float gap = 1.0 - smoothstep(0.0, 0.32, min(vLocal, 1.0 - vLocal));
    c *= clamp(1.0 - (L.z - lam) * 0.8, 0.32, 1.0) * (1.0 - 0.16 * vTurn * gap);
    c += spec * 0.12 * vTurn;
    c = mix(c, red, vRed * 0.12 * vTurn * vTurn);
  } else {
    c = vec3(0.11, 0.106, 0.102) * (0.35 + 1.1 * lam) + vec3(1.0, 0.64, 0.42) * spec * 0.5;
    c = mix(c, red * 1.12, clamp(vRed * 1.4, 0.0, 1.0));
  }
  o = vec4(c * alpha, alpha);
}`

const UNDER_VS = `#version 300 es
in vec2 aQ;
uniform vec4 uFilm;
uniform vec2 uRes;
out vec2 vUv;
void main(){
  vUv = aQ;
  vec2 p = uFilm.xy + aQ * uFilm.zw;
  gl_Position = vec4(2.0 * p.x / uRes.x - 1.0, 1.0 - 2.0 * p.y / uRes.y, 0.0, 1.0);
}`

const UNDER_FS = `#version 300 es
precision highp float;
uniform sampler2D uA;
uniform sampler2D uB;
uniform sampler2D uC;
uniform sampler2D uE;
uniform vec4 uFilm;
uniform vec3 uSeam;
uniform float uShear;
in vec2 vUv;
out vec4 o;
void main(){
  float x = vUv.x - (vUv.y - 0.5) * uShear * uFilm.w / uFilm.z;
  vec4 a = texture(uA, vUv);
  vec4 b = texture(uB, vUv);
  vec4 c3 = texture(uC, vUv);
  vec4 e = texture(uE, vUv);
  vec4 c = x < uSeam.x ? a : x < uSeam.y ? b : x < uSeam.z ? c3 : e;
  o = vec4(c.rgb * 0.8 * c.a, c.a);
}`

const BOX = (() => {
  const v: number[] = []
  const quad = (f: number, corners: number[][]) => { for (const k of [0, 1, 2, 0, 2, 3]) v.push(...(corners[k] as number[]), f) }
  const h = 0.5
  quad(0, [[-h, -h, h], [h, -h, h], [h, h, h], [-h, h, h]])
  quad(1, [[h, -h, -h], [-h, -h, -h], [-h, h, -h], [h, h, -h]])
  quad(2, [[h, -h, h], [h, -h, -h], [h, h, -h], [h, h, h]])
  quad(3, [[-h, -h, -h], [-h, -h, h], [-h, h, h], [-h, h, -h]])
  quad(4, [[-h, h, h], [h, h, h], [h, h, -h], [-h, h, -h]])
  quad(5, [[-h, -h, -h], [h, -h, -h], [h, -h, h], [-h, -h, h]])
  return new Float32Array(v)
})()

const HALF = Math.PI / 2
const SHEAR = 0.1
const smooth = (v: number) => { const x = Math.min(1, Math.max(0, v)); return x * x * (3 - 2 * x) }

export interface Film { x: number; y: number; w: number; h: number }

/** one board behind a shutter of slats: four stills from one camera, a seam between each pair, every slat turning as a seam passes it */
export class LooksGL {
  private readonly gl: WebGL2RenderingContext
  private readonly slat: WebGLProgram
  private readonly under: WebGLProgram
  private readonly vao: WebGLVertexArrayObject
  private readonly quad: WebGLVertexArrayObject
  private readonly inst: WebGLBuffer
  private data = new Float32Array(0)
  private readonly tex: WebGLTexture[]

  static create(canvas: HTMLCanvasElement): LooksGL | null {
    const gl = canvas.getContext('webgl2', { antialias: true, alpha: true, premultipliedAlpha: true })
    if (!gl) return null
    const link = (vsrc: string, fsrc: string) => {
      const prog = gl.createProgram()
      for (const [type, src] of [[gl.VERTEX_SHADER, vsrc], [gl.FRAGMENT_SHADER, fsrc]] as const) {
        const s = gl.createShader(type)
        if (!s) return null
        gl.shaderSource(s, src)
        gl.compileShader(s)
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) return null
        gl.attachShader(prog, s)
      }
      gl.linkProgram(prog)
      return gl.getProgramParameter(prog, gl.LINK_STATUS) ? prog : null
    }
    const slat = link(VS, FS)
    const under = link(UNDER_VS, UNDER_FS)
    return slat && under ? new LooksGL(gl, slat, under) : null
  }

  private constructor(gl: WebGL2RenderingContext, slat: WebGLProgram, under: WebGLProgram) {
    this.gl = gl
    this.slat = slat
    this.under = under
    this.vao = gl.createVertexArray()
    gl.bindVertexArray(this.vao)
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer())
    gl.bufferData(gl.ARRAY_BUFFER, BOX, gl.STATIC_DRAW)
    const at = (name: string) => gl.getAttribLocation(slat, name)
    gl.enableVertexAttribArray(at('aP'))
    gl.vertexAttribPointer(at('aP'), 3, gl.FLOAT, false, 16, 0)
    gl.enableVertexAttribArray(at('aF'))
    gl.vertexAttribPointer(at('aF'), 1, gl.FLOAT, false, 16, 12)
    this.inst = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, this.inst)
    gl.enableVertexAttribArray(at('aS'))
    gl.vertexAttribPointer(at('aS'), 4, gl.FLOAT, false, 20, 0)
    gl.vertexAttribDivisor(at('aS'), 1)
    gl.enableVertexAttribArray(at('aR'))
    gl.vertexAttribPointer(at('aR'), 1, gl.FLOAT, false, 20, 16)
    gl.vertexAttribDivisor(at('aR'), 1)
    this.quad = gl.createVertexArray()
    gl.bindVertexArray(this.quad)
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer())
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1]), gl.STATIC_DRAW)
    const aQ = gl.getAttribLocation(under, 'aQ')
    gl.enableVertexAttribArray(aQ)
    gl.vertexAttribPointer(aQ, 2, gl.FLOAT, false, 0, 0)
    gl.bindVertexArray(null)
    this.tex = ['uA', 'uB', 'uC', 'uE'].map((name, i) => {
      const t = gl.createTexture()
      gl.activeTexture(gl.TEXTURE0 + i)
      gl.bindTexture(gl.TEXTURE_2D, t)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4))
      for (const prog of [slat, under]) { gl.useProgram(prog); gl.uniform1i(gl.getUniformLocation(prog, name), i) }
      return t
    })
  }

  upload(slot: number, src: TexImageSource): void {
    const gl = this.gl
    gl.activeTexture(gl.TEXTURE0 + slot)
    gl.bindTexture(gl.TEXTURE_2D, this.tex[slot] ?? null)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src)
    gl.generateMipmap(gl.TEXTURE_2D)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR)
  }

  draw(film: Film, n: number, seams: readonly [number, number, number], dpr: number): void {
    const gl = this.gl
    const { width, height } = gl.canvas
    if (this.data.length !== n * 5) this.data = new Float32Array(n * 5)
    const sw = film.w / n
    const reach = 0.055
    const settle = 0.03
    for (let i = 0; i < n; i++) {
      const x = (i + 0.5) / n
      const pair = x < (seams[0] + seams[1]) / 2 ? 0 : x < (seams[1] + seams[2]) / 2 ? 1 : 2
      const seam = seams[pair]
      const even = pair % 2 === 0
      const s = even ? x - seam : seam - x
      const turn = HALF * smooth((s + reach) / reach) + HALF * smooth(s / settle)
      const a = even ? turn : Math.PI - turn
      const d = (a - HALF) / 0.3
      this.data.set([i, a, Math.abs(Math.sin(a)) * sw * 0.9, pair, Math.exp(-d * d)], i * 5)
    }
    gl.viewport(0, 0, width, height)
    gl.clearColor(0, 0, 0, 0)
    gl.depthMask(true)
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    gl.disable(gl.DEPTH_TEST)
    gl.depthMask(false)
    gl.useProgram(this.under)
    const U = (name: string) => gl.getUniformLocation(this.under, name)
    gl.uniform4f(U('uFilm'), film.x, film.y, film.w, film.h)
    gl.uniform2f(U('uRes'), width, height)
    gl.uniform3f(U('uSeam'), ...seams)
    gl.uniform1f(U('uShear'), SHEAR)
    gl.bindVertexArray(this.quad)
    gl.drawArrays(gl.TRIANGLES, 0, 6)
    gl.useProgram(this.slat)
    const S = (name: string) => gl.getUniformLocation(this.slat, name)
    gl.bindVertexArray(this.vao)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.inst)
    gl.bufferData(gl.ARRAY_BUFFER, this.data, gl.DYNAMIC_DRAW)
    gl.uniform4f(S('uFilm'), film.x, film.y, film.w, film.h)
    gl.uniform2f(S('uRes'), width, height)
    gl.uniform1f(S('uN'), n)
    gl.uniform1f(S('uThick'), Math.max(1.5 * dpr, sw * 0.05))
    gl.uniform1f(S('uD'), height * 1.5)
    gl.uniform1f(S('uShear'), SHEAR)
    gl.uniform1f(S('uShadow'), 1)
    gl.uniform1f(S('uDrop'), 8 * dpr)
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 36, n)
    gl.uniform1f(S('uShadow'), 0)
    gl.uniform1f(S('uDrop'), 0)
    gl.enable(gl.DEPTH_TEST)
    gl.depthMask(true)
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 36, n)
    gl.disable(gl.DEPTH_TEST)
    gl.bindVertexArray(null)
  }
}
