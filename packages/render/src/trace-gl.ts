import { makeCam, norm, sampleShot } from '@silk-reel/choreo'
import type { Cam, CameraShot, TraceTimeline } from '@silk-reel/choreo'
import { createMaps, drawMaps } from './trace-maps'
import type { MapSet, Region } from './trace-maps'
import { compileShader } from './post'

/**
 * The lit trace renderer. The board is a physical plate on a dark studio
 * floor under a real perspective camera: copper has sharp shoulders and a
 * metal's reflection, mask is a glossy dielectric that coats it, silk is
 * matte ink, the finish is the board's own gold or tin, and the parts are
 * bodies with weight. Lit surfaces stop below the bloom threshold, so only
 * light the score authors (routing heads, power, data, the LEDs) blooms.
 *
 * Per frame: draw board-space data maps (trace-maps) for the region the
 * camera sees → render floor, board and parts into an HDR buffer per
 * motion-blur subframe → depth of field → bloom + lens streak → grade.
 */
export interface Annotation {
  text: string
  sub?: string | undefined
  alpha: number
}

export interface TraceGL {
  render(tl: TraceTimeline, frame: number): HTMLCanvasElement
  /** the captions of the last rendered frame, in screen space */
  annotations(): Annotation[]
  dispose(): void
}

export interface TraceQuality {
  /** motion-blur samples per frame */
  subframes: number
  /** data-map resolution, × the frame */
  mapScale: number
}

const VS_PLANE = `#version 300 es
uniform mat4 uVP; uniform vec4 uRegion; uniform float uZ;
out vec2 vUv; out vec3 vW;
void main(){
  vec2 c = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1));
  vec2 p = uRegion.xy + uRegion.zw * c;
  vUv = c;
  vW = vec3(p.x, -p.y, uZ);
  gl_Position = uVP * vec4(vW, 1.0);
}`

const LIGHTING = `
uniform vec3 uCam; uniform vec3 uKey; uniform vec3 uKeyCol; uniform vec3 uFill;
uniform vec3 uRim; uniform vec3 uRimCol; uniform float uRoom;
const float PI = 3.14159265;
const float LIT_MAX = 1.45;
float sq(float x){ return x * x; }
float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
  return mix(mix(hash(i), hash(i+vec2(1,0)), f.x), mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), f.x), f.y); }
// a soft-edged rectangle of the sky, in elevation and azimuth from its centre
float panel(vec3 R, float el0, float el1, float azC, float azW, float soft){
  float el = asin(clamp(R.z, -1.0, 1.0));
  float az = atan(R.y, R.x);
  float da = abs(mod(az - azC + PI, 2.0 * PI) - PI);
  return smoothstep(el0 - soft, el0 + soft, el) * (1.0 - smoothstep(el1 - soft, el1 + soft, el))
       * (1.0 - smoothstep(azW - soft * 2.0, azW + soft * 2.0, da));
}
// the studio: a dim cyclorama, a big soft box overhead, a wide one behind the
// board for flat metal to catch from a three-quarter, and a thin strip
vec3 envLight(vec3 R, float rough){
  float soft = 0.04 + rough * 0.45;
  vec3 sky = vec3(0.010, 0.012, 0.016) + vec3(0.03, 0.033, 0.04) * smoothstep(-0.2, 1.0, R.z);
  float top = panel(R, 1.18, 1.62, 0.0, 3.2, soft);
  float back = panel(R, 0.62, 1.0, PI * 0.5, 0.95, soft);
  float strip = exp(-sq((R.x * 0.8 + R.y * 0.6) / (0.06 + rough * 0.5))) * smoothstep(0.3, 0.8, R.z);
  return sky + vec3(0.95, 0.93, 0.9) * top * 0.5 + vec3(0.9, 0.92, 0.95) * back * 0.6 + vec3(0.5, 0.55, 0.6) * strip * 0.35;
}
float ggx(vec3 N, vec3 V, vec3 L, float rough){
  vec3 H = normalize(L + V);
  float NoL = max(dot(N, L), 0.0), NoV = max(dot(N, V), 1e-3), NoH = max(dot(N, H), 0.0);
  float a = max(rough * rough, 0.003); float a2 = a * a;
  float dd = NoH * NoH * (a2 - 1.0) + 1.0; float D = a2 / (PI * dd * dd);
  float k = a * 0.5; float Vis = 0.25 / ((NoL * (1.0 - k) + k) * (NoV * (1.0 - k) + k));
  return D * Vis * NoL;
}
// specular anti-aliasing: a normal that changes inside a pixel widens the lobe
// instead of sparkling (Kaplanyan and Hoffman 2016)
float aaRough(vec3 N, float rough){
  vec3 dx = dFdx(N), dy = dFdy(N);
  float v = 0.25 * (dot(dx, dx) + dot(dy, dy));
  return sqrt(clamp(rough * rough + min(2.0 * v, 0.3), 0.0, 1.0));
}
vec3 shade(vec3 N, vec3 V, vec3 albedo, float metal, float rough0, float f0d){
  float rough = aaRough(N, rough0);
  vec3 L = normalize(uKey);
  float NoL = max(dot(N, L), 0.0), NoV = max(dot(N, V), 1e-3);
  vec3 f0 = mix(vec3(f0d), albedo, metal);
  vec3 H = normalize(L + V);
  vec3 F = f0 + (1.0 - f0) * pow(1.0 - max(dot(V, H), 0.0), 5.0);
  vec3 spec = ggx(N, V, L, rough) * F * uKeyCol;
  // the rim: a cool light from behind that only catches edges and bevels
  vec3 Lr = normalize(uRim);
  vec3 Fr = f0 + (1.0 - f0) * pow(1.0 - NoV, 5.0);
  vec3 rim = ggx(N, V, Lr, max(rough, 0.18)) * Fr * uRimCol * smoothstep(0.02, 0.35, 1.0 - N.z);
  vec3 diff = albedo * (1.0 - metal) * (NoL * uKeyCol + uFill) / PI * 2.0;
  vec3 refl = envLight(reflect(-V, N), rough) * mix(Fr, albedo * 0.9 + 0.1, metal);
  vec3 lit = (diff + spec + refl) * uRoom + rim;
  // stop below the bloom threshold, keeping the hue
  return lit * min(1.0, LIT_MAX / max(1e-4, max(lit.r, max(lit.g, lit.b))));
}`

