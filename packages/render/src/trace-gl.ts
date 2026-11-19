import { FENCE_DEPTH, FENCE_MOST, lightAt, liveLed, makeCam, nearShare, norm, project, sampleShot, silhouette } from '@silk-reel/choreo'
import type { Cam, CameraShot, TraceLight, TracePad, TracePart, TraceTimeline } from '@silk-reel/choreo'
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
export interface TraceGL {
  /** sweep: that many samples across a 180° shutter centred on the frame, with no smear limit; shut: the share of that shutter left open */
  render(tl: TraceTimeline, frame: number, sweep?: number, shut?: number): HTMLCanvasElement
  /** the same frame as render, handing the browser back its main thread between passes of BLUR_PASS samples */
  renderAsync(tl: TraceTimeline, frame: number): Promise<HTMLCanvasElement>
  /** the same frame's board and parts as a matte, same size and camera as render: alpha 1 where the board slab or a part is the nearest surface, 0 on the floor; red is height above the board plane, 1 at the tallest part */
  matte(tl: TraceTimeline, frame: number): HTMLCanvasElement
  dispose(): void
}

export interface TraceQuality {
  /** motion-blur samples per frame */
  subframes: number
  /** data-map resolution, × the frame */
  mapScale: number
  /**
   * accumulation samples per frame: above 1, each sample also jitters the pixel, a point on the lens
   * (true depth of field), a point on the key (soft shadows) and a point of the sky (occlusion), and the
   * board and floor show planar reflections. subframes is then ignored
   */
  samples?: number | undefined
  /** tone curve for look tests: ACES (the default), Khronos PBR Neutral or AgX */
  tonemap?: 'aces' | 'neutral' | 'agx' | undefined
  /** studio for look tests: the dark studio (the default) or a pale high-key one */
  studio?: 'dark' | 'high' | undefined
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
uniform vec3 uRim; uniform vec3 uRimCol; uniform float uRoom; uniform vec4 uRing;
uniform vec4 uEnv; uniform float uBackAz; uniform vec3 uStripN; uniform vec3 uStrip; uniform vec3 uStripCol; uniform float uRimOnly;
uniform vec3 uBand; uniform vec3 uBandCol; uniform vec4 uPoolAt; uniform float uBounce; uniform float uSide; uniform float uMark; uniform float uHeroLit; uniform float uEtch; uniform vec4 uSweep; uniform float uSweepLid;
uniform highp sampler2DShadow tShadow; uniform mat4 uLightVP[4]; uniform vec2 uShadowBias;
uniform highp sampler2DShadow tSky; uniform mat4 uSkyVP; uniform float uSkyOn;
uniform vec3 uBoxC; uniform vec3 uBoxU; uniform vec3 uBoxV; uniform vec3 uBoxCol;
uniform vec4 uLedP[12]; uniform vec4 uLedC[12];
uniform vec4 uFallA[24]; uniform vec4 uFallB[24];
uniform vec3 uScrC; uniform vec3 uScrU; uniform vec3 uScrV; uniform vec3 uScrCol; uniform vec4 uScrK; uniform float uGloss; uniform float uFlip; uniform float uBody; uniform vec3 uEyeN; uniform vec3 uFwdN; uniform vec2 uNearDim;
float gHero = 0.0;
float gDim = 0.0;
// a part still in the air throws a soft pool, no edge: wider and fainter the higher it hangs
float fallShade(vec3 p){
  float v = 1.0;
  for (int i = 0; i < 24; i++) {
    float h = uFallB[i].y;
    if (h <= 0.0) continue;
    if (p.z > h) continue;
    vec2 d = p.xy - uFallA[i].xy;
    float c = cos(uFallB[i].x), s = sin(uFallB[i].x);
    vec2 q = vec2(c * d.x - s * d.y, s * d.x + c * d.y);
    vec2 e = abs(q) - uFallA[i].zw;
    float sd = length(max(e, 0.0)) + min(max(e.x, e.y), 0.0);
    float size = max(uFallA[i].z, uFallA[i].w);
    float blur = 0.5 * min(uFallA[i].z, uFallA[i].w) + 0.9 * h;
    float k = 1.0 - smoothstep(-blur, blur, sd);
    v *= 1.0 - 0.6 * k * size / (size + 1.4 * h);
  }
  return v;
}
// the board's own LEDs as small point lights: what they throw on the mask, the silk and the sides of their neighbours
vec3 ledLight(vec3 P, vec3 N, vec3 alb){
  vec3 s = vec3(0.0);
  for (int i = 0; i < 12; i++) {
    if (uLedC[i].a <= 0.0) continue;
    vec3 d = uLedP[i].xyz - P;
    float r = uLedP[i].w;
    if (length(d.xy) < 0.25 * r && P.z > 0.6 * uLedP[i].z) continue;
    float d2 = dot(d, d);
    float face = 0.3 + 0.7 * max(dot(N, d * inversesqrt(max(d2, 1e-6))), 0.0);
    float fall = r * r / (d2 + r * r);
    s += uLedC[i].rgb * uLedC[i].a * face * 2.0 * fall * fall;
  }
  return s * alb;
}
vec3 gPos = vec3(0.0);
const float PI = 3.14159265;
const float LIT_MAX = 1.45;
const float COAT_BOX = 0.3;
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
// the studio each shot sets: a dim cyclorama (uEnv.z), a big soft box overhead (uEnv.x),
// a wide panel ahead of the lens that grades dark to bright across its width (uEnv.y),
// black flags either side of the lens (uEnv.w), and one strip light: the band of sky
// where R is square to uStripN, uStrip.x wide, uStrip.y bright, above elevation uStrip.z
const float RING_AA = 0.6;
vec3 envLight(vec3 R, float rough){
  float soft = 0.04 + rough * 0.45;
  vec3 sky = (vec3(0.010, 0.012, 0.016) + vec3(0.03, 0.033, 0.04) * smoothstep(-0.2, 1.0, R.z)) * uEnv.z;
  float top = panel(R, 0.92, 1.62, 0.0, 3.2, soft) * mix(0.18, 1.0, smoothstep(-0.45, 0.55, dot(R.xy, vec2(cos(uBackAz), sin(uBackAz)))));
  float az = atan(R.y, R.x);
  float across = mod(az - uBackAz + PI, 2.0 * PI) - PI;
  float back = panel(R, 0.02, 0.93, uBackAz, 0.95, soft) * mix(0.15, 1.0, smoothstep(-0.95, 0.95, across));
  float strip = exp(-sq(dot(R, uStripN) / (uStrip.x + rough * 0.06))) * (1.0 - smoothstep(0.25, 0.6, rough)) * smoothstep(uStrip.z - 0.05, uStrip.z + 0.1, R.z);
  float flags = max(panel(R, -0.1, 1.2, uBackAz + 1.35, 0.3, soft), panel(R, -0.1, 1.2, uBackAz - 1.35, 0.3, soft));
  vec3 env = sky + vec3(1.0, 0.99, 0.975) * top * 0.5 * uEnv.x + vec3(1.0, 0.99, 0.975) * back * 0.6 * uEnv.y + uStripCol * strip * uStrip.y;
  float rel = asin(clamp(R.z, -1.0, 1.0));
  float ringSoft = 0.02 + rough * 0.3 + RING_AA * fwidth(rel);
  float ring = smoothstep(uRing.y - ringSoft, uRing.y + ringSoft, rel) * (1.0 - smoothstep(uRing.z - ringSoft, uRing.z + ringSoft, rel));
  return env * (1.0 - uEnv.w * flags) + vec3(1.0, 0.93, 0.84) * ring * uRing.x;
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
// how much of the key reaches p: four shadow maps per accumulation sample, each from a point on the key's face, in the atlas's quadrants
float keyVis(vec3 p, vec3 N){
  float v = 0.0;
  for (int k = 0; k < 4; k++) {
    vec4 c = uLightVP[k] * vec4(p + N * uShadowBias.x, 1.0);
    vec3 q = c.xyz / c.w * 0.5 + 0.5;
    if (q.x <= 0.0 || q.y <= 0.0 || q.x >= 1.0 || q.y >= 1.0 || q.z >= 1.0) { v += 1.0; continue; }
    vec2 o = vec2(float(k - (k / 2) * 2), float(k / 2));
    v += texture(tShadow, vec3((clamp(q.xy, vec2(0.001), vec2(0.999)) + o) * 0.5, q.z - uShadowBias.y));
  }
  return 0.25 * v * fallShade(p);
}
// how much of the sky reaches p: a shadow map from a different point of the sky each sample, so the average is occlusion
float skyVis(vec3 p, vec3 N){
  if (uSkyOn < 0.5) return 1.0;
  vec4 c = uSkyVP * vec4(p + N * uShadowBias.x, 1.0);
  vec3 q = c.xyz / c.w * 0.5 + 0.5;
  if (q.x <= 0.0 || q.y <= 0.0 || q.x >= 1.0 || q.y >= 1.0 || q.z >= 1.0) return 1.0;
  return texture(tSky, vec3(q.xy, q.z - uShadowBias.y));
}
// the softbox: a lit rectangle (centre, half sides). a glossy surface shows its shape: the mirror ray lands on
// the box's plane, the lobe blurs its edges by the roughness times the distance, and a lobe wider than the box
// dilutes its radiance by the ratio of their solid angles
vec3 boxSpec(vec3 N, vec3 V, float rough, vec3 f0){
  if (dot(uBoxCol, uBoxCol) < 1e-8) return vec3(0.0);
  vec3 R = reflect(-V, N);
  vec3 nB = normalize(cross(uBoxU, uBoxV));
  float den = dot(R, nB);
  if (abs(den) < 1e-4) return vec3(0.0);
  float t = dot(uBoxC - gPos, nB) / den;
  if (t <= 0.0) return vec3(0.0);
  vec3 d = gPos + R * t - uBoxC;
  float lu = length(uBoxU), lv = length(uBoxV);
  float dx = max(abs(dot(d, uBoxU / lu)) - lu, 0.0);
  float dy = max(abs(dot(d, uBoxV / lv)) - lv, 0.0);
  float lobe = 1.5 * max(rough * rough, 0.002);
  float edge = lobe * t + 1e-3;
  float cover = exp(-(dx * dx + dy * dy) / (edge * edge));
  float dilute = min(1.0, 4.0 * lu * lv * abs(den) / (t * t) / (PI * lobe * lobe));
  float NoV = max(dot(N, V), 1e-3);
  vec3 F = f0 + (1.0 - f0) * pow(1.0 - NoV, 5.0);
  return F * uBoxCol * cover * dilute;
}
const float SCRIM_MAX = 0.7;
// under the scrim the lids are black gloss: this rough, and this share of their base colour
const float GLOSS_ROUGH = 0.22;
const float GLOSS_BASE = 0.5;
vec3 scrSpec(vec3 N, vec3 V, float rough, vec3 f0){
  if (dot(uScrCol, uScrCol) < 1e-8) return vec3(0.0);
  vec3 R = reflect(-V, N);
  vec3 nB = normalize(cross(uScrU, uScrV));
  float den = dot(R, nB);
  if (abs(den) < 1e-4) return vec3(0.0);
  float t = dot(uScrC - gPos, nB) / den;
  if (t <= 0.0) return vec3(0.0);
  vec3 d = gPos + R * t - uScrC;
  float lu = length(uScrU), lv = length(uScrV);
  float x = dot(d, uScrU / lu), y = dot(d, uScrV / lv);
  float lobe = 1.5 * max(rough * rough, 0.002);
  float edge = lobe * t * uScrK.w + 1e-3;
  float sideA = smoothstep(-edge, edge, x + lu);
  float sideB = 1.0 - smoothstep(-edge, edge, x - lu);
  float u = clamp((y + lv * uScrK.x) / (lv * (1.0 + uScrK.x)), 0.0, 1.0);
  float hard = smoothstep(-edge, edge, y + lv * uScrK.x);
  float ramp = hard * sq(1.0 - u) * (1.0 - smoothstep(lv * 0.9, lv, y));
  float side = mix(sideA * sideB, sideA * sideB * mix(1.0, 0.15, smoothstep(-lu, lu, x)), uScrK.y);
  float NoV = max(dot(N, V), 1e-3);
  vec3 F = f0 + (1.0 - f0) * pow(1.0 - NoV, 5.0);
  vec3 c = F * uScrCol * ramp * side;
  return c / (1.0 + c / SCRIM_MAX);
}
vec3 boxDiff(vec3 N){
  if (dot(uBoxCol, uBoxCol) < 1e-8) return vec3(0.0);
  vec3 toC = uBoxC - gPos;
  float d2 = dot(toC, toC);
  float area = 4.0 * length(uBoxU) * length(uBoxV);
  vec3 nB = normalize(cross(uBoxU, uBoxV));
  vec3 L = toC * inversesqrt(d2);
  return 0.08 * uBoxCol * max(dot(N, L), 0.0) * abs(dot(L, nB)) * area / (PI * d2 + area);
}
vec3 shade(vec3 N, vec3 V, vec3 albedo, float metal, float rough0, float f0d){
  float rough = aaRough(N, rough0);
  vec3 L = normalize(uKey);
  float NoL = max(dot(N, L), 0.0), NoV = max(dot(N, V), 1e-3);
  vec3 f0 = mix(vec3(f0d), albedo, metal);
  vec3 H = normalize(L + V);
  vec3 F = f0 + (1.0 - f0) * pow(clamp(1.0 - dot(V, H), 0.0, 1.0), 5.0);
  float vis = NoL > 0.0 ? keyVis(gPos, N) : 0.0;
  float sky = skyVis(gPos, N);
  vec3 spec = ggx(N, V, L, rough) * F * uKeyCol * vis + boxSpec(N, V, rough, f0) * sky + scrSpec(N, V, rough, f0) * sky * (1.0 - gHero);
  // the rim: a cool light from behind that only catches edges and bevels
  vec3 Lr = normalize(uRim);
  vec3 Fr = f0 + (1.0 - f0) * pow(max(1.0 - NoV, 0.0), 5.0);
  vec3 rim = ggx(N, V, Lr, max(rough, 0.18)) * Fr * uRimCol * smoothstep(0.02, 0.35, 1.0 - N.z) * mix(1.0, gHero, uRimOnly);
  vec3 diff = albedo * (1.0 - metal) * (NoL * uKeyCol * vis + (uFill + vec3(1.0, 0.99, 0.975) * uBounce * mix(0.6 + 0.4 * max(N.z, 0.0), 1.0 - 0.6 * max(N.z, 0.0), uSide) + boxDiff(N)) * sky) / PI * 2.0;
  vec3 refl = (envLight(reflect(-V, N), rough) * mix(Fr, albedo * 0.9 + 0.1, metal) + vec3(1.0, 0.99, 0.975) * uBounce * 0.13 * Fr * max(N.z, 0.0) * (1.0 - metal)) * sky;
  // a dimmed studio goes cool, so the board's warm light has a colour to stand against
  float band = uBand.z * exp(-sq((gPos.x - uBand.x) / max(uBand.y, 1e-3)));
  float pool = exp2(-uPoolAt.w * sq(length(gPos.xy - uPoolAt.xy) / max(uPoolAt.z, 1.0)));
  vec3 lit = (diff + spec + refl) * uRoom * pool * mix(1.0, uHeroLit, gHero) + rim
           + uBandCol * band * mix(albedo * (1.0 - metal), albedo * 0.6, metal)
           + ledLight(gPos, N, albedo * (1.0 - metal) + f0 * 0.5);
  // stop below the bloom threshold, keeping the hue
  return lit * min(1.0, LIT_MAX / max(1e-4, max(lit.r, max(lit.g, lit.b))));
}`

const FS_TOP = `#version 300 es
precision highp float;
in vec2 vUv; in vec3 vW; out vec4 o;
uniform sampler2D tTop; uniform sampler2D tSurf; uniform sampler2D tFx; uniform vec2 uTexel;
uniform vec3 uCopper; uniform vec3 uFinish; uniform vec3 uMask; uniform vec3 uSub; uniform vec3 uSilk;
uniform vec4 uGold0; uniform vec4 uGold1; uniform vec4 uGold2; uniform vec4 uGold3;
const float GLOW_MAX = 0.8;
const float SPILL_PX = 8.0;
const float HEAT_FILL = 0.3;
const float HEAT_EDGE_PX = 2.0;
float inBox(vec2 p, vec4 b){ return step(b.x, p.x) * step(p.x, b.z) * step(b.y, p.y) * step(p.y, b.w); }
uniform vec3 uWarm; uniform vec3 uCool;
uniform float uMaskKeep; uniform float uFinishRough; uniform float uMaskFront; uniform float uMaskSoft; uniform float uMaskOn; uniform float uMaskLuma; uniform vec2 uMaskDir;
uniform float uCured; uniform float uFinishOn; uniform float uSolder; uniform float uEnergy; uniform float uPxPerMm; uniform float uBump;
uniform sampler2D tMirror; uniform float uMirrorOn; uniform vec2 uRes;
uniform float uDark; uniform float uHeat; uniform float uKeepCu; uniform float uFrontGain; uniform vec2 uOrigin; uniform float uFlare; uniform float uLip; uniform vec2 uFwd; uniform float uThick; uniform vec2 uSpan; uniform vec4 uLamp; uniform vec3 uLampCol;
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
  float pxPerTexel = 1.0 / max(1e-4, length(fwidth(vUv / uTexel)));
  float soft = textureLod(tTop, vUv, 0.8).r;
  float crisp = smoothstep(0.42 - max(0.75 * fwidth(soft), 0.02), 0.42 + max(0.75 * fwidth(soft), 0.02), soft);
  cu = mix(cu, crisp, smoothstep(1.5, 3.0, pxPerTexel));
  gPos = vW;
  vec3 V = normalize(uCam - vW);
  vec2 mm = vec2(vW.x, -vW.y) / uPxPerMm;
  // sharp shoulders, flat tops: a fine gradient for the edge, a broad one for the bevel
  vec2 g = (gradH(1.0, 0.5) * 0.7 + gradH(2.5, 1.2) * 0.35) * uBump;
  vec2 gs = gradC(tSurf, 0, 1.2, 0.3) * uBump * 0.6;
  // rolled copper: a fine directional grain
  float grain = (vnoise(mm * vec2(70.0, 2.5)) - 0.5) * (1.0 - smoothstep(0.25, 0.6, length(fwidth(mm)) * 70.0));
  vec3 Ncu = normalize(vec3(-g.x + grain * 0.03, g.y, 1.0));
  float weave = 0.5 + 0.5 * sin(mm.x * 11.0) * sin(mm.y * 11.0 + 1.3);
  vec3 subAlb = uSub * (0.85 + 0.25 * weave);
  // while the copper is drawn the laminate sits in the dark, so the drawing is the only thing to read
  vec3 baseSub = shade(vec3(0, 0, 1), V, subAlb, 0.0, 0.6, 0.04) * (1.0 - 0.82 * uDark);
  float tone = vnoise(mm * 0.5) * 0.06;
  float cuRough = min(0.6, sqrt(0.0484 + 4.0 * dot(fwidth(Ncu), fwidth(Ncu))));
  vec3 baseCu = shade(Ncu, V, uCopper * (0.97 + tone), 1.0, cuRough, 0.04);
  vec2 plane = vec2(vW.x, -vW.y);
  float fingers = max(max(inBox(plane, uGold0), inBox(plane, uGold1)), max(inBox(plane, uGold2), inBox(plane, uGold3)));
  vec3 plated = mix(shade(Ncu, V, uFinish, 1.0, max(cuRough, max(uFinishRough, 0.22) + 0.15 * (1.0 - uSolder)), 0.04), shade(Ncu, V, uFinish * 0.85, 0.0, 0.55, 0.04), 0.4);
  vec3 basePad = mix(plated,
                     shade(Ncu, V, vec3(0.94, 0.66, 0.26), 1.0, 0.26, 0.04), fingers);
  vec3 col = mix(baseSub, baseCu, cu);
  col = mix(col, mix(baseCu, basePad, uFinishOn), pad);
  // the mask clears every pad by a lip and follows the copper relief beneath.
  // one pour across the board from the hero's side: the liquid runs ahead along the copper, lags over bare laminate, and its edge lobes
  float wick = textureLod(tTop, vUv, 3.0).r + 0.6 * textureLod(tTop, vUv, 1.2).r;
  float lobes = (vnoise(mm * 0.11) - 0.5) * 1.6 + (vnoise(mm * 0.37 + 4.1) - 0.5) * 0.5;
  float py = dot(vec2(vW.x, -vW.y) - uOrigin, uMaskDir) + uMaskSoft * (lobes - 1.1 * (wick - 0.5));
  float padNear = textureLod(tTop, vUv, 1.4).g;
  float clearance = smoothstep(0.04, 0.22, padNear);
  float poured = smoothstep(uMaskFront, uMaskFront - uMaskSoft * 0.12, py);
  float wet = poured * exp(-max(0.0, uMaskFront - py) / (uMaskSoft * 3.0)) * step(uMaskOn, 1.5) * (1.0 - step(0.999, uCured));
  float front = uMaskOn * exp(-sq((py - uMaskFront + uMaskSoft * 0.2) / (uMaskSoft * 0.1))) * (1.0 - poured * 0.5);
  float masked = uMaskOn * poured * (1.0 - max(pad, clearance)) * (1.0 - hole);
  vec2 lip = gradC(tTop, 1, 2.0, 1.4) * uBump * 0.8 * uMaskOn;
  // under the coat the relief softens: traces read as gentle ridges, not engraved lines
  vec3 Nm = normalize(vec3(-g.x * 0.28 + lip.x, g.y * 0.28 - lip.y, 1.0));
  // the mask is a clear coat over two floors: over copper the colour is lighter and yellower, over bare
  // laminate darker and bluer. a dark coat shows the copper under it as a faint lift
  float lift = mix(1.18, 1.45, smoothstep(0.08, 0.3, uMaskLuma) * (1.0 - smoothstep(0.6, 0.9, uMaskLuma)));
  float sink = mix(0.9, 0.95, uMaskLuma);
  vec3 overCu = min(uMask * lift * vec3(1.04, 1.02, 0.9) + uCopper * mix(0.018, 0.05, smoothstep(0.08, 0.3, uMaskLuma)), vec3(0.82));
  vec3 overLam = uMask * sink * mix(vec3(1.0), vec3(0.86, 0.97, 1.12), smoothstep(0.08, 0.3, uMaskLuma) * (1.0 - smoothstep(0.6, 0.9, uMaskLuma)));
  vec3 maskAlb = mix(overLam, overCu, smoothstep(0.1, 0.9, textureLod(tTop, vUv, 0.6).r));
  vec3 maskBase = shade(Nm, V, maskAlb, 0.0, 0.62, 0.0);
  maskBase *= min(1.0, 0.85 / max(1e-4, max(maskBase.r, max(maskBase.g, maskBase.b))));
  // from the breath on, the base keeps a share of its own colour at any view angle: the board never goes to a black card
  maskBase = max(maskBase, maskAlb * uMaskKeep);
  // the coat: its own lobe (F0 0.04), a ridge over every trace edge (bright toward the key, dark away from it),
  // orange peel in its gloss, and the parts standing on it seen in it
  float peelFade = 1.0 - smoothstep(0.08, 0.35, length(fwidth(mm * 1.8)));
  float peel = (vnoise(mm * 1.8) - 0.5) * peelFade;
  vec2 gr = gradH(0.8, 0.3) * uBump;
  vec3 Nc = normalize(vec3(-gr.x * 0.75 + lip.x + peel * 0.002, gr.y * 0.75 - lip.y + (vnoise(mm * 1.8 + 7.3) - 0.5) * peelFade * 0.002, 1.0));
  float rc = mix(mix(0.16, 0.22, uCured) * (1.0 + 0.06 * peel), 0.07, wet);
  float NcV = max(dot(Nc, V), 1e-3);
  float Fc = 0.04 + 0.96 * pow(1.0 - NcV, 5.0);
  vec3 Lk = normalize(uKey);
  float kv = keyVis(gPos, Nc);
  float sv = skyVis(gPos, Nc);
  vec3 coat = ggx(Nc, V, Lk, max(rc, 0.05)) * Fc * uKeyCol * kv + boxSpec(Nc, V, rc, vec3(0.04)) * sv * COAT_BOX + envLight(reflect(-V, Nc), rc) * min(Fc, 0.2) * sv * 0.15;
  vec3 seenIn = textureLod(tMirror, gl_FragCoord.xy / uRes, 1.0 + rc * 18.0).rgb * uMirrorOn;
  vec3 coatLit = coat * uRoom;
  coatLit *= min(1.0, LIT_MAX / max(1e-4, max(coatLit.r, max(coatLit.g, coatLit.b))));
  vec3 maskC = maskBase * (1.0 - Fc) + coatLit + seenIn * min(Fc, 0.2) * 0.6;
  maskC = max(maskC, maskBase * (1.0 - Fc) * uMaskKeep);
  vec2 dcell = floor(mm * 2.5);
  vec2 dpos = (dcell + vec2(hash(dcell), hash(dcell + 17.0))) / 2.5;
  float dust = step(0.986, hash(dcell + 3.1)) * (1.0 - smoothstep(0.012, 0.03, length(mm - dpos))) * (1.0 - smoothstep(0.02, 0.06, length(fwidth(mm))));
  maskC = mix(maskC, shade(vec3(0.0, 0.0, 1.0), V, vec3(0.42, 0.41, 0.39), 0.0, 0.9, 0.0), dust * 0.8);
  float flux = clamp(1.6 * textureLod(tTop, vUv, 2.5).g - textureLod(tTop, vUv, 0.5).g, 0.0, 1.0);
  maskC += maskBase * 0.1 * flux * uSolder;
  col = mix(col, maskC, masked);
  // the coat's edge catches the key, so even a black coat is seen arriving
  col += vec3(0.1, 0.105, 0.11) * front * uFrontGain * (1.0 - uMaskLuma) * (1.0 - max(pad, hole));
  // the wet front has a body: a rounded bead that catches the key as it travels
  float bx = (py - uMaskFront + uMaskSoft * 0.06) / (uMaskSoft * 0.045);
  float bead = uMaskOn * exp(-bx * bx) * (1.0 - step(0.999, uCured)) * (1.0 - max(pad, hole));
  vec3 Nb = normalize(vec3(vec2(uMaskDir.x, -uMaskDir.y) * clamp(-bx, -1.5, 1.5) * 0.8, 1.0));
  col += bead * (shade(Nb, V, vec3(0.0), 0.0, 0.07, 0.04) * 2.5 + uMask * 0.08);
  vec3 Ns = normalize(vec3(-gs.x, gs.y, 1.0));
  float inkFill = smoothstep(0.45, 0.85, textureLod(tSurf, vUv, 3.5).r);
  vec3 inkAlb = uSilk * mix(1.0, 0.8 + 0.14 * vnoise(mm * 2.2) + 0.06 * vnoise(mm * 9.0), inkFill);
  col = mix(col, shade(Ns, V, inkAlb, 0.0, mix(0.7, 0.85, inkFill), 0.04), silk * (0.4 + 0.6 * poured * uMaskOn));
  float drill = hole * (1.0 - pad);
  float holeLip = clamp(1.0 - abs(hole - 0.6) * 2.5, 0.0, 1.0) * (1.0 - pad);
  vec2 away = -V.xy / max(V.z, 0.08) * uThick;
  vec2 duv = vec2(away.x, -away.y) / uSpan;
  float wall = 0.0;
  for (float k = 0.25; k < 1.01; k += 0.25) wall = max(wall, 1.0 - textureLod(tSurf, vUv + duv * k, 0.0).g);
  wall *= drill;
  vec3 wallC = shade(normalize(vec3(V.xy, 0.0)), V, uSub * 1.3, 0.0, 0.7, 0.04);
  col = mix(col, wallC, drill) + mix(uSub, vec3(0.8), 0.5) * holeLip * (0.15 + 0.5 * uRoom) * (1.0 + 2.0 * clamp(dot(normalize(gradC(tSurf, 1, 1.5, 0.3) * vec2(1.0, -1.0) + vec2(1e-6)), -normalize(V.xy + vec2(1e-6))), 0.0, 1.0));
  vec2 ge = gradC(tSurf, 2, 2.0, 0.8);
  vec2 outward = -normalize(vec2(ge.x, -ge.y) + vec2(1e-6));
  col += uRimCol * 0.08 * uLip * clamp(length(ge) * 1.2, 0.0, 1.0) * mix(0.5, 1.0, smoothstep(-0.2, 0.8, dot(outward, uFwd))) * (1.0 - drill);
  // parts shade the board around their bodies
  col *= 1.0 - 0.9 * clamp(shadow, 0.0, 1.0);
  float under = smoothstep(0.45, 0.7, shadow);
  float seat = (1.0 - under) * (1.0 - 0.45 * smoothstep(0.08, 0.3, shadow));
  col *= 1.0 - 0.8 * under;
  // light: the only thing brighter than a lit surface. under the coat it spreads a little
  // a pale mask scatters what is under it far more than a dark one
  float scatter = masked * mix(0.25, 0.95, uMaskLuma);
  float reach = log2(max(1.0, SPILL_PX / pxPerTexel));
  float lod = min(mix(1.4, 1.9, uMaskLuma), reach);
  float spread = mix(1.3, 1.05, uMaskLuma);
  // capped, so a crowd of pads stays a set of lines instead of swelling into a halo;
  // only a pale coat, which really does glow from within, lifts the cap
  float cap = mix(0.5, 0.85, masked * smoothstep(0.4, 0.8, uMaskLuma));
  // the rails are a held glow, never brighter than the hero's own streaks
  float warm = min(mix(a.b, textureLod(tTop, vUv, lod).b * spread, scatter), cap * 0.65);
  float cool = min(mix(fx.r, textureLod(tFx, vUv, lod).r * spread, scatter), cap + 0.2);
  // under a pale coat light glows through as a deeper amber, not a white glare on white
  float pale = masked * smoothstep(0.5, 0.9, uMaskLuma);
  float dense = textureLod(tTop, vUv, 6.0).b + textureLod(tFx, vUv, 6.0).r + textureLod(tFx, vUv, 6.0).b;
  float tame = 1.0 / (1.0 + 5.0 * dense);
  vec3 warmCol = mix(uWarm, vec3(1.0, 0.42, 0.1), pale * 0.75);
  vec3 coolCol = mix(uCool, vec3(1.0, 0.6, 0.25), pale * 0.6);
  vec3 glowC = (warmCol * pow(warm, 1.4) + coolCol * pow(cool, 1.4) * 1.15) * uEnergy * tame * mix(1.0, 0.85, pale) * (1.0 - drill) * seat;
  // fresh copper cools like a struck wire: white at the head, then amber, then a dull red into bare metal
  vec3 hot = mix(vec3(0.85, 0.16, 0.03), vec3(1.0, 0.55, 0.18), smoothstep(0.04, 0.3, head));
  // held under the bloom threshold: the drawing glows, but power-on is the film's only light event
  float before = max(col.r, max(col.g, col.b));
  float inside = smoothstep(0.9, 0.99, textureLod(tTop, vUv, log2(max(1.0, HEAT_EDGE_PX * min(length(dFdx(vUv / uTexel)), length(dFdy(vUv / uTexel)))))).r);
  vec3 heat = hot * head * uEnergy * uHeat * (1.0 - masked) * (1.0 - drill);
  col += heat * min(1.0, max(0.0, LIT_MAX - before) / max(1e-4, max(heat.r, max(heat.g, heat.b)))) * mix(1.0, HEAT_FILL, inside);
  vec3 kept = vec3(1.0, 0.48, 0.16) * uKeepCu * textureLod(tTop, vUv, 0.0).r * (1.0 - masked) * (1.0 - drill);
  col += kept * min(1.0, max(0.0, LIT_MAX - max(col.r, max(col.g, col.b))) / max(1e-4, kept.r));
  col += vec3(1.0, 0.72, 0.42) * head * uFlare * tame * (1.0 - drill) * seat;
  // a pulse's white-hot core: the only thing in the film above the bloom threshold on a thin line
  col += vec3(1.0, 0.97, 0.92) * smoothstep(0.45, 1.0, head) * uFlare * 2.2 * (1.0 - drill) * seat;
  // lit copper is a line source: its light falls on the mask round it about as 1/d (three widths summed), tinted by the coat
  vec3 lods = min(vec3(2.5, 4.0, 5.5), vec3(reach + 1.0, reach + 2.5, reach + 4.0));
  vec3 spillW = vec3(textureLod(tTop, vUv, lods.x).b, textureLod(tTop, vUv, lods.y).b, textureLod(tTop, vUv, lods.z).b);
  vec3 spillC = vec3(textureLod(tFx, vUv, lods.x).r, textureLod(tFx, vUv, lods.y).r, textureLod(tFx, vUv, lods.z).r);
  vec3 spillH = vec3(textureLod(tFx, vUv, lods.x).b, textureLod(tFx, vUv, lods.y).b, textureLod(tFx, vUv, lods.z).b);
  vec3 wts = vec3(0.55, 0.3, 0.15);
  vec3 tint = mix(vec3(1.0), uMask / max(1e-3, max(uMask.r, max(uMask.g, uMask.b))), 0.7);
  glowC += (uWarm * dot(spillW, wts) + uCool * dot(spillC, wts) + vec3(1.0, 0.9, 0.8) * dot(spillH, wts) * 0.8) * tint * uEnergy * 0.35 * uFlare / 1.6 * masked * (1.0 - drill) * seat;
  float glowPeak = max(glowC.r, max(glowC.g, glowC.b));
  col += mix(glowC, vec3(1.0, 0.42, 0.1) * glowPeak, smoothstep(0.3, 1.5, glowPeak) * 0.6) * min(1.0, GLOW_MAX / max(1e-4, glowPeak));
  col += ledLight(gPos, vec3(0.0, 0.0, 1.0), mix(mix(mix(uSub, uMask, masked), uCopper, pad), uSilk, silk)) * (1.0 - drill);
  vec2 toLamp = (vec2(vW.x, -vW.y) - uLamp.xy) / uLamp.z;
  col += uLampCol * uLamp.w * exp(-dot(toLamp, toLamp)) * (0.3 + 0.7 * masked) * (1.0 - drill);
  float alpha = clamp(max(max(area * (1.0 - drill), wall), max(max(cu, pad), max(warm, max(cool, head)) * (1.0 - drill))), 0.0, 1.0);
  o = vec4(col * alpha, alpha);
}`

const FS_FLOOR = `#version 300 es
precision highp float;
in vec2 vUv; in vec3 vW; out vec4 o;
uniform sampler2D tSurf; uniform sampler2D tTop; uniform sampler2D tFx; uniform vec4 uMap;
uniform vec2 uCentre; uniform float uSpread; uniform float uPool; uniform vec3 uWarm; uniform vec3 uCool; uniform vec3 uKeyDir;
uniform vec3 uGround; uniform float uGroundOn; uniform float uFloorBase; uniform vec2 uFwd; uniform float uReach; uniform vec3 uReflCol; uniform float uReflLod; uniform float uEnergy;
uniform sampler2D tMirror; uniform float uMirrorOn; uniform vec2 uRes; uniform vec3 uEye;
void main(){
  vec2 p = vec2(vW.x, -vW.y);
  float d = length(p - uCentre);
  float pool = exp(-d * d / (2.0 * uSpread * uSpread));
  float near = exp(-d * d / (0.72 * uSpread * uSpread));
  // a pool of studio light falling off into black, or the end frame's graphite, lit in a soft pool under the board
  float behind = dot(p - uCentre, uFwd) / max(uReach, 1.0);
  float horizon = smoothstep(0.5, 2.6, behind);
  vec3 col = mix(vec3(0.016, 0.018, 0.022) * uPool * pool + vec3(0.0004), uGround * (uFloorBase + 0.3 * pool + 2.2 * near + 0.9 * horizon), uGroundOn);
  vec2 uv = (p - uMap.xy) / uMap.zw;
  vec2 suv = uv + uKeyDir.xy * vec2(1.0, -1.0) * mix(0.006, 0.012, uGroundOn);
  if (uv.x > 0.0 && uv.y > 0.0 && uv.x < 1.0 && uv.y < 1.0) {
    float refl = textureLod(tSurf, uv, uReflLod).b;
    col += uReflCol * refl * refl * 0.1 * uGroundOn;
  }
  if (suv.x > 0.0 && suv.y > 0.0 && suv.x < 1.0 && suv.y < 1.0) {
    // the board's contact shadow: tight under the edge, a soft skirt beyond it on a pale ground
    float sh = mix(textureLod(tSurf, suv, 4.5).b * 1.3, textureLod(tSurf, suv, 2.5).b + textureLod(tSurf, uv, 5.5).b * 0.3, uGroundOn);
    col *= 1.0 - mix(0.92, 0.7, uGroundOn) * clamp(sh, 0.0, 1.0);
  }
  if (uv.x > 0.0 && uv.y > 0.0 && uv.x < 1.0 && uv.y < 1.0) {
    // energy spills onto the floor around the board
    float spillLod = max(0.0, uReflLod - 1.0);
    float dense = textureLod(tTop, uv, 6.0).b + textureLod(tFx, uv, 6.0).r + textureLod(tFx, uv, 6.0).b;
    col += 0.35 * (uWarm * pow(textureLod(tTop, uv, spillLod).b, 1.4) + uCool * pow(textureLod(tFx, uv, spillLod).r, 1.4) * 1.15) * uEnergy / (1.0 + 5.0 * dense);
  }
  // a dark, slightly glossy studio floor: the board and its parts seen in it, blurred, stronger at grazing
  vec3 Vf = normalize(uEye - vW);
  float Ff = 0.04 + 0.96 * pow(1.0 - max(Vf.z, 0.0), 5.0);
  col += textureLod(tMirror, gl_FragCoord.xy / uRes, 2.2).rgb * Ff * 0.55 * uMirrorOn;
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
uniform vec3 uSub; uniform vec3 uCopper; uniform vec3 uMask; uniform float uLayers; uniform float uMaskOn; uniform float uEdgeFill;
${LIGHTING}
void main(){
  gPos = vW;
  vec3 V = normalize(uCam - vW);
  vec3 N = dot(vN, V) < 0.0 ? -vN : vN;
  // the cross-section: laminate with a copper line at every layer, mask on both faces
  float band = 0.0;
  for (float i = 0.0; i < 6.0; i += 1.0) {
    if (i >= uLayers) break;
    float li = uLayers > 1.0 ? i / (uLayers - 1.0) : 0.0;
    band = max(band, 0.45 * exp(-sq((vF - li) / 0.02)));
  }
  float fibre = 0.5 + 0.5 * sin(vF * 70.0);
  float glass = 0.5 + 0.5 * sin(dot(vW.xy, vec2(0.7071)) * 0.9) * sin(vF * 34.0);
  vec3 sub = mix(uSub, vec3(0.30, 0.27, 0.13), 0.75) * (0.8 + 0.35 * glass);
  vec3 lam = shade(N, V, sub * (1.0 + 0.3 * fibre), 0.0, 0.6, 0.04);
  vec3 cu = shade(N, V, uCopper, 1.0, 0.3, 0.04);
  vec3 col = mix(lam, cu, band);
  float face = uMaskOn * max(smoothstep(0.06, 0.0, vF), smoothstep(0.94, 1.0, vF));
  col = mix(col, shade(N, V, uMask, 0.0, 0.15, 0.05), face);
  col += sub * (1.0 + 0.3 * fibre) * uEdgeFill * (1.0 - face) * (1.0 - band);
  o = vec4(col, 1.0);
}`

const LANDING = `
// mirrors partDrop in trace-maps: one eased descent onto the pads along a straight line from its way in, zero from contact on,
// above 1 (not drawn) before the descent starts. a valve, the hero, settles slowly over three beats
uniform float uSlow;
float drop(float t, float p, float fall, float hero){
  if (hero > 0.5 && uSlow > 0.5) {
    float a = 1.0 - (t - p) / (3.0 / 24.0);
    if (a <= 0.0) return 1.0;
    if (a >= 1.0) return 0.0;
    return 1.0 - a * a * (3.0 - 2.0 * a);
  }
  float u = (t - p) / fall;
  if (u > 1.0) return 99.0;
  if (u <= 0.0) return 0.0;
  return hero > 0.5 ? u * u : u * u * (3.0 - 2.0 * u);
}
// a part set down by a machine comes in a little tipped and levels as it seats
float tip(float dr, float hero){ return hero > 0.5 ? 0.0 : 0.14 * min(dr, 1.0); }
`

/** a crystal's can is satin steel: a dark body that takes one soft highlight along its length */
/** where the held poster's out-of-focus foreground still covers more than FENCE_MOST of the frame, bodies nearer than the focus plane lose this much light, from none at `from` of the focus distance in front of it to `amount` at `full` */
export const NEAR_DIM = { amount: 0.7, from: 0.15, full: 0.3 }

/** how much light the bodies nearer than the focus plane lose at p: NEAR_DIM.amount from the cut to the held poster, where its foreground still covers more than FENCE_MOST of the frame, else none */
export function nearDimAt(tl: TraceTimeline, p: number, W: number, H: number): number {
  const s = tl.scene
  return s.film === true && p >= (s.shots.filter((k) => k.cut === true).at(-1)?.t ?? 1) && fenceOf(tl, W, H) > FENCE_MOST ? NEAR_DIM.amount : 0
}

const fences = new WeakMap<TraceTimeline, number>()
/** the share of the held poster's frame covered by bodies nearer than FENCE_DEPTH of the main chip's depth */
function fenceOf(tl: TraceTimeline, W: number, H: number): number {
  const known = fences.get(tl)
  if (known !== undefined) return known
  const s = tl.scene
  const hero = s.parts.find((pt) => pt.hero === true)
  const cam = makeCam(sampleShot(s.shots, 1), W, H)
  const share = hero === undefined ? 0 : nearShare(cam, W, H, s.parts.filter((pt) => pt.hero !== true && (pt.kind !== 'pin' || Math.hypot(pt.x - hero.x, pt.y - hero.y) > Math.max(hero.w, hero.h) / 2)), FENCE_DEPTH * ((hero.x - cam.pos[0]) * cam.f[0] + (-hero.y - cam.pos[1]) * cam.f[1] + (hero.z / 2 - cam.pos[2]) * cam.f[2]))
  fences.set(tl, share)
  return share
}

export const CAN = { alb: [0.2, 0.205, 0.215], rough: 0.34 }

const MARKING = `
// black epoxy takes this share of the studio's light; its marking takes all of it
const float LID = 0.5;
// a highlight crossing the main chip's lid: uSweep.xy is the crossing direction over the band's width, .z where the band stands, .w its strength; uSweepLid is the share of it the bare epoxy takes
// with uFlip the band is flat across its width and falls off only at its edge: under it the epoxy is bright and the marking dark; outside it the marking keeps uFlip of the band's resting light
vec3 lidSweep(vec3 w, float m){
  float x = dot(w.xy, uSweep.xy) - uSweep.z;
  if (uFlip > 0.0) {
    float k = sign(uSweep.w) * (1.0 - smoothstep(0.35, 1.0, abs(x)));
    gDim = k * m * gHero;
    return vec3(1.0, 0.98, 0.95) * (uSweep.w * k * (0.55 + 0.3 * vnoise(w.xy * 2.6)) * (1.0 - m) + uFlip * 0.6 * m * (1.0 - k));
  }
  float band = uSweep.w * exp(-sq(x));
  return vec3(1.0, 0.98, 0.95) * band * ((0.16 + 0.22 * vnoise(w.xy * 2.6)) * mix(uSweepLid, 1.0, m) + 0.6 * m);
}
// mould compound's grain at the screen's own scale: two octaves blended so no cell is wider than about 1.5 px at any distance, in -0.5..0.5
float fineGrain(vec2 w){
  float lv = log2(max(1e-3, 1.0 / max(1e-6, length(fwidth(w))) / 1.5)) + 1.0;
  float f0 = exp2(floor(lv));
  return mix(vnoise(w * f0), vnoise(w * f0 * 2.0), fract(lv)) - 0.5;
}
const float ETCH_LID = 0.7;
const float NEAR_FROM = ${NEAR_DIM.from};
const float NEAR_FULL = ${NEAR_DIM.full};
const vec3 CAN_ALB = vec3(${CAN.alb[0]}, ${CAN.alb[1]}, ${CAN.alb[2]});
const float CAN_ROUGH = ${CAN.rough};
const vec3 ETCH_ALB = vec3(0.16, 0.16, 0.165);
// the laser-etched marking on an IC's top face (q: 0..1 across the body)
uniform float uBareLid;
float marking(vec2 q){
  if (vLabel.z < 0.5) return 0.0;
  float shown = vLabel.w > 0.5 ? 1.0 - uBareLid : 1.0;
  if (shown <= 0.0) return 0.0;
  // the marking runs along the long side, at the atlas cell's 2:1 aspect
  bool wide = vSize.x >= vSize.y;
  vec2 t = wide ? q : vec2(q.y, 1.0 - q.x);
  float longS = max(vSize.x, vSize.y), shortS = min(vSize.x, vSize.y);
  float hFrac = min(1.0, 0.78 * longS / 2.0 / shortS);
  float wFrac = hFrac * shortS * 2.0 / longS;
  vec2 tc = vec2((t.x - 0.5) / wFrac + 0.5, (t.y - 0.5) / hFrac + 0.5);
  if (vLabel.z > 1.5) tc = 1.0 - tc;
  vec2 gx = dFdx(tc) * uCell, gy = dFdy(tc) * uCell;
  if (tc.x <= 0.0 || tc.x >= 1.0 || tc.y <= 0.0 || tc.y >= 1.0) return 0.0;
  return shown * textureGrad(tAtlas, (vLabel.xy + tc) * uCell, gx, gy).r;
}`

const VS_PART = `#version 300 es
in vec4 aBox;   // plane x, y, w, h
in vec4 aMeta;  // rot, height px, kind, landing time
in vec4 aLabel; // atlas cell (col,row), has label / pin pitch / a pin's housing height, hero
in vec4 aLed;   // an LED's linear colour and gain
in vec4 aFall;  // descent length (phase)
in vec4 aEnter; // where in the plane the descent starts, px from the pads
uniform mat4 uVP; uniform float uP; uniform float uDur; uniform int uRound; uniform float uFall; uniform float uMid; uniform float uCast; uniform vec2 uBlink;
out vec3 vW; out vec3 vN; out vec3 vL; flat out vec4 vMeta; flat out vec4 vLabel; flat out vec2 vSize; flat out float vRot; flat out vec4 vLed; flat out float vDrop; flat out float vSettle;
uniform vec2 uSettle;
const vec3 C[8] = vec3[8](vec3(-.5,-.5,0), vec3(.5,-.5,0), vec3(.5,.5,0), vec3(-.5,.5,0),
                          vec3(-.5,-.5,1), vec3(.5,-.5,1), vec3(.5,.5,1), vec3(-.5,.5,1));
const int I[36] = int[36](4,5,6, 4,6,7, 0,2,1, 0,3,2, 0,1,5, 0,5,4, 1,2,6, 1,6,5, 2,3,7, 2,7,6, 3,0,4, 3,4,7);
const vec3 FN[6] = vec3[6](vec3(0,0,1), vec3(0,0,-1), vec3(0,-1,0), vec3(1,0,0), vec3(0,1,0), vec3(-1,0,0));
${LANDING}
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
  float dr = drop(aMeta.w, uMid + (uP - uMid) * aFall.z, aFall.x, aLabel.w);
  vDrop = dr;
  vSettle = uP >= aMeta.w ? uSettle.y * exp(-(uP - aMeta.w) / uSettle.x) : 0.0;
  float rot = aMeta.x;
  float cr = cos(rot), sr = sin(rot);
  float ta = tip(dr, aLabel.w);
  float lz = (c.z - 0.5) * aMeta.y;
  vec2 lp = vec2(c.x * aBox.z, c.y * aBox.w * cos(ta) - lz * sin(ta));
  lz = c.y * aBox.w * sin(ta) + lz * cos(ta);
  vec2 pp = aBox.xy + aEnter.xy * min(dr, 1.0) + vec2(lp.x * cr - lp.y * sr, lp.x * sr + lp.y * cr);
  float fall = min(dr, 1.0) * (aFall.y > 0.0 ? aFall.y : uFall);
  vW = vec3(pp.x, -pp.y, fall + lz + 0.5 * aMeta.y + aEnter.z);
  vec3 nt = vec3(n.x, n.y * cos(ta) - n.z * sin(ta), n.y * sin(ta) + n.z * cos(ta));
  vec2 nn = vec2(nt.x * cr - nt.y * sr, nt.x * sr + nt.y * cr);
  vN = vec3(nn.x, -nn.y, nt.z);
  vL = c;
  vMeta = aMeta;
  vLabel = aLabel;
  vSize = aBox.zw;
  vRot = rot;
  float lit = uP - aLed.a;
  vLed = vec4(aLed.rgb, aLed.a > 0.0 ? clamp(lit / 0.004, 0.0, 1.0) * (1.0 + 0.5 * exp(-max(0.0, lit) / 0.03)) * (aFall.w > 0.0 ? 1.0 - clamp((uP - aFall.w) / 0.006, 0.0, 1.0) : 1.0) * (aLed.a == uBlink.x ? uBlink.y : 1.0) : 0.0);
  gl_Position = dr > 1.005 || (uCast > 0.5 && dr > 0.0 && aLabel.w < 0.5) ? vec4(2.0, 2.0, 2.0, 1.0) : uVP * vec4(vW, 1.0);
}`

const FS_PART = `#version 300 es
precision highp float;
in vec3 vW; in vec3 vN; in vec3 vL; flat in vec4 vMeta; flat in vec4 vLabel; flat in vec2 vSize; flat in float vRot; flat in vec4 vLed; flat in float vDrop; flat in float vSettle; out vec4 o;
uniform sampler2D tAtlas; uniform vec2 uCell; uniform vec3 uFinish; uniform float uHeat; uniform mat4 uVP; uniform int uDepthOnly;
${LIGHTING}
uniform sampler2D tGlowA; uniform sampler2D tGlowB; uniform vec4 uMapR; uniform vec3 uWarmL; uniform vec3 uCoolL; uniform float uGlow;
// light from lit copper below: it falls on a body's sides and underside, fading with height above the board
vec3 glowOn(vec3 pos, vec3 N, vec3 alb){
  if (uGlow <= 0.0) return vec3(0.0);
  vec2 uv = (vec2(pos.x, -pos.y) - uMapR.xy) / uMapR.zw;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return vec3(0.0);
  vec3 e = uWarmL * (textureLod(tGlowA, uv, 3.5).b + textureLod(tGlowA, uv, 5.0).b) + uCoolL * (textureLod(tGlowB, uv, 3.5).r + textureLod(tGlowB, uv, 5.0).r) + vec3(1.0, 0.92, 0.82) * textureLod(tGlowB, uv, 3.5).b;
  float h = exp(-max(pos.z, 0.0) / max(4.0, 0.6 * uMapR.z / 64.0));
  return e * (alb + 0.04) * h * (0.25 + 0.75 * (1.0 - max(N.z, 0.0))) * smoothstep(-0.7, -0.2, N.z) * uGlow;
}
${MARKING}
float sdBox(vec3 p, vec3 b){ vec3 d = abs(p) - b; return length(max(d, 0.0)) + min(max(d.x, max(d.y, d.z)), 0.0); }
float valveSdf(vec3 p, float Dm, float Hh){
  float f = 1e9;
  for (int i = 0; i < 2; i++) {
    float cx = (i == 0 ? 0.2 : -0.2) * Dm;
    for (int j = 0; j < 4; j++) {
      vec3 c = vec3(cx + (j < 2 ? 0.0675 : -0.0675) * Dm, ((j & 1) == 0 ? 0.07 : -0.07) * Dm, 0.5 * Hh);
      f = min(f, sdBox(p - c, vec3(0.0425 * Dm, 0.005 * Dm, 0.17 * Hh)));
    }
  }
  for (int k = 0; k < 2; k++) {
    float z = (k == 0 ? 0.3 : 0.7) * Hh;
    f = min(f, sdBox(p - vec3(0.0, 0.0, z), vec3(0.33 * Dm, 0.12 * Dm, 0.005 * Hh)));
  }
  for (int k = 0; k < 9; k++) {
    float a = (float(k) + 0.5) * 6.2832 / 10.0;
    vec2 c = vec2(cos(a), sin(a)) * 0.3 * Dm;
    f = min(f, max(length(p.xy - c) - 0.011 * Dm, abs(p.z - 0.15 * Hh) - 0.15 * Hh));
  }
  f = min(f, max(length(p.xy) - 0.36 * Dm, abs(p.z - 0.02 * Hh) - 0.012 * Hh));
  return f;
}
float valveHeater(vec3 p, float Dm, float Hh){
  float dz = max(abs(p.z - 0.5 * Hh) - 0.235 * Hh, 0.0);
  return min(length(vec3(p.x - 0.2 * Dm, p.y, dz)), length(vec3(p.x + 0.2 * Dm, p.y, dz)));
}
uniform int uShadowPass;
uniform vec2 uBoardC;
void main(){
  gl_FragDepth = gl_FragCoord.z;
  if (uShadowPass == 1) { o = vec4(0.0); return; }
  gHero = vLabel.w;
  gPos = vW;
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
  float lid = 1.0; vec3 glint = vec3(0.0);
  float along = vSize.x >= vSize.y ? vL.x : vL.y;
  float cap = smoothstep(0.34, 0.37, abs(along));
  if (kind == 0) {            // ic: black epoxy, a pin-1 dimple, a laser-etched marking
    float speck = fineGrain(vW.xy) * top;
    alb = vec3(0.03, 0.03, 0.032) * (1.0 + 0.3 * speck); rough = 0.74 + 0.05 * speck;
    N = normalize(N + vec3(fineGrain(vW.xy + 3.7), fineGrain(vW.xy + 9.1), 0.0) * mix(0.05, 0.1, uEtch * gHero) * top);
    if (top > 0.5) {
      vec2 q = vL.xy + 0.5;
      float dimple = 1.0 - smoothstep(0.035, 0.05, length((q - vec2(0.13, 0.13)) * vSize / max(vSize.x, vSize.y)));
      vec2 dq = (q - vec2(0.13, 0.13)) * vSize / max(vSize.x, vSize.y);
      vec2 bowl = vec2(dq.x * cos(vRot) - dq.y * sin(vRot), dq.x * sin(vRot) + dq.y * cos(vRot));
      N = normalize(N - vec3(bowl.x, -bowl.y, 0.0) * 4.0 * dimple);
      alb = mix(alb, alb * 0.8, dimple); rough = mix(rough, rough + 0.05, dimple);
      rough = mix(rough, 0.52, uEtch * gHero * (1.0 - dimple));
      float m = marking(q);
      alb = mix(alb, mix(ETCH_ALB, vec3(0.22), uEtch * gHero), m); rough = mix(rough, 0.82, m);
      rough = mix(rough, mix(GLOSS_ROUGH, 0.6, m), uGloss * (1.0 - gHero));
      alb *= mix(1.0, GLOSS_BASE, uGloss * (1.0 - gHero) * (1.0 - m));
      lid = mix(LID, ETCH_LID, m);
      glint = lidSweep(vW, m) * gHero;
    }
  } else if (kind == 1) {     // resistor: black top, white ceramic sides, silver tinned ends
    alb = top > 0.5 ? vec3(0.02) : vec3(0.55, 0.53, 0.5); rough = 0.55;
    alb = mix(alb, vec3(0.86, 0.86, 0.84), cap); metal = cap; rough = mix(rough, 0.1, cap);
  } else if (kind == 2) {     // MLCC: tan ceramic, silver tinned ends
    alb = vec3(0.33, 0.24, 0.15); rough = 0.6;
    alb = mix(alb, vec3(0.86, 0.86, 0.84), cap); metal = cap; rough = mix(rough, 0.1, cap);
  } else if (kind == 3) {     // inductor
    alb = vec3(0.05, 0.05, 0.055); rough = 0.5;
    alb = mix(alb, uFinish * 0.9 + 0.1, cap); metal = cap;
  } else if (kind == 4) {     // diode: black with a silver cathode band
    alb = vec3(0.025); rough = 0.45;
    float band = smoothstep(0.24, 0.27, along) * (1.0 - smoothstep(0.33, 0.36, along));
    alb = mix(alb, vec3(0.5), band);
  } else if (kind == 5) {     // chip LED: a thin pale substrate, a metal terminal round each end, a glassy lens with the die inside; lit from the die
    float term = smoothstep(0.3, 0.32, abs(along));
    float across = vSize.x >= vSize.y ? vL.y : vL.x;
    float sub = (1.0 - top) * (1.0 - smoothstep(0.28, 0.34, vL.z));
    float rim = top * smoothstep(0.38, 0.42, abs(across));
    vec2 q = vL.xy * vSize / max(vSize.x, vSize.y);
    float die = top * (1.0 - term) * (1.0 - smoothstep(0.055, 0.07, max(abs(q.x), abs(q.y))));
    float bond = top * (1.0 - term) * (1.0 - smoothstep(0.018, 0.026, length(q - vec2(vSize.x >= vSize.y ? 0.14 : 0.0, vSize.x >= vSize.y ? 0.0 : 0.14))));
    float on = min(vLed.a, 1.0);
    float lens = (1.0 - term) * (1.0 - sub) * (1.0 - rim);
    alb = mix(vec3(0.8, 0.79, 0.74), vec3(0.88, 0.87, 0.82), top);
    alb = mix(alb, vec3(0.86, 0.85, 0.8), max(sub, rim));
    alb = mix(alb, vec3(0.06, 0.055, 0.05), max(die, bond) * (1.0 - 0.8 * on));
    alb *= 1.0 - 0.9 * on * lens;
    rough = mix(0.5, mix(0.3, 0.1, top), lens);
    alb = mix(alb, vec3(0.9, 0.9, 0.88), term); metal = 0.5 * term; rough = mix(rough, 0.38, term);
    float core = (1.0 - term) * top * exp(-dot(q, q) / 0.0016);
    float halo = (1.0 - term) * exp(-dot(q, q) / 0.02);
    emit = (1.0 - top) * lens * uKeyCol * 0.08 + on * (vLed.rgb * (1.8 * lens * (0.3 + 0.7 * top) + 3.0 * halo * lens) + mix(vLed.rgb, vec3(1.0), 0.35) * core * 7.0);
  } else if (kind == 6 && vLabel.z > 2.5) {     // a socket's drawn steel shell: a seam round its stamped top, two spring tabs, a mouth with its tongue on the side facing off the board
    alb = vec3(0.7, 0.71, 0.72); metal = 1.0; rough = 0.3;
    vec2 q = abs(vL.xy) * 2.0;
    float seam = top * (1.0 - smoothstep(0.012, 0.03, abs(max(q.x, q.y) - 0.8)));
    float tab = top * (1.0 - smoothstep(0.02, 0.04, abs(abs(vL.x) - 0.22))) * (1.0 - smoothstep(0.1, 0.12, abs(vL.y)));
    alb = mix(alb, vec3(0.08), max(seam, tab)); rough = mix(rough, 0.6, max(seam, tab));
    float away = (1.0 - top) * smoothstep(0.55, 0.75, dot(normalize(vN.xy + vec2(1e-4)), normalize(vW.xy - uBoardC + vec2(1e-3))));
    float across = abs(vN.x) > abs(vN.y) ? abs(vL.y) : abs(vL.x);
    float mouth = away * (1.0 - smoothstep(0.36, 0.4, across)) * smoothstep(0.16, 0.2, vL.z) * (1.0 - smoothstep(0.8, 0.84, vL.z));
    float tongue = mouth * (1.0 - smoothstep(0.26, 0.29, across)) * (1.0 - smoothstep(0.06, 0.08, abs(vL.z - 0.5)));
    alb = mix(alb, mix(vec3(0.006), vec3(0.06, 0.06, 0.065), tongue), mouth); metal = mix(metal, 0.0, mouth); rough = mix(rough, 0.7, mouth);
  } else if (kind == 6) {     // crystal: a metal can
    alb = CAN_ALB; metal = 1.0; rough = CAN_ROUGH;
  } else if (kind == 7) {     // connector: black plastic, a grid of gold pins on top
    alb = vec3(0.03, 0.03, 0.032); rough = mix(0.36, 0.3, uGloss);
    if (top > 0.5 && vLabel.z > 0.5) {
      vec2 lpx = vL.xy * vSize;
      vec2 cell = abs(fract(lpx / vLabel.z + 0.5) - 0.5) * 2.0;
      float pin = (1.0 - smoothstep(0.32, 0.4, max(cell.x, cell.y))) * step(max(abs(vL.x) * vSize.x - vSize.x * 0.5 + vLabel.z * 0.5, abs(vL.y) * vSize.y - vSize.y * 0.5 + vLabel.z * 0.5), 0.0);
      alb = mix(alb, uFinish * 0.85 + vec3(0.05, 0.04, 0.0), pin); metal = pin; rough = mix(rough, 0.25, pin);
    }
  } else if (kind == 13) {
    alb = vec3(0.62, 0.6, 0.56); metal = 1.0; rough = 0.32;
  } else if (kind == 12) {    // header pin: gold-plated square post
    alb = vec3(0.95, 0.7, 0.32); metal = 1.0; rough = 0.28;
  } else if (kind == 8) {     // switch: brushed steel cap on a black base
    alb = top > 0.5 ? vec3(0.55, 0.56, 0.58) : vec3(0.03); metal = top; rough = 0.45;
  } else if (kind == 9) {     // electrolytic: aluminium top, dark sleeve
    vec2 vq = vL.xy * 2.0;
    float vent = top * max(1.0 - smoothstep(0.015, 0.04, abs(vq.x)), 1.0 - smoothstep(0.015, 0.04, abs(vq.y))) * (1.0 - smoothstep(0.5, 0.56, length(vq)));
    alb = top > 0.5 ? vec3(0.78, 0.79, 0.8) * mix(1.0, 0.2, vent) : vec3(0.02, 0.04, 0.12); metal = top; rough = top > 0.5 ? mix(0.14 + 0.03 * sin(length(vq) * 120.0), 0.6, vent) : 0.35;
  } else if (kind == 11) {
    if (dot(normalize(vN), V) < 0.0) discard;
    float Dm = vSize.x;
    float Hh = vMeta.y;
    float cr = cos(vRot), sr = sin(vRot);
    vec3 dW = normalize(vW - uCam);
    vec2 dp = vec2(dW.x, -dW.y);
    vec3 d = normalize(vec3(dp.x * cr + dp.y * sr, -dp.x * sr + dp.y * cr, dW.z));
    vec3 q = vec3(vL.x * Dm, vL.y * vSize.y, vL.z * Hh);
    float R = 0.5 * Dm;
    float cc = dot(q.xy, q.xy) - R * R;
    if (cc > 0.0) {
      float A = max(dot(d.xy, d.xy), 1e-8);
      float bb = dot(q.xy, d.xy);
      float disc = bb * bb - A * cc;
      if (disc < 0.0) discard;
      float te = (-bb - sqrt(disc)) / A;
      float ze = q.z + d.z * te;
      if (te < 0.0 || ze < 0.0 || ze > Hh) discard;
    }
    float tOut = 2.0 * Dm + Hh;
    float t = 0.0;
    float glow = 0.0;
    float hit = -1.0;
    bool ended = vDrop > 0.05;
    float tc0 = dot(vec2(0.2 * Dm, 0.0) - q.xy, d.xy) / max(dot(d.xy, d.xy), 1e-6);
    float tc1 = dot(vec2(-0.2 * Dm, 0.0) - q.xy, d.xy) / max(dot(d.xy, d.xy), 1e-6);
    vec2 clear = vec2(1e9);
    for (int i = 0; i < 160 && !ended; i++) {
      vec3 x = q + d * t;
      if (length(x.xy) > 0.5 * Dm + 0.5 || x.z < 0.0 || x.z > Hh) { ended = true; break; }
      float f = valveSdf(x, Dm, Hh);
      if (t < tc0) clear.x = min(clear.x, f);
      if (t < tc1) clear.y = min(clear.y, f);
      if (f < 0.0015 * Dm) { hit = t; ended = true; break; }
      t += max(f, 0.004 * Dm);
      if (t > tOut) ended = true;
    }
    if (!ended) hit = t;
    vec3 Nside = normalize(vN);
    if (top > 0.5) {
      vec2 lp2 = vL.xy * 2.4;
      vec2 wp = vec2(lp2.x * cr - lp2.y * sr, lp2.x * sr + lp2.y * cr);
      Nside = normalize(vec3(wp.x, -wp.y, 1.0));
    }
    float NoV = max(dot(Nside, V), 1e-3);
    float F = 0.04 + 0.96 * pow(1.0 - NoV, 5.0);
    vec3 Hk = normalize(V + normalize(uKey));
    float streak = exp(-sq((1.0 - dot(normalize(Nside.xy + 1e-5), normalize(Hk.xy + 1e-5))) / 0.0016)) * (1.0 - top) * smoothstep(0.04, 0.2, vL.z) * (1.0 - smoothstep(0.9, 0.99, vL.z));
    vec3 glint = (ggx(Nside, V, normalize(uKey), 0.25) * uKeyCol * 0.5 * top + streak * uKeyCol * 1.8) * F * 0.6
               + (envLight(reflect(-V, Nside), 0.05) * F * 0.35 + vec3(0.75, 0.8, 0.85) * pow(1.0 - NoV, 6.0) * (0.12 + 0.5 * uRoom) * (1.0 - top)) * smoothstep(0.015, 0.1, NoV);
    float getter = 0.0;
    float pip = 0.0;
    vec3 mirror = vec3(0.09, 0.092, 0.1) + envLight(reflect(-V, Nside), 0.08) * 0.8 + uKeyCol * 0.5 * pow(max(dot(Nside, Hk), 0.0), 60.0);
    if (top > 0.5) {
      float gr = length(vL.xy * 2.0);
      pip = exp(-sq(gr / 0.07));
      getter = (1.0 - smoothstep(0.3, 0.55, length(vL.xy * 2.0 - vec2(0.2, -0.1)) + 0.1 * vnoise(vL.xy * 9.0))) * 0.85 * (1.0 - pip);
      glint = mix(glint, mirror * (0.5 + 0.5 * (1.0 - gr * gr)), getter) + uKeyCol * 0.35 * pip * F + vec3(0.6, 0.62, 0.66) * 0.25 * pip;
    } else {
      vec2 rightOf = normalize(vec2(V.y, -V.x) + 1e-5);
      float across = dot(normalize(Nside.xy + 1e-5), rightOf);
      getter = smoothstep(0.8, 0.88, vL.z + 0.03 * vnoise(vL.xy * 12.0)) * (1.0 - smoothstep(0.93, 0.99, vL.z)) * smoothstep(0.05, 0.45, across + 0.2 * vnoise(vec2(across * 6.0, vL.z * 10.0))) * 0.9;
      glint = mix(glint, mirror, getter);
    }
    float core = 0.0;
    float tCore = 0.0;
    float pix = max(length(dFdx(vW)), length(dFdy(vW)));
    float coreW = max(0.016 * Dm, 2.0 * pix);
    float near0 = 0.0;
    for (int k = 0; k < 2; k++) {
      float tc = k == 0 ? tc0 : tc1;
      float h = valveHeater(q + d * tc, Dm, Hh);
      float seen = vDrop > 0.05 ? 0.0 : smoothstep(0.0015 * Dm, 0.03 * Dm, k == 0 ? clear.x : clear.y);
      glow += mix(0.08, 1.0, seen) * exp(-sq(h / (0.022 * Dm))) * 2.4;
      float c0 = seen * exp(-sq(h / coreW)) * 0.5;
      float g0 = seen * exp(-sq(h / (0.012 * Dm)));
      if (g0 > 0.05 && g0 > near0) { near0 = g0; tCore = tc; }
      core = max(core, c0);
    }
    if (uDepthOnly == 1) {
      if (hit < 0.0 && tCore == 0.0) discard;
      vec4 clip = uVP * vec4(vW + normalize(vW - uCam) * (hit >= 0.0 && (tCore == 0.0 || hit < tCore) ? hit : tCore), 1.0);
      gl_FragDepth = clamp(clip.z / clip.w * 0.5 + 0.5, 0.0, 1.0);
      o = vec4(0.0);
      return;
    }
    vec3 ember = mix(vec3(0.55, 0.06, 0.015), vec3(1.0, 0.36, 0.07), smoothstep(0.15, 0.9, uHeat));
    vec3 heat = ember * uHeat * (glow * 1.1 + core * 2.2);
    heat *= min(1.0, 0.92 * LIT_MAX / max(1e-4, max(heat.r, max(heat.g, heat.b))));
    glint += ember * uHeat * (0.012 + 0.09 * pow(1.0 - NoV, 3.0)) * (1.0 - top) * smoothstep(0.015, 0.1, NoV);
    glint += ember * uHeat * 0.3 * getter;
    glint *= (1.0 - smoothstep(0.0, 0.3, vDrop)) * (1.0 - 0.75 * top);
    float near = smoothstep(1.2 * Hh, 2.4 * Hh, length(uCam - vW));
    glint *= near;
    vec3 col = glint + heat;
    float falling = 1.0 - smoothstep(0.0, 0.3, vDrop);
    float a = clamp((0.85 * getter * near + 0.5 * pip * near) * falling + (0.12 * (1.0 - 0.7 * top) + 0.3 * F * (1.0 - 0.6 * top)) * near * (1.0 - smoothstep(0.0, 0.3, vDrop)) + dot(glint + heat, vec3(0.3)) + core, 0.0, 1.0);
    if (hit >= 0.0) {
      vec3 x = q + d * hit;
      float e = 0.002 * Dm;
      vec3 nl = normalize(vec3(valveSdf(x + vec3(e, 0, 0), Dm, Hh) - valveSdf(x - vec3(e, 0, 0), Dm, Hh), valveSdf(x + vec3(0, e, 0), Dm, Hh) - valveSdf(x - vec3(0, e, 0), Dm, Hh), valveSdf(x + vec3(0, 0, e), Dm, Hh) - valveSdf(x - vec3(0, 0, e), Dm, Hh)));
      vec3 nw = vec3(nl.x * cr - nl.y * sr, -(nl.x * sr + nl.y * cr), nl.z);
      bool mica = abs(x.z - 0.3 * Hh) < 0.02 * Hh || abs(x.z - 0.7 * Hh) < 0.02 * Hh;
      vec3 inside = shade(nw, V, mica ? vec3(0.1, 0.097, 0.088) : vec3(0.1, 0.1, 0.105), mica ? 0.0 : 0.7, mica ? 0.6 : 0.45, 0.04)
        + ember * uHeat * (mica ? 0.18 : 0.08) * exp(-min(abs(abs(x.x) - 0.2 * Dm), Dm) / (0.08 * Dm)) * (0.4 + 0.6 * pow(1.0 - max(dot(nw, V), 0.0), 2.0));
      col = glint + heat + inside * (1.0 - F) * (1.0 - min(1.0, core)) * mix(0.3, 1.0, near);
      a = (mica ? 0.25 * near : mix(0.6, 1.0, near)) * mix(1.0, mica ? 0.0 : 0.7, 1.0 - falling);
    }
    o = vec4(col, a) * near * (hit >= 0.0 ? 1.0 : falling);
    return;
  } else {
    alb = vec3(0.05, 0.05, 0.055); rough = 0.5;
  }
  vec3 col = shade(N, V, alb, metal, rough, 0.045) * lid * (1.0 - 0.85 * gDim) + glint;
  // the underside hugs the board: ambient occlusion at the foot of every wall
  col *= mix(0.45, 1.0, smoothstep(0.0, 0.35, vL.z));
  col = max(col, min(col * (1.0 + vSettle), vec3(LIT_MAX)));
  o = vec4((col * uBody + emit + glowOn(vW, N, alb)) * (1.0 - uNearDim.x * smoothstep(NEAR_FROM, NEAR_FULL, 1.0 - dot(vW - uEyeN, uFwdN) / max(1e-3, uNearDim.y))), 1.0);
}`

const VS_MESH = `#version 300 es
in vec3 aPos; in vec3 aNor; in vec3 aCol;  // footprint-local mm (y down, z up), unit normal, sRGB
in vec4 aAff;   // local mm to plane px, the linear part
in vec4 aBox; in vec4 aMeta; in vec4 aLabel; in vec4 aLed; in vec4 aFall; in vec4 aEnter;  // as for the boxes
uniform mat4 uVP; uniform float uP; uniform float uDur; uniform float uFall; uniform float uMid; uniform float uCast; uniform vec3 uMin; uniform vec3 uMax; uniform vec4 uTop; uniform vec2 uBlink;
out vec3 vW; out vec3 vN; out vec3 vL; out vec2 vQ; out vec3 vCol; flat out vec4 vMeta; flat out vec4 vLabel; flat out vec2 vSize; flat out vec4 vLed; flat out vec4 vAxes; out vec2 vTop; flat out float vSettle;
uniform vec2 uSettle;
${LANDING}
void main(){
  float dr = drop(aMeta.w, uMid + (uP - uMid) * aFall.z, aFall.x, aLabel.w);
  vSettle = uP >= aMeta.w ? uSettle.y * exp(-(uP - aMeta.w) / uSettle.x) : 0.0;
  vec3 c = 0.5 * (uMin + uMax);
  vec2 d = aPos.xy - c.xy;
  vec2 lp = vec2(aAff.x * d.x + aAff.z * d.y, aAff.y * d.x + aAff.w * d.y);
  vec2 pp = aBox.xy + aEnter.xy * min(dr, 1.0) + lp;
  float scale = length(aAff.xy);
  float fall = min(dr, 1.0) * (aFall.y > 0.0 ? aFall.y : uFall);
  float ta = tip(dr, aLabel.w);
  vec2 bx = vec2(cos(aMeta.x), sin(aMeta.x));
  vec2 by = vec2(-bx.y, bx.x);
  float ly = dot(lp, by);
  float lz = aPos.z * scale - 0.5 * uMax.z * scale;
  pp += by * (ly * cos(ta) - lz * sin(ta) - ly);
  vW = vec3(pp.x, -pp.y, fall + ly * sin(ta) + lz * cos(ta) + 0.5 * uMax.z * scale);
  vec2 n = vec2(aAff.x * aNor.x + aAff.z * aNor.y, aAff.y * aNor.x + aAff.w * aNor.y) / scale;
  float ny = dot(n, by);
  vec2 nh = n + by * (ny * cos(ta) - aNor.z * sin(ta) - ny);
  vN = vec3(nh.x, -nh.y, ny * sin(ta) + aNor.z * cos(ta));
  vec2 ax = normalize(aAff.xy);
  vec2 ay = normalize(aAff.zw);
  vAxes = vec4(ax, ay);
  vTop = (aPos.xy - uTop.xy) / uTop.zw;
  vL = vec3((aPos.xy - c.xy) / max(uMax.xy - uMin.xy, vec2(1e-3)), aPos.z / max(uMax.z, 1e-3));
  // the marking reads in the boxes' frame, so it keeps their left-to-right flip
  float br = cos(aMeta.x), bs = sin(aMeta.x);
  vQ = vec2(lp.x * br + lp.y * bs, -lp.x * bs + lp.y * br) / aBox.zw + 0.5;
  vCol = aCol;
  vMeta = aMeta;
  vLabel = aLabel;
  vSize = aBox.zw;
  float lit = uP - aLed.a;
  vLed = vec4(aLed.rgb, aLed.a > 0.0 ? clamp(lit / 0.004, 0.0, 1.0) * (1.0 + 0.5 * exp(-max(0.0, lit) / 0.03)) * (aFall.w > 0.0 ? 1.0 - clamp((uP - aFall.w) / 0.006, 0.0, 1.0) : 1.0) * (aLed.a == uBlink.x ? uBlink.y : 1.0) : 0.0);
  gl_Position = dr > 1.005 || (uCast > 0.5 && dr > 0.0 && aLabel.w < 0.5) ? vec4(2.0, 2.0, 2.0, 1.0) : uVP * vec4(vW, 1.0);
}`

const FS_MESH = `#version 300 es
precision highp float;
in vec3 vW; in vec3 vN; in vec3 vL; in vec2 vQ; in vec3 vCol; flat in vec4 vMeta; flat in vec4 vLabel; flat in vec2 vSize; flat in vec4 vLed; flat in vec4 vAxes; in vec2 vTop; flat in float vSettle; out vec4 o;
uniform sampler2D tAtlas; uniform vec2 uCell; uniform vec3 uMax;
${LIGHTING}
uniform sampler2D tGlowA; uniform sampler2D tGlowB; uniform vec4 uMapR; uniform vec3 uWarmL; uniform vec3 uCoolL; uniform float uGlow;
// light from lit copper below: it falls on a body's sides and underside, fading with height above the board
vec3 glowOn(vec3 pos, vec3 N, vec3 alb){
  if (uGlow <= 0.0) return vec3(0.0);
  vec2 uv = (vec2(pos.x, -pos.y) - uMapR.xy) / uMapR.zw;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return vec3(0.0);
  vec3 e = uWarmL * (textureLod(tGlowA, uv, 3.5).b + textureLod(tGlowA, uv, 5.0).b) + uCoolL * (textureLod(tGlowB, uv, 3.5).r + textureLod(tGlowB, uv, 5.0).r) + vec3(1.0, 0.92, 0.82) * textureLod(tGlowB, uv, 3.5).b;
  float h = exp(-max(pos.z, 0.0) / max(4.0, 0.6 * uMapR.z / 64.0));
  return e * (alb + 0.04) * h * (0.25 + 0.75 * (1.0 - max(N.z, 0.0))) * smoothstep(-0.7, -0.2, N.z) * uGlow;
}
${MARKING}
uniform vec2 uBoardC;
uniform int uShadowPass;
void main(){
  if (uShadowPass == 1) { o = vec4(0.0); return; }
  gHero = vLabel.w;
  gPos = vW;
  vec3 V = normalize(uCam - vW);
  vec3 N = length(vN) > 0.1 ? normalize(vN) : normalize(cross(dFdx(vW), dFdy(vW)));
  if (dot(N, V) < 0.0) N = -N;
  int kind = int(vMeta.z + 0.5);
  if (N.z > 0.9) {
    vec2 e = abs(vTop);
    vec2 dirL = vec2(e.x > e.y ? sign(vTop.x) : 0.0, e.x > e.y ? 0.0 : sign(vTop.y));
    vec2 dw = dirL.x * vAxes.xy + dirL.y * vAxes.zw;
    N = normalize(N + vec3(dw.x, -dw.y, 0.0) * smoothstep(0.86, 1.0, max(e.x, e.y)) * mix(0.6, 0.9, gHero));
  }
  // the model's own paint: light neutral greys and golds are plated leads, the rest is moulded plastic
  float lum = dot(vCol, vec3(0.299, 0.587, 0.114));
  float chroma = max(vCol.r, max(vCol.g, vCol.b)) - min(vCol.r, min(vCol.g, vCol.b));
  float gold = step(0.4, lum) * step(0.15, chroma) * step(vCol.g, vCol.r) * step(vCol.b + 0.2, vCol.r);
  float metal = max(step(0.55, lum) * step(chroma, 0.1), gold);
  vec3 alb = max(pow(vCol, vec3(2.2)), vec3(0.055));
  // stock model paint is loud: plastic keeps its hue but sinks toward a dark neutral, so no sleeve outshouts the copper
  float grey = dot(alb, vec3(0.2126, 0.7152, 0.0722));
  alb = mix(alb, mix(vec3(grey), alb, 0.35) * 0.45, (1.0 - metal) * smoothstep(0.12, 0.4, chroma));
  float rough = mix(0.48, 0.28, metal);
  if ((kind == 0 || kind == 7) && metal < 0.5 && chroma < 0.12) { alb = vec3(0.035, 0.035, 0.038); rough = kind == 7 ? 0.62 : 0.38; }
  if (kind == 7 && metal < 0.5 && vLabel.z > 0.5 && abs(N.z) < 0.3 && uMax.z > 4.0 && dot(N.xy, normalize(vW.xy - uBoardC + vec2(1e-3))) > 0.55) {
    vec2 tdir = normalize(vec2(-N.y, N.x));
    float cell = abs(fract(dot(vW.xy, tdir) / vLabel.z + 0.5) - 0.5) * 2.0;
    float row = abs(fract(vW.z / vLabel.z) - 0.5) * 2.0;
    float hole = (1.0 - smoothstep(0.42, 0.5, cell)) * (1.0 - smoothstep(0.42, 0.5, row)) * step(0.15, vL.z) * step(vL.z, 0.9);
    alb = mix(alb, vec3(0.004), hole); rough = mix(rough, 0.9, hole);
  }
  if (kind == 6) { alb = CAN_ALB; metal = 1.0; rough = CAN_ROUGH; }
  else if (kind == 9 && chroma < 0.12) { alb = vec3(0.62, 0.63, 0.65); metal = 1.0; rough = 0.3; }
  if (metal > 0.5 && gold < 0.5 && kind != 6) { alb = vec3(0.86, 0.86, 0.84); rough = 0.12; }
  if (kind == 0 && max(max(-vQ.x, vQ.x - 1.0), max(-vQ.y, vQ.y - 1.0)) > 0.01) { alb = vec3(0.72, 0.72, 0.7); metal = 1.0; rough = 0.22; }
  if (metal < 0.5 && chroma < 0.12 && lum > 0.3) { alb = min(alb, vec3(0.14)); rough = max(rough, 0.5); }
  vec3 emit = vec3(0.0);
  float lid = 1.0; vec3 glint = vec3(0.0);
  float top = step(0.9, N.z) * step(0.98, vL.z);
  bool can = kind == 2 && uMax.z > 3.0;
  if (metal > 0.5 && gold < 0.5 && top > 0.5) rough = 0.5 + 0.05 * sin(length(vL.xy) * 160.0);
  if (can) {
    vec2 q = vL.xy * 2.0;
    float r = length(q);
    if (N.z > 0.85 && vL.z > 0.8 && r < 0.86) {
      float score = max(1.0 - smoothstep(0.02, 0.05, abs(q.x)), 1.0 - smoothstep(0.02, 0.05, abs(q.y))) * (1.0 - smoothstep(0.5, 0.56, r));
      alb = vec3(0.62, 0.63, 0.65) * mix(0.7, 0.18, score);
      metal = 1.0;
      rough = mix(0.14 + 0.03 * sin(r * 140.0), 0.65, score);
      N = normalize(N + vec3(sign(q.x) * (1.0 - smoothstep(0.02, 0.05, abs(q.x))), -sign(q.y) * (1.0 - smoothstep(0.02, 0.05, abs(q.y))), 0.0) * 0.35 * (1.0 - smoothstep(0.5, 0.56, r)));
    } else {
      float stripe = 1.0 - smoothstep(0.32, 0.4, abs(atan(q.y, q.x) - 2.5));
      alb = mix(vec3(0.03, 0.035, 0.05), vec3(0.42, 0.44, 0.47), stripe * step(0.08, vL.z) * step(vL.z, 0.9));
      metal = 0.0;
      rough = N.z > 0.85 ? 0.22 : 0.3;
    }
  }
  if (kind == 0) {
    float speck = fineGrain(vW.xy);
    if (metal < 0.5) { alb *= 1.0 + 0.35 * speck * step(0.5, N.z); rough = max(rough, 0.74) + 0.06 * speck * step(0.5, N.z); }
    if (top > 0.5 && metal < 0.5) {
      N = normalize(N + vec3(fineGrain(vW.xy + 3.7), fineGrain(vW.xy + 9.1), 0.0) * mix(0.05, 0.1, uEtch * gHero));
      vec2 dq = (vQ - vec2(0.13, 0.13)) * vSize / max(vSize.x, vSize.y);
      float dimple = 1.0 - smoothstep(0.035, 0.05, length(dq));
      vec2 bowl = dq.x * vAxes.xy + dq.y * vAxes.zw;
      N = normalize(N - vec3(bowl.x, -bowl.y, 0.0) * 4.0 * dimple);
      alb = mix(alb, alb * 0.8, dimple); rough = mix(rough, rough + 0.05, dimple);
      rough = mix(rough, 0.52, uEtch * gHero * (1.0 - dimple));
    }
    float m = marking(vQ) * top;
    alb = mix(alb, mix(ETCH_ALB, vec3(0.22), uEtch * gHero), m); rough = mix(rough, 0.82, m);
    if (metal < 0.5) { lid = mix(LID, ETCH_LID, m); rough = mix(rough, mix(GLOSS_ROUGH, 0.6, m), uGloss * (1.0 - gHero)); alb *= mix(1.0, GLOSS_BASE, uGloss * (1.0 - gHero) * (1.0 - m)); }
    glint = lidSweep(vW, m) * gHero * top * (1.0 - metal);
  } else if (kind == 5) {
    float lens = smoothstep(0.6, 0.95, vL.z) * smoothstep(0.75, 0.95, N.z) * (1.0 - metal);
    float core = lens * exp(-dot(vL.xy, vL.xy) / 0.02);
    alb = mix(alb, vec3(0.8, 0.79, 0.72), 0.6 * lens);
    alb *= 1.0 - 0.8 * min(vLed.a, 1.0) * lens;
    emit = vLed.a * (vLed.rgb * 2.6 * lens + mix(vLed.rgb, vec3(1.0), 0.45) * core * 5.0);
  }
  if (kind == 7 && metal < 0.5) rough = mix(rough, 0.32, uGloss);
  vec3 col = shade(N, V, alb, metal, rough, kind == 7 && metal < 0.5 ? 0.012 : 0.045) * lid * (1.0 - 0.85 * gDim * top) + glint;
  if (gold > 0.5) col = mix(col, shade(N, V, alb * 0.85, 0.0, 0.45, 0.045), 0.4);
  col *= mix(0.45, 1.0, smoothstep(0.0, 0.35, vL.z));
  col = max(col, min(col * (1.0 + vSettle), vec3(LIT_MAX)));
  o = vec4((col * uBody + emit + glowOn(vW, N, alb)) * (1.0 - uNearDim.x * smoothstep(NEAR_FROM, NEAR_FULL, 1.0 - dot(vW - uEyeN, uFwdN) / max(1e-3, uNearDim.y))), 1.0);
}`

const VS_QUAD = `#version 300 es
out vec2 uv;
void main(){ vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2); uv = p; gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }`

const FS_COPY = `#version 300 es
precision highp float; in vec2 uv; out vec4 o; uniform sampler2D t; uniform float uW;
void main(){ o = texture(t, uv) * uW; }`

const FS_MATTE = `#version 300 es
precision highp float; in vec2 uv; out vec4 o; uniform sampler2D tZ; uniform mat4 uInv; uniform float uTall;
void main(){
  float d = texture(tZ, uv).r;
  if (d >= 1.0) { o = vec4(0.0); return; }
  vec4 w = uInv * vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
  o = vec4(clamp(w.z / w.w / uTall, 0.0, 1.0), 0.0, 0.0, 1.0);
}`

const FS_DOF = `#version 300 es
precision highp float; in vec2 uv; out vec4 o;
uniform sampler2D t; uniform sampler2D tZ; uniform bool uHasZ; uniform vec2 uNearFar; uniform vec2 uRes;
uniform vec3 uCam; uniform vec3 uF; uniform vec3 uR; uniform vec3 uU; uniform vec2 uTan; uniform float uShift;
uniform float uFocus; uniform float uAperture; uniform float uMaxR; uniform vec4 uFog;
float depthAt(vec2 q){
  vec2 n = q * 2.0 - 1.0;
  vec3 d = normalize(uF + uR * n.x * uTan.x + uU * (n.y - uShift) * uTan.y);
  float zd = texture(tZ, q).r;
  return uHasZ && zd < 1.0 ? 2.0 * uNearFar.x * uNearFar.y / (uNearFar.y + uNearFar.x - (2.0 * zd - 1.0) * (uNearFar.y - uNearFar.x)) : (d.z < -1e-4 ? (-uCam.z / d.z) * dot(d, uF) : 1e6);
}
const float HAZE_FALL = 12.0;
vec4 hazed(vec4 c){
  if (uFog.x <= 0.0) return c;
  vec2 n = uv * 2.0 - 1.0;
  float up = max(0.0, normalize(uF + uR * n.x * uTan.x + uU * (n.y - uShift) * uTan.y).z);
  float k = exp(-uFog.x * max(0.0, depthAt(uv) - uFog.y));
  float glow = (1.0 - k) * mix(exp(-up * HAZE_FALL), 1.0, c.a);
  return vec4(c.rgb * k + vec3(1.0, 0.66, 0.38) * uFog.z * glow, max(c.a, glow));
}
float coc(vec2 q){
  vec2 n = q * 2.0 - 1.0;
  vec3 d = normalize(uF + uR * n.x * uTan.x + uU * (n.y - uShift) * uTan.y);
  float zd = texture(tZ, q).r;
  float z = uHasZ && zd < 1.0 ? 2.0 * uNearFar.x * uNearFar.y / (uNearFar.y + uNearFar.x - (2.0 * zd - 1.0) * (uNearFar.y - uNearFar.x)) : (d.z < -1e-4 ? (-uCam.z / d.z) * dot(d, uF) : 1e6);
  return clamp(abs(1.0 - uFocus / z) * uAperture, 0.0, uMaxR);
}
void main(){
  float c = coc(uv);
  vec4 sharp = texture(t, uv);
  if (c < 0.3) { o = hazed(sharp); return; }
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
    float w = smoothstep(r - 1.5, r + 0.5, coc(q) + 1.0) * (1.0 + 0.3 * smoothstep(1.2, 4.0, l));
    acc += min(s, vec4(3.0)) * w; wsum += w;
  }
  o = hazed(mix(sharp, acc / max(wsum, 1e-3), smoothstep(0.3, 1.2, c)));
}`

const FS_BRIGHT = `#version 300 es
precision highp float; in vec2 uv; out vec4 o; uniform sampler2D t; uniform vec2 h;
vec3 over(vec2 p){ vec3 c = texture(t, p).rgb; return c * smoothstep(1.6, 3.4, max(c.r, max(c.g, c.b))); }
void main(){ o = vec4((over(uv + vec2(-h.x, -h.y)) + over(uv + vec2(h.x, -h.y)) + over(uv + vec2(-h.x, h.y)) + over(uv + h)) * 0.25, 1.0); }`

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
uniform int uTone; uniform float uBloom; uniform float uStreak; uniform vec3 uStreakTint; uniform float uExposure; uniform float uCA;
uniform vec3 uBg; uniform float uFrame; uniform bool uGrain; uniform bool uTransparent; uniform float uVignette;
vec3 aces(vec3 x){ return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
vec3 neutral(vec3 c){
  float x = min(c.r, min(c.g, c.b));
  float off = x < 0.08 ? x - 6.25 * x * x : 0.04;
  c -= off;
  float peak = max(c.r, max(c.g, c.b));
  if (peak < 0.76) return c;
  float np = 1.0 - 0.0576 / (peak + 0.24 - 0.76);
  c *= np / peak;
  float g = 1.0 - 1.0 / (0.15 * (peak - np) + 1.0);
  return mix(c, vec3(np), g);
}
vec3 agx(vec3 c){
  mat3 inM = mat3(0.842479062253094, 0.0423282422610123, 0.0423756549057051, 0.0784335999999992, 0.878468636469772, 0.0784336, 0.0792237451477643, 0.0791661274605434, 0.879142973793104);
  mat3 outM = mat3(1.19687900512017, -0.0528968517574562, -0.0529716355144438, -0.0980208811401368, 1.15190312990417, -0.0980434501171241, -0.0990297440797205, -0.0989611768448433, 1.15107367264116);
  c = inM * max(c, vec3(1e-10));
  c = clamp((log2(c) + 12.47393) / 16.5, 0.0, 1.0);
  vec3 x2 = c * c; vec3 x4 = x2 * x2;
  c = 15.5 * x4 * x2 - 40.14 * x4 * c + 31.96 * x4 - 6.868 * x2 * c + 0.4298 * x2 + 0.1191 * c - 0.00232;
  return clamp(pow(max(outM * c, vec3(0.0)), vec3(2.2)), 0.0, 1.0);
}
void main(){
  vec2 d = uv - 0.5;
  vec4 base = texture(tCol, uv);
  vec3 c = vec3(texture(tCol, uv - d * uCA).r, base.g, texture(tCol, uv + d * uCA).b);
  vec3 glow = texture(tBloom, uv).rgb * uBloom + texture(tStreak, uv).rgb * uStreak * uStreakTint;
  c += glow;
  c = uTone == 1 ? neutral(c * uExposure) : uTone == 2 ? agx(c * uExposure) : aces(c * uExposure);
  // a gentle toe keeps the blacks black and the mids open
  c = pow(c, vec3(1.0 / 2.2));
  c = smoothstep(0.0, 1.0, c * 0.96 + 0.02) * 0.92 + c * 0.08;
  float y = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(y), c, mix(0.35, 1.0, smoothstep(0.03, 0.16, y)));
  float a = 1.0;
  if (uTransparent) {
    a = clamp(base.a + dot(glow, vec3(0.3)), 0.0, 1.0);
  } else {
    c += uBg * (1.0 - clamp(base.a, 0.0, 1.0));
    c *= mix(1.0, smoothstep(1.25, 0.3, length(d) * 1.45), uVignette);
    if (uGrain) {
      float lum = clamp(dot(c, vec3(0.2126, 0.7152, 0.0722)), 0.0, 1.0);
      float tri = hash(gl_FragCoord.xy + uFrame * 17.0) + hash(gl_FragCoord.yx * 1.37 + uFrame * 29.0 + 3.1) - 1.0;
      c += tri * (2.0 / 255.0) * smoothstep(0.0, 0.06, lum) * smoothstep(1.0, 0.94, lum);
    }
  }
  o = vec4(c * (uTransparent ? a : 1.0), a);
}`

