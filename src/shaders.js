export const FULLSCREEN_VS = `#version 300 es
precision highp float;
out vec2 vUv;

void main() {
  // Fullscreen triangle from vertex ID (0, 1, 2)
  float x = float((gl_VertexID & 1) << 2) - 1.0;
  float y = float((gl_VertexID & 2) << 1) - 1.0;
  vUv = vec2(x, y) * 0.5 + 0.5;
  gl_Position = vec4(x, y, 0.0, 1.0);
}
`;

export const RAYMARCH_FS = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;

in vec2 vUv;
out vec4 fragColor;

uniform vec2 uResolution;
uniform float uTime;

// 32-bit float (R32F) 2D SDF for "hydrogen" + 16-bit half-float (RGBA16F) frost micro-facet texture
uniform sampler2D uSdfTex;
uniform sampler2D uFrostTex;
uniform vec2 uSdfWorldSize;
uniform ivec2 uSdfTexSize;
uniform int uSdfLinear;

// Camera
uniform vec3 uCamPos;
uniform vec3 uCamRight;
uniform vec3 uCamUp;
uniform vec3 uCamForward;
uniform float uCamFov;

// Optical
uniform float uIor;
uniform float uDispersion;
uniform float uAbsorption;
uniform vec3 uTint;
uniform float uFresnel;
uniform float uEtchGlow;

// Frost
uniform float uFrost;
uniform float uFrostScale;
uniform float uEtchFrost;

// Light & Environment
uniform vec3 uLightDir;
uniform vec3 uLightColor;
uniform float uLightIntensity;
uniform int uEnvTheme;

// Interaction
uniform vec3 uClickRayDir;
uniform float uClickTime;

// Volume & Core
uniform int uShape;
uniform float uRippleAmp;
uniform float uRippleSpeed;
uniform float uEtchScale;
uniform float uEtchDepth;
uniform float uCaustics;

const float FLOOR_Y = -0.76;
const float MAX_DIST = 26.0;
const float SURF_EPS = 0.0008;

// -----------------------------------------------------------------------------
// 32-bit R32F SDF Sampling (Hardware LINEAR when OES_texture_float_linear is
// available, else exact manual bilinear via texelFetch)
// -----------------------------------------------------------------------------
float sampleSdf2D(vec2 uv) {
  if (uSdfLinear == 1) {
    return texture(uSdfTex, clamp(uv, 0.0, 1.0)).r;
  }
  vec2 size = vec2(uSdfTexSize);
  vec2 coord = clamp(uv, 0.0, 1.0) * size - 0.5;
  vec2 f = fract(coord);
  ivec2 i0 = clamp(ivec2(floor(coord)), ivec2(0), uSdfTexSize - 1);
  ivec2 i1 = clamp(i0 + 1, ivec2(0), uSdfTexSize - 1);

  float a = texelFetch(uSdfTex, i0, 0).r;
  float b = texelFetch(uSdfTex, ivec2(i1.x, i0.y), 0).r;
  float c = texelFetch(uSdfTex, ivec2(i0.x, i1.y), 0).r;
  float d = texelFetch(uSdfTex, i1, 0).r;

  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

// Triplanar sample of 16-bit half-float RGBA16F frost micro-facet map
vec4 sampleFrostTriplanar(vec3 p, vec3 n, float scale) {
  vec3 w = abs(n);
  w = pow(w, vec3(4.0));
  w /= max(dot(w, vec3(1.0)), 1e-4);

  vec4 sx = texture(uFrostTex, p.yz * scale);
  vec4 sy = texture(uFrostTex, p.xz * scale);
  vec4 sz = texture(uFrostTex, p.xy * scale);
  return sx * w.x + sy * w.y + sz * w.z;
}

// -----------------------------------------------------------------------------
// Pure Euclidean SDF Primitives
// -----------------------------------------------------------------------------
float sdRoundBox(vec3 p, vec3 b, float r) {
  vec3 q = abs(p) - b;
  return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0) - r;
}

float sdCapsuleX(vec3 p, float halfLen, float r) {
  p.x -= clamp(p.x, -halfLen, halfLen);
  return length(p) - r;
}