const FS_TOP = `#version 300 es
precision highp float;
in vec2 vUv; in vec3 vW; out vec4 o;
uniform sampler2D tTop; uniform sampler2D tSurf; uniform sampler2D tFx; uniform vec2 uTexel;
uniform vec3 uCopper; uniform vec3 uFinish; uniform vec3 uMask; uniform vec3 uSub; uniform vec3 uSilk;
uniform vec3 uWarm; uniform vec3 uCool; uniform vec3 uHead;
uniform float uFinishRough; uniform float uMaskFront; uniform float uMaskSoft; uniform float uMaskOn; uniform float uMaskLuma;
uniform float uCured; uniform float uFinishOn; uniform float uEnergy; uniform float uPxPerMm; uniform float uBump;
uniform float uHeat; uniform float uHeatX; uniform float uHeatW;
${LIGHTING}
float hcu(vec2 uv, float lod){ return smoothstep(0.2, 0.8, textureLod(tTop, uv, lod).r); }
vec2 gradH(float s, float lod){
  vec2 dx = vec2(uTexel.x * s, 0.0), dy = vec2(0.0, uTexel.y * s);
  return vec2(hcu(vUv + dx, lod) - hcu(vUv - dx, lod), hcu(vUv + dy, lod) - hcu(vUv - dy, lod));
}
vec2 gradC(sampler2D t, int ch, float s, float lod){
  vec2 dx = vec2(uTexel.x * s, 0.0), dy = vec2(0.0, uTexel.y * s);
  return vec2(textureLod(t, vUv + dx, lod)[ch] - textureLod(t, vUv - dx, lod)[ch],
              textureLod(t, vUv + dy, lod)[ch] - textureLod(t, vUv - dy, lod)[ch]);
}
void main(){
  if (vUv.x < 0.0 || vUv.y < 0.0 || vUv.x > 1.0 || vUv.y > 1.0) discard;
  vec4 a = texture(tTop, vUv); vec4 s = texture(tSurf, vUv); vec4 fx = texture(tFx, vUv);
  float cu = a.r, pad = a.g, silk = s.r, hole = s.g, area = s.b, shadow = fx.g, head = fx.b;
  if (area < 0.002 && cu < 0.002 && head < 0.002) discard;
  vec3 V = normalize(uCam - vW);
  vec2 mm = vec2(vW.x, -vW.y) / uPxPerMm;
  // sharp shoulders, flat tops: a fine gradient for the edge, a broad one for the bevel
  vec2 g = (gradH(1.0, 0.5) * 0.7 + gradH(2.5, 1.2) * 0.35) * uBump;
  vec2 gs = gradC(tSurf, 0, 1.2, 0.3) * uBump * 0.6;
  // rolled copper: a fine directional grain
  float grain = vnoise(mm * vec2(70.0, 2.5)) - 0.5;
  vec3 Ncu = normalize(vec3(-g.x + grain * 0.03, g.y, 1.0));
  float weave = 0.5 + 0.5 * sin(mm.x * 11.0) * sin(mm.y * 11.0 + 1.3);
  vec3 subAlb = uSub * (0.85 + 0.25 * weave);
  vec3 baseSub = shade(vec3(0, 0, 1), V, subAlb, 0.0, 0.6, 0.04);
  float tone = vnoise(mm * 0.5) * 0.06;
  vec3 baseCu = shade(Ncu, V, uCopper * (0.97 + tone), 1.0, 0.3, 0.04);
  vec3 basePad = shade(Ncu, V, uFinish, 1.0, max(uFinishRough, 0.22), 0.04);
  vec3 col = mix(baseSub, baseCu, cu);
  col = mix(col, mix(baseCu, basePad, uFinishOn), pad);
  // the mask coats the board from the far edge: a wet front, then a glossy
  // coat that settles to satin. it clears every pad by a lip and follows the
  // copper relief beneath
  float py = -vW.y + (vnoise(mm * 0.35) - 0.5) * uMaskSoft * 0.6 + sin(mm.x * 0.21) * uMaskSoft * 0.12;
  float padNear = textureLod(tTop, vUv, 1.4).g;
  float clearance = smoothstep(0.04, 0.22, padNear);
  float poured = smoothstep(uMaskFront, uMaskFront - uMaskSoft * 0.3, py);
  float masked = uMaskOn * poured * (1.0 - max(pad, clearance)) * (1.0 - hole);
  float wet = uMaskOn * exp(-sq((py - (uMaskFront - uMaskSoft * 0.22)) / (uMaskSoft * 0.14)));
  vec2 lip = gradC(tTop, 1, 2.0, 1.4) * uBump * 0.8 * uMaskOn;
  // under the coat the relief softens: traces read as gentle ridges, not engraved lines
  vec3 Nm = normalize(vec3(-g.x * 0.28 + lip.x, g.y * 0.28 - lip.y + wet * 0.35, 1.0));
  // a dark mask shows the copper under it as a faint lift; a white one warms a touch
  float lift = mix(1.18, 1.03, uMaskLuma);
  float sink = mix(0.9, 0.95, uMaskLuma);
  vec3 maskAlb = mix(uMask * sink, min(uMask * lift + uCopper * mix(0.018, 0.02, uMaskLuma), vec3(0.82)), cu);
  vec3 maskC = shade(Nm, V, maskAlb, 0.0, mix(0.05, mix(0.08, 0.16, uCured), 1.0 - wet), 0.05);
  col = mix(col, maskC, masked);
  vec3 Ns = normalize(vec3(-gs.x, gs.y, 1.0));
  col = mix(col, shade(Ns, V, uSilk, 0.0, 0.7, 0.04), silk * (0.4 + 0.6 * poured * uMaskOn));
  col = mix(col, vec3(0.0015), hole * (1.0 - pad));
  // parts shade the board around their bodies
  col *= 1.0 - 0.8 * clamp(shadow, 0.0, 1.0);
  // the reflow oven: a warm band of heat crossing the board
  col += uWarm * 0.05 * uHeat * exp(-sq((vW.x - uHeatX) / uHeatW)) * area;
  // light: the only thing brighter than a lit surface. under the coat it spreads a little
  // a pale mask scatters what is under it far more than a dark one
  float scatter = masked * mix(0.6, 0.95, uMaskLuma);
  float lod = mix(1.6, 2.8, uMaskLuma);
  float spread = mix(1.4, 2.0, uMaskLuma);
  // capped, so a crowd of pads stays a set of lines instead of swelling into a halo;
  // only a pale coat, which really does glow from within, lifts the cap
  float cap = mix(0.5, 1.6, masked * smoothstep(0.4, 0.8, uMaskLuma));
  float warm = min(mix(a.b, textureLod(tTop, vUv, lod).b * spread, scatter), cap);
  float cool = min(mix(fx.r, textureLod(tFx, vUv, lod).r * spread, scatter), cap + 0.2);
  col += uWarm * pow(warm, 1.4) * uEnergy + uCool * pow(cool, 1.4) * uEnergy * 1.15;
  col += uHead * pow(head, 1.3) * uEnergy * (1.0 - masked);
  float alpha = clamp(max(area * (1.0 - hole * (1.0 - pad)), max(max(cu, pad), max(warm, max(cool, head)))), 0.0, 1.0);
  o = vec4(col * alpha, alpha);
}`

const FS_FLOOR = `#version 300 es
precision highp float;
in vec2 vUv; in vec3 vW; out vec4 o;
uniform sampler2D tSurf; uniform sampler2D tTop; uniform sampler2D tFx; uniform vec4 uMap;
uniform vec2 uCentre; uniform float uSpread; uniform vec3 uWarm; uniform vec3 uCool; uniform vec3 uKeyDir;
void main(){
  vec2 p = vec2(vW.x, -vW.y);
  float d = length(p - uCentre);
  // a pool of studio light falling off into black
  vec3 col = vec3(0.016, 0.018, 0.022) * exp(-d * d / (2.0 * uSpread * uSpread)) + vec3(0.0015);
  vec2 uv = (p - uMap.xy) / uMap.zw;
  vec2 suv = uv + uKeyDir.xy * vec2(1.0, -1.0) * 0.006;
  if (suv.x > 0.0 && suv.y > 0.0 && suv.x < 1.0 && suv.y < 1.0) {
    // the board's contact shadow
    float sh = textureLod(tSurf, suv, 4.5).b;
    col *= 1.0 - 0.92 * clamp(sh * 1.3, 0.0, 1.0);
  }
  if (uv.x > 0.0 && uv.y > 0.0 && uv.x < 1.0 && uv.y < 1.0) {
    // energy spills onto the floor around the board
    col += uWarm * textureLod(tTop, uv, 6.5).b * 0.3 + uCool * textureLod(tFx, uv, 6.5).r * 0.35;
  }
  o = vec4(col, 1.0);
}`

const VS_WALL = `#version 300 es
in vec4 aWall; // plane x, plane y, height fraction (0 top .. 1 bottom), outward normal angle
uniform mat4 uVP; uniform float uThick; uniform float uZ;
out vec3 vW; out vec3 vN; out float vF;
void main(){
  vW = vec3(aWall.x, -aWall.y, uZ - aWall.z * uThick);
  vN = vec3(cos(aWall.w), -sin(aWall.w), 0.0);
  vF = aWall.z;
  gl_Position = uVP * vec4(vW, 1.0);
}`

