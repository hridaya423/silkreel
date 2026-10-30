const VS = `#version 300 es
in vec2 aP;
void main(){ gl_Position = vec4(aP, 0.0, 1.0); }`

const FS = `#version 300 es
precision highp float;
uniform sampler2D uPlot;
uniform sampler2D uTrace;
uniform sampler2D uGlyph;
uniform vec2 uRes;
uniform vec4 uFilm;
uniform vec3 uCutA;
uniform vec3 uCutB;
uniform float uThree;
uniform float uPlotIn;
uniform float uTime;
uniform float uDpr;
uniform vec3 uPaper;
uniform vec3 uStock;
uniform vec3 uRed;
out vec4 o;

float hash(vec2 p){ p = fract(p * vec2(443.897, 441.423)); p += dot(p, p.yx + 19.19); return fract((p.x + p.y) * p.x); }

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

  float hair = 1.1 * uDpr;
  float lineA = 1.0 - smoothstep(hair * 0.5, hair * 0.5 + aa, abs(sA));
  float lineB = (1.0 - smoothstep(hair * 0.5, hair * 0.5 + aa, abs(sB))) * uThree;
  c = mix(c, uRed, max(lineA * mix(1.0, step(sB, 0.0), uThree), lineB) * 0.92);

  float g = hash(floor(px / uDpr) + floor(uTime * 24.0) * 17.0) - 0.5;
  c += g * 0.028;
  o = vec4(c, 1.0);
}`

export interface CutLine { nx: number; ny: number; d: number }
export interface CutFrame {
  film: { x: number; y: number; w: number; h: number }
  a: CutLine
  b: CutLine
  three: number
  plotIn: number
  time: number
}

const hex = (c: string): [number, number, number] => [1, 3, 5].map((i) => Number.parseInt(c.slice(i, i + 2), 16) / 255) as [number, number, number]

export class CutGL {
  readonly gl: WebGL2RenderingContext
  private readonly prog: WebGLProgram
  private readonly tex: WebGLTexture[]
  private readonly loc: Record<string, WebGLUniformLocation | null> = {}

  static create(canvas: HTMLCanvasElement): CutGL | null {
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, premultipliedAlpha: false, preserveDrawingBuffer: false })
    if (!gl) return null
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)
      if (!s) return null
      gl.shaderSource(s, src)
      gl.compileShader(s)
      return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null
    }
    const vs = sh(gl.VERTEX_SHADER, VS)
    const fs = sh(gl.FRAGMENT_SHADER, FS)
    const prog = gl.createProgram()
    if (!vs || !fs) return null
    gl.attachShader(prog, vs)
    gl.attachShader(prog, fs)
    gl.linkProgram(prog)
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null
    return new CutGL(gl, prog)
  }

  private constructor(gl: WebGL2RenderingContext, prog: WebGLProgram) {
    this.gl = gl
    this.prog = prog
    gl.useProgram(prog)
    const buf = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
    const a = gl.getAttribLocation(prog, 'aP')
    gl.enableVertexAttribArray(a)
    gl.vertexAttribPointer(a, 2, gl.FLOAT, false, 0, 0)
    for (const n of ['uRes', 'uFilm', 'uCutA', 'uCutB', 'uThree', 'uPlotIn', 'uTime', 'uDpr', 'uPaper', 'uStock', 'uRed']) this.loc[n] = gl.getUniformLocation(prog, n)
    this.tex = ['uPlot', 'uTrace', 'uGlyph'].map((name, i) => {
      const t = gl.createTexture()
      gl.activeTexture(gl.TEXTURE0 + i)
      gl.bindTexture(gl.TEXTURE_2D, t)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(i === 0 ? [236, 237, 233, 255] : [11, 11, 11, 255]))
      gl.uniform1i(gl.getUniformLocation(prog, name), i)
      return t
    })
    gl.uniform3fv(this.loc.uPaper ?? null, hex('#ecede9'))
    gl.uniform3fv(this.loc.uStock ?? null, hex('#0b0b0b'))
    gl.uniform3fv(this.loc.uRed ?? null, hex('#c4221a'))
  }

  upload(slot: 0 | 1 | 2, src: TexImageSource): void {
    const gl = this.gl
    gl.activeTexture(gl.TEXTURE0 + slot)
    gl.bindTexture(gl.TEXTURE_2D, this.tex[slot] ?? null)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src)
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
    gl.uniform1f(L.uPlotIn ?? null, f.plotIn)
    gl.uniform1f(L.uTime ?? null, f.time)
    gl.uniform1f(L.uDpr ?? null, dpr)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }
}
