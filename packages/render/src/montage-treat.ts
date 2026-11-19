import { FONT } from './font'

export type TreatKind = 'dots' | 'dither' | 'ascii' | 'blueprint'

export interface TreatOptions {
  kind: TreatKind
  progress: number
  cell: number
  dark: string
  light: string
  invert: boolean
  stream: string
  seed: number
  gain?: number
}

export interface Treat {
  render(source: CanvasImageSource, o: TreatOptions): CanvasImageSource
  dispose(): void
}

const VS = `#version 300 es
in vec2 a;
out vec2 v;
void main() { v = a * 0.5 + 0.5; gl_Position = vec4(a, 0.0, 1.0); }`

const FS = `#version 300 es
precision highp float;
in vec2 v;
out vec4 o;
uniform sampler2D uSrc;
uniform sampler2D uAtlas;
uniform sampler2D uGlyph;
uniform vec2 uRes;
uniform int uKind;
uniform float uCell;
uniform float uProgress;
uniform vec3 uDark;
uniform vec3 uLight;
uniform int uInvert;
uniform float uSeed;
uniform float uGain;
uniform vec2 uGrid;
uniform float uAtlasCols;

float luma(vec2 px) {
  vec3 c = texture(uSrc, px / uRes).rgb;
  float l = clamp(dot(c, vec3(0.2126, 0.7152, 0.0722)) * uGain, 0.0, 1.0);
  return uInvert == 1 ? 1.0 - l : l;
}

// the mean over a 3x3 patch: a print takes its edges from this, so a body's surface texture draws no lines
float meanAt(vec2 px, float s) {
  float a = 0.0;
  for (int i = -1; i <= 1; i++) for (int j = -1; j <= 1; j++) a += luma(px + vec2(float(i), float(j)) * s);
  return a / 9.0;
}

float bayer(ivec2 p) {
  int x = p.x & 7;
  int y = p.y & 7;
  int v = 0;
  int xy = x ^ y;
  v |= ((xy & 1) << 5) | ((x & 1) << 4) | (((xy >> 1) & 1) << 3) | (((x >> 1) & 1) << 2) | (((xy >> 2) & 1) << 1) | ((x >> 2) & 1);
  return (float(v) + 0.5) / 64.0;
}

vec3 inks(float on) {
  return uInvert == 1 ? mix(uLight, uDark, on) : mix(uDark, uLight, on);
}

void main() {
  vec2 px = vec2(v.x * uRes.x, (1.0 - v.y) * uRes.y);
  vec3 src = texture(uSrc, px / uRes).rgb;
  vec2 c = uRes * 0.5;
  if (uKind == 0) {
    mat2 rot = mat2(0.70710678, -0.70710678, 0.70710678, 0.70710678);
    vec2 q = rot * (px - c);
    vec2 id = floor(q / uCell + 0.5);
    vec2 ctr = transpose(rot) * (id * uCell) + c;
    float l = luma(ctr);
    float r = l < 0.08 ? 0.0 : sqrt(clamp(l, 0.0, 1.0)) * uCell * 0.62 * uProgress;
    float d = length(q - id * uCell);
    o = vec4(inks(1.0 - smoothstep(r - 0.6, r + 0.6, d)), 1.0);
    return;
  }
  if (uKind == 1) {
    vec2 id = floor(px / uCell);
    float l = luma(id * uCell + uCell * 0.5);
    float on = l > bayer(ivec2(id)) ? 1.0 : 0.0;
    o = vec4(inks(on), 1.0);
    return;
  }
  if (uKind == 3) {
    float s = uCell;
    float gx = meanAt(px + vec2(s, 0.0), s) - meanAt(px - vec2(s, 0.0), s);
    float gy = meanAt(px + vec2(0.0, s), s) - meanAt(px - vec2(0.0, s), s);
    float wide = 3.0 * s;
    float wx = meanAt(px + vec2(wide, 0.0), wide) - meanAt(px - vec2(wide, 0.0), wide);
    float wy = meanAt(px + vec2(0.0, wide), wide) - meanAt(px - vec2(0.0, wide), wide);
    float fine = length(vec2(gx, gy));
    float hard = smoothstep(0.45, 0.75, fine / max(length(vec2(wx, wy)), 1e-4));
    float e = smoothstep(0.06, 0.2, fine) * hard;
    vec2 g = abs(fract(px / (uCell * 24.0) + 0.5) - 0.5) * uCell * 24.0;
    float grid = (1.0 - smoothstep(0.0, 1.2, min(g.x, g.y))) * 0.22;
    o = vec4(mix(uDark, uLight, max(e, grid)), 1.0);
    return;
  }
  vec2 cell = vec2(uCell * 0.6, uCell);
  vec2 id = floor(px / cell);
  vec2 f = (px - id * cell) / cell;
  float l = 0.0;
  for (int i = 0; i < 4; i++) for (int j = 0; j < 4; j++) l += step(0.72, luma((id + (vec2(float(i), float(j)) + 0.5) / 4.0) * cell));
  l /= 16.0;
  float on = 0.0;
  if (l >= 0.45) {
    float g = 0.0;
    if (l >= 0.6) {
      g = floor(texture(uGlyph, (mod(id, uGrid) + 0.5) / uGrid).r * 255.0 + 0.5);
      if (g >= 0.5 && l >= 0.9) g += 128.0;
      if (g < 0.5) g = 1.0;
    }
    float row = floor(g / uAtlasCols);
    float col = g - row * uAtlasCols;
    vec2 aUv = (vec2(col, row) + f) / vec2(uAtlasCols, 16.0);
    on = texture(uAtlas, aUv).a;
  }
  o = vec4(mix(uDark, uLight, on), 1.0);
}`