type GL = WebGL2RenderingContext

interface Target { tex: WebGLTexture; fbo: WebGLFramebuffer; w: number; h: number; z?: WebGLTexture }

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
  f4v(name: string, v: Float32Array): this {
    this.gl.uniform4fv(this.u(name), v)
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
function invert4(m: Float32Array): Float32Array {
  const a = Array.from(m)
  const inv = new Float32Array(16)
  const n = 4
  const aug = Array.from({ length: n }, (_, r) => [...Array.from({ length: n }, (_, c) => a[c * n + r] as number), ...Array.from({ length: n }, (_, c) => (c === r ? 1 : 0))])
  for (let c = 0; c < n; c++) {
    const piv = aug.slice(c).reduce((best, row, i) => (Math.abs(row[c] as number) > Math.abs((aug[best] as number[])[c] as number) ? c + i : best), c)
    ;[aug[c], aug[piv]] = [aug[piv] as number[], aug[c] as number[]]
    const row = aug[c] as number[]
    const d = row[c] as number
    for (let k = 0; k < 2 * n; k++) row[k] = (row[k] as number) / d
    for (let r = 0; r < n; r++) {
      if (r === c) continue
      const other = aug[r] as number[]
      const f = other[c] as number
      for (let k = 0; k < 2 * n; k++) other[k] = (other[k] as number) - f * (row[k] as number)
    }
  }
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) inv[c * n + r] = (aug[r] as number[])[n + c] as number
  return inv
}

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