float sdFacetedMonolith(vec3 p) {
  // Exact Euclidean plane intersections with chamfered bevels
  vec3 ap = abs(p);
  float bx = max(ap.x - 1.24, max(ap.y - 0.56, ap.z - 0.44));
  // 45-degree corner bevels along XZ and XY and YZ
  float cxz = (ap.x + ap.z) * 0.70710678 - 1.06;
  float cxy = (ap.x + ap.y) * 0.70710678 - 1.12;
  float cyz = (ap.y + ap.z) * 0.70710678 - 0.62;
  float d = max(bx, max(cxz, max(cxy, cyz)));
  // Smooth sharp facet creases slightly so highlights gleam along edges
  return d - 0.016;
}

float sdOuterRaw(vec3 p) {
  if (uShape == 0) {
    // Rounded Optical Prism
    return sdRoundBox(p, vec3(1.16, 0.46, 0.34), 0.12);
  } else if (uShape == 1) {
    // Water Cushion / Droplet Lens
    return sdRoundBox(p, vec3(0.96, 0.28, 0.16), 0.28);
  } else if (uShape == 2) {
    // Faceted Crystal Monolith
    return sdFacetedMonolith(p);
  } else {
    // Capsule Lens (smooth horizontal pill)
    float cap = sdCapsuleX(p, 0.78, 0.48);
    float slab = abs(p.z) - 0.38;
    return max(cap, slab) - 0.03;
  }
}

float waveDisplacement(vec3 p) {
  if (uRippleAmp <= 0.0001) return 0.0;
  float t = uTime * uRippleSpeed;
  float w1 = sin(p.x * 5.2 + t * 1.9 + sin(p.z * 3.1 - t * 1.1)) * 0.48;
  float w2 = sin(p.z * 6.4 - t * 1.5 + cos(p.x * 2.7 + t * 0.8)) * 0.32;
  float w3 = sin((p.x + p.y) * 9.5 + t * 2.4) * 0.20;
  return (w1 + w2 + w3) * uRippleAmp;
}

// Lipschitz-safe outer SDF for pure sphere-tracing
float sdOuter(vec3 p) {
  float dRaw = sdOuterRaw(p) + waveDisplacement(p);

  // Jelly wobble perturbation
  float wobble = 0.0;
  if (uClickTime > 0.0) {
    float t = uTime - uClickTime;
    // Project ray-sphere intersection approximation
    float distToRay = length(cross(p, uClickRayDir));
    wobble = sin(t * 12.0 - distToRay * 8.0) * exp(-distToRay * 3.0) * exp(-t * 2.5) * 0.15;
  }

  float d = dRaw + wobble;
  float lip = 1.0 + uRippleAmp * 7.5 + 0.16;
  return d / lip;
}

// Exact 3D Euclidean SDF for "hydrogen" etched inside the volume's core
float sdEtch(vec3 p) {
  float sc = max(uEtchScale, 0.05);
  vec2 q = p.xy / sc;
  vec2 halfBounds = uSdfWorldSize * 0.5;
  vec2 clamped = clamp(q, -halfBounds, halfBounds);
  vec2 outside = q - clamped;
  vec2 uv = clamped / uSdfWorldSize + 0.5;

  float d2 = sampleSdf2D(uv);
  float d2World = (dot(outside, outside) > 0.0)
    ? sqrt(dot(outside, outside) + max(d2, 0.0) * max(d2, 0.0))
    : d2;
  d2World *= sc;

  float halfD = max(uEtchDepth * 0.5, 0.008);
  float bevel = 0.0055 * sc;
  vec2 w = vec2(d2World, abs(p.z) - halfD);
  return min(max(w.x, w.y), 0.0) + length(max(w, 0.0)) - bevel;
}

// Tetrahedron finite-difference normals
vec3 calcOuterNormal(vec3 p) {
  const float h = 0.0012;
  const vec2 k = vec2(1.0, -1.0);
  return normalize(
    k.xyy * sdOuter(p + k.xyy * h) +
    k.yyx * sdOuter(p + k.yyx * h) +
    k.yxy * sdOuter(p + k.yxy * h) +
    k.xxx * sdOuter(p + k.xxx * h)
  );
}

vec3 calcEtchNormal(vec3 p) {
  const float h = 0.0014;
  const vec2 k = vec2(1.0, -1.0);
  return normalize(
    k.xyy * sdEtch(p + k.xyy * h) +
    k.yyx * sdEtch(p + k.yyx * h) +
    k.yxy * sdEtch(p + k.yxy * h) +
    k.xxx * sdEtch(p + k.xxx * h)
  );
}