const FS_WALL = `#version 300 es
precision highp float;
in vec3 vW; in vec3 vN; in float vF; out vec4 o;
uniform vec3 uSub; uniform vec3 uCopper; uniform vec3 uMask; uniform float uLayers; uniform float uMaskOn;
${LIGHTING}
void main(){
  vec3 V = normalize(uCam - vW);
  vec3 N = dot(vN, V) < 0.0 ? -vN : vN;
  // the cross-section: laminate with a copper line at every layer, mask on both faces
  float band = 0.0;
  for (float i = 0.0; i < 6.0; i += 1.0) {
    if (i >= uLayers) break;
    float li = uLayers > 1.0 ? i / (uLayers - 1.0) : 0.0;
    band = max(band, exp(-sq((vF - li) / 0.03)));
  }
  float fibre = 0.5 + 0.5 * sin(vF * 70.0);
  vec3 lam = shade(N, V, uSub * (1.2 + 0.4 * fibre), 0.0, 0.7, 0.04);
  vec3 cu = shade(N, V, uCopper, 1.0, 0.3, 0.04);
  vec3 col = mix(lam, cu, band);
  float face = uMaskOn * max(smoothstep(0.06, 0.0, vF), smoothstep(0.94, 1.0, vF));
  col = mix(col, shade(N, V, uMask, 0.0, 0.15, 0.05), face);
  o = vec4(col, 1.0);
}`

const VS_PART = `#version 300 es
in vec4 aBox;   // plane x, y, w, h
in vec4 aMeta;  // rot, height px, kind, landing time
in vec4 aLabel; // atlas cell (col,row), has label / pin pitch / a pin's housing height, hero
in vec4 aSkew;  // off-square on the paste: dx, dy px, rotation; settle time
in vec4 aLed;   // an LED's linear colour and gain
uniform mat4 uVP; uniform float uP; uniform float uDur; uniform int uRound; uniform float uFall;
out vec3 vW; out vec3 vN; out vec3 vL; flat out vec4 vMeta; flat out vec4 vLabel; flat out vec2 vSize; flat out float vRot; flat out vec4 vLed;
const vec3 C[8] = vec3[8](vec3(-.5,-.5,0), vec3(.5,-.5,0), vec3(.5,.5,0), vec3(-.5,.5,0),
                          vec3(-.5,-.5,1), vec3(.5,-.5,1), vec3(.5,.5,1), vec3(-.5,.5,1));
const int I[36] = int[36](4,5,6, 4,6,7, 0,2,1, 0,3,2, 0,1,5, 0,5,4, 1,2,6, 1,6,5, 2,3,7, 2,7,6, 3,0,4, 3,4,7);
const vec3 FN[6] = vec3[6](vec3(0,0,1), vec3(0,0,-1), vec3(0,-1,0), vec3(1,0,0), vec3(0,1,0), vec3(-1,0,0));
// mirrors partDrop in trace-maps: fast in, set down gently
float drop(float t, float p, float hero){
  float dur = (hero > 0.5 ? 0.75 : 0.5) / 24.0;
  float u = (p - (t - dur)) / dur;
  if (u <= 0.0) return 1.0;
  if (u >= 1.0) return 0.0;
  return (1.0 - u) * (1.0 - u) * (1.0 - u);
}
// the solder melts: surface tension pulls the part square with a small overshoot
float snapBack(float s){ return s <= 0.0 ? 1.0 : exp(-s / 0.05) * cos(6.2832 * s / 0.2); }
// a 24-sided cylinder in the unit box: sides, then the top cap
const int SEG = 24;
void cylinder(int id, out vec3 c, out vec3 n){
  if (id < SEG * 6) {
    int s = id / 6, k = id - s * 6;
    int corner = k == 0 ? 0 : k == 1 ? 1 : k == 2 ? 2 : k == 3 ? 1 : k == 4 ? 3 : 2;
    float a = 6.2831853 * float(s + (corner & 1)) / float(SEG);
    c = vec3(0.5 * cos(a), 0.5 * sin(a), float(corner >> 1));
    n = vec3(cos(a), sin(a), 0.0);
  } else {
    int t = id - SEG * 6, s = t / 3, k = t - s * 3;
    float a = 6.2831853 * float(s + (k == 2 ? 1 : 0)) / float(SEG);
    c = k == 0 ? vec3(0.0, 0.0, 1.0) : vec3(0.5 * cos(a), 0.5 * sin(a), 1.0);
    n = vec3(0.0, 0.0, 1.0);
  }
}
void main(){
  vec3 c; vec3 n;
  if (uRound == 1) cylinder(gl_VertexID, c, n);
  else { c = C[I[gl_VertexID]]; n = FN[gl_VertexID / 6]; }
  float dr = drop(aMeta.w, uP, aLabel.w);
  float k = snapBack((uP - aSkew.w) * uDur);
  float rot = aMeta.x + aSkew.z * k;
  float cr = cos(rot), sr = sin(rot);
  vec2 lp = vec2(c.x * aBox.z, c.y * aBox.w);
  vec2 pp = aBox.xy + aSkew.xy * k + vec2(lp.x * cr - lp.y * sr, lp.x * sr + lp.y * cr);
  // it rides the paste until the reflow, then sinks onto its pads
  // a header's pins fall and sink with their housing
  float seat = int(aMeta.z + 0.5) == 12 ? aLabel.z : aMeta.y;
  float paste = max(0.0, k) * min(1.5, 0.08 * seat);
  // from a common height, so the smallest passives fall in a visible stack instead of popping in
  float fall = dr * max(seat * (aLabel.w > 0.5 ? 5.0 : 6.0), uFall);
  vW = vec3(pp.x, -pp.y, fall + paste + c.z * aMeta.y);
  vec2 nn = vec2(n.x * cr - n.y * sr, n.x * sr + n.y * cr);
  vN = vec3(nn.x, -nn.y, n.z);
  vL = c;
  vMeta = aMeta;
  vLabel = aLabel;
  vSize = aBox.zw;
  vRot = rot;
  vLed = aLed;
  gl_Position = dr > 0.999 ? vec4(2.0, 2.0, 2.0, 1.0) : uVP * vec4(vW, 1.0);
}`