const KIND_ID: Record<string, number> = { ic: 0, res: 1, cap: 2, ind: 3, diode: 4, led: 5, xtal: 6, conn: 7, switch: 8, can: 9, other: 10, valve: 11, pin: 12, lead: 13 }
const ROUND = new Set(['can', 'valve'])
const HERO_FALL = 11.5 / 360
const LED_THROW = 1.2
/** how far the studio falls while the lamps are the light: about a stop */
const LAMP_DIM = 0.5
const rank = (kind: string): number => (kind === 'valve' ? 2 : ROUND.has(kind) ? 1 : 0)

const bytes = (b64: string): Uint8Array => Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0))

/** how far the trace film's held poster has pushed in by its last frame */
const POSTER_PUSH = 1.015

function handheld(tl: TraceTimeline, q: number): ReturnType<typeof sampleShot> {
  const s = tl.scene
  const k = sampleShot(s.shots, q)
  const fade = 1 - ease((q - (s.acts.hold[0] - 1 / 24)) / (1 / 24))
  if (fade <= 0) return tl.style === 'trace' ? { ...k, zoom: k.zoom * (1 + (POSTER_PUSH - 1) * (1 - Math.cos((Math.PI / 2) * Math.min(1, (q - s.acts.hold[0]) / (1 - s.acts.hold[0]))))) } : k
  const seed = (s.board[0]?.[0] ?? 0) * 12.9898 + (s.board[0]?.[1] ?? 0) * 78.233
  const t = (q * tl.totalFrames) / 30
  const wave = (a: number): number => 0.6 * Math.sin(2 * Math.PI * 0.11 * t + a) + 0.3 * Math.sin(2 * Math.PI * 0.23 * t + 2.1 * a) + 0.1 * Math.sin(2 * Math.PI * 0.47 * t + 3.7 * a)
  const reach = (0.0018 * tl.width) / k.zoom
  return { ...k, x: k.x + reach * fade * wave(seed % 6.283), y: k.y + reach * fade * wave((seed * 1.618) % 6.283) }
}