export function createTreat(width: number, height: number): Treat | undefined {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const gl = canvas.getContext('webgl2', { premultipliedAlpha: false, preserveDrawingBuffer: true })
  if (gl === null) return undefined
  const shader = (type: number, src: string): WebGLShader | undefined => {
    const s = gl.createShader(type) as WebGLShader
    gl.shaderSource(s, src)
    gl.compileShader(s)
    return gl.getShaderParameter(s, gl.COMPILE_STATUS) === true ? s : undefined
  }
  const vs = shader(gl.VERTEX_SHADER, VS)
  const fs = shader(gl.FRAGMENT_SHADER, FS)
  if (vs === undefined || fs === undefined) return undefined
  const prog = gl.createProgram()
  gl.attachShader(prog, vs)
  gl.attachShader(prog, fs)
  gl.bindAttribLocation(prog, 0, 'a')
  gl.linkProgram(prog)
  if (gl.getProgramParameter(prog, gl.LINK_STATUS) !== true) return undefined
  const buf = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, buf)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
  const texture = (): WebGLTexture => {
    const t = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, t)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    return t
  }
  const src = texture()
  const atlas = texture()
  const glyphs = texture()
  const COLS = 16
  let atlasKey = ''
  const loc = (n: string): WebGLUniformLocation | null => gl.getUniformLocation(prog, n)
  const rgb = (hex: string): [number, number, number] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number]

  const buildAtlas = (stream: string, cell: number): [number, number] => {
    const chars = [...new Set(stream)].slice(0, 126)
    const cw = Math.round(cell * 0.6)
    const ch = Math.round(cell)
    const a = document.createElement('canvas')
    a.width = cw * COLS
    a.height = ch * 16
    const c = a.getContext('2d') as CanvasRenderingContext2D
    c.textAlign = 'center'
    c.textBaseline = 'middle'
    c.fillStyle = '#fff'
    const put = (glyph: string, index: number, bold: boolean): void => {
      c.font = `${bold ? 700 : 500} ${Math.round(cell * 0.92)}px ${FONT}`
      c.fillText(glyph, (index % COLS) * cw + cw / 2, Math.floor(index / COLS) * ch + ch * 0.54)
    }
    put('.', 0, false)
    put(':', 1, false)
    chars.forEach((g, i) => {
      put(g, i + 2, false)
      put(g, i + 130, true)
    })
    gl.bindTexture(gl.TEXTURE_2D, atlas)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, a)
    const cols = Math.ceil(width / (cell * 0.6))
    const rows = Math.ceil(height / cell)
    const index = new Uint8Array(cols * rows)
    const codes = Array.from(stream)
    for (let i = 0; i < index.length; i++) {
      const g = codes[i % codes.length] as string
      index[i] = g === ' ' ? 0 : chars.indexOf(g) + 2
    }
    gl.bindTexture(gl.TEXTURE_2D, glyphs)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, cols, rows, 0, gl.RED, gl.UNSIGNED_BYTE, index)
    return [cols, rows]
  }
  let grid: [number, number] = [1, 1]

  return {
    render(source, o) {
      gl.viewport(0, 0, width, height)
      gl.useProgram(prog)
      if (o.kind === 'ascii' && atlasKey !== `${o.stream}|${o.cell}`) {
        atlasKey = `${o.stream}|${o.cell}`
        grid = buildAtlas(o.stream, o.cell)
      }
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, src)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source as TexImageSource)
      gl.activeTexture(gl.TEXTURE1)
      gl.bindTexture(gl.TEXTURE_2D, atlas)
      gl.activeTexture(gl.TEXTURE2)
      gl.bindTexture(gl.TEXTURE_2D, glyphs)
      gl.uniform1i(loc('uSrc'), 0)
      gl.uniform1i(loc('uAtlas'), 1)
      gl.uniform1i(loc('uGlyph'), 2)
      gl.uniform2f(loc('uRes'), width, height)
      gl.uniform1i(loc('uKind'), { dots: 0, dither: 1, ascii: 2, blueprint: 3 }[o.kind])
      gl.uniform1f(loc('uCell'), o.cell)
      gl.uniform1f(loc('uProgress'), o.progress)
      gl.uniform3f(loc('uDark'), ...rgb(o.dark))
      gl.uniform3f(loc('uLight'), ...rgb(o.light))
      gl.uniform1i(loc('uInvert'), o.invert ? 1 : 0)
      gl.uniform1f(loc('uSeed'), o.seed % 97)
      gl.uniform1f(loc('uGain'), o.gain ?? 1)
      gl.uniform2f(loc('uGrid'), grid[0], grid[1])
      gl.uniform1f(loc('uAtlasCols'), COLS)
      gl.bindBuffer(gl.ARRAY_BUFFER, buf)
      gl.enableVertexAttribArray(0)
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
      return canvas
    },
    dispose() {
      gl.getExtension('WEBGL_lose_context')?.loseContext()
    }
  }
}