const FS_PART = `#version 300 es
precision highp float;
in vec3 vW; in vec3 vN; in vec3 vL; flat in vec4 vMeta; flat in vec4 vLabel; flat in vec2 vSize; flat in float vRot; flat in vec4 vLed; out vec4 o;
uniform sampler2D tAtlas; uniform vec2 uCell; uniform vec3 uFinish; uniform float uLedOn; uniform float uHeat;
${LIGHTING}
void main(){
  vec3 V = normalize(uCam - vW);
  int kind = int(vMeta.z + 0.5);
  vec3 N = normalize(vN);
  // softened edges: bend the normal toward the nearest edge so every box catches a rim
  vec2 e = abs(vL.xy) * 2.0;
  float edge = smoothstep(0.86, 1.0, max(e.x, e.y));
  float top = step(0.5, vN.z);
  bool round = kind == 9 || kind == 11;
  if (top > 0.5 && !round) {
    vec2 dirL = vec2(e.x > e.y ? sign(vL.x) : 0.0, e.x > e.y ? 0.0 : sign(vL.y));
    float cr = cos(vRot), sr = sin(vRot);
    vec2 dw = vec2(dirL.x * cr - dirL.y * sr, dirL.x * sr + dirL.y * cr);
    N = normalize(N + vec3(dw.x, -dw.y, 0.0) * edge * 0.9);
  }
  vec3 alb = vec3(0.022); float metal = 0.0; float rough = 0.42; vec3 emit = vec3(0.0);
  float along = vSize.x >= vSize.y ? vL.x : vL.y;
  float cap = smoothstep(0.34, 0.37, abs(along));
  if (kind == 0) {            // ic: black epoxy, a pin-1 dimple, a laser-etched marking
    alb = vec3(0.028, 0.028, 0.03); rough = 0.5;
    if (top > 0.5) {
      vec2 q = vL.xy + 0.5;
      float dimple = 1.0 - smoothstep(0.035, 0.05, length((q - vec2(0.13, 0.13)) * vSize / max(vSize.x, vSize.y)));
      alb = mix(alb, vec3(0.012), dimple); rough = mix(rough, 0.2, dimple);
      if (vLabel.z > 0.5) {
        // the marking runs along the long side, at the atlas cell's 4:1 aspect
        bool wide = vSize.x >= vSize.y;
        vec2 t = wide ? q : vec2(q.y, 1.0 - q.x);
        float longS = max(vSize.x, vSize.y), shortS = min(vSize.x, vSize.y);
        float hFrac = min(0.5, 0.78 * longS / 4.0 / shortS);
        float wFrac = hFrac * shortS * 4.0 / longS;
        vec2 tc = vec2((t.x - 0.5) / wFrac + 0.5, (t.y - 0.5) / hFrac + 0.5);
        if (vLabel.z > 1.5) tc = 1.0 - tc;
        if (tc.x > 0.0 && tc.x < 1.0 && tc.y > 0.0 && tc.y < 1.0) {
          float m = texture(tAtlas, (vLabel.xy + tc) * uCell).r;
          alb = mix(alb, vec3(0.16, 0.16, 0.165), m); rough = mix(rough, 0.75, m);
        }
      }
    }
  } else if (kind == 1) {     // resistor: black top, white ceramic sides, tin ends
    alb = top > 0.5 ? vec3(0.02) : vec3(0.55, 0.53, 0.5); rough = 0.55;
    alb = mix(alb, uFinish * 0.9 + 0.1, cap); metal = cap; rough = mix(rough, 0.3, cap);
  } else if (kind == 2) {     // MLCC: tan ceramic, tin ends
    alb = vec3(0.33, 0.24, 0.15); rough = 0.6;
    alb = mix(alb, uFinish * 0.9 + 0.1, cap); metal = cap; rough = mix(rough, 0.3, cap);
  } else if (kind == 3) {     // inductor
    alb = vec3(0.05, 0.05, 0.055); rough = 0.5;
    alb = mix(alb, uFinish * 0.9 + 0.1, cap); metal = cap;
  } else if (kind == 4) {     // diode: black with a silver cathode band
    alb = vec3(0.025); rough = 0.45;
    float band = smoothstep(0.24, 0.27, along) * (1.0 - smoothstep(0.33, 0.36, along));
    alb = mix(alb, vec3(0.5), band);
  } else if (kind == 5) {     // LED: milky lens that lights at power-on, from its centre, so neighbours keep a dark gap
    float lens = top * (1.0 - smoothstep(0.3, 0.44, max(abs(vL.x), abs(vL.y))));
    alb = mix(vec3(0.3, 0.3, 0.28), vLed.rgb, 0.25) * (1.0 - 0.6 * uLedOn * lens); rough = 0.2;
    emit = vLed.rgb * uLedOn * 3.2 * vLed.a * (lens + 0.1 * (1.0 - top));
  } else if (kind == 6) {     // crystal: a metal can
    alb = vec3(0.72, 0.73, 0.75); metal = 1.0; rough = 0.3;
  } else if (kind == 7) {     // connector: black plastic, a grid of gold pins on top
    alb = vec3(0.03, 0.03, 0.032); rough = 0.55;
    if (top > 0.5 && vLabel.z > 0.5) {
      vec2 lpx = vL.xy * vSize;
      vec2 cell = abs(fract(lpx / vLabel.z + 0.5) - 0.5) * 2.0;
      float pin = (1.0 - smoothstep(0.32, 0.4, max(cell.x, cell.y))) * step(max(abs(vL.x) * vSize.x - vSize.x * 0.5 + vLabel.z * 0.5, abs(vL.y) * vSize.y - vSize.y * 0.5 + vLabel.z * 0.5), 0.0);
      alb = mix(alb, uFinish * 0.85 + vec3(0.05, 0.04, 0.0), pin); metal = pin; rough = mix(rough, 0.25, pin);
    }
  } else if (kind == 12) {    // header pin: gold-plated square post
    alb = vec3(0.95, 0.7, 0.32); metal = 1.0; rough = 0.28;
  } else if (kind == 8) {     // switch: brushed steel cap on a black base
    alb = top > 0.5 ? vec3(0.55, 0.56, 0.58) : vec3(0.03); metal = top; rough = 0.45;
  } else if (kind == 9) {     // electrolytic: aluminium top, dark sleeve
    alb = top > 0.5 ? vec3(0.7, 0.71, 0.72) : vec3(0.02, 0.04, 0.12); metal = top; rough = top > 0.5 ? 0.32 : 0.35;
  } else if (kind == 11) {    // vacuum tube: clear glass over dark plates, a mirror getter in the dome, two heaters that warm at power-on
    float facing = abs(dot(N, V));
    float inner = smoothstep(0.35, 0.75, facing) * smoothstep(0.14, 0.22, vL.z) * (1.0 - smoothstep(0.66, 0.74, vL.z)) * (1.0 - top);
    alb = vec3(0.0); metal = 0.0; rough = 0.04;
    float heater = exp(-sq((vL.z - 0.42) / 0.09)) * smoothstep(0.6, 0.92, facing) * (1.0 - top);
    // thin, clean glass: only a faint sheen of the soft boxes, so the tube never reads as a pale slab out of focus
    vec3 glass = shade(N, V, alb, metal, rough, 0.04) * 0.35;
    vec3 getter = shade(N, V, vec3(0.07, 0.07, 0.075), 1.0, 0.35, 0.04) * top;
    vec3 plates = vec3(0.012, 0.012, 0.013) * uRoom * inner;
    vec3 glow = vec3(1.0, 0.36, 0.08) * uHeat * heater * 3.0;
    vec3 col = glass + getter + plates + glow;
    float a = top > 0.5 ? 0.5 : clamp(0.06 + 0.5 * pow(1.0 - facing, 3.0) + 0.8 * inner, 0.0, 1.0);
    o = vec4(col * a + glow * 0.5, a);
    return;
  } else {
    alb = vec3(0.05, 0.05, 0.055); rough = 0.5;
  }
  vec3 col = shade(N, V, alb, metal, rough, 0.045);
  // the underside hugs the board: ambient occlusion at the foot of every wall
  col *= mix(0.45, 1.0, smoothstep(0.0, 0.35, vL.z));
  o = vec4(col + emit, 1.0);
}`

const VS_QUAD = `#version 300 es
out vec2 uv;
void main(){ vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2); uv = p; gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }`

const FS_COPY = `#version 300 es
precision highp float; in vec2 uv; out vec4 o; uniform sampler2D t; uniform float uW;
void main(){ o = texture(t, uv) * uW; }`

const FS_DOF = `#version 300 es
precision highp float; in vec2 uv; out vec4 o;
uniform sampler2D t; uniform vec2 uRes;
uniform vec3 uCam; uniform vec3 uF; uniform vec3 uR; uniform vec3 uU; uniform vec2 uTan; uniform float uShift;
uniform float uFocus; uniform float uAperture; uniform float uMaxR;
float coc(vec2 q){
  vec2 n = q * 2.0 - 1.0;
  vec3 d = normalize(uF + uR * n.x * uTan.x + uU * (n.y - uShift) * uTan.y);
  float z = d.z < -1e-4 ? (-uCam.z / d.z) * dot(d, uF) : 1e6;
  return clamp(abs(1.0 - uFocus / z) * uAperture, 0.0, uMaxR);
}
void main(){
  float c = coc(uv);
  if (c < 0.5) { o = texture(t, uv); return; }
  vec4 acc = vec4(0.0); float wsum = 0.0;
  const int N = 48;
  for (int i = 0; i < N; i++) {
    float fi = float(i) + 0.5;
    float r = sqrt(fi / float(N)) * c;
    float a = fi * 2.39996;
    vec2 q = uv + vec2(cos(a), sin(a)) * r / uRes;
    vec4 s = texture(t, q);
    // highlights weigh a little more in their disc: soft bokeh, not gaussian mush
    float l = max(s.r, max(s.g, s.b));
    float w = smoothstep(r - 1.5, r + 0.5, coc(q) + 1.0) * (1.0 + 0.8 * smoothstep(1.2, 4.0, l));
    acc += s * w; wsum += w;
  }
  o = acc / max(wsum, 1e-3);
}`

const FS_BRIGHT = `#version 300 es
precision highp float; in vec2 uv; out vec4 o; uniform sampler2D t;
void main(){ vec3 c = texture(t, uv).rgb; float l = max(c.r, max(c.g, c.b));
  float k = smoothstep(1.6, 3.4, l); o = vec4(c * k, 1.0); }`

const FS_DOWN = `#version 300 es
precision highp float; in vec2 uv; out vec4 o; uniform sampler2D t; uniform vec2 h;
void main(){ vec4 s = texture(t, uv) * 4.0;
  s += texture(t, uv - h) + texture(t, uv + h) + texture(t, uv + vec2(h.x, -h.y)) + texture(t, uv - vec2(h.x, -h.y));
  o = s / 8.0; }`