const ease = (x: number): number => {
  const t = Math.min(1, Math.max(0, x))
  return t * t * (3 - 2 * t)
}

const LIGHT_EASE = 1.2 / 24

/** the rig part way from a to b: numbers blend, switches and colours of absent lights take b's */
export function mixRig<T>(a: T, b: T, k: number): T {
  if (typeof a === 'number' && typeof b === 'number') return (a + (b - a) * k) as T
  if (Array.isArray(a) && Array.isArray(b)) return b.map((v: unknown, i): unknown => mixRig<unknown>(a[i] as unknown, v, k)) as T
  if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
    return Object.fromEntries(Object.entries(b).map(([key, v]) => [key, mixRig((a as Record<string, unknown>)[key], v, k)])) as T
  }
  return b
}

/** the rig with every optional light at the value the renderer reads when it is absent, so a blend never jumps */
export function wholeRig(r: Rig): Rig {
  return {
    ...r,
    partRoom: r.partRoom ?? r.room,
    bounce: r.bounce ?? 0,
    partBounce: r.partBounce ?? r.bounce ?? 0,
    turn: r.partBounce === undefined ? 0 : r.turn ?? 1,
    fall: r.fall ?? 0,
    lip: r.lip ?? 0,
    mark: r.mark ?? 0,
    floorBase: r.floorBase ?? 0.06,
    box: r.box ?? 0,
    boxLift: r.boxLift ?? 0.12,
    partEnv: r.partEnv ?? r.env,
    heroLit: r.heroLit ?? 1,
    rimAz: r.rimAz ?? 0,
    etch: r.etch ?? 0,
    sweep: r.sweep ?? [0, 0, 0, 0, 1],
    groundOn: r.ground === undefined ? 0 : r.groundOn ?? 1,
    ground: r.ground ?? [0, 0, 0]
  }
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

/** the [start, end) of the light state that holds phase p: from the key that set it to the next cut or change */
export function lightSpan(shots: CameraShot[], p: number): [number, number] {
  let a = 0
  let b = 1
  let light: TraceLight | undefined
  for (const k of shots) {
    const turn = k.cut === true || (k.light !== undefined && k.light !== light)
    if (k.t <= p) {
      if (turn) a = k.t
      if (k.light !== undefined) light = k.light
    } else if (turn) {
      b = k.t
      break
    }
  }
  return [a, b]
}

type RGB = [number, number, number]

/** what the studio holds for one shot: its key, rim, panels, strip light and ground */
export interface Rig {
  /** how brightly bare copper holds the draw's amber until the coat covers it */
  keepCu?: number | undefined
  /** how much of the coat's own colour it keeps at any view angle, scaled down to none for a white coat */
  maskKeep?: number | undefined
  /** how bright the coat's travelling front line is, against its resting grey */
  frontGain?: number | undefined
  /** the room: key, fill and reflections together */
  room: number
  /** how far the bare laminate sinks into black */
  dark: number
  /** how hot the head of a line being drawn burns */
  heat?: number | undefined
  key: { az: number; el: number; col: RGB; size?: number | undefined }
  rim: number
  /** how far the rim keeps to the hero: 0 catches every edge, 1 the hero alone */
  rimOnly: number
  /** top box, panel ahead of the lens, cyclorama, black flags */
  env: [number, number, number, number]
  strip: { n: [number, number, number]; width: number; gain: number; el: number; col: RGB }
  pool: number
  /** the poster's ground (linear), or none: the floor stays black */
  ground: RGB | undefined
  vignette: number
  /** how many stops the light falls from the hero to the board's far corners */
  fall?: number | undefined
  /** how brightly the board's top edge catches the light */
  lip?: number | undefined
  /** a large soft bounce from overhead that lifts every top face: on the board, and on the parts */
  bounce?: number | undefined
  partBounce?: number | undefined
  /** how far the bounce has turned from the parts' tops to their sides (0..1) */
  turn?: number | undefined
  /** the floor's light far from the board, as a share of its ground colour */
  floorBase?: number | undefined
  /** how far the floor shows its ground colour (0: the dark studio floor) */
  groundOn?: number | undefined
  /** how far the hero's marking is lifted so it reads in a dim rig (0..1) */
  mark?: number | undefined
  /** the room on the parts, when it differs from the board's */
  partRoom?: number | undefined
  /** the strip light glints on the parts alone, never across the board */
  stripParts?: boolean | undefined
  /** the softbox ahead of the lens: its radiance, and how far above the lens's mirror line it hangs (radians) */
  box?: number | undefined
  boxLift?: number | undefined
  /** the studio as the parts reflect it, when it differs from the board's */
  partEnv?: [number, number, number, number] | undefined
  /** the rim's heading off the lens's own, radians (0 when absent: from straight ahead) */
  rimAz?: number | undefined
  /** the studio's gain on the main chip alone: 0 leaves its faces unlit, its rim alone showing its outline (1 when absent) */
  heroLit?: number | undefined
  /** how far the main chip's marking and mould grain catch the light (0..1) */
  etch?: number | undefined
  /** a highlight crossing the main chip's lid: its direction over its width (world x, y), where it stands along that, its strength, and the share of it the bare epoxy takes */
  sweep?: [number, number, number, number, number] | undefined
}

/**
 * The light of each shot, at shot-local time u (0..1). fwd is the lens's
 * heading on the board (radians, world); pale is the mask's display
 * luma, so a dark gloss coat gets the soft box it needs to read; lift is
 * how far the crane has risen toward the end frame. Everything else changes
 * on the cut.
 */
const STUDIO = 2.0
const STUDIO_BASE = 0.8
/** how far the floor dims for the breath and power-on */
const DIM = 0.45
/** how far the board's own light dims with it: less than the floor, so the board stays its colour and the lit nets carry the contrast */
const BOARD_DIM = 0.62

/** the soft light over the finished object: high, a little behind, and wide, so each part sits in a short soft pool */
const OVER = { el: 1.25, size: 0.32, gain: 1.7 }

/** the low key's bearing off the board's forward direction as it travels: the coat's start, the parts take's start, the main chip's close, the breath */
const STAGE_KEY = [1.55, 1.65, 1.95, 2.1] as const
/** in the parts take the plate takes this many times the parts' room light, so the frame holds a floor while the parts keep their round-5 light and glint at their edges */
export const STAGE_BOARD = 1.8
/** the coat take: bare copper holds the draw's amber until the coat covers it, the coat keeps some of its own colour, and its front is one thin line of sheen */
export const COAT_HOLD = { keepCu: 0.45, maskKeep: 1, frontGain: 4 }
/** frames the key takes to leave once the main chip seats, and what of it stays */
const LEAVE = { frames: 8, rest: 0.3 }
/** frames over which the main chip's rim and key fall back after it seats */
const SEAT_FLASH = 5
/** the highlight that finds the main chip: it starts this many frames after the wake, takes this many to reach the lid's middle, and is this share of the chip wide; there it rests, wider, mostly on the marking (the bare epoxy takes `lid` of it), so the marking stays lit to the last frame */
const SWEEP_AFTER = 4
const SWEEP_FRAMES = 34
const SWEEP_WIDTH = 0.11
const SWEEP_REST = { width: 0.3, gain: 0.9, lid: 0.25 }

/** the trace film's own studio, by light (scene.film): how bright a ring of light low around the board is (the copper's edges read as lines on black) and how far the rest of the studio dims, and how hot the drawing fronts burn; the gain of a soft source the lids reflect; how thick the haze, how far the bloom spreads and how much of the shutter stays open; and in the look straight down, the part bodies' share of their light, the nets' glow, a key from straight above, the LEDs' gain and reach, and how far every drawn net and the main chip's own nets are lit */
type FilmLook = { ring: number; dim: number; heat: number; scrim: number; haze: number; bloom: number; shutter: number; glow: number; body: number; coax: number; led: number; ledReach: number; allLit: number; heroLit: number }
const PLAIN: FilmLook = { ring: 0, dim: 1, heat: 1, scrim: 0, haze: 0, bloom: 1, shutter: 1, glow: 1, body: 1, coax: 0, led: 1, ledReach: 1, allLit: 0, heroLit: 0 }
const FILM: Partial<Record<TraceLight, Partial<FilmLook>>> = {
  spark: { ring: 22, dim: 0.012, heat: 1.8, shutter: 2 },
  skyline: { scrim: 12 },
  rim: { scrim: 12 },
  stage: { scrim: 5 },
  alone: { scrim: 10 },
  ride: { haze: 0.9, bloom: 2, glow: 2, shutter: 0.35 },
  power: { body: 0.35, glow: 1.6, coax: 0.12, led: 0.6, ledReach: 0.6, allLit: 0.5, heroLit: 1 }
}

/** the film look at phase p: a change of light inside a shot eases in over LIGHT_EASE; on the leds film the poster holds the power-on's look */
export function lookAt(tl: TraceTimeline, p: number): FilmLook {
  const s = tl.scene
  const settle = s.shots.findIndex((k) => k.light === 'poster')
  const craning = settle > 0 && p >= (s.shots[settle - 1]?.t ?? 1)
  const [litA] = lightSpan(s.shots, p)
  const turning = !craning && litA > shotSpan(s.shots, p)[0] + 1e-9 && p - litA < LIGHT_EASE
  const lookOf = (q: number): FilmLook => {
    const l = lightAt(s.shots, q)
    return { ...PLAIN, ...(s.film === true && l !== undefined ? FILM[s.power === 'leds' && l === 'poster' ? 'power' : l] : {}) }
  }
  return turning ? mixRig(lookOf(litA - 1e-6), lookOf(p), ease((p - litA) / LIGHT_EASE)) : lookOf(p)
}

/** the motion blur at phase p: the shutter, in phase, that keeps the fastest of 25 points over the board's extent under 1.2% of W times the look's gain; and how far the fastest board point in frame (a 17 by 17 grid over the screen) moves on screen while it is open, in px */
export function blurAt(tl: TraceTimeline, p: number, W: number, H: number, extent: Region, gain: number): { shutter: number; smear: number } {
  const open = 0.5 / tl.totalFrames
  const probe: Array<[number, number]> = Array.from({ length: 25 }, (_, i): [number, number] => [extent.x + (extent.w * (i % 5)) / 4, extent.y + (extent.h * Math.floor(i / 5)) / 4])
  const [spanA, spanB] = shotSpan(tl.scene.shots, p)
  const ca = makeCam(handheld(tl, Math.max(spanA, p - open / 2)), W, H)
  const cb = makeCam(handheld(tl, Math.min(spanB - 1e-7, p + open / 2)), W, H)
  const fast = Math.max(0, ...probe.map(([x, y]) => {
    const a = project(ca, x, y, 0)
    const b = project(cb, x, y, 0)
    const seen = (q: { x: number; y: number; w: number }): boolean => q.w > 0 && Math.abs(q.x) <= 1.2 && Math.abs(q.y) <= 1.2
    return seen(a) && seen(b) ? Math.hypot((a.x - b.x) * W, (a.y - b.y) * H) / 2 : 0
  }))
  const shutter = open * gain * Math.min(1, (0.012 * W) / Math.max(1e-6, fast))
  const ground = (c: Cam, sx: number, sy: number): [number, number] | undefined => {
    const d = c.r.map((v, i) => v * sx * c.tanX + (c.u[i] as number) * (sy - c.shift) * c.tanY + (c.f[i] as number))
    const t = -c.pos[2] / (d[2] as number)
    const x = c.pos[0] + t * (d[0] as number)
    const y = -(c.pos[1] + t * (d[1] as number))
    return t > 0 && x >= extent.x && x <= extent.x + extent.w && y >= extent.y && y <= extent.y + extent.h ? [x, y] : undefined
  }
  const mid = makeCam(handheld(tl, p), W, H)
  const seenFast = Math.max(0, ...Array.from({ length: 17 * 17 }, (_, i) => {
    const g = ground(mid, -1 + (2 * (i % 17)) / 16, -1 + (2 * Math.floor(i / 17)) / 16)
    if (g === undefined) return 0
    const a = project(ca, g[0], g[1], 0)
    const b = project(cb, g[0], g[1], 0)
    return a.w > 0 && b.w > 0 ? Math.hypot((a.x - b.x) * W, (a.y - b.y) * H) / 2 : 0
  }))
  return { shutter, smear: (seenFast * shutter) / open }
}

/** the most on-screen px between two neighbouring motion-blur samples: closer copies merge into one smear */
export const BLUR_STEP = 0.75
/** a frame's samples accumulate in passes of at most this many; renderAsync finishes each pass on the GPU and hands the browser its main thread before the next, since one frame of several seconds' unbroken GPU work loses the WebGL context and comes back white */
export const BLUR_PASS = 32
/** whether sample i of n closes a pass, with more samples to come */
export function passEnds(i: number, n: number): boolean {
  return (i + 1) % BLUR_PASS === 0 && i + 1 < n
}

/** the most motion-blur samples one frame takes */
export const BLUR_MOST = 212

/** the largest gap between the shutter times of the jitter sequence's first n samples, as a share of the shutter */
export function shutterGap(n: number): number {
  const u = Array.from({ length: n }, (_, i) => fract((i + 1) * (R_ALPHA[0] as number))).sort((x, y) => x - y)
  return Math.max(1 - (u[n - 1] as number) + (u[0] as number), ...u.slice(1).map((v, i) => v - (u[i] as number)))
}

/** a frame's motion-blur samples, for a smear of this many px: its quality's own count and shutter times (from the jitter sequence when jittered, else even) while neighbouring samples stand at most BLUR_STEP apart; else as many evenly spaced shutter times as keep that step, up to BLUR_MOST */
export function blurPlan(smear: number, least: number, jittered: boolean): { n: number; even: boolean } {
  if (least <= 1 || smear * (jittered ? shutterGap(least) : 1 / least) <= BLUR_STEP) return { n: least, even: false }
  return { n: Math.min(BLUR_MOST, Math.max(least, Math.ceil(smear / BLUR_STEP))), even: true }
}
/** the ring's lower and upper elevation, radians */
const RING = [(10 * Math.PI) / 180, (15 * Math.PI) / 180] as const
/** the haze starts this share of the lens's distance out and scatters this much light back */
const HAZE = { from: 0.25, col: 0.045 }
/** the lids' soft source: this share of the lens's distance beyond the parts in frame, in the mirror of the view; this wide and this tall as shares of that distance; the share of its height that ramps */
const SCRIM = { reach: 0.3, wide: 1.5, tall: 0.07, ramp: 0.25 }
/** the band that flips the main chip's marking: it starts this many frames after the wake, crosses in this many, leaves the lid this many frames before the next cut, and is this share of the chip wide at this strength */
const FLIP = { after: 8, frames: 20, clear: 2, width: 2.2 * SWEEP_WIDTH, gain: 0.6 }

/** the softbox's radiance in each light: the coat is lit by it, the power-on has none */
const BOX: Record<TraceLight, number> = { spark: 1.5, route: 1, coat: 3.5, place: 2.2, breath: 2.2, skyline: 2.2, rim: 2.2, ride: 1.2, power: 2.2, poster: 3, sheen: 5, hero: 2.6, stage: 0.5, alone: 0.6 }

/** a chip's marking: where the value carries a package suffix after its last hyphen, the part stands over the package on two lines */
/** gull-wing leads for an estimated chip whose pads reach past its body on two opposite sides (at least `out[0]` of a pad's length outside: less is a leadless pad's toe): each pad that reaches past the body (up to `out[1]`; more is a neighbour's pad) gets one, out of the side at mid height, down, and flat onto its pad, as wide as the pad; pads under the body get none */
export const LEAD = { thick: 0.2, knee: 0.55, across: 0.8, out: [0.6, 1.25] as const }
export function leadsOf(part: Pick<TracePart, 'x' | 'y' | 'w' | 'h' | 'rot' | 'z'>, pads: Array<Pick<TracePad, 'x' | 'y' | 'w' | 'h' | 'rot'>>, pxPerMm: number): Array<{ x: number; y: number; w: number; h: number; rot: number; base: number; z: number }> {
  const c = Math.cos(part.rot)
  const s = Math.sin(part.rot)
  const t = LEAD.thick * pxPerMm
  const mid = part.z / 2
  const reach = 1.2 * Math.max(part.w, part.h)
  const outs = pads.flatMap((pd) => {
    const dx = pd.x - part.x
    const dy = pd.y - part.y
    if (Math.hypot(dx, dy) > reach) return []
    const lx = c * dx + s * dy
    const ly = -s * dx + c * dy
    const turned = Math.abs(Math.sin(pd.rot - part.rot)) > 0.7
    const hx = (turned ? pd.h : pd.w) / 2
    const hy = (turned ? pd.w : pd.h) / 2
    const overX = Math.abs(lx) + hx - part.w / 2
    const overY = Math.abs(ly) + hy - part.h / 2
    const share = (over: number, half: number): number => over / (2 * half)
    if (overX > 0 && share(overX, hx) <= LEAD.out[1] && Math.abs(ly) < part.h / 2) return [{ axis: 0, sign: Math.sign(lx), along: Math.abs(lx) + hx, mid: ly, wide: 2 * hy, share: share(overX, hx) }]
    if (overY > 0 && share(overY, hy) <= LEAD.out[1] && Math.abs(lx) < part.w / 2) return [{ axis: 1, sign: Math.sign(ly), along: Math.abs(ly) + hy, mid: lx, wide: 2 * hx, share: share(overY, hy) }]
    return []
  })
  const sides = new Set(outs.filter((o) => o.share >= LEAD.out[0]).map((o) => `${o.axis}${o.sign}`))
  const opposite = sides.has('01') && sides.has('0-1') || sides.has('11') && sides.has('1-1')
  if (!opposite) return []
  return outs.flatMap((o) => {
    const e0 = o.axis === 0 ? part.w / 2 : part.h / 2
    const knee = e0 + LEAD.knee * (o.along - e0)
    const across = LEAD.across * o.wide
    const box = (u0: number, u1: number, base: number, z: number) => {
      const u = o.sign * (u0 + u1) / 2
      const [lx, ly] = o.axis === 0 ? [u, o.mid] : [o.mid, u]
      const [w, h] = o.axis === 0 ? [u1 - u0, across] : [across, u1 - u0]
      return { x: part.x + c * lx - s * ly, y: part.y + s * lx + c * ly, w, h, rot: part.rot, base, z }
    }
    return [box(e0, knee, mid - t / 2, t), box(knee - t / 2, knee + t / 2, 0, mid + t / 2), box(knee, o.along, 0, t)]
  })
}

export function markingLines(label: string): string[] {
  const m = /^(.+[A-Z0-9])-([A-Z]{1,4}[0-9]{1,4}[A-Z]?)$/i.exec(label)
  return m === null ? [label] : [m[1] as string, m[2] as string]
}

/** the key's sheen crosses the main chip's lid once as it seats: it starts `lead` frames before the seat and takes `frames` to cross */
export const SEAT_SHEEN = { lead: 3, frames: 14, width: 0.2, gain: 0.55 }
export function seatSheen(framesFromSeat: number): number | undefined {
  const u = (framesFromSeat + SEAT_SHEEN.lead) / SEAT_SHEEN.frames
  return u < 0 || u > 1 ? undefined : u
}

/** a part that has just landed catches the key: its light lifts by `gain` and settles back over `frames` */
export const SETTLE = { frames: 6, gain: 1.2 }

export function rigFor(light: TraceLight | undefined, u: number, fwd: number, ground: string, pale: number, lift = 1, gain = 1, from = BOARD_DIM): Rig {
  const r = rigBase(light, u, fwd, ground, pale, lift, gain, from)
  return { ...r, box: r.box ?? (light === undefined ? 0 : BOX[light] * (light === 'coat' ? 0.3 + 0.7 * ease((pale - 0.5) / 0.4) : 1)), boxLift: r.boxLift ?? (light === 'coat' || light === 'sheen' ? 0.16 - 0.3 * Math.min(1, Math.max(0, u)) : 0.08) }
}

function rigBase(light: TraceLight | undefined, u: number, fwd: number, ground: string, pale: number, lift = 1, gain = 1, from = BOARD_DIM): Rig {
  const none = { n: [0, 0, 1] as [number, number, number], width: 0.05, gain: 0, el: 0, col: [1, 1, 1] as RGB }
  const floorOf = (hex: string): RGB => linear(hex).map((v) => v * STUDIO) as RGB
  const white = ease((pale - 0.5) / 0.4)
  const E = 0.9 * (1 - 0.45 * white)
  const tint = (i: number): RGB => [i, 0.99 * i, 0.975 * i]
  switch (light) {
    case 'place':
    case 'breath':
      return { room: E, dark: 0, key: { az: fwd + Math.PI - 0.35, el: OVER.el, col: tint(OVER.gain), size: OVER.size }, rimOnly: 0, rim: 1.1, env: [0.45, 0.62, 0.2, 1], mark: 1, bounce: 0.12, strip: none, pool: 0, ground: floorOf(ground), floorBase: STUDIO_BASE, vignette: 0.3 }
    case 'route':
      return { room: E, dark: 0, key: { az: fwd + Math.PI - 0.78, el: 0.55, col: tint(2.6) }, rimOnly: 0, rim: 1.1, env: [0.45, 0.62, 0.2, 1], mark: 1, bounce: 0.12, strip: none, pool: 0, ground: floorOf(ground), floorBase: STUDIO_BASE, vignette: 0.3 }
    case 'spark':
      return { room: 0.5 * E, dark: 1, key: { az: fwd - 0.25, el: 0.2, col: tint(1.4) }, rimOnly: 0, rim: 0.25, env: [0, 0.75, 0, 1], mark: 0, bounce: 0, strip: none, pool: 0, ground: undefined, vignette: 0.5, fall: 1.5, heat: 1.3 }
    case 'coat':
      return { room: 0.55 * E, dark: 0.6, key: { az: fwd - 0.4, el: 0.2, col: tint(1.2) }, rimOnly: 0, rim: 0.5, env: [0, 0.5, 0, 1], mark: 0, bounce: 0, strip: none, pool: 0, ground: undefined, vignette: 0.45, heat: 1.3 }
    case 'sheen':
      return { room: 0.6 * E, dark: 0.6, key: { az: fwd + STAGE_KEY[0] + (STAGE_KEY[1] - STAGE_KEY[0]) * u, el: 0.16, col: tint(5) }, rimOnly: 0, rim: 0.5, env: [0, 0.35, 0, 1], mark: 0, bounce: 0, strip: none, pool: 0, ground: undefined, vignette: 0.5, heat: 1.3, ...COAT_HOLD }
    case 'hero':
      return { room: 0.5 * E, partRoom: 1.13, dark: 0, key: { az: fwd + 2.2, el: 0.3, col: tint(2.2), size: OVER.size }, rimOnly: 0.6, rim: 2.4, env: [0.06, 0.5, 0, 1], partEnv: [0.1, 1.1, 0, 1], heroLit: 1, etch: 1, mark: 1, bounce: 0.03, strip: none, pool: 0, ground: undefined, vignette: 0.5, fall: 5 }
    case 'skyline':
      return { room: 1.35 * E, dark: 0, key: { az: fwd + 2.1, el: 0.32, col: tint(2.4), size: OVER.size }, rimOnly: 0, rim: 1.6, env: [0.1, 0.22, 0, 1], mark: 0.6, bounce: 0.05, strip: none, pool: 0, ground: undefined, vignette: 0.42, fall: 1.6 }
    case 'stage':
      return { room: STAGE_BOARD * 0.6 * E, partRoom: 0.6 * E, dark: 0.2, key: { az: fwd + STAGE_KEY[1] + (STAGE_KEY[2] - STAGE_KEY[1]) * u, el: 0.13, col: tint(4.5) }, rimOnly: 0, rim: 4, env: [0.02, 0.18, 0, 1], mark: 0.6, bounce: 0.02, strip: none, pool: 0, ground: undefined, vignette: 0.5, fall: 2.5 }
    case 'alone':
      return { room: STAGE_BOARD * 0.55 * E, partRoom: 0.55 * E, dark: 0.2, key: { az: fwd + STAGE_KEY[2] + (STAGE_KEY[3] - STAGE_KEY[2]) * u, el: 0.22, col: tint(4) }, rimOnly: 0.6, rim: 4, env: [0.02, 0.2, 0, 1], mark: 0.8, bounce: 0.02, strip: none, pool: 0, ground: undefined, vignette: 0.55, fall: 4 }
    case 'rim':
      return { room: 0.7 * E, dark: 0, key: { az: fwd + 2.1, el: 0.24, col: tint(1.5), size: OVER.size }, rimOnly: 0.85, rim: 2.2, env: [0.04, 0.25, 0, 1], mark: 0.8, bounce: 0.02, strip: none, pool: 0, ground: undefined, vignette: 0.5, fall: 4 }
    case 'ride':
      return { room: 0.8 * E, dark: 0, key: { az: fwd + 2.4, el: 0.2, col: [1.5, 1.7, 2.1] }, rimOnly: 0, rim: 2.8, env: [0.04, 0.32, 0, 1], mark: 0.6, bounce: 0.02, strip: none, pool: 0, ground: undefined, vignette: 0.42, fall: 1.4 }
    case 'power':
      return { room: 0.5 * E, dark: 0, key: { az: fwd + 2.1, el: 0.32, col: tint(1.1), size: OVER.size }, rimOnly: 0.3, rim: 1.4, env: [0.08, 0.3, 0, 1], mark: 0.8, bounce: 0.03, strip: none, pool: 0, ground: undefined, vignette: 0.45, fall: 2 }
    case 'poster': {
      const l = lift
      const mixN = (a: number, b: number): number => a + (b - a) * l
      const k = Math.min(1, Math.max(0, (u - 0.25) / 0.5))
      const sweep = fwd - 0.32 + 0.64 * k * k * (3 - 2 * k)
      const g = linear(ground)
      const m = mixN(from, Math.min(1.3, gain))
      const fm = mixN(DIM, Math.min(1.3, gain))
      return {
        room: E * m * (1 + (1 - white) * (1 - l)), partRoom: E * m * mixN(1 + (1 - white), 0.85), dark: 0, key: { az: fwd + mixN(2.6, 0.8), el: OVER.el, col: tint(OVER.gain * m), size: OVER.size }, rimOnly: mixN(0.6, 0), rim: mixN(1.5, 3.2 + 1.6 * Math.min(1, Math.max(0, (0.3 - pale) / 0.15))),
        env: [0.45 * m, 0.62 * m, 0.2 * m, 1],
        strip: { n: [-Math.sin(sweep), Math.cos(sweep), 0], width: 0.006, gain: u > 0 ? 0.3 * Math.sin(Math.PI * k) : 0, el: -1, col: [1.0, 0.97, 0.93] },
        pool: 0, ground: [g[0] * STUDIO * fm, g[1] * STUDIO * fm, g[2] * STUDIO * fm], floorBase: STUDIO_BASE, groundOn: 1, mark: 1, vignette: mixN(0.3, 0.32), fall: 0.6 * l, lip: l, turn: l, bounce: mixN(0.12, 0.3 * (1 - white)), partBounce: mixN(0.12, 1.3), stripParts: true
      }
    }
    default:
      return { room: 1, dark: 0, key: { az: -2.35, el: 0.52, col: [3.0, 2.72, 2.35] }, rimOnly: 0, rim: 1, env: [1, 1, 1, 0], strip: none, pool: 1, ground: undefined, vignette: 0.32 }
  }
}

type V3 = [number, number, number]

/** shadow map size, texels a side; the key's atlas holds four of them */
const SHADOW = 2048
/** the key's angular radius: small, so shadows stay hard near the part and soften with distance */
const KEY_SIZE = 0.035
/** the live LED's blink period on a held ending, seconds */
const BLINK = 0.8

/** the 9-dimensional R-sequence (Roberts): sample i of dimension j is fract(i · alpha_j) */
const R_ALPHA = ((): number[] => {
  let phi = 2
  for (let i = 0; i < 64; i++) phi = Math.pow(1 + phi, 1 / 10)
  return Array.from({ length: 9 }, (_, j) => Math.pow(1 / phi, j + 1) % 1)
})()

const fract = (x: number): number => x - Math.floor(x)

/** a point of the unit disk from two uniforms, area-preserving (Shirley's concentric map) */
function disk(a: number, b: number): [number, number] {
  const x = 2 * a - 1
  const y = 2 * b - 1
  if (x === 0 && y === 0) return [0, 0]
  const [r, t] = Math.abs(x) > Math.abs(y) ? [x, (Math.PI / 4) * (y / x)] : [y, Math.PI / 2 - (Math.PI / 4) * (x / y)]
  return [r * Math.cos(t), r * Math.sin(t)]
}

/** an orthographic view along -dir (light travelling toward the board) that holds every point */
function orthoLight(dir: V3, pts: V3[]): Float32Array {
  const f = norm([-dir[0], -dir[1], -dir[2]])
  const up: V3 = Math.abs(f[2]) > 0.99 ? [0, 1, 0] : [0, 0, 1]
  const r = norm([f[1] * up[2] - f[2] * up[1], f[2] * up[0] - f[0] * up[2], f[0] * up[1] - f[1] * up[0]])
  const u: V3 = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]]
  const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
  const xs = pts.map((q) => dot(q, r))
  const ys = pts.map((q) => dot(q, u))
  const ds = pts.map((q) => dot(q, f))
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
  const pad = 0.02 * Math.max(x1 - x0, y1 - y0)
  const n0 = Math.min(...ds) - pad
  const n1 = Math.max(...ds) + pad
  const sx = 2 / (x1 - x0 + 2 * pad)
  const sy = 2 / (y1 - y0 + 2 * pad)
  const sz = 2 / (n1 - n0)
  return new Float32Array([
    sx * r[0], sy * u[0], sz * f[0], 0,
    sx * r[1], sy * u[1], sz * f[1], 0,
    sx * r[2], sy * u[2], sz * f[2], 0,
    -(x0 + x1) / (x1 - x0 + 2 * pad), -(y0 + y1) / (y1 - y0 + 2 * pad), -(n0 + n1) / (n1 - n0), 1
  ])
}