// Perturb normal with 16-bit half-float frost micro-facet gradients
vec3 applyFrostNormal(vec3 n, vec3 p, float frostAmount, float scale) {
  if (frostAmount <= 0.001) return n;
  vec4 f = sampleFrostTriplanar(p, n, scale * 0.25);
  vec3 up = abs(n.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 t = normalize(cross(up, n));
  vec3 b = cross(n, t);
  float strength = frostAmount * frostAmount * 0.38;
  return normalize(n + (t * f.z + b * f.w) * strength);
}

// -----------------------------------------------------------------------------
// Studio HDR Environment Dome
// -----------------------------------------------------------------------------
vec3 evalEnvironment(vec3 rd, float roughness) {
  vec3 baseSky;
  vec3 horizonCol;
  vec3 rimCool;
  vec3 rimWarm;

  if (uEnvTheme == 0) {
    // Obsidian Studio
    baseSky = vec3(0.025, 0.042, 0.082);
    horizonCol = vec3(0.065, 0.115, 0.195);
    rimCool = vec3(0.35, 0.85, 1.15);
    rimWarm = vec3(0.95, 0.65, 0.45);
  } else if (uEnvTheme == 1) {
    // Abyssal Deep
    baseSky = vec3(0.008, 0.028, 0.055);
    horizonCol = vec3(0.02, 0.14, 0.24);
    rimCool = vec3(0.18, 0.95, 1.05);
    rimWarm = vec3(0.25, 0.45, 0.95);
  } else if (uEnvTheme == 2) {
    // Arctic Daylight
    baseSky = vec3(0.26, 0.44, 0.68);
    horizonCol = vec3(0.62, 0.78, 0.92);
    rimCool = vec3(0.95, 1.05, 1.18);
    rimWarm = vec3(0.88, 0.94, 1.02);
  } else {
    // Amber Horizon
    baseSky = vec3(0.055, 0.032, 0.065);
    horizonCol = vec3(0.34, 0.15, 0.11);
    rimCool = vec3(0.45, 0.75, 1.15);
    rimWarm = vec3(1.35, 0.68, 0.28);
  }

  float h = clamp(rd.y * 0.5 + 0.5, 0.0, 1.0);
  vec3 col = mix(horizonCol * 0.45, mix(horizonCol, baseSky, smoothstep(0.48, 0.95, h)), smoothstep(0.0, 0.55, h));

  // Architectural studio softbox strips for crisp glass reflections
  vec3 strip1Dir = normalize(vec3(-0.75, 0.65, -0.35));
  vec3 strip2Dir = normalize(vec3(0.82, 0.35, 0.48));
  float s1 = pow(max(dot(rd, strip1Dir), 0.0), mix(24.0, 4.0, roughness));
  float s2 = pow(max(dot(rd, strip2Dir), 0.0), mix(18.0, 3.5, roughness));
  float overheadStrip = smoothstep(0.72 - roughness * 0.35, 0.96, rd.y) *
                        smoothstep(0.55, 0.0, abs(rd.x + rd.z * 0.3));

  col += rimCool * (s1 * 1.15 + overheadStrip * 0.95);
  col += rimWarm * (s2 * 0.75);

  // Key light specular sun / softbox disk
  float ld = max(dot(rd, uLightDir), 0.0);
  float sharpExp = mix(260.0, 12.0, roughness);
  float softExp = mix(18.0, 3.0, roughness);
  float keyDisk = pow(ld, sharpExp) * (3.2 - roughness * 2.2) + pow(ld, softExp) * 0.38;
  col += uLightColor * uLightIntensity * keyDisk;

  return col;
}

// -----------------------------------------------------------------------------
// Studio Pedestal / Floor with Shadow & Refractive Dispersive Caustics
// -----------------------------------------------------------------------------
vec3 shadeFloor(vec3 ro, vec3 rd, float tFloor, float frostHint) {
  vec3 p = ro + rd * tFloor;
  float r2 = dot(p.xz, p.xz);

  // Base slate pedestal color
  vec3 baseCol = (uEnvTheme == 2) ? vec3(0.32, 0.38, 0.46) : vec3(0.028, 0.036, 0.052);

  // Subtle radial studio grid & brushed micro-grain
  vec2 gridUv = fract(p.xz * 2.0) - 0.5;
  float gridLine = smoothstep(0.02, 0.0, min(abs(gridUv.x), abs(gridUv.y)));
  float gridMask = exp(-r2 * 0.14);
  baseCol += vec3(0.045, 0.08, 0.12) * gridLine * gridMask;

  // Trace shadow ray from floor point toward light to detect volume occlusion & caustic lensing
  vec3 lDir = uLightDir;
  float t = 0.02;
  float minD = 1e4;
  float hitT = -1.0;
  for (int i = 0; i < 36; i++) {
    vec3 sp = p + lDir * t;
    float d = sdOuter(sp);
    minD = min(minD, d);
    if (d < 0.004) {
      hitT = t;
      break;
    }
    if (t > 5.0 || sp.y > 1.8) break;
    t += d;
  }

  float shadow = smoothstep(0.0, 0.14, minD);
  vec3 causticLight = vec3(0.0);

  if (hitT > 0.0 && uCaustics > 0.001) {
    vec3 enterP = p + lDir * hitT;
    vec3 n = calcOuterNormal(enterP);

    // Focusing strength from curvature & ripples + grazing bevel brightening
    vec3 nPert = calcOuterNormal(enterP + vec3(0.04, 0.0, 0.04));
    float focus = clamp(length(n - nPert) * 14.0, 0.0, 2.5);
    float fresnelRim = pow(1.0 - abs(dot(n, lDir)), 2.0);

    // Chromatic caustic shift
    vec3 refrR = refract(-lDir, n, 1.0 / max(uIor - uDispersion * 0.8, 1.02));
    vec3 refrG = refract(-lDir, n, 1.0 / uIor);
    vec3 refrB = refract(-lDir, n, 1.0 / (uIor + uDispersion * 0.8));

    float caustBase = (0.35 + focus * 1.45 + fresnelRim * 0.85) * (1.0 - uFrost * 0.55);

    // Sample core shadow modulation inside volume along refracted ray
    vec3 coreR = enterP + refrR * 0.35;
    vec3 coreG = enterP + refrG * 0.35;
    vec3 coreB = enterP + refrB * 0.35;
    float etchMaskR = smoothstep(-0.02, 0.04, sdEtch(coreR));
    float etchMaskG = smoothstep(-0.02, 0.04, sdEtch(coreG));
    float etchMaskB = smoothstep(-0.02, 0.04, sdEtch(coreB));

    vec3 sigma = (vec3(1.0) - uTint) * uAbsorption * 0.7;
    vec3 beer = exp(-sigma);

    causticLight = vec3(
      mix(0.45, 1.15, etchMaskR),
      mix(0.45, 1.15, etchMaskG),
      mix(0.45, 1.15, etchMaskB)
    ) * beer * caustBase * uCaustics * uLightColor * uLightIntensity * 0.38;
  }

  // Ambient + diffused key light on floor
  float diff = max(lDir.y, 0.05);
  vec3 litFloor = baseCol * (0.42 + 0.58 * diff * mix(0.28, 1.0, shadow)) + causticLight;

  // Floor Fresnel reflection of studio dome
  float floorF = 0.04 + 0.45 * pow(1.0 - clamp(-rd.y, 0.0, 1.0), 4.0);
  vec3 reflDir = reflect(rd, vec3(0.0, 1.0, 0.0));
  vec3 floorCol = mix(litFloor, evalEnvironment(reflDir, 0.32 + frostHint * 0.25) * 0.65, floorF);

  // Fade smoothly into distant studio horizon
  float fog = 1.0 - exp(-r2 * 0.012);
  return mix(floorCol, evalEnvironment(rd, 0.2), fog);
}

// Evaluates external ray (either pedestal floor or HDR studio dome)
vec3 evalExternalRay(vec3 ro, vec3 rd, float roughness) {
  if (rd.y < -0.002 && ro.y > FLOOR_Y) {
    float tFloor = (FLOOR_Y - ro.y) / rd.y;
    if (tFloor > 0.0 && tFloor < 18.0) {
      return shadeFloor(ro, rd, tFloor, roughness);
    }
  }
  return evalEnvironment(rd, roughness);
}

// -----------------------------------------------------------------------------
// Pure Sphere-Trace Inside Dielectric Medium + Etched "hydrogen" Core
// -----------------------------------------------------------------------------
float pickCh(vec3 v, int ch) {
  return (ch == 0) ? v.r : ((ch == 1) ? v.g : v.b);
}

float schlickFresnel(float cosTheta, float iorA, float iorB) {
  float r0 = (iorA - iorB) / (iorA + iorB);
  r0 = r0 * r0;
  float f = r0 + (1.0 - r0) * pow(clamp(1.0 - cosTheta, 0.0, 1.0), 5.0);
  return clamp(f * uFresnel, 0.0, 0.99);
}

// Traces a single wavelength channel inside the glass/water volume
float traceChannel(vec3 startP, vec3 startDir, float channelIor, vec3 sigma, float channelWeight, int chIdx) {
  vec3 p = startP;
  vec3 dir = startDir;
  vec3 throughput = vec3(1.0);
  float accum = 0.0;
  bool inEtchCavity = false;

  for (int bounce = 0; bounce < 3; bounce++) {
    float segLen = 0.0;
    int hitType = 0; // 1 = outer surface exit, 2 = etched core hit

    // Pure sphere-tracing inside medium or inside etched cavity
    for (int stepIdx = 0; stepIdx < 48; stepIdx++) {
      float dOuter = -sdOuter(p);
      float dEtch = sdEtch(p);

      float d = inEtchCavity ? -dEtch : min(dOuter, dEtch);
      if (d < SURF_EPS) {
        if (inEtchCavity) {
          hitType = 2;
        } else {
          hitType = (dEtch <= dOuter) ? 2 : 1;
        }
        break;
      }
      float stepSize = max(d, 0.0005);
      p += dir * stepSize;
      segLen += stepSize;
      if (segLen > 3.0) break;
    }

    // Beer-Lambert absorption only while travelling through glass/water
    if (!inEtchCavity) {
      throughput *= exp(-sigma * segLen);
    }

    if (hitType == 0) {
      vec3 bg = evalExternalRay(p, dir, uFrost * 0.45);
      accum += pickCh(throughput, chIdx) * pickCh(bg, chIdx);
      break;
    }

    if (hitType == 2) {
      // Hit the "hydrogen" etched core wall!
      vec3 nEtch = calcEtchNormal(p);
      vec3 nFrosted = applyFrostNormal(nEtch, p * 1.4, uEtchFrost, uFrostScale * 1.3);
      vec3 nFace = inEtchCavity ? -nFrosted : nFrosted;
      if (dot(nFace, dir) > 0.0) nFace = -nFace;

      float cosI = clamp(-dot(dir, nFace), 0.0, 1.0);

      // Etched laser-frost crystal sheen + grazing rim + key specular
      vec3 hVec = normalize(uLightDir - dir);
      float spec = pow(max(dot(nFace, hVec), 0.0), mix(96.0, 14.0, uEtchFrost));
      float rim = pow(1.0 - cosI, 2.2);
      float diffLight = 0.35 + 0.65 * max(dot(nFace, uLightDir), 0.0);

      vec3 etchTint = mix(vec3(0.88, 0.97, 1.0), uTint * 0.65 + 0.45, 0.35);
      vec3 etchDirect = etchTint * (diffLight * (0.28 + uEtchFrost * 0.42) + rim * 0.68) * uEtchGlow
                      + uLightColor * uLightIntensity * spec * 0.55 * uEtchGlow;

      // Energy scattered from the etched cavity walls
      float scatterAmt = mix(0.22, 0.68, uEtchFrost);
      accum += pickCh(throughput, chIdx) * pickCh(etchDirect, chIdx) * scatterAmt;

      // Remaining energy crosses or reflects off the air-gap etched letter boundary
      float eta = inEtchCavity ? (1.0 / channelIor) : channelIor;
      vec3 refr = refract(dir, nFace, eta);
      vec3 refl = reflect(dir, nFace);

      if (dot(refr, refr) < 0.001) {
        // Total internal reflection on etched letter bevel -> bright silver crystal glint!
        dir = refl;
        p += nFace * 0.0025;
        throughput *= (1.0 - scatterAmt * 0.6);
      } else {
        // Transmit through the etched letter cavity & keep going!
        float fCavity = schlickFresnel(cosI, inEtchCavity ? 1.0 : channelIor, inEtchCavity ? channelIor : 1.0);
        // Add subtle specular glint along reflected direction from studio
        vec3 glintEnv = evalEnvironment(refl, 0.15 + uEtchFrost * 0.35);
        accum += pickCh(throughput, chIdx) * fCavity * pickCh(glintEnv, chIdx) * 0.65;

        dir = normalize(refr);
        inEtchCavity = !inEtchCavity;
        p += dir * 0.003;
        throughput *= (1.0 - scatterAmt * 0.55) * (1.0 - fCavity * 0.5);
      }
    } else {
      // Hit outer boundary from inside -> exit into air or TIR
      vec3 nOut = calcOuterNormal(p);
      nOut = applyFrostNormal(nOut, p, uFrost, uFrostScale);
      vec3 nIn = -nOut;
      if (dot(nIn, dir) > 0.0) nIn = -nIn;

      float cosI = clamp(-dot(dir, nIn), 0.0, 1.0);
      vec3 exitDir = refract(dir, nIn, channelIor);

      if (dot(exitDir, exitDir) < 0.001) {
        // Total Internal Reflection (TIR)
        dir = reflect(dir, nIn);
        p += nIn * 0.0025;
      } else {
        float fExit = schlickFresnel(cosI, channelIor, 1.0);
        vec3 extCol = evalExternalRay(p + nOut * 0.004, normalize(exitDir), uFrost * 0.65);
        accum += pickCh(throughput, chIdx) * (1.0 - fExit) * pickCh(extCol, chIdx);

        // Continue internal reflection bounce
        dir = reflect(dir, nIn);
        p += nIn * 0.0025;
        throughput *= fExit;
      }
    }

    if (pickCh(throughput, chIdx) < 0.015) break;
  }

  return accum * channelWeight;
}

void main() {
  // Construct camera ray
  vec2 ndc = vUv * 2.0 - 1.0;
  float aspect = uResolution.x / max(uResolution.y, 1.0);
  float tanHalfFov = tan(radians(uCamFov) * 0.5);
  vec3 rd = normalize(
    uCamForward +
    uCamRight * (ndc.x * aspect * tanHalfFov) +
    uCamUp * (ndc.y * tanHalfFov)
  );
  vec3 ro = uCamPos;

  // Primary pure sphere-trace in air
  float t = 0.0;
  int hitObj = 0; // 0 = sky, 1 = volume, 2 = floor
  vec3 p = ro;

  for (int i = 0; i < 80; i++) {
    p = ro + rd * t;
    float dVol = sdOuter(p);
    float dFloor = p.y - FLOOR_Y;
    float d = min(dVol, dFloor);

    if (d < SURF_EPS) {
      hitObj = (dVol <= dFloor) ? 1 : 2;
      break;
    }
    t += d;
    if (t > MAX_DIST) break;
  }

  vec3 color = vec3(0.0);

  if (hitObj == 0) {
    color = evalEnvironment(rd, 0.0);
  } else if (hitObj == 2) {
    color = shadeFloor(ro, rd, t, 0.0);
  } else {
    // Hit outer dielectric water/glass surface!
    vec3 nGeo = calcOuterNormal(p);
    vec3 n = applyFrostNormal(nGeo, p, uFrost, uFrostScale);
    if (dot(n, rd) > 0.0) n = -n;

    float cosTheta = clamp(-dot(rd, n), 0.0, 1.0);
    float fEntry = schlickFresnel(cosTheta, 1.0, uIor);

    // Outer specular reflection (studio dome + pedestal)
    vec3 reflDir = reflect(rd, n);
    vec3 reflCol = evalExternalRay(p + nGeo * 0.004, reflDir, uFrost * 0.72);

    // Sharp key-light micro-glint
    vec3 halfVec = normalize(uLightDir - rd);
    float keySpec = pow(max(dot(n, halfVec), 0.0), mix(320.0, 18.0, uFrost));
    reflCol += uLightColor * uLightIntensity * keySpec * (1.2 - uFrost * 0.65);

    // Beer-Lambert absorption coefficient from medium tint
    vec3 sigma = (vec3(1.0) - clamp(uTint, 0.02, 0.995)) * (0.25 + uAbsorption * 1.45);

    // Spectral dispersion across R, G, B channels (Cauchy model)
    vec3 refrCol;
    vec3 pIn = p - nGeo * 0.003;
    if (uDispersion > 0.0015) {
      float iorR = max(uIor - uDispersion, 1.01);
      float iorG = uIor;
      float iorB = uIor + uDispersion;

      vec3 rdR = refract(rd, n, 1.0 / iorR);
      vec3 rdG = refract(rd, n, 1.0 / iorG);
      vec3 rdB = refract(rd, n, 1.0 / iorB);

      rdR = (dot(rdR, rdR) > 1e-5) ? normalize(rdR) : reflDir;
      rdG = (dot(rdG, rdG) > 1e-5) ? normalize(rdG) : reflDir;
      rdB = (dot(rdB, rdB) > 1e-5) ? normalize(rdB) : reflDir;

      refrCol.r = traceChannel(pIn, rdR, iorR, sigma, 1.0, 0);
      refrCol.g = traceChannel(pIn, rdG, iorG, sigma, 1.0, 1);
      refrCol.b = traceChannel(pIn, rdB, iorB, sigma, 1.0, 2);
    } else {
      vec3 rdG = refract(rd, n, 1.0 / uIor);
      rdG = (dot(rdG, rdG) > 1e-5) ? normalize(rdG) : reflDir;
      refrCol.r = traceChannel(pIn, rdG, uIor, sigma, 1.0, 0);
      refrCol.g = traceChannel(pIn, rdG, uIor, sigma, 1.0, 1);
      refrCol.b = traceChannel(pIn, rdG, uIor, sigma, 1.0, 2);
    }

    // Subtle frosted subsurface milky scattering on outer shell
    if (uFrost > 0.01) {
      vec3 frostScatter = (uTint * 0.4 + 0.6) * evalEnvironment(n, 0.85) * 0.45;
      refrCol = mix(refrCol, refrCol * 0.72 + frostScatter, uFrost * 0.42);
    }

    color = mix(refrCol, reflCol, fEntry);
  }

  fragColor = vec4(max(color, 0.0), 1.0);
}
`;

// Pass 2: HDR Bloom & Frost Scatter Threshold (reads RGBA16F -> writes RGBA16F)
export const BLOOM_THRESHOLD_FS = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uSource;
uniform float uThreshold;
uniform float uSoftKnee;

void main() {
  vec3 col = texture(uSource, vUv).rgb;
  float br = max(col.r, max(col.g, col.b));
  float knee = uThreshold * uSoftKnee + 1e-5;
  float soft = br - uThreshold + knee;
  soft = clamp(soft, 0.0, 2.0 * knee);
  soft = soft * soft / (4.0 * knee);
  float contrib = max(soft, br - uThreshold) / max(br, 1e-4);
  fragColor = vec4(col * clamp(contrib, 0.0, 1.0), 1.0);
}
`;

// Pass 3: Separable 9-tap Gaussian Blur in 16-bit float precision (RGBA16F)
export const BLUR_FS = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uSource;
uniform vec2 uDirection; // (texelX, 0) or (0, texelY)

void main() {
  const float weights[5] = float[](0.2270270270, 0.1945945946, 0.1216216216, 0.0540540541, 0.0162162162);
  vec3 res = texture(uSource, vUv).rgb * weights[0];
  for (int i = 1; i < 5; i++) {
    vec2 off = uDirection * float(i) * 1.45;
    res += texture(uSource, vUv + off).rgb * weights[i];
    res += texture(uSource, vUv - off).rgb * weights[i];
  }
  fragColor = vec4(res, 1.0);
}
`;

// Pass 4: Final ACES Filmic Tonemapping + Bloom Composite + Blue-Noise-Style Dithering
export const COMPOSITE_FS = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uHdrTex;
uniform sampler2D uBloomTex1;
uniform sampler2D uBloomTex2;
uniform float uExposure;
uniform float uBloomIntensity;

vec3 acesFilmic(vec3 x) {
  const float a = 2.51;
  const float b = 0.03;
  const float c = 2.43;
  const float d = 0.59;
  const float e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

void main() {
  vec3 hdr = texture(uHdrTex, vUv).rgb;
  vec3 b1 = texture(uBloomTex1, vUv).rgb;
  vec3 b2 = texture(uBloomTex2, vUv).rgb;
  vec3 bloom = (b1 * 0.55 + b2 * 0.45) * uBloomIntensity;

  vec3 col = (hdr + bloom) * uExposure;
  col = acesFilmic(col);

  // Subtle photographic vignette
  vec2 q = vUv - 0.5;
  col *= 1.0 - dot(q, q) * 0.24;

  // sRGB gamma
  col = pow(max(col, 0.0), vec3(1.0 / 2.2));

  // Triangular dither to prevent 8-bit display quantization
  float dither = (hash12(gl_FragCoord.xy) - 0.5) / 255.0;
  fragColor = vec4(clamp(col + dither, 0.0, 1.0), 1.0);
}
`;