const FS_UP = `#version 300 es
precision highp float; in vec2 uv; out vec4 o; uniform sampler2D t; uniform vec2 h;
void main(){ vec4 s = texture(t, uv + vec2(-h.x * 2.0, 0.0)) + texture(t, uv + vec2(h.x * 2.0, 0.0))
  + texture(t, uv + vec2(0.0, -h.y * 2.0)) + texture(t, uv + vec2(0.0, h.y * 2.0));
  s += (texture(t, uv + vec2(-h.x, h.y)) + texture(t, uv + h) + texture(t, uv + vec2(h.x, -h.y)) + texture(t, uv - h)) * 2.0;
  o = s / 12.0; }`

const FS_STREAK = `#version 300 es
precision highp float; in vec2 uv; out vec4 o; uniform sampler2D t; uniform vec2 uStep;
void main(){ vec4 s = vec4(0.0); float ws = 0.0;
  for (int i = -4; i <= 4; i++) { float w = exp(-float(i * i) / 8.0); s += texture(t, uv + uStep * float(i)) * w; ws += w; }
  o = s / ws * 0.98; }`

const FS_FINAL = `#version 300 es
precision highp float; in vec2 uv; out vec4 o;
uniform sampler2D tCol; uniform sampler2D tBloom; uniform sampler2D tStreak;
uniform float uBloom; uniform float uStreak; uniform vec3 uStreakTint; uniform float uExposure; uniform float uCA;
uniform vec3 uBg; uniform float uFrame; uniform bool uGrain; uniform bool uTransparent; uniform float uVignette;
vec3 aces(vec3 x){ return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main(){
  vec2 d = uv - 0.5;
  vec4 base = texture(tCol, uv);
  vec3 c = vec3(texture(tCol, uv - d * uCA).r, base.g, texture(tCol, uv + d * uCA).b);
  vec3 glow = texture(tBloom, uv).rgb * uBloom + texture(tStreak, uv).rgb * uStreak * uStreakTint;
  c += glow;
  c = aces(c * uExposure);
  // a gentle toe keeps the blacks black and the mids open
  c = pow(c, vec3(1.0 / 2.2));
  c = smoothstep(0.0, 1.0, c * 0.96 + 0.02) * 0.92 + c * 0.08;
  float a = 1.0;
  if (uTransparent) {
    a = clamp(base.a + dot(glow, vec3(0.3)), 0.0, 1.0);
  } else {
    c += uBg * (1.0 - clamp(base.a, 0.0, 1.0));
    c *= mix(1.0, smoothstep(1.25, 0.3, length(d) * 1.45), uVignette);
    if (uGrain) c += (hash(gl_FragCoord.xy + uFrame * 17.0) - 0.5) * (2.0 / 255.0);
  }
  o = vec4(c * (uTransparent ? a : 1.0), a);
}`

type GL = WebGL2RenderingContext

interface Target { tex: WebGLTexture; fbo: WebGLFramebuffer; w: number; h: number }

class Prog {
  private readonly loc = new Map<string, WebGLUniformLocation | null>()
  constructor(private readonly gl: GL, readonly p: WebGLProgram) {}
  use(): this {
    this.gl.useProgram(this.p)
    return this
  }
  private u(name: string): WebGLUniformLocation | null {
    let l = this.loc.get(name)
    if (l === undefined) {
      l = this.gl.getUniformLocation(this.p, name)
      this.loc.set(name, l)
    }
    return l
  }
  f(name: string, ...v: number[]): this {
    const l = this.u(name)
    if (v.length === 1) this.gl.uniform1f(l, v[0] as number)
    else if (v.length === 2) this.gl.uniform2f(l, v[0] as number, v[1] as number)
    else if (v.length === 3) this.gl.uniform3f(l, v[0] as number, v[1] as number, v[2] as number)
    else this.gl.uniform4f(l, v[0] as number, v[1] as number, v[2] as number, v[3] as number)
    return this
  }
  v3(name: string, v: readonly number[]): this {
    return this.f(name, v[0] as number, v[1] as number, v[2] as number)
  }
  i(name: string, v: number): this {
    this.gl.uniform1i(this.u(name), v)
    return this
  }
  m4(name: string, m: Float32Array): this {
    this.gl.uniformMatrix4fv(this.u(name), false, m)
    return this
  }
}

function link(gl: GL, vs: string, fs: string): Prog | undefined {
  const v = compileShader(gl, gl.VERTEX_SHADER, vs)
  const f = compileShader(gl, gl.FRAGMENT_SHADER, fs)
  if (v === undefined || f === undefined) return undefined
  const p = gl.createProgram() as WebGLProgram | null
  if (p === null) return undefined
  gl.attachShader(p, v)
  gl.attachShader(p, f)
  gl.linkProgram(p)
  gl.deleteShader(v)
  gl.deleteShader(f)
  if (gl.getProgramParameter(p, gl.LINK_STATUS) !== true) {
    // eslint-disable-next-line no-console
    console.warn(`trace-gl link: ${gl.getProgramInfoLog(p) ?? 'link failed'}`)
    return undefined
  }
  return new Prog(gl, p)
}

/** #rrggbb → linear RGB */
export function linear(hex: string): [number, number, number] {
  const c = (i: number): number => Math.pow(Number.parseInt(hex.slice(1 + 2 * i, 3 + 2 * i), 16) / 255, 2.2)
  return [c(0), c(1), c(2)]
}

/** where the camera's view meets the plane z = zPlane, as a plane-px bbox */
function footprint(cam: Cam, zPlane: number): Region {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      const d = norm([
        cam.f[0] + cam.r[0] * sx * cam.tanX + cam.u[0] * (sy - cam.shift) * cam.tanY,
        cam.f[1] + cam.r[1] * sx * cam.tanX + cam.u[1] * (sy - cam.shift) * cam.tanY,
        cam.f[2] + cam.r[2] * sx * cam.tanX + cam.u[2] * (sy - cam.shift) * cam.tanY
      ])
      // rays near the horizon clamp to a far reach instead of infinity
      const t = d[2] < -0.05 ? (zPlane - cam.pos[2]) / d[2] : cam.dist * 6
      const x = cam.pos[0] + d[0] * t
      const y = -(cam.pos[1] + d[1] * t)
      x0 = Math.min(x0, x)
      y0 = Math.min(y0, y)
      x1 = Math.max(x1, x)
      y1 = Math.max(y1, y)
    }
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

const KIND_ID: Record<string, number> = { ic: 0, res: 1, cap: 2, ind: 3, diode: 4, led: 5, xtal: 6, conn: 7, switch: 8, can: 9, other: 10, valve: 11, pin: 12 }
const ROUND = new Set(['can', 'valve'])
const rank = (kind: string): number => (kind === 'valve' ? 2 : ROUND.has(kind) ? 1 : 0)

const ease = (x: number): number => {
  const t = Math.min(1, Math.max(0, x))
  return t * t * (3 - 2 * t)
}

/** the [start, end) of the shot that holds phase p: motion blur never samples across a cut */
export function shotSpan(shots: CameraShot[], p: number): [number, number] {
  let a = 0
  let b = 1
  for (const k of shots) {
    if (k.cut !== true) continue
    if (k.t <= p) a = k.t
    else {
      b = k.t
      break
    }
  }
  return [a, b]
}