/**
 * The camera moved by (ox, oy) across its lens (world units, along its right and up) with its view
 * sheared so the focus plane stays put, and the picture moved by (jx, jy) in NDC: one sample of a thin
 * lens and of the pixel's area
 */
export function lensCam(c: Cam, ox: number, oy: number, jx: number, jy: number): Cam {
  const pos: V3 = [c.pos[0] + c.r[0] * ox + c.u[0] * oy, c.pos[1] + c.r[1] * ox + c.u[1] * oy, c.pos[2] + c.r[2] * ox + c.u[2] * oy]
  const dot = (a: readonly number[], b: readonly number[]): number => (a[0] as number) * (b[0] as number) + (a[1] as number) * (b[1] as number) + (a[2] as number) * (b[2] as number)
  const view = [c.r[0], c.u[0], -c.f[0], 0, c.r[1], c.u[1], -c.f[1], 0, c.r[2], c.u[2], -c.f[2], 0, -dot(c.r, pos), -dot(c.u, pos), dot(c.f, pos), 1]
  const near = c.dist * 0.02
  const far = c.dist * 20
  const px = 1 / c.tanX
  const py = 1 / c.tanY
  const proj = [px, 0, 0, 0, 0, py, 0, 0, -px * ox / c.focus - jx, -c.shift - py * oy / c.focus - jy, (far + near) / (near - far), -1, 0, 0, (2 * far * near) / (near - far), 0]
  const vp = new Float32Array(16)
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0
      for (let i = 0; i < 4; i++) sum += (proj[i * 4 + row] as number) * (view[col * 4 + i] as number)
      vp[col * 4 + row] = sum
    }
  }
  return { ...c, pos, vp }
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
    mesh: link(g, VS_MESH, FS_MESH),
    copy: link(g, VS_QUAD, FS_COPY),
    dof: link(g, VS_QUAD, FS_DOF),
    bright: link(g, VS_QUAD, FS_BRIGHT),
    down: link(g, VS_QUAD, FS_DOWN),
    up: link(g, VS_QUAD, FS_UP),
    streak: link(g, VS_QUAD, FS_STREAK),
    final: link(g, VS_QUAD, FS_FINAL),
    matte: link(g, VS_QUAD, FS_MATTE)
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

  const target = (w: number, h: number, depth: boolean, wide = false): Target => {
    let zTex: WebGLTexture | undefined
    const tex = g.createTexture()
    g.bindTexture(g.TEXTURE_2D, tex)
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.LINEAR)
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.LINEAR)
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE)
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE)
    if (wide) {
      g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.NEAREST)
      g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.NEAREST)
    }
    g.texImage2D(g.TEXTURE_2D, 0, wide ? g.RGBA32F : hdr ? g.RGBA16F : g.RGBA8, w, h, 0, g.RGBA, wide ? g.FLOAT : hdr ? g.HALF_FLOAT : g.UNSIGNED_BYTE, null)
    const fbo = g.createFramebuffer()
    g.bindFramebuffer(g.FRAMEBUFFER, fbo)
    g.framebufferTexture2D(g.FRAMEBUFFER, g.COLOR_ATTACHMENT0, g.TEXTURE_2D, tex, 0)
    if (depth) {
      zTex = g.createTexture()
      g.bindTexture(g.TEXTURE_2D, zTex)
      g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.NEAREST)
      g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.NEAREST)
      g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE)
      g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE)
      g.texImage2D(g.TEXTURE_2D, 0, g.DEPTH_COMPONENT24, w, h, 0, g.DEPTH_COMPONENT, g.UNSIGNED_INT, null)
      g.framebufferTexture2D(g.FRAMEBUFFER, g.DEPTH_ATTACHMENT, g.TEXTURE_2D, zTex, 0)
    }
    return { tex, fbo, w, h, ...(zTex === undefined ? {} : { z: zTex }) }
  }
  const scene = target(width, height, true)
  const blend32 = g.getExtension('EXT_float_blend') !== null && hdr
  const accum = target(width, height, true, blend32)
  const depthOnly = (w: number, h: number): Target => {
    const z = g.createTexture()
    g.bindTexture(g.TEXTURE_2D, z)
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.LINEAR)
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.LINEAR)
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE)
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE)
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_COMPARE_MODE, g.COMPARE_REF_TO_TEXTURE)
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_COMPARE_FUNC, g.LEQUAL)
    g.texImage2D(g.TEXTURE_2D, 0, g.DEPTH_COMPONENT24, w, h, 0, g.DEPTH_COMPONENT, g.UNSIGNED_INT, null)
    const fbo = g.createFramebuffer()
    g.bindFramebuffer(g.FRAMEBUFFER, fbo)
    g.framebufferTexture2D(g.FRAMEBUFFER, g.DEPTH_ATTACHMENT, g.TEXTURE_2D, z, 0)
    return { tex: z, fbo, w, h, z }
  }
  const keyShadow = depthOnly(2 * SHADOW, 2 * SHADOW)
  const skyShadow = depthOnly(SHADOW / 2, SHADOW / 2)
  const dummyDepth = depthOnly(1, 1).tex
  const mipped = (t: Target): Target => {
    g.bindTexture(g.TEXTURE_2D, t.tex)
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.LINEAR_MIPMAP_LINEAR)
    g.generateMipmap(g.TEXTURE_2D)
    return t
  }
  const maskRefl = mipped(target(width, height, true))
  const floorRefl = mipped(target(Math.ceil(width / 2), Math.ceil(height / 2), true))
  const shadow = {
    light: new Float32Array(64) as Float32Array,
    sky: new Float32Array(16) as Float32Array,
    skyOn: 0,
    bias: [0, 0] as [number, number],
    boxC: [0, 0, 1] as V3,
    boxU: [1, 0, 0] as V3,
    boxV: [0, 1, 0] as V3,
    boxCol: [0, 0, 0] as V3
  }
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
  let meshDraws: Array<{ pos: WebGLBuffer; nor: WebGLBuffer; col: WebGLBuffer; idx: WebGLBuffer; inst: WebGLBuffer; count: number; parts: number; min: number[]; max: number[]; top: [number, number, number, number] }> = []
  let extent: Region = { x: 0, y: 0, w: width, h: height }
  const CELL_W = 256
  const CELL_H = 128
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
    const instanceOf = (part: TracePart): number[] => {
      let col = 0
      let row = 0
      let has = 0
      if (part.label !== undefined && cell < ATLAS_COLS * ATLAS_ROWS) {
        col = cell % ATLAS_COLS
        row = Math.floor(cell / ATLAS_COLS)
        const fit = (text: string): number => {
          actx.font = '600 34px ui-monospace, Menlo, monospace'
          return Math.min(34, (34 * CELL_W * 0.9) / Math.max(1, actx.measureText(text).width))
        }
        const lines = markingLines(part.label)
        const size = lines.length === 1 ? fit(part.label) : Math.min(1.5 * fit(part.label), ...lines.map(fit), 0.4 * CELL_H)
        actx.font = `600 ${size}px ui-monospace, Menlo, monospace`
        lines.forEach((line, i) => {
          actx.fillText(line, col * CELL_W + CELL_W / 2, row * CELL_H + CELL_H / 2 + (i - (lines.length - 1) / 2) * 1.15 * size)
        })
        has = part.turn === true ? 2 : 1
        cell++
      }
      // connectors carry their pin pitch and pins their housing height where ICs carry their marking flag
      const third = part.socket === true ? 3 : part.kind === 'conn' && part.mesh === undefined ? (part.pitch ?? 0) : part.kind === 'pin' ? (part.seat ?? 0) : has
      return [
        part.x, part.y, part.w, part.h,
        part.rot, part.z, KIND_ID[part.kind] ?? 10, part.t,
        col, row, third, part.hero === true ? 1 : 0,
        ...(part.led === undefined ? [0, 0, 0, 0] : [...linear(part.led.color).map((c) => c * 0.5 * (part.led?.gain ?? 1)), part.led.at]),
        part.fall ?? HERO_FALL, part.lift ?? 0, 0, part.led?.off ?? 0,
        part.enter?.x ?? 0, part.enter?.y ?? 0, 0, 0
      ]
    }
    // boxes first, round bodies after: each set draws with its own mesh
    const ordered = s.parts.filter((pt) => pt.mesh === undefined).sort((x, y) => rank(x.kind) - rank(y.kind))
    const leads = s.parts.filter((pt) => pt.kind === 'ic' && pt.mesh === undefined).flatMap((pt) => leadsOf(pt, s.pads, s.material.pxPerMm).flatMap((l) => [
      l.x, l.y, l.w, l.h, l.rot, l.z, KIND_ID.lead as number, pt.t, 0, 0, 0, 0, 0, 0, 0, 0, 1e-3, 0, 0, 0, 0, 0, l.base, 0
    ]))
    const boxes = ordered.filter((pt) => rank(pt.kind) === 0)
    const inst = [...boxes.flatMap(instanceOf), ...leads, ...ordered.filter((pt) => rank(pt.kind) !== 0).flatMap(instanceOf)]
    for (const d of meshDraws) for (const b of [d.pos, d.nor, d.col, d.idx, d.inst]) g.deleteBuffer(b)
    meshDraws = s.meshes.map((mesh, id) => {
      const wearing = s.parts.filter((pt) => pt.mesh?.id === id)
      const upload = (target: number, data: ArrayBufferView): WebGLBuffer => {
        const b = g.createBuffer()
        g.bindBuffer(target, b)
        g.bufferData(target, data, g.STATIC_DRAW)
        return b
      }
      const idx = new Uint32Array(bytes(mesh.idx).buffer)
      const pos = new Float32Array(bytes(mesh.pos).buffer)
      const zTop = mesh.max[2] - 0.02 * (mesh.max[2] - mesh.min[2])
      let tx0 = Infinity
      let ty0 = Infinity
      let tx1 = -Infinity
      let ty1 = -Infinity
      for (let i = 0; i + 2 < pos.length; i += 3) {
        if ((pos[i + 2] as number) < zTop) continue
        tx0 = Math.min(tx0, pos[i] as number)
        tx1 = Math.max(tx1, pos[i] as number)
        ty0 = Math.min(ty0, pos[i + 1] as number)
        ty1 = Math.max(ty1, pos[i + 1] as number)
      }
      return {
        pos: upload(g.ARRAY_BUFFER, pos),
        nor: upload(g.ARRAY_BUFFER, bytes(mesh.nor)),
        col: upload(g.ARRAY_BUFFER, bytes(mesh.col)),
        idx: upload(g.ELEMENT_ARRAY_BUFFER, idx),
        inst: upload(g.ARRAY_BUFFER, new Float32Array(wearing.flatMap((pt) => [...(pt.mesh?.m.slice(0, 4) ?? []), ...instanceOf(pt)]))),
        count: idx.length,
        parts: wearing.length,
        min: mesh.min,
        max: mesh.max,
        top: [(tx0 + tx1) / 2, (ty0 + ty1) / 2, Math.max(1e-3, (tx1 - tx0) / 2), Math.max(1e-3, (ty1 - ty0) / 2)]
      }
    })
    g.bindTexture(g.TEXTURE_2D, atlasTex)
    g.texImage2D(g.TEXTURE_2D, 0, g.RGBA, g.RGBA, g.UNSIGNED_BYTE, atlas)
    g.generateMipmap(g.TEXTURE_2D)
    g.bindBuffer(g.ARRAY_BUFFER, partBuf)
    g.bufferData(g.ARRAY_BUFFER, new Float32Array(inst), g.STATIC_DRAW)
    valveCount = ordered.filter((pt) => rank(pt.kind) === 2).length
    roundCount = ordered.filter((pt) => rank(pt.kind) === 1).length
    boxCount = boxes.length + leads.length / 24
  }

  /**
   * The region to rasterise: what the camera sees of the board, on whole
   * texels at a stepped scale. The map grid then holds still in board space
   * from frame to frame, so thin copper does not crawl as the camera moves.
   */
  const seen = (cams: Cam[], tallest: number): { xa: number; ya: number; xb: number; yb: number } => {
    let r: Region | undefined
    for (const [cam, z] of cams.flatMap((c): Array<[Cam, number]> => [[c, 0], [c, tallest]])) {
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
    return { xa, ya, xb, yb }
  }
  const texelOf = (cams: Cam[], tallest: number): number => {
    const { xa, ya, xb, yb } = seen(cams, tallest)
    return 2 ** (Math.ceil(Math.log2(Math.max(Math.max(8, xb - xa) / MW, Math.max(8, yb - ya) / MH) * 1.02) * 8) / 8)
  }
  const shotTexel = new Map<number, number>()
  let texelFor: TraceTimeline | undefined
  const regionFor = (cams: Cam[], tallest: number, texel: number): Region => {
    const { xa, ya, xb, yb } = seen(cams, tallest)
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

  let fillTint: RGB = [1, 1, 1]
  const xl = { look: PLAIN, scrC: [0, 0, 0] as V3, scrU: [1, 0, 0] as V3, scrV: [0, 1, 0] as V3, scrCol: [0, 0, 0] as V3, flip: 0, settle: [1, 0] as [number, number], nearDim: 0 }
  const lighting = (prog: Prog, cam: Cam, rig: Rig, fwd: number, band: readonly [number, number, number], poolAt: readonly [number, number, number]): void => {
    const { az, el, col } = rig.key
    prog.v3('uCam', cam.pos)
      .f('uKey', Math.cos(az) * Math.cos(el), Math.sin(az) * Math.cos(el), Math.sin(el))
      .v3('uKeyCol', col)
      .f('uFill', ...(prog === P.top ? fillTint.map((v) => 0.045 * v * xl.look.dim) as RGB : [0.045 * xl.look.dim, 0.0446 * xl.look.dim, 0.0439 * xl.look.dim] as RGB))
      .f('uRing', xl.look.ring, RING[0], RING[1], 0)
      .f('uRim', Math.cos(fwd + (rig.rimAz ?? 0)) * 0.9, Math.sin(fwd + (rig.rimAz ?? 0)) * 0.9, 0.42)
      .f('uRimCol', 1.62 * rig.rim, 1.6 * rig.rim, 1.58 * rig.rim)
      .f('uRoom', prog === P.part || prog === P.mesh ? rig.partRoom ?? rig.room : rig.room)
      .f('uEnv', ...(prog === P.part || prog === P.mesh ? rig.partEnv ?? rig.env : rig.env)).f('uBackAz', fwd)
      .v3('uStripN', rig.strip.n).f('uStrip', rig.strip.width, rig.stripParts === true && prog !== P.part && prog !== P.mesh ? 0 : rig.strip.gain, rig.strip.el).v3('uStripCol', rig.strip.col)
      .f('uBounce', prog === P.part || prog === P.mesh ? rig.partBounce ?? rig.bounce ?? 0 : rig.bounce ?? 0)
      .f('uSide', (prog === P.part || prog === P.mesh) && rig.partBounce !== undefined ? rig.turn ?? 1 : 0)
      .f('uRimOnly', rig.rimOnly).f('uMark', rig.mark ?? 0).f('uHeroLit', rig.heroLit ?? 1).f('uEtch', rig.etch ?? 0).f('uSweep', ...(rig.sweep ?? [0, 0, 0, 0, 1]).slice(0, 4)).f('uSweepLid', rig.sweep?.[4] ?? 1)
      .f('uBand', ...band).f('uBandCol', 1.0, 0.42, 0.12)
      .f('uPoolAt', poolAt[0], poolAt[1], poolAt[2], rig.fall ?? 0)
      .i('tShadow', 5).i('tSky', 6).m4('uLightVP', shadow.light).m4('uSkyVP', shadow.sky).f('uSkyOn', shadow.skyOn).f('uShadowBias', ...shadow.bias)
      .v3('uBoxC', shadow.boxC).v3('uBoxU', shadow.boxU).v3('uBoxV', shadow.boxV).v3('uBoxCol', shadow.boxCol)
      .f4v('uLedP', ledLights.p).f4v('uLedC', ledLights.c)
      .f4v('uFallA', airborne.a).f4v('uFallB', airborne.b)
    const onParts = prog === P.part || prog === P.mesh
    prog.v3('uScrC', xl.scrC).v3('uScrU', xl.scrU).v3('uScrV', xl.scrV).v3('uScrCol', onParts ? xl.scrCol : [0, 0, 0]).f('uScrK', SCRIM.ramp, 0, 0, 1)
      .f('uGloss', onParts && xl.look.scrim > 0 ? 1 : 0).f('uFlip', onParts ? xl.flip : 0).f('uSettle', ...xl.settle).f('uBody', xl.look.body).v3('uEyeN', cam.pos).v3('uFwdN', cam.f).f('uNearDim', onParts ? xl.nearDim : 0, cam.focus)
  }
  const airborne = { a: new Float32Array(96), b: new Float32Array(96) }
  const ledLights = { p: new Float32Array(48), c: new Float32Array(48) }

  let exposeFor: TraceTimeline | undefined
  let exposure = 1
  let probing = false

  const frameSteps = function* (tl: TraceTimeline, frame: number, matte: boolean, sweep = 1, shut = 1): Generator<undefined, HTMLCanvasElement, undefined> {
    {
      if (g.isContextLost()) return canvas
      build(tl)
      const s = tl.scene
      const W = width
      const H = height
      const p = frame / tl.totalFrames
      const acts = s.acts
      const poster = s.shots.findIndex((k) => k.light === 'poster')
      if (!probing && exposeFor !== tl && poster > 0 && p >= (s.shots[poster - 1]?.t ?? 1)) {
        probing = true
        exposure = 1
        for (let i = 0; i < 2; i++) exposure = Math.min(5, Math.max(0.3, exposure * boardGain(frameOut(tl, tl.totalFrames - 1, false), tl, W, H)))
        probing = false
        exposeFor = tl
      }
      const span = (a: [number, number]): number => ease((p - a[0]) / (a[1] - a[0]))
      const tallest = Math.max(0, ...s.parts.map((pt) => pt.z))

      const cam = makeCam(handheld(tl, p), W, H)
      const [shotA, shotB] = shotSpan(s.shots, p)
      if (texelFor !== tl) shotTexel.clear()
      texelFor = tl
      let mapTexel = shotTexel.get(shotA)
      if (mapTexel === undefined) {
        const steps = Array.from({ length: 17 }, (_, i) => texelOf([makeCam(sampleShot(s.shots, shotA + (shotB - 1e-6 - shotA) * (i / 16)), W, H)], tallest))
        mapTexel = Math.max(...steps) <= 2 * Math.min(...steps) ? Math.max(...steps) : 0
        shotTexel.set(shotA, mapTexel)
      }
      const open = 0.5 / tl.totalFrames
      const view = sweep > 1 ? [cam, makeCam(handheld(tl, Math.max(shotA, p - open / 2)), W, H), makeCam(handheld(tl, Math.min(shotB - 1e-7, p + open / 2)), W, H)] : [cam]
      const region = regionFor(view, tallest, Math.max(mapTexel > 0 ? mapTexel : texelOf([cam], tallest), sweep > 1 ? texelOf(view, tallest) : 0))

      const pal = tl.palette
      const m = s.material
      const warmC = linear(m.energyWarm)
      const coolC = linear(m.energyCool)
      const copper = linear(m.copper)
      const texel = [1 / MW, 1 / MH] as const
      const regionV = [region.x, region.y, region.w, region.h] as const
      const maskSpan = span(acts.mask)
      const maskOn = p >= acts.mask[0] ? 1 : 0
      const soft = 0.035 * extent.h
      const toCentre = [extent.x + extent.w / 2 - s.origin.x, extent.y + extent.h / 2 - s.origin.y]
      const toLen = Math.hypot(toCentre[0] as number, toCentre[1] as number)
      const maskDir: [number, number] = toLen > 0.05 * extent.h ? [(toCentre[0] as number) / toLen, (toCentre[1] as number) / toLen] : [1, 0]
      const reach = Math.max(...[[extent.x, extent.y], [extent.x + extent.w, extent.y], [extent.x, extent.y + extent.h], [extent.x + extent.w, extent.y + extent.h]]
        .map(([x, y]) => Math.hypot((x as number) - s.origin.x, (y as number) - s.origin.y)))
      const along = [[extent.x, extent.y], [extent.x + extent.w, extent.y], [extent.x, extent.y + extent.h], [extent.x + extent.w, extent.y + extent.h]]
        .map(([x, y]) => ((x as number) - s.origin.x) * maskDir[0] + ((y as number) - s.origin.y) * maskDir[1])
      const maskFront = maskOn * (Math.min(...along) - 3 * soft + maskSpan * (Math.max(...along) - Math.min(...along) + 6 * soft)) - (1 - maskOn) * 1e6
      const maskLin = linear(m.mask)
      fillTint = maskLin.map((v) => 0.3 + (0.7 * v) / Math.max(1e-4, ...maskLin)) as RGB
      const maskLuma = 0.2126 * maskLin[0] + 0.7152 * maskLin[1] + 0.0722 * maskLin[2]
      const sign = s.sign !== undefined && s.sign.kind !== 'heater' ? s.sign.t : undefined
      const lamp = s.sign?.kind === 'led' ? s.parts.find((pt) => pt.led?.at === s.sign?.t) : undefined
      const valve = s.sign?.kind === 'heater' ? s.parts.find((pt) => pt.hero === true && pt.kind === 'valve') : undefined
      const quiet = sign === undefined ? 0 : Math.exp(-((((p - sign - 0.5 / 24) * 24) / 0.6) ** 4))
      const flatF = Math.hypot(cam.f[0], cam.f[1]) > 0.1 ? [cam.f[0], cam.f[1]] : [cam.u[0], cam.u[1]]
      const fwd = Math.atan2(flatF[1] as number, flatF[0] as number)
      const settle = s.shots.findIndex((k) => k.light === 'poster')
      const craneA = s.shots[settle - 1]?.t ?? 1
      const craneB = s.shots[settle]?.t ?? 1
      const craning = settle > 0 && p >= craneA
      const [litA, litB] = lightSpan(s.shots, p)
      const lift = craning ? ease((p - craneA) / Math.max(1e-6, craneB - craneA)) : 0
      const pale = Math.pow(maskLuma, 1 / 2.2)
      const turning = !craning && litA > shotA + 1e-9 && p - litA < LIGHT_EASE
      const lit = s.power === 'leds' || s.power === 'pulse' || s.power === 'lamps'
      const leds = s.power === 'leds'
      const lightNow = (q: number): TraceLight | undefined => {
        const l = lightAt(s.shots, q)
        return leds && l === 'poster' ? 'power' : l
      }
      const rig = craning && !leds
        ? rigFor('poster', (p - craneB) / Math.max(1e-6, 1 - craneB), fwd, m.ground, pale, lift, exposure, s.power === 'routes' ? Math.min(1.3, exposure) : BOARD_DIM)
        : rigFor(lightNow(p), (p - litA) / Math.max(1e-6, litB - litA), fwd, m.ground, pale)
      if (turning) Object.assign(rig, mixRig(wholeRig(rigFor(lightNow(litA - 1e-6), 1, fwd, m.ground, pale)), wholeRig(rig), ease((p - litA) / LIGHT_EASE)))
      if (craning && !leds && p - craneA < LIGHT_EASE) {
        const [preA, preB] = lightSpan(s.shots, craneA - 1e-6)
        Object.assign(rig, mixRig(wholeRig(rigFor(lightAt(s.shots, craneA - 1e-6), (craneA - preA) / Math.max(1e-6, preB - preA), fwd, m.ground, pale)), wholeRig(rig), ease((p - craneA) / LIGHT_EASE)))
      }
      if (s.character?.archetype === 'valve' && lightAt(s.shots, p) === 'spark') rig.key = { ...rig.key, el: 0.14 }
      const seat = s.parts.find((pt) => pt.hero === true)?.t
      if (seat !== undefined && p >= seat && (lightAt(s.shots, p) === 'rim' || lightAt(s.shots, p) === 'alone')) {
        const flash = Math.exp(-((p - seat) * tl.totalFrames) / SEAT_FLASH)
        const leave = lightAt(s.shots, p) === 'alone' ? 1 - (1 - LEAVE.rest) * ease(((p - seat) * tl.totalFrames) / LEAVE.frames) : 1
        rig.rim *= (1 + 1.4 * flash) * leave
        rig.key = { ...rig.key, col: rig.key.col.map((v) => v * (1 + 0.6 * flash) * leave) as RGB }
      }
      const chip = s.parts.find((pt) => pt.hero === true)
      const lidDiag = chip === undefined ? 0 : Math.atan2(chip.h, chip.w)
      const across = chip === undefined ? [cam.r[0], cam.r[1]] as [number, number] : [chip.rot + lidDiag + Math.PI / 2, chip.rot - lidDiag + Math.PI / 2].map((a): [number, number] => [Math.cos(a), -Math.sin(a)]).map(([x, y]): [number, number] => (x * cam.r[0] + y * cam.r[1] < 0 ? [-x, -y] : [x, y])).sort((a, b) => b[0] * cam.r[0] + b[1] * cam.r[1] - (a[0] * cam.r[0] + a[1] * cam.r[1]))[0] as [number, number]
      const crossing = s.wake === undefined ? -1 : ((p - s.wake) * tl.totalFrames - SWEEP_AFTER) / SWEEP_FRAMES
      if (chip !== undefined && crossing > 0 && lightAt(s.shots, p) === 'hero') {
        const u = Math.min(1, crossing)
        const size = Math.max(chip.w, chip.h)
        const wide = (SWEEP_WIDTH + (SWEEP_REST.width - SWEEP_WIDTH) * ease((u - 0.5) / 0.5)) * size
        const from = 0.5 * Math.hypot(chip.w, chip.h) + 2 * SWEEP_WIDTH * size
        rig.sweep = [across[0] / wide, across[1] / wide, (across[0] * chip.x - across[1] * chip.y - (1 - u) ** 3 * from) / wide, Math.min(1, u / 0.2) * (1 + (SWEEP_REST.gain - 1) * ease((u - 0.5) / 0.5)), 1 + (SWEEP_REST.lid - 1) * ease((u - 0.5) / 0.5)]
      }
      const sheen = s.film !== true || s.seat === undefined ? undefined : seatSheen((p - s.seat) * tl.totalFrames)
      if (chip !== undefined && sheen !== undefined) {
        const wide = SEAT_SHEEN.width * Math.max(chip.w, chip.h)
        const from = 0.5 * Math.hypot(chip.w, chip.h) + 2 * wide
        rig.sweep = [across[0] / wide, across[1] / wide, (across[0] * chip.x - across[1] * chip.y + from * (2 * sheen - 1)) / wide, SEAT_SHEEN.gain, 1]
      }
      const look = lookAt(tl, p)
      xl.look = look
      const energyGain = look.glow * (s.power === 'leds' && p >= acts.power[0] ? 0 : s.power === 'pulse' && p >= acts.power[0] ? 1 : 1) * 3.2 * (1 - 0.35 * quiet) * (1 + 0.5 * ease((p - acts.hold[0]) / 0.04)) * (s.stage !== undefined && p >= acts.hold[0] ? s.stage.energy : 1)
      if (look.dim !== 1) {
        const k = look.dim
        rig.key = { ...rig.key, col: rig.key.col.map((v) => v * k) as RGB }
        rig.env = [rig.env[0] * k, rig.env[1] * k, rig.env[2] * k, rig.env[3]]
        rig.box = (rig.box ?? 0) * k
        rig.strip = { ...rig.strip, gain: rig.strip.gain * k }
        rig.bounce = (rig.bounce ?? 0) * k
        if (rig.partBounce !== undefined) rig.partBounce *= k
        rig.rim *= k
      }
      if (look.coax > 0) rig.key = { ...rig.key, el: Math.PI / 2 - 0.05, col: rig.key.col.map((v) => v * look.coax) as RGB }
      xl.scrCol = [0, 0, 0]
      xl.flip = 0
      xl.settle = s.film === true ? [SETTLE.frames / tl.totalFrames, SETTLE.gain] : [1, 0]
      xl.nearDim = nearDimAt(tl, p, W, H)
      const flipEnd = s.wake === undefined ? 0 : s.shots.find((k) => k.cut === true && k.t > (s.wake as number))?.t ?? 0
      if (s.film === true && chip !== undefined && s.wake !== undefined && lightAt(s.shots, p) === 'hero' && p < flipEnd) {
        const a0 = s.wake + FLIP.after / tl.totalFrames
        const a1 = Math.min(s.wake + (FLIP.after + FLIP.frames) / tl.totalFrames, flipEnd - FLIP.clear / tl.totalFrames)
        const u = Math.min(1, Math.max(0, (p - a0) / (a1 - a0)))
        const size = Math.max(chip.w, chip.h)
        const wide = FLIP.width * size
        const from = 0.5 * Math.hypot(chip.w, chip.h) + 2.5 * wide
        rig.sweep = [across[0] / wide, across[1] / wide, (across[0] * chip.x - across[1] * chip.y + from * (2 * u - 1)) / wide, p < a0 || p > a1 ? 0 : FLIP.gain, 1]
        xl.flip = SWEEP_REST.gain
      }
      if (look.scrim > 0) {
        const C: V3 = [0, 0, 0]
        let weight = 0
        for (const pt of s.parts) {
          if (pt.hero === true || pt.kind === 'pin') continue
          const d: V3 = [pt.x - cam.pos[0], -pt.y - cam.pos[1], pt.z - cam.pos[2]]
          const depth = d[0] * cam.f[0] + d[1] * cam.f[1] + d[2] * cam.f[2]
          if (depth <= 0) continue
          const qx = (d[0] * cam.r[0] + d[1] * cam.r[1] + d[2] * cam.r[2]) / (depth * cam.tanX)
          const qy = (d[0] * cam.u[0] + d[1] * cam.u[1] + d[2] * cam.u[2]) / (depth * cam.tanY)
          if (Math.abs(qx) > 1 || Math.abs(qy) > 1) continue
          const w = (pt.w * pt.h) / (depth * depth)
          C[0] += pt.x * w
          C[1] -= pt.y * w
          C[2] += pt.z * w
          weight += w
        }
        if (weight > 0) {
          const at: V3 = [C[0] / weight, C[1] / weight, C[2] / weight]
          const to: V3 = [at[0] - cam.pos[0], at[1] - cam.pos[1], at[2] - cam.pos[2]]
          const R = norm([to[0], to[1], -to[2]])
          const D = SCRIM.reach * Math.hypot(...to)
          const U = norm([R[1], -R[0], 0])
          let Vv = norm([U[1] * R[2] - U[2] * R[1], U[2] * R[0] - U[0] * R[2], U[0] * R[1] - U[1] * R[0]])
          if (Vv[2] < 0) Vv = [-Vv[0], -Vv[1], -Vv[2]]
          xl.scrC = [at[0] + R[0] * D, at[1] + R[1] * D, at[2] + R[2] * D]
          xl.scrU = U.map((v) => v * SCRIM.wide * D) as V3
          xl.scrV = Vv.map((v) => v * SCRIM.tall * D) as V3
          xl.scrCol = [look.scrim, look.scrim * 0.98, look.scrim * 0.95]
        }
      }
      if (quality.studio === 'high') Object.assign(rig, { ground: [0.74, 0.74, 0.72] as RGB, floorBase: 1.15, vignette: 0.12 })
      if (s.stage !== undefined && craning) {
        const st = s.stage
        rig.key = { az: fwd + st.key.az, el: st.key.el, col: rig.key.col.map((v) => v * st.key.gain) as RGB, size: st.key.size }
        rig.room *= st.fill
        if (rig.partRoom !== undefined) rig.partRoom *= st.fill
        rig.env = [rig.env[0] * st.fill, rig.env[1] * st.fill, rig.env[2] * st.fill, rig.env[3]]
        rig.bounce = (rig.bounce ?? 0) * st.fill
        rig.partBounce = (rig.partBounce ?? 0) * st.fill
        rig.box = (rig.box ?? 0) * st.fill
        rig.heroLit = st.hero
        rig.etch = 1
        rig.fall = st.fall
        rig.ground = linear(st.ground).map((v) => v * STUDIO) as RGB
      }
      const bareLid = s.bareLid !== undefined && p >= s.bareLid[0] && p < s.bareLid[1] ? Math.min(1, (s.bareLid[1] - p) / Math.max(1e-9, s.bareLid[1] - s.bareLid[2])) : 0
      const live = s.blink ?? (tl.style === 'trace' ? { at: liveLed(s.parts) ?? -1, from: s.acts.hold[0] } : undefined)
      const blink: [number, number] = live === undefined || p < live.from ? [-1, 1] : [live.at, 0.1 + 0.9 * ease((Math.cos((2 * Math.PI * (p - live.from) * tl.totalFrames) / (BLINK * tl.fps)) + 0.25) / 0.5)]
      ledLights.c.fill(0)
      if (lit || s.power === 'routes') {
        s.parts.filter((pt) => pt.led !== undefined && pt.led.at >= 0 && p >= pt.led.at).slice(0, 12).forEach((pt, i) => {
          const at = pt.led?.at ?? 0
          const out = pt.led?.off === undefined ? 1 : 1 - ease((p - pt.led.off) / (2 / tl.totalFrames))
          ledLights.p.set([pt.x, -pt.y, pt.z * 0.8, (s.power === 'lamps' ? 1.4 - 0.3 * (1 - lift) : s.power === 'routes' ? 0.9 : 1.4) * Math.max(pt.w, pt.h) * look.ledReach], i * 4)
          ledLights.c.set([...linear(pt.led?.color ?? '#ffffff').map((v) => v * look.led * LED_THROW * (pt.led?.gain ?? 1) * (s.power === 'lamps' ? 0.4 + 0.5 * pale : 1)), ease((p - at) / (4 / tl.totalFrames)) * out * (at === blink[0] ? blink[1] : 1)], i * 4)
        })
      }
      const dark = (s.power === 'pulse' || s.power === 'lamps') && !s.parts.some((pt) => pt.led !== undefined && pt.led.at >= 0)
      if (dark) {
        const up = 1 + 0.18 * ease((p - (acts.power[0] + 4 / 24)) / (1 / 24))
        rig.key = { ...rig.key, col: rig.key.col.map((v) => v * up) as RGB }
      }
      const keyEnv = 1 - (leds ? 0.4 : lit ? 0 : 0.1) * ease((p - acts.power[0]) / (18 / tl.totalFrames)) * (1 - lift)
      if (keyEnv < 1 - 1e-6) {
        rig.key = { ...rig.key, col: rig.key.col.map((v) => v * keyEnv) as RGB }
        rig.box = (rig.box ?? 0) * keyEnv
        rig.strip = { ...rig.strip, gain: rig.strip.gain * keyEnv }
      }
      const firstLamp = s.power === 'lamps' ? Math.min(...s.parts.flatMap((pt) => (pt.led !== undefined && pt.led.at >= 0 ? [pt.led.at] : []))) : Infinity
      const bloomHold = Number.isFinite(firstLamp) ? ease((p - firstLamp) / (8 / tl.totalFrames)) * (1 - lift) : 0
      if (Number.isFinite(firstLamp)) {
        const stop = 1 - LAMP_DIM * ease((p - firstLamp) / (8 / tl.totalFrames)) * (1 - lift)
        rig.room *= stop
        if (rig.partRoom !== undefined) rig.partRoom *= stop
        rig.key = { ...rig.key, col: rig.key.col.map((v) => v * stop) as RGB }
        rig.box = (rig.box ?? 0) * stop
        rig.env = [rig.env[0] * stop, rig.env[1] * stop, rig.env[2] * stop, rig.env[3]]
        rig.strip = { ...rig.strip, gain: rig.strip.gain * stop }
        if (rig.ground !== undefined) rig.ground = rig.ground.map((v) => v * stop) as RGB
      }
      const darkBoard = 1 - Math.min(1, pale / 0.5)
      const ending = lit ? ease((p - acts.power[0]) / (18 / tl.totalFrames)) : 0
      const boost = 1 + darkBoard * ((p >= 8 / 24 ? 0.5 : 0) + 0.5 * ending * (leds ? 1 : 1 - lift))
      if (boost > 1) {
        rig.key = { ...rig.key, col: rig.key.col.map((v) => v * boost) as RGB }
        rig.box = (rig.box ?? 0) * boost
      }
      if (ending > 0 && darkBoard > 0) {
        const lift2 = 1 + 1.2 * darkBoard * ending * (1 - lift)
        rig.floorBase = (rig.floorBase ?? 0.06) * lift2
        if (rig.ground !== undefined) rig.ground = rig.ground.map((v) => v * lift2) as RGB
      }
      const goldBox = (i: number): [number, number, number, number] => s.gold?.[i] ?? [0, 0, -1, -1]
      const band = [0, 1, 0] as const
      const centre = { x: extent.x + extent.w / 2, y: extent.y + extent.h / 2 }
      const poolAt = [s.origin.x, -s.origin.y, reach] as const
      const diag = Math.hypot(extent.w, extent.h)
      const floorZ = -Math.max(1.5, m.thicknessPx) - 0.5
      const keyAz = rig.key.az
      const reachOut = lift / Math.tan(Math.max(0.2, rig.key.el))
      drawMaps(maps, tl, p, region, { all: look.allLit, hero: look.heroLit }, craning ? { x: -Math.cos(keyAz) * reachOut, y: Math.sin(keyAz) * reachOut } : undefined)
      upload(0, maps.top)
      upload(1, maps.surf)
      upload(2, maps.fx)

      const fall = fallHeight(s.shots, W, H, 6 * m.pxPerMm)
      let frameMid = p
      const boardC = [s.parts.reduce((sum, pt) => sum + pt.x, 0) / Math.max(1, s.parts.length), -s.parts.reduce((sum, pt) => sum + pt.y, 0) / Math.max(1, s.parts.length)] as const
      const drawScene = (c: Cam, q: number, mode: 'main' | 'mirror' | 'shadow' = 'main'): void => {
        airborne.b.fill(0)
        s.parts
          .filter((pt) => pt.hero !== true && pt.kind !== 'pin' && (pt.t - q) / (pt.fall ?? 1) > 0 && (pt.t - q) / (pt.fall ?? 1) <= 1)
          .sort((a, b) => b.w * b.h - a.w * a.h)
          .slice(0, 24)
          .forEach((pt, i) => {
            const u = (pt.t - q) / (pt.fall ?? 1)
            const k = u * u * (3 - 2 * u)
            airborne.a.set([pt.x + k * (pt.enter?.x ?? 0), -(pt.y + k * (pt.enter?.y ?? 0)), pt.w / 2, pt.h / 2], i * 4)
            airborne.b.set([pt.rot, k * (pt.lift ?? fall), pt.z, 0], i * 4)
          })
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
        // the studio floor: light pool, contact shadow, spill and the board's reflection
        if (!tl.transparent && mode === 'main') {
          tex(7, floorRefl.tex)
          tex(0, mapTex[1] as WebGLTexture)
          tex(1, mapTex[0] as WebGLTexture)
          tex(2, mapTex[2] as WebGLTexture)
          const fr = diag * 40
          P.floor.use().m4('uVP', c.vp).f('uRegion', centre.x - fr, centre.y - fr, fr * 2, fr * 2).f('uZ', floorZ)
            .i('tSurf', 0).i('tTop', 1).i('tFx', 2).f('uMap', ...regionV).f('uCentre', centre.x, centre.y).f('uSpread', diag * 0.75)
            .f('uPool', rig.pool * (1 + 1.8 * (1 - Math.min(1, Math.pow(maskLuma, 1 / 2.2) / 0.5))))
            .v3('uWarm', warmC).v3('uCool', coolC).f('uKeyDir', Math.cos(keyAz), Math.sin(keyAz), 0)
            .v3('uGround', rig.ground ?? [0, 0, 0]).f('uGroundOn', rig.ground === undefined ? 0 : rig.groundOn ?? 1).f('uFloorBase', rig.floorBase ?? 0.06).f('uFwd', Math.cos(fwd), Math.sin(fwd)).f('uReach', diag * 0.5)
            .v3('uReflCol', maskLin.map((v) => v * 1.2 + 0.01)).f('uReflLod', Math.max(0, Math.log2((4 * Math.max(1.5, m.thicknessPx)) / (region.w / MW)))).f('uEnergy', energyGain)
            .i('tMirror', 7).f('uMirrorOn', mirrored ? 1 : 0).f('uRes', W, H).v3('uEye', c.pos)
          g.drawArrays(g.TRIANGLE_STRIP, 0, 4)
        }
        if (wallCount > 0 && mode !== 'shadow') {
          // the board's edge: laminate with a copper line per layer
          g.enable(g.DEPTH_TEST)
          g.depthMask(true)
          g.bindBuffer(g.ARRAY_BUFFER, wallBuf)
          const loc = g.getAttribLocation(P.wall.p, 'aWall')
          g.enableVertexAttribArray(loc)
          g.vertexAttribPointer(loc, 4, g.FLOAT, false, 0, 0)
          P.wall.use().m4('uVP', c.vp).f('uThick', Math.max(1.5, m.thicknessPx)).f('uZ', 0)
            .v3('uSub', linear(m.substrate)).v3('uCopper', copper).v3('uMask', maskLin).f('uLayers', Math.max(1, s.layers.length)).f('uMaskOn', maskSpan).f('uEdgeFill', 0.6 * lift * Math.min(1, Math.max(0, (0.3 - pale) / 0.15)))
          lighting(P.wall, c, rig, fwd, band, poolAt)
          g.drawArrays(g.TRIANGLES, 0, wallCount)
          g.disableVertexAttribArray(loc)
        }
        g.enable(g.DEPTH_TEST)
        g.depthFunc(g.LEQUAL)
        g.depthMask(true)
        if (mode === 'main') {
        tex(0, mapTex[0] as WebGLTexture)
        tex(1, mapTex[1] as WebGLTexture)
        tex(2, mapTex[2] as WebGLTexture)
        tex(7, maskRefl.tex)
        P.top.use().m4('uVP', c.vp).i('tMirror', 7).f('uMirrorOn', mirrored ? 1 : 0).f('uRes', W, H).f('uRegion', ...regionV).f('uZ', 0)
          .f('uGold0', ...goldBox(0)).f('uGold1', ...goldBox(1)).f('uGold2', ...goldBox(2)).f('uGold3', ...goldBox(3)).i('tTop', 0).i('tSurf', 1).i('tFx', 2)
          .f('uTexel', ...texel).v3('uCopper', copper).v3('uFinish', linear(m.finish)).v3('uMask', maskLin)
          .v3('uSub', linear(m.substrate)).v3('uSilk', linear(m.silk)).v3('uWarm', warmC).v3('uCool', coolC)
          .f('uFinishRough', m.finishRough).f('uMaskFront', maskFront).f('uMaskDir', maskDir[0], maskDir[1]).f('uMaskSoft', soft).f('uMaskOn', maskOn).f('uMaskLuma', Math.pow(maskLuma, 1 / 2.2)).f('uMaskKeep', (rig.maskKeep ?? 0) * (1 - Math.pow(maskLuma, 1 / 2.2))).f('uKeepCu', rig.keepCu ?? 0).f('uFrontGain', rig.frontGain ?? 1)
          .f('uCured', span([acts.mask[1], acts.mask[1] + 0.04])).f('uSolder', span(acts.reflow)).f('uFinishOn', span([(acts.mask[0] + acts.mask[1]) / 2, acts.mask[1]]))
          .f('uEnergy', energyGain).f('uFlare', p >= acts.power[0] && !leds && s.power !== 'lamps' ? 1.6 : 0).f('uPxPerMm', m.pxPerMm).f('uBump', 1.6)
          .f('uOrigin', s.origin.x, s.origin.y).f('uDark', rig.dark).f('uHeat', (rig.heat ?? 0.6) * xl.look.heat).f('uLip', rig.lip ?? 0).f('uFwd', Math.cos(fwd), Math.sin(fwd)).f('uThick', Math.max(1.5, m.thicknessPx)).f('uSpan', region.w, region.h)
          .f('uLamp', valve !== undefined ? valve.x : lamp?.x ?? 0, valve !== undefined ? valve.y : lamp?.y ?? 0, valve !== undefined ? 0.75 * Math.max(valve.w, valve.h) : lamp === undefined ? 1 : 2.5 * Math.max(lamp.w, lamp.h), valve !== undefined && s.sign !== undefined ? 0.07 * ease((p - s.sign.t) / (3 / 24)) : lamp === undefined || lit ? 0 : 0.09 * ease((p - (lamp.led?.at ?? 1)) / (7 / 360)) * (1 - 0.7 * ease((p - acts.power[0]) / (2 / 24)))).v3('uLampCol', valve !== undefined ? linear('#ff8a3a') : lamp?.led === undefined ? [0, 0, 0] : linear(lamp.led.color))
        lighting(P.top, c, rig, fwd, band, poolAt)
        g.drawArrays(g.TRIANGLE_STRIP, 0, 4)
        }
        if (boxCount + roundCount + valveCount + meshDraws.length > 0) {
          // bodies: opaque, depth-tested, sampled at the subframe's own time so falls blur
          g.disable(g.BLEND)
          g.bindBuffer(g.ARRAY_BUFFER, partBuf)
          const stride = 24 * 4
          const locs = ['aBox', 'aMeta', 'aLabel', 'aLed', 'aFall', 'aEnter'].map((n) => g.getAttribLocation(P.part.p, n))
          const point = (first: number): void => {
            for (const [i, loc] of locs.entries()) {
              g.enableVertexAttribArray(loc)
              g.vertexAttribPointer(loc, 4, g.FLOAT, false, stride, first * stride + i * 16)
              g.vertexAttribDivisor(loc, 1)
            }
          }
          tex(0, atlasTex)
          tex(3, mapTex[0] as WebGLTexture)
          tex(4, mapTex[2] as WebGLTexture)
          const glowGain = energyGain * (s.power === 'pulse' || s.power === 'lamps' ? 0 : 0.45) * (p >= acts.power[0] ? 1 : 0)
          P.part.use().f('uBareLid', bareLid).f('uBoardC', boardC[0], boardC[1]).i('tGlowA', 3).i('tGlowB', 4).f('uMapR', ...regionV).v3('uWarmL', warmC).v3('uCoolL', coolC).f('uGlow', glowGain).m4('uVP', c.vp).f('uP', q).f('uBlink', ...blink).f('uDur', tl.durationSeconds).f('uFall', fall).f('uMid', frameMid).f('uCast', mode === 'shadow' ? 1 : 0).i('uShadowPass', mode === 'shadow' ? 1 : 0)
            .i('tAtlas', 0).f('uCell', 1 / ATLAS_COLS, 1 / ATLAS_ROWS).v3('uFinish', linear(m.finish))
            .f('uHeat', s.sign?.kind === 'heater' ? span([s.sign.t, s.sign.t + 3 / 24]) : span([acts.power[1], acts.power[1] + 1 / 24]))
          lighting(P.part, c, rig, fwd, band, poolAt)
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
          for (const loc of locs) {
            g.vertexAttribDivisor(loc, 0)
            g.disableVertexAttribArray(loc)
          }
          if (meshDraws.length > 0) {
            P.mesh.use().f('uBareLid', bareLid).i('tGlowA', 3).i('tGlowB', 4).f('uMapR', ...regionV).v3('uWarmL', warmC).v3('uCoolL', coolC).f('uGlow', glowGain).m4('uVP', c.vp).f('uP', q).f('uBlink', ...blink).f('uDur', tl.durationSeconds).f('uFall', fall).f('uMid', frameMid).f('uCast', mode === 'shadow' ? 1 : 0).i('uShadowPass', mode === 'shadow' ? 1 : 0).f('uBoardC', boardC[0], boardC[1])
              .i('tAtlas', 0).f('uCell', 1 / ATLAS_COLS, 1 / ATLAS_ROWS)
            lighting(P.mesh, c, rig, fwd, band, poolAt)
            const vertex = ([['aPos', 3, g.FLOAT, false], ['aNor', 3, g.BYTE, true], ['aCol', 3, g.UNSIGNED_BYTE, true]] as const).map(([n, size, type, normalized]) => ({ loc: g.getAttribLocation(P.mesh.p, n), size, type, normalized }))
            const perPart = ['aAff', 'aBox', 'aMeta', 'aLabel', 'aLed', 'aFall', 'aEnter'].map((n) => g.getAttribLocation(P.mesh.p, n))
            for (const d of meshDraws) {
              if (d.parts === 0) continue
              for (const [i, a] of vertex.entries()) {
                g.bindBuffer(g.ARRAY_BUFFER, [d.pos, d.nor, d.col][i] as WebGLBuffer)
                g.enableVertexAttribArray(a.loc)
                g.vertexAttribPointer(a.loc, a.size, a.type, a.normalized, 0, 0)
              }
              g.bindBuffer(g.ARRAY_BUFFER, d.inst)
              for (const [i, loc] of perPart.entries()) {
                g.enableVertexAttribArray(loc)
                g.vertexAttribPointer(loc, 4, g.FLOAT, false, 28 * 4, i * 16)
                g.vertexAttribDivisor(loc, 1)
              }
              g.bindBuffer(g.ELEMENT_ARRAY_BUFFER, d.idx)
              P.mesh.f('uMin', ...d.min).f('uMax', ...d.max).f('uTop', ...d.top)
              g.drawElementsInstanced(g.TRIANGLES, d.count, g.UNSIGNED_INT, 0, d.parts)
            }
            for (const loc of perPart) {
              g.vertexAttribDivisor(loc, 0)
              g.disableVertexAttribArray(loc)
            }
            for (const a of vertex) g.disableVertexAttribArray(a.loc)
          }
          if (valveCount > 0 && mode !== 'shadow') {
            g.bindBuffer(g.ARRAY_BUFFER, partBuf)
            P.part.use()
            for (const [i, loc] of locs.entries()) {
              g.enableVertexAttribArray(loc)
              g.vertexAttribDivisor(loc, 1)
              g.vertexAttribPointer(loc, 4, g.FLOAT, false, stride, (boxCount + roundCount) * stride + i * 16)
            }
            // glass: blended over everything drawn so far, without hiding what is behind it
            g.enable(g.BLEND)
            g.blendFunc(g.ONE, g.ONE_MINUS_SRC_ALPHA)
            P.part.i('uRound', 1).f('uSlow', 1).f('uFall', 1.15 * Math.max(...s.parts.filter((pt) => pt.kind === 'valve').map((pt) => pt.z)))
            g.depthMask(false)
            g.drawArraysInstanced(g.TRIANGLES, 0, 24 * 9, valveCount)
            g.colorMask(false, false, false, false)
            g.depthMask(true)
            P.part.i('uDepthOnly', 1)
            g.drawArraysInstanced(g.TRIANGLES, 0, 24 * 9, valveCount)
            P.part.i('uDepthOnly', 0).f('uSlow', 0)
            g.colorMask(true, true, true, true)
            g.disable(g.BLEND)
            for (const loc of locs) {
              g.vertexAttribDivisor(loc, 0)
              g.disableVertexAttribArray(loc)
            }
          }
          g.enable(g.BLEND)
        }
        g.disable(g.DEPTH_TEST)
        g.depthMask(false)
      }

      // motion blur: up to a 180° shutter slid inside the current shot and shortened so nothing smears past 1.2% of W; maps hold per frame
      const blur = blurAt(tl, p, W, H, extent, look.shutter)
      const plan = sweep > 1 ? { n: sweep, even: false } : blurPlan(blur.smear, Math.max(1, quality.samples ?? quality.subframes), quality.samples !== undefined)
      const n = plan.n
      const shutter = sweep > 1 ? open * shut : blur.shutter
      const keyDir = (az: number, el: number): V3 => [Math.cos(az) * Math.cos(el), Math.sin(az) * Math.cos(el), Math.sin(el)]
      const key0 = keyDir(rig.key.az, rig.key.el)
      const lift0 = (tl.style === 'trace' || s.parts.some((pt) => pt.t > p - open) ? fall : 0) + tallest
      const casters: Array<[number, number, number]> = [[region.x, region.y], [region.x + region.w, region.y], [region.x, region.y + region.h], [region.x + region.w, region.y + region.h]]
        .flatMap(([x, y]) => [0, lift0].map((z): [number, number, number] => [x as number, -(y as number), z]))
      const shadowInto = (t: Target, dir: V3, q: number): Float32Array => {
        const vp = orthoLight(dir, casters)
        tex(5, dummyDepth)
        tex(6, dummyDepth)
        bind(t)
        g.enable(g.POLYGON_OFFSET_FILL)
        g.polygonOffset(1.5, 4)
        g.colorMask(false, false, false, false)
        drawScene({ ...cam, vp, pos: [cam.pos[0] + dir[0] * 1e6, cam.pos[1] + dir[1] * 1e6, cam.pos[2] + dir[2] * 1e6] }, q, 'shadow')
        g.colorMask(true, true, true, true)
        g.disable(g.POLYGON_OFFSET_FILL)
        tex(5, keyShadow.z as WebGLTexture)
        tex(6, skyShadow.z as WebGLTexture)
        return vp
      }
      const keyAxes = ((): [V3, V3] => {
        const t1 = norm([-key0[1], key0[0], 0])
        return [t1, norm([key0[1] * t1[2] - key0[2] * t1[1], key0[2] * t1[0] - key0[0] * t1[2], key0[0] * t1[1] - key0[1] * t1[0]])]
      })()
      const keyPoints = (i: number, of: number): V3[] => [0, 1, 2, 3].map((j) => {
        const m = i * 4 + j
        const r = (rig.key.size ?? KEY_SIZE) * Math.sqrt((m + 0.5) / (4 * of))
        const a = m * 2.399963
        return norm([0, 1, 2].map((c) => (key0[c] as number) + r * (Math.cos(a) * (keyAxes[0][c] as number) + Math.sin(a) * (keyAxes[1][c] as number))) as V3)
      })
      const keyInto = (dirs: V3[], q: number): Float32Array => {
        const out = new Float32Array(64)
        tex(5, dummyDepth)
        tex(6, dummyDepth)
        bind(keyShadow)
        g.enable(g.SCISSOR_TEST)
        g.enable(g.POLYGON_OFFSET_FILL)
        g.polygonOffset(1.5, 4)
        g.colorMask(false, false, false, false)
        dirs.forEach((dir, k) => {
          const x = (k % 2) * SHADOW
          const y = Math.floor(k / 2) * SHADOW
          g.viewport(x, y, SHADOW, SHADOW)
          g.scissor(x, y, SHADOW, SHADOW)
          const vp = orthoLight(dir, casters)
          out.set(vp, k * 16)
          drawScene({ ...cam, vp, pos: [cam.pos[0] + dir[0] * 1e6, cam.pos[1] + dir[1] * 1e6, cam.pos[2] + dir[2] * 1e6] }, q, 'shadow')
        })
        g.colorMask(true, true, true, true)
        g.disable(g.POLYGON_OFFSET_FILL)
        g.disable(g.SCISSOR_TEST)
        tex(5, keyShadow.z as WebGLTexture)
        tex(6, skyShadow.z as WebGLTexture)
        return out
      }
      const texelWorld = Math.max(region.w, region.h) / SHADOW
      shadow.bias = [1.5 * texelWorld, 0.0002]
      const boxAt = (c: Cam): void => {
        const gain = rig.box ?? 0
        const back = Math.hypot(c.f[0], c.f[1]) > 0.1 ? [-c.f[0], -c.f[1]] : [-c.u[0], -c.u[1]]
        const len = Math.max(1e-6, Math.hypot(back[0] as number, back[1] as number))
        const along: V3 = [-(back[0] as number) / len, -(back[1] as number) / len, 0]
        const el = Math.asin(Math.min(0.99, Math.max(0.05, -c.f[2]))) + (rig.boxLift ?? 0.12)
        const dirB: V3 = [along[0] * Math.cos(el), along[1] * Math.cos(el), Math.sin(el)]
        const reachB = 2.2 * diag
        const target: V3 = [centre.x, -centre.y, 0]
        const across: V3 = [-along[1], along[0], 0]
        const up = norm([-dirB[0] * dirB[2], -dirB[1] * dirB[2], 1 - dirB[2] * dirB[2]])
        shadow.boxC = [target[0] + dirB[0] * reachB, target[1] + dirB[1] * reachB, target[2] + dirB[2] * reachB]
        shadow.boxU = across.map((v) => v * 0.26 * reachB) as V3
        shadow.boxV = up.map((v) => v * 0.035 * reachB) as V3
        shadow.boxCol = [gain, gain * 0.985, gain * 0.96]
      }
      const mirrored = n > 1 && !tl.transparent
      if (mirrored) {
        const mirror = (c: Cam, h: number): Cam => {
          const vp = new Float32Array(c.vp)
          for (let r = 0; r < 4; r++) {
            vp[12 + r] = (c.vp[12 + r] as number) + 2 * h * (c.vp[8 + r] as number)
            vp[8 + r] = -(c.vp[8 + r] as number)
          }
          return { ...c, vp, pos: [c.pos[0], c.pos[1], 2 * h - c.pos[2]] }
        }
        shadow.light = keyInto(keyPoints(0, 1), p)
        shadow.skyOn = 0
        boxAt(cam)
        bind(maskRefl)
        drawScene(mirror(cam, 0), p, 'mirror')
        g.bindTexture(g.TEXTURE_2D, maskRefl.tex)
        g.generateMipmap(g.TEXTURE_2D)
        bind(floorRefl)
        drawScene(mirror(cam, floorZ), p, 'mirror')
        g.bindTexture(g.TEXTURE_2D, floorRefl.tex)
        g.generateMipmap(g.TEXTURE_2D)
      }
      if (n === 1) {
        shadow.light = keyInto(keyPoints(0, 1), p)
        shadow.skyOn = 0
        boxAt(cam)
        bind(accum)
        drawScene(cam, p)
      } else if (quality.samples === undefined || sweep > 1) {
        const [ta, tb] = shotSpan(s.shots, p)
        shadow.light = keyInto(keyPoints(0, 1), p)
        shadow.skyOn = 0
        boxAt(cam)
        bind(accum)
        g.clearColor(0, 0, 0, 0)
        g.clear(g.COLOR_BUFFER_BIT)
        for (let i = 0; i < n; i++) {
          const mid = Math.min(tb - 1e-7 - shutter / 2, Math.max(ta + shutter / 2, p))
          frameMid = mid
          const q = Math.min(tb - 1e-7, Math.max(ta, mid + ((i + 0.5) / n - 0.5) * shutter))
          shadow.light = keyInto(keyPoints(i, n), q)
          bind(scene)
          drawScene(makeCam(handheld(tl, q), W, H), q)
          bind(accum)
          g.enable(g.BLEND)
          g.blendFunc(g.ONE, g.ONE)
          tex(0, scene.tex)
          P.copy.use().i('t', 0).f('uW', 1 / n)
          quad()
          if (passEnds(i, n)) yield
        }
      } else {
        // lens, pixel, key, sky and shutter jittered together on one R-sequence (Roberts), rotated per frame; a frame that would step takes even shutter times
        const [ta, tb] = shotSpan(s.shots, p)
        const mid = Math.min(tb - 1e-7 - shutter / 2, Math.max(ta + shutter / 2, p))
        frameMid = mid
        const turn = R_ALPHA.map((_, j) => fract(Math.sin((frame + 1) * 12.9898 + j * 78.233) * 43758.5453))
        bind(accum)
        g.clearColor(0, 0, 0, 0)
        g.clear(g.COLOR_BUFFER_BIT)
        for (let i = 0; i < n; i++) {
          const u = R_ALPHA.map((a, j) => fract((turn[j] as number) + (i + 1) * a))
          const q = Math.min(tb - 1e-7, Math.max(ta, mid + ((plan.even ? fract((turn[0] as number) + (i + 0.5) / n) : (u[0] as number)) - 0.5) * shutter))
          const cq = makeCam(handheld(tl, q), W, H)
          const lens = disk(u[3] as number, u[4] as number)
          const radius = 0.0241 * cq.aperture * cq.focus
          const cl = lensCam(cq, lens[0] * radius, lens[1] * radius, ((u[1] as number) - 0.5) * (2 / W), ((u[2] as number) - 0.5) * (2 / H))
          shadow.light = keyInto(keyPoints(i, n), q)
          const r2 = Math.sqrt(u[7] as number)
          const phi = 2 * Math.PI * (u[8] as number)
          const sky = norm([r2 * Math.cos(phi), r2 * Math.sin(phi), Math.max(0.25, Math.sqrt(1 - (u[7] as number)))])
          shadow.sky = shadowInto(skyShadow, sky, q)
          shadow.skyOn = 1
          boxAt(cq)
          bind(scene)
          drawScene(cl, q)
          bind(accum)
          g.enable(g.BLEND)
          g.blendFunc(g.ONE, g.ONE)
          tex(0, scene.tex)
          P.copy.use().i('t', 0).f('uW', 1 / n)
          quad()
          if (passEnds(i, n)) yield
        }
      }
      g.disable(g.BLEND)

      if (matte) {
        bind(scene)
        drawScene(cam, p, 'main')
        bind(null)
        g.disable(g.BLEND)
        g.disable(g.DEPTH_TEST)
        tex(1, scene.z as WebGLTexture)
        P.matte.use().i('tZ', 1).m4('uInv', invert4(cam.vp)).f('uTall', Math.max(1e-6, tallest))
        quad()
        g.finish()
        return canvas
      }

      // depth of field focused on the look-at point; with a jittered lens it only fills between the lens samples
      bind(dof)
      tex(0, accum.tex)
      const zSource = n === 1 ? accum.z : scene.z
      if (zSource !== undefined) tex(1, zSource)
      const fill = quality.samples !== undefined && n > 1 ? 1.9 / Math.sqrt(n) : 1
      P.dof.use().i('t', 0).i('tZ', 1).i('uHasZ', zSource === undefined ? 0 : 1).f('uNearFar', cam.dist * 0.02, cam.dist * 20).f('uRes', W, H).v3('uCam', cam.pos).v3('uF', cam.f).v3('uR', cam.r).v3('uU', cam.u)
        .f('uTan', cam.tanX, cam.tanY).f('uShift', cam.shift).f('uFocus', cam.focus)
        .f('uAperture', fill * cam.aperture * 0.045 * H * (Math.tan(Math.PI / 12) / cam.tanY)).f('uMaxR', 0.022 * H).f('uFog', look.haze / cam.dist, cam.dist * HAZE.from, HAZE.col, 0)
      quad()

      // bloom pyramid on what's above white, and a horizontal streak
      bind(pyramid[0] as Target)
      tex(0, dof.tex)
      P.bright.use().i('t', 0).f('h', 0.5 / W, 0.5 / H)
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
      g.blendFunc(g.CONSTANT_ALPHA, g.ONE)
      for (let i = pyramid.length - 1; i > 0; i--) {
        const src = pyramid[i] as Target
        g.blendColor(0, 0, 0, i >= 3 ? 0.3 * (1 - 0.87 * bloomHold) : 0.8)
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
      const bg = quality.studio === 'high' ? [0.62, 0.62, 0.6] : [0, 0, 0]
      P.final.use().i('tCol', 0).i('tBloom', 1).i('tStreak', 2)
        .f('uBloom', (0.55 * pal.bloom + 0.15) * look.bloom).f('uStreak', 0.07 * Math.exp(-((((p - acts.power[0] - 3 / tl.totalFrames) * tl.totalFrames) / 12) ** 2))).v3('uStreakTint', coolC)
        .i('uTone', quality.tonemap === 'aces' ? 0 : quality.tonemap === 'agx' ? 2 : 1).f('uExposure', 1.32).f('uCA', 0).f('uFrame', frame).i('uGrain', tl.transparent ? 0 : 1)
        .i('uTransparent', tl.transparent ? 1 : 0).v3('uBg', bg).f('uVignette', rig.vignette)
      g.clearColor(0, 0, 0, 0)
      g.clear(g.COLOR_BUFFER_BIT)
      quad()
      g.finish()

      return canvas
    }
  }
  const frameOut = (tl: TraceTimeline, frame: number, matte: boolean, sweep = 1, shut = 1): HTMLCanvasElement => {
    const steps = frameSteps(tl, frame, matte, sweep, shut)
    for (;;) {
      const step = steps.next()
      if (step.done === true) return step.value
    }
  }
  return {
    renderAsync: async (tl, frame) => {
      const steps = frameSteps(tl, frame, false)
      for (;;) {
        const step = steps.next()
        if (step.done === true) return step.value
        g.finish()
        await new Promise((go) => setTimeout(go, 0))
      }
    },
    render: (tl, frame, sweep, shut) => frameOut(tl, frame, false, sweep, shut),
    matte: (tl, frame) => frameOut(tl, frame, true),
    dispose(): void {
      g.getExtension('WEBGL_lose_context')?.loseContext()
    }
  }
}

/**
 * How high every part starts its descent: from the place shot's middle camera, the height whose drop
 * spans 15% of the frame's height on screen, so even a large part's landing is a visible travel.
 */
export function fallHeight(shots: CameraShot[], W: number, H: number, least: number): number {
  const place = shots.findIndex((k) => k.light === 'place' || k.light === 'skyline' || k.light === 'stage')
  if (place < 0) return least
  const a = (shots[place] as CameraShot).t
  const b = shots.slice(place + 1).find((k) => k.cut === true)?.t ?? 1
  const cam = makeCam(sampleShot(shots, (a + b) / 2), W, H)
  const sinE = Math.min(1, Math.max(0, cam.pos[2] / cam.dist))
  const cosE = Math.sqrt(1 - sinE * sinE)
  return Math.max(least, (0.15 * 2 * cam.focus * cam.tanY) / Math.max(0.35, cosE))
}

function boardGain(shot: HTMLCanvasElement, tl: TraceTimeline, W: number, H: number): number {
  const s = tl.scene
  const w = Math.round(W / 4)
  const h = Math.round(H / 4)
  const cam = makeCam(handheld(tl, (tl.totalFrames - 1) / tl.totalFrames), W, H)
  const look = document.createElement('canvas')
  look.width = w
  look.height = h
  const lc = look.getContext('2d', { willReadFrequently: true })
  const mask = document.createElement('canvas')
  mask.width = w
  mask.height = h
  const mc = mask.getContext('2d', { willReadFrequently: true })
  if (lc === null || mc === null) return 1
  lc.drawImage(shot, 0, 0, w, h)
  const px = (x: number, y: number, z: number): [number, number] => {
    const q = project(cam, x, y, z)
    return [(q.x * 0.5 + 0.5) * w, (0.5 - q.y * 0.5) * h]
  }
  mc.fillStyle = '#fff'
  mc.beginPath()
  for (const loop of s.board) {
    for (let i = 0; i + 1 < loop.length; i += 2) {
      const [x, y] = px(loop[i] as number, loop[i + 1] as number, 0)
      if (i === 0) mc.moveTo(x, y)
      else mc.lineTo(x, y)
    }
    mc.closePath()
  }
  mc.fill('evenodd')
  mc.fillStyle = '#000'
  for (const part of s.parts) {
    if (part.kind === 'pin') continue
    const c = Math.cos(part.rot)
    const sn = Math.sin(part.rot)
    const pts: Array<[number, number, number]> = []
    for (const z of [0, part.z]) for (const [u, v] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) pts.push([part.x + ((u * part.w) / 2) * c - ((v * part.h) / 2) * sn, part.y + ((u * part.w) / 2) * sn + ((v * part.h) / 2) * c, z])
    const hull = silhouette(cam, pts, W, H).map(([x, y]): [number, number] => [(x * w) / W, (y * h) / H])
    mc.beginPath()
    for (const [x, y] of hull) mc.lineTo(x, y)
    mc.fill()
  }
  const img = lc.getImageData(0, 0, w, h).data
  const sel = mc.getImageData(0, 0, w, h).data
  let sum = 0
  let n = 0
  for (let i = 0; i < img.length; i += 4) {
    if ((sel[i] as number) < 128) continue
    sum += (0.2126 * (img[i] as number) + 0.7152 * (img[i + 1] as number) + 0.0722 * (img[i + 2] as number)) / 255
    n++
  }
  if (n < 50) return 1
  return Math.pow(maskExposure(s.material.mask) / Math.max(0.02, sum / n), 2.2)
}

/** the end frame's mean board luma for a mask colour: a white mask stays white, a black one stays black, colours sit between */
export function maskExposure(mask: string): number {
  const lin = linear(mask)
  const pale = Math.pow(0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2], 1 / 2.2)
  const stops: Array<[number, number]> = [[0.08, 0.23], [0.21, 0.37], [0.35, 0.41], [0.85, 0.67]]
  const i = stops.findIndex(([x]) => x >= pale)
  if (i <= 0) return (stops[i < 0 ? stops.length - 1 : 0] as [number, number])[1]
  const [x0, y0] = stops[i - 1] as [number, number]
  const [x1, y1] = stops[i] as [number, number]
  return y0 + ((y1 - y0) * (pale - x0)) / (x1 - x0)
}