export function createTraceGL(width: number, height: number, quality: TraceQuality): TraceGL | undefined {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  let gl: GL | null = null
  try {
    gl = canvas.getContext('webgl2', { premultipliedAlpha: true, preserveDrawingBuffer: true, antialias: false, alpha: true })
  } catch {
    return undefined
  }
  if (gl === null) return undefined
  const g = gl
  const hdr = g.getExtension('EXT_color_buffer_float') !== null
  const aniso = g.getExtension('EXT_texture_filter_anisotropic')

  const progs = {
    top: link(g, VS_PLANE, FS_TOP),
    floor: link(g, VS_PLANE, FS_FLOOR),
    wall: link(g, VS_WALL, FS_WALL),
    part: link(g, VS_PART, FS_PART),
    copy: link(g, VS_QUAD, FS_COPY),
    dof: link(g, VS_QUAD, FS_DOF),
    bright: link(g, VS_QUAD, FS_BRIGHT),
    down: link(g, VS_QUAD, FS_DOWN),
    up: link(g, VS_QUAD, FS_UP),
    streak: link(g, VS_QUAD, FS_STREAK),
    final: link(g, VS_QUAD, FS_FINAL)
  }
  if (Object.values(progs).some((p) => p === undefined)) return undefined
  const P = progs as { [K in keyof typeof progs]: Prog }

  const vao = g.createVertexArray()
  g.bindVertexArray(vao)
  g.pixelStorei(g.UNPACK_COLORSPACE_CONVERSION_WEBGL, g.NONE)
  g.pixelStorei(g.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)

  const k = Math.min(quality.mapScale, 4096 / Math.max(width, height))
  const MW = Math.round(width * k)
  const MH = Math.round(height * k)
  const maps: MapSet = createMaps(MW, MH)
  const mkTex = (mip: boolean): WebGLTexture => {
    const t = g.createTexture()
    g.bindTexture(g.TEXTURE_2D, t)
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, mip ? g.LINEAR_MIPMAP_LINEAR : g.LINEAR)
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.LINEAR)
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE)
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE)
    if (mip && aniso !== null) g.texParameterf(g.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, 8)
    return t
  }
  // top, surf, fx, atlas
  const mapTex = [0, 1, 2].map(() => mkTex(true))
  const atlasTex = mkTex(true)

  const target = (w: number, h: number, depth: boolean): Target => {
    const tex = g.createTexture()
    g.bindTexture(g.TEXTURE_2D, tex)
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.LINEAR)
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.LINEAR)
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE)
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE)
    g.texImage2D(g.TEXTURE_2D, 0, hdr ? g.RGBA16F : g.RGBA8, w, h, 0, g.RGBA, hdr ? g.HALF_FLOAT : g.UNSIGNED_BYTE, null)
    const fbo = g.createFramebuffer()
    g.bindFramebuffer(g.FRAMEBUFFER, fbo)
    g.framebufferTexture2D(g.FRAMEBUFFER, g.COLOR_ATTACHMENT0, g.TEXTURE_2D, tex, 0)
    if (depth) {
      const rb = g.createRenderbuffer()
      g.bindRenderbuffer(g.RENDERBUFFER, rb)
      g.renderbufferStorage(g.RENDERBUFFER, g.DEPTH_COMPONENT24, w, h)
      g.framebufferRenderbuffer(g.FRAMEBUFFER, g.DEPTH_ATTACHMENT, g.RENDERBUFFER, rb)
    }
    return { tex, fbo, w, h }
  }
  const scene = target(width, height, true)
  const accum = target(width, height, true)
  const dof = target(width, height, false)
  const pyramid: Target[] = []
  for (let i = 0, w = Math.ceil(width / 2), h = Math.ceil(height / 2); i < 6; i++, w = Math.max(1, w >> 1), h = Math.max(1, h >> 1)) pyramid.push(target(w, h, false))
  const sw = Math.ceil(width / 4)
  const sh = Math.ceil(height / 4)
  const streakA = target(sw, sh, false)
  const streakB = target(sw, sh, false)

  const bind = (t: Target | null): void => {
    g.bindFramebuffer(g.FRAMEBUFFER, t?.fbo ?? null)
    g.viewport(0, 0, t?.w ?? width, t?.h ?? height)
  }
  const tex = (unit: number, t: WebGLTexture): void => {
    g.activeTexture(g.TEXTURE0 + unit)
    g.bindTexture(g.TEXTURE_2D, t)
  }
  const quad = (): void => {
    g.drawArrays(g.TRIANGLES, 0, 3)
  }

  // per-timeline geometry: board walls, parts and their markings
  let builtFor: TraceTimeline | undefined
  const wallBuf = g.createBuffer()
  const partBuf = g.createBuffer()
  let wallCount = 0
  let boxCount = 0
  let roundCount = 0
  let valveCount = 0
  let extent: Region = { x: 0, y: 0, w: width, h: height }
  let boardX: [number, number] = [0, width]
  const CELL_W = 256
  const CELL_H = 64
  const ATLAS_COLS = 8
  const ATLAS_ROWS = 16
  const build = (tl: TraceTimeline): void => {
    if (builtFor === tl) return
    builtFor = tl
    const s = tl.scene
    const walls: number[] = []
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    for (const loop of s.board) {
      const n = loop.length / 2
      for (let i = 0; i < n; i++) {
        const ax = loop[i * 2] as number
        const ay = loop[i * 2 + 1] as number
        const bx = loop[((i + 1) % n) * 2] as number
        const by = loop[((i + 1) % n) * 2 + 1] as number
        x0 = Math.min(x0, ax)
        y0 = Math.min(y0, ay)
        x1 = Math.max(x1, ax)
        y1 = Math.max(y1, ay)
        if (Math.hypot(bx - ax, by - ay) < 1e-6) continue
        const ang = Math.atan2(bx - ax, -(by - ay))
        walls.push(ax, ay, 0, ang, bx, by, 0, ang, ax, ay, 1, ang, bx, by, 0, ang, bx, by, 1, ang, ax, ay, 1, ang)
      }
    }
    const m = 0.06 * Math.max(x1 - x0, y1 - y0)
    extent = Number.isFinite(x0) ? { x: x0 - m, y: y0 - m, w: x1 - x0 + 2 * m, h: y1 - y0 + 2 * m } : { x: 0, y: 0, w: width, h: height }
    boardX = Number.isFinite(x0) ? [x0, x1] : [0, width]
    g.bindBuffer(g.ARRAY_BUFFER, wallBuf)
    g.bufferData(g.ARRAY_BUFFER, new Float32Array(walls), g.STATIC_DRAW)
    wallCount = walls.length / 4
    // markings: one atlas cell per labelled part
    const atlas = document.createElement('canvas')
    atlas.width = CELL_W * ATLAS_COLS
    atlas.height = CELL_H * ATLAS_ROWS
    const actx = atlas.getContext('2d') as CanvasRenderingContext2D
    actx.fillStyle = '#000'
    actx.fillRect(0, 0, atlas.width, atlas.height)
    actx.fillStyle = '#fff'
    actx.textAlign = 'center'
    actx.textBaseline = 'middle'
    let cell = 0
    const inst: number[] = []
    // boxes first, round bodies after: each set draws with its own mesh
    const ordered = [...s.parts].sort((x, y) => rank(x.kind) - rank(y.kind))
    for (const part of ordered) {
      let col = 0
      let row = 0
      let has = 0
      if (part.label !== undefined && cell < ATLAS_COLS * ATLAS_ROWS) {
        col = cell % ATLAS_COLS
        row = Math.floor(cell / ATLAS_COLS)
        const size = Math.min(34, (CELL_W * 0.92) / Math.max(1, part.label.length) * 1.7)
        actx.font = `600 ${size}px ui-monospace, Menlo, monospace`
        actx.fillText(part.label, col * CELL_W + CELL_W / 2, row * CELL_H + CELL_H / 2)
        // a marking reads left to right across the frame: flip it if its baseline runs backwards
        const dirX = part.w >= part.h ? Math.cos(part.rot) : -Math.sin(part.rot)
        has = dirX < -0.01 ? 2 : 1
        cell++
      }
      // connectors carry their pin pitch and pins their housing height where ICs carry their marking flag
      const third = part.kind === 'conn' ? (part.pitch ?? 0) : part.kind === 'pin' ? (part.seat ?? 0) : has
      inst.push(
        part.x, part.y, part.w, part.h,
        part.rot, part.z, KIND_ID[part.kind] ?? 10, part.t,
        col, row, third, part.hero === true ? 1 : 0,
        part.skew[0], part.skew[1], part.skew[2], part.settle,
        ...(part.led === undefined ? [0, 0, 0, 0] : [...linear(part.led.color), part.led.gain])
      )
    }
    g.bindTexture(g.TEXTURE_2D, atlasTex)
    g.texImage2D(g.TEXTURE_2D, 0, g.RGBA, g.RGBA, g.UNSIGNED_BYTE, atlas)
    g.generateMipmap(g.TEXTURE_2D)
    g.bindBuffer(g.ARRAY_BUFFER, partBuf)
    g.bufferData(g.ARRAY_BUFFER, new Float32Array(inst), g.STATIC_DRAW)
    valveCount = s.parts.filter((pt) => rank(pt.kind) === 2).length
    roundCount = s.parts.filter((pt) => rank(pt.kind) === 1).length
    boxCount = s.parts.length - roundCount - valveCount
  }

  /**
   * The region to rasterise: what the camera sees of the board, on whole
   * texels at a stepped scale. The map grid then holds still in board space
   * from frame to frame, so thin copper does not crawl as the camera moves.
   */
  const regionFor = (cam: Cam, tallest: number): Region => {
    let r: Region | undefined
    for (const z of [0, tallest]) {
      const f = footprint(cam, z)
      if (r === undefined) r = f
      else {
        const xa = Math.min(r.x, f.x)
        const ya = Math.min(r.y, f.y)
        r = { x: xa, y: ya, w: Math.max(r.x + r.w, f.x + f.w) - xa, h: Math.max(r.y + r.h, f.y + f.h) - ya }
      }
    }
    const f = r as Region
    const xa = Math.max(f.x, extent.x)
    const ya = Math.max(f.y, extent.y)
    const xb = Math.min(f.x + f.w, extent.x + extent.w)
    const yb = Math.min(f.y + f.h, extent.y + extent.h)
    const w = Math.max(8, xb - xa)
    const h = Math.max(8, yb - ya)
    const texel = 2 ** (Math.ceil(Math.log2(Math.max(w / MW, h / MH) * 1.02) * 8) / 8)
    return {
      x: Math.floor(((xa + xb) / 2) / texel - MW / 2) * texel,
      y: Math.floor(((ya + yb) / 2) / texel - MH / 2) * texel,
      w: MW * texel,
      h: MH * texel
    }
  }

  const upload = (i: number, c: HTMLCanvasElement): void => {
    g.bindTexture(g.TEXTURE_2D, mapTex[i] as WebGLTexture)
    g.texImage2D(g.TEXTURE_2D, 0, g.RGBA, g.RGBA, g.UNSIGNED_BYTE, c)
    g.generateMipmap(g.TEXTURE_2D)
  }

  const lighting = (prog: Prog, cam: Cam, p: number, room: number): void => {
    // a warm key raking low across the board, a cool rim from behind the camera's line
    const az = -2.35 + p * 1.1
    const el = 0.52
    const back = norm([-cam.f[0], -cam.f[1], 0])
    prog.v3('uCam', cam.pos)
      .f('uKey', Math.cos(az) * Math.cos(el), Math.sin(az) * Math.cos(el), Math.sin(el))
      .f('uKeyCol', 3.0, 2.72, 2.35)
      .f('uFill', 0.03, 0.045, 0.07)
      .f('uRim', -back[0] * 0.9, -back[1] * 0.9, 0.42)
      .f('uRimCol', 1.3, 1.65, 2.2)
      .f('uRoom', room)
  }

  let lastAnnotations: Annotation[] = []

  return {
    annotations: () => lastAnnotations,
    render(tl: TraceTimeline, frame: number): HTMLCanvasElement {
      if (g.isContextLost()) return canvas
      build(tl)
      const s = tl.scene
      const W = width
      const H = height
      const p = frame / tl.totalFrames
      const acts = s.acts
      const span = (a: [number, number]): number => ease((p - a[0]) / (a[1] - a[0]))
      const tallest = Math.max(0, ...s.parts.map((pt) => pt.z))

      const cam = makeCam(sampleShot(s.shots, p), W, H)
      const region = regionFor(cam, tallest)
      drawMaps(maps, tl, p, region)
      upload(0, maps.top)
      upload(1, maps.surf)
      upload(2, maps.fx)

      const pal = tl.palette
      const m = s.material
      const warmC = linear(m.energyWarm)
      const coolC = linear(m.energyCool)
      const copper = linear(m.copper)
      const texel = [1 / MW, 1 / MH] as const
      const regionV = [region.x, region.y, region.w, region.h] as const
      const maskSpan = span(acts.mask)
      const maskOn = p >= acts.mask[0] ? 1 : 0
      const soft = 0.07 * extent.h
      const maskFront = extent.y - soft + maskSpan * (extent.h + 2 * soft)
      const maskLin = linear(m.mask)
      const maskLuma = 0.2126 * maskLin[0] + 0.7152 * maskLin[1] + 0.0722 * maskLin[2]
      const energyGain = 3.2
      // the studio dims for the held breath before power-on, so the board's own light carries the
      // climax; a dark mask has little to lose, so it dims less and comes back further for the poster
      const dim = 0.22 + 0.3 * Math.pow(maskLuma, 1 / 2.2)
      const room = 1 - dim * span([acts.reflow[1], acts.power[0] - 0.01]) + dim * 0.8 * span([acts.power[1] - 0.04, acts.hold[0]])
      const heatSpan = (acts.reflow[1] - acts.reflow[0]) - 0.5 / 24
      const heatU = (p - acts.reflow[0]) / heatSpan
      const heat = Math.min(span([acts.reflow[0] - 0.01, acts.reflow[0] + 0.01]), 1 - span([acts.reflow[1] - 0.01, acts.reflow[1] + 0.01]))
      const centre = { x: extent.x + extent.w / 2, y: extent.y + extent.h / 2 }
      const diag = Math.hypot(extent.w, extent.h)
      const floorZ = -Math.max(1.5, m.thicknessPx * 1.4) - 0.5
      const keyAz = -2.35 + p * 1.1

      const drawScene = (c: Cam, q: number): void => {
        g.enable(g.BLEND)
        g.blendFunc(g.ONE, g.ONE_MINUS_SRC_ALPHA)
        g.clearColor(0, 0, 0, 0)
        g.clearDepth(1)
        // clear respects the depth mask: open it, or last frame's depth survives
        g.depthMask(true)
        g.clear(g.COLOR_BUFFER_BIT | g.DEPTH_BUFFER_BIT)
        g.disable(g.DEPTH_TEST)
        g.depthMask(false)
        g.bindVertexArray(vao)
        // the studio floor: light pool, contact shadow and spill
        if (!tl.transparent) {
          tex(0, mapTex[1] as WebGLTexture)
          tex(1, mapTex[0] as WebGLTexture)
          tex(2, mapTex[2] as WebGLTexture)
          const fr = diag * 3
          P.floor.use().m4('uVP', c.vp).f('uRegion', centre.x - fr, centre.y - fr, fr * 2, fr * 2).f('uZ', floorZ)
            .i('tSurf', 0).i('tTop', 1).i('tFx', 2).f('uMap', ...regionV).f('uCentre', centre.x, centre.y).f('uSpread', diag * 0.75)
            .v3('uWarm', warmC).v3('uCool', coolC).f('uKeyDir', Math.cos(keyAz), Math.sin(keyAz), 0)
          g.drawArrays(g.TRIANGLE_STRIP, 0, 4)
        }
        if (wallCount > 0) {
          // the board's edge: laminate with a copper line per layer
          g.enable(g.DEPTH_TEST)
          g.depthMask(true)
          g.bindBuffer(g.ARRAY_BUFFER, wallBuf)
          const loc = g.getAttribLocation(P.wall.p, 'aWall')
          g.enableVertexAttribArray(loc)
          g.vertexAttribPointer(loc, 4, g.FLOAT, false, 0, 0)
          P.wall.use().m4('uVP', c.vp).f('uThick', Math.max(1.5, m.thicknessPx * 1.4)).f('uZ', 0)
            .v3('uSub', linear(m.substrate)).v3('uCopper', copper).v3('uMask', maskLin).f('uLayers', Math.max(1, s.layers.length)).f('uMaskOn', maskSpan)
          lighting(P.wall, c, p, room)
          g.drawArrays(g.TRIANGLES, 0, wallCount)
          g.disableVertexAttribArray(loc)
        }
        g.enable(g.DEPTH_TEST)
        g.depthFunc(g.LEQUAL)
        g.depthMask(true)
        tex(0, mapTex[0] as WebGLTexture)
        tex(1, mapTex[1] as WebGLTexture)
        tex(2, mapTex[2] as WebGLTexture)
        P.top.use().m4('uVP', c.vp).f('uRegion', ...regionV).f('uZ', 0).i('tTop', 0).i('tSurf', 1).i('tFx', 2)
          .f('uTexel', ...texel).v3('uCopper', copper).v3('uFinish', linear(m.finish)).v3('uMask', maskLin)
          .v3('uSub', linear(m.substrate)).v3('uSilk', linear(m.silk)).v3('uWarm', warmC).v3('uCool', coolC).f('uHead', 1.25, 0.95, 0.65)
          .f('uFinishRough', m.finishRough).f('uMaskFront', maskFront).f('uMaskSoft', soft).f('uMaskOn', maskOn).f('uMaskLuma', Math.pow(maskLuma, 1 / 2.2))
          .f('uCured', span([acts.mask[1], acts.mask[1] + 0.04])).f('uFinishOn', span([acts.mask[1] - 0.01, acts.mask[1] + 0.02]))
          .f('uEnergy', energyGain).f('uPxPerMm', m.pxPerMm).f('uBump', 1.6)
          .f('uHeat', heat).f('uHeatX', boardX[0] + heatU * (boardX[1] - boardX[0])).f('uHeatW', 0.12 * extent.w)
        lighting(P.top, c, p, room)
        g.drawArrays(g.TRIANGLE_STRIP, 0, 4)
        if (boxCount + roundCount + valveCount > 0) {
          // bodies: opaque, depth-tested, sampled at the subframe's own time so falls blur
          g.disable(g.BLEND)
          g.bindBuffer(g.ARRAY_BUFFER, partBuf)
          const stride = 20 * 4
          const locs = ['aBox', 'aMeta', 'aLabel', 'aSkew', 'aLed'].map((n) => g.getAttribLocation(P.part.p, n))
          const point = (first: number): void => {
            for (const [i, loc] of locs.entries()) {
              g.enableVertexAttribArray(loc)
              g.vertexAttribPointer(loc, 4, g.FLOAT, false, stride, first * stride + i * 16)
              g.vertexAttribDivisor(loc, 1)
            }
          }
          tex(0, atlasTex)
          P.part.use().m4('uVP', c.vp).f('uP', q).f('uDur', tl.durationSeconds).f('uFall', 6 * m.pxPerMm)
            .i('tAtlas', 0).f('uCell', 1 / ATLAS_COLS, 1 / ATLAS_ROWS).v3('uFinish', linear(m.finish))
            .f('uLedOn', span([acts.power[0], acts.power[0] + 0.01])).f('uHeat', span([acts.power[0], acts.power[0] + 3 / 24]))
          lighting(P.part, c, p, room)
          if (boxCount > 0) {
            point(0)
            P.part.i('uRound', 0)
            g.drawArraysInstanced(g.TRIANGLES, 0, 36, boxCount)
          }
          if (roundCount > 0) {
            point(boxCount)
            P.part.i('uRound', 1)
            g.drawArraysInstanced(g.TRIANGLES, 0, 24 * 9, roundCount)
          }
          if (valveCount > 0) {
            // glass: blended over everything drawn so far, without hiding what is behind it
            g.enable(g.BLEND)
            g.blendFunc(g.ONE, g.ONE_MINUS_SRC_ALPHA)
            g.depthMask(false)
            point(boxCount + roundCount)
            P.part.i('uRound', 1)
            g.drawArraysInstanced(g.TRIANGLES, 0, 24 * 9, valveCount)
            g.depthMask(true)
            g.disable(g.BLEND)
          }
          for (const loc of locs) {
            g.vertexAttribDivisor(loc, 0)
            g.disableVertexAttribArray(loc)
          }
          g.enable(g.BLEND)
        }
        g.disable(g.DEPTH_TEST)
        g.depthMask(false)
      }

      // motion blur: a 180° shutter, clamped to the current shot; maps hold per frame
      const n = Math.max(1, quality.subframes)
      const shutter = 0.5 / tl.totalFrames
      if (n === 1) {
        bind(accum)
        drawScene(cam, p)
      } else {
        const [ta, tb] = shotSpan(s.shots, p)
        bind(accum)
        g.clearColor(0, 0, 0, 0)
        g.clear(g.COLOR_BUFFER_BIT)
        for (let i = 0; i < n; i++) {
          const q = Math.min(tb - 1e-7, Math.max(ta, p + ((i + 0.5) / n - 0.5) * shutter))
          bind(scene)
          drawScene(makeCam(sampleShot(s.shots, q), W, H), q)
          bind(accum)
          g.enable(g.BLEND)
          g.blendFunc(g.ONE, g.ONE)
          tex(0, scene.tex)
          P.copy.use().i('t', 0).f('uW', 1 / n)
          quad()
        }
      }
      g.disable(g.BLEND)

      // depth of field focused on the look-at point
      bind(dof)
      tex(0, accum.tex)
      P.dof.use().i('t', 0).f('uRes', W, H).v3('uCam', cam.pos).v3('uF', cam.f).v3('uR', cam.r).v3('uU', cam.u)
        .f('uTan', cam.tanX, cam.tanY).f('uShift', cam.shift).f('uFocus', cam.dist).f('uAperture', cam.aperture * 0.045 * H).f('uMaxR', 0.022 * H)
      quad()

      // bloom pyramid on what's above white, and a horizontal streak
      bind(pyramid[0] as Target)
      tex(0, dof.tex)
      P.bright.use().i('t', 0)
      quad()
      for (let i = 1; i < pyramid.length; i++) {
        const src = pyramid[i - 1] as Target
        bind(pyramid[i] as Target)
        tex(0, src.tex)
        P.down.use().i('t', 0).f('h', 0.5 / src.w, 0.5 / src.h)
        quad()
      }
      bind(streakA)
      tex(0, (pyramid[0] as Target).tex)
      P.copy.use().i('t', 0).f('uW', 1)
      quad()
      let sa = streakA
      let sb = streakB
      for (const step of [1, 2.5, 6]) {
        bind(sb)
        tex(0, sa.tex)
        P.streak.use().i('t', 0).f('uStep', step / sw, 0)
        quad()
        ;[sa, sb] = [sb, sa]
      }
      g.enable(g.BLEND)
      g.blendFunc(g.ONE, g.ONE)
      for (let i = pyramid.length - 1; i > 0; i--) {
        const src = pyramid[i] as Target
        bind(pyramid[i - 1] as Target)
        tex(0, src.tex)
        P.up.use().i('t', 0).f('h', 0.5 / src.w, 0.5 / src.h)
        quad()
      }
      g.disable(g.BLEND)

      bind(null)
      tex(0, dof.tex)
      tex(1, (pyramid[0] as Target).tex)
      tex(2, sa.tex)
      const bg = tl.transparent ? [0, 0, 0] : linear(pal.bg).map((v) => Math.pow(v, 1 / 2.2))
      P.final.use().i('tCol', 0).i('tBloom', 1).i('tStreak', 2)
        .f('uBloom', 0.7 * pal.bloom + 0.2).f('uStreak', 0.04).v3('uStreakTint', coolC)
        .f('uExposure', 1.32).f('uCA', 0.0012).f('uFrame', frame).i('uGrain', tl.transparent ? 0 : 1)
        .i('uTransparent', tl.transparent ? 1 : 0).v3('uBg', bg).f('uVignette', 0.32)
      g.clearColor(0, 0, 0, 0)
      g.clear(g.COLOR_BUFFER_BIT)
      quad()
      g.finish()

      lastAnnotations = annotate(tl, p)
      return canvas
    },
    dispose(): void {
      g.getExtension('WEBGL_lose_context')?.loseContext()
    }
  }
}

/** the captions showing at phase p, faded in and out */
function annotate(tl: TraceTimeline, p: number): Annotation[] {
  return tl.scene.callouts
    .filter((c) => p >= c.t0 && p <= c.t1)
    .map((c) => ({ text: c.text, sub: c.sub, alpha: Math.min(ease((p - c.t0) / 0.012), ease((c.t1 - p) / 0.012)) }))
    .filter((a) => a.alpha > 0.01)
}

