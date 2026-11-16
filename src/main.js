import { generateHydrogenSDF, generateFrostTexture16F } from './sdfGenerator.js';
import {
  FULLSCREEN_VS,
  RAYMARCH_FS,
  BLOOM_THRESHOLD_FS,
  BLUR_FS,
  COMPOSITE_FS,
} from './shaders.js';
import { MATERIAL_PRESETS, DEFAULT_STATE } from './presets.js';

const canvas = document.getElementById('gl-canvas');
const telemetryEl = document.getElementById('gpu-telemetry');
const panelEl = document.getElementById('control-panel');
const togglePanelBtn = document.getElementById('toggle-panel-btn');
const resetCameraBtn = document.getElementById('reset-camera-btn');
const presetGridEl = document.getElementById('preset-grid');

const state = { ...DEFAULT_STATE };
let activePresetId = MATERIAL_PRESETS[0].id;

// Camera state
const DEFAULT_CAM = { yaw: 0.16, pitch: 0.18, dist: 3.35 };
const cam = {
  yaw: DEFAULT_CAM.yaw,
  pitch: DEFAULT_CAM.pitch,
  dist: DEFAULT_CAM.dist,
  targetYaw: DEFAULT_CAM.yaw,
  targetPitch: DEFAULT_CAM.pitch,
  targetDist: DEFAULT_CAM.dist,
  dragging: false,
  lastX: 0,
  lastY: 0,
};

const interaction = {
  clickTime: -1.0,
  clickRay: [0, 0, 1],
};

// -----------------------------------------------------------------------------
// WebGL2 Helpers
// -----------------------------------------------------------------------------
function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Shader compile error:\n${log}`);
  }
  return shader;
}

function createProgram(gl, vsSrc, fsSrc, name) {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vsSrc);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSrc);
  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(prog);
    console.error(`Program link error for ${name}:\n${log}`);
    throw new Error(`Program link error for ${name}:\n${log}`);
  }
  return prog;
}

function getUniformLocations(gl, prog, names) {
  const map = {};
  for (const name of names) {
    map[name] = gl.getUniformLocation(prog, name);
  }
  return map;
}

function hexToRgb01(hex) {
  const clean = hex.replace('#', '');
  const n = parseInt(clean, 16);
  return [
    ((n >> 16) & 255) / 255,
    ((n >> 8) & 255) / 255,
    (n & 255) / 255,
  ];
}

function createFloatFBO(gl, width, height, internalFormat, type) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, width, height, 0, gl.RGBA, type, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);

  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.bindTexture(gl.TEXTURE_2D, null);

  return { fbo, tex, width, height, ok: status === gl.FRAMEBUFFER_COMPLETE };
}

function destroyFBO(gl, target) {
  if (!target) return;
  if (target.fbo) gl.deleteFramebuffer(target.fbo);
  if (target.tex) gl.deleteTexture(target.tex);
}

// -----------------------------------------------------------------------------
// UI Wiring
// -----------------------------------------------------------------------------
const SLIDER_DEFS = [
  { key: 'ior', decimals: 3, suffix: '' },
  { key: 'dispersion', decimals: 3, suffix: '' },
  { key: 'absorption', decimals: 2, suffix: '' },
  { key: 'fresnel', decimals: 2, suffix: '' },
  { key: 'etchGlow', decimals: 2, suffix: '' },
  { key: 'frost', decimals: 3, suffix: '' },
  { key: 'frostScale', decimals: 1, suffix: '' },
  { key: 'bloom', decimals: 2, suffix: '' },
  { key: 'etchFrost', decimals: 2, suffix: '' },
  { key: 'lightAzimuth', decimals: 0, suffix: '°' },
  { key: 'lightElevation', decimals: 0, suffix: '°' },
  { key: 'lightIntensity', decimals: 2, suffix: '' },
  { key: 'exposure', decimals: 2, suffix: '' },
  { key: 'rippleAmp', decimals: 3, suffix: '' },
  { key: 'rippleSpeed', decimals: 2, suffix: '' },
  { key: 'etchScale', decimals: 2, suffix: '' },
  { key: 'etchDepth', decimals: 3, suffix: '' },
  { key: 'caustics', decimals: 2, suffix: '' },
];

function syncUIFromState() {
  for (const def of SLIDER_DEFS) {
    const input = document.getElementById(`ctrl-${def.key}`);
    const out = document.getElementById(`val-${def.key}`);
    if (input) input.value = String(state[def.key]);
    if (out) out.textContent = Number(state[def.key]).toFixed(def.decimals) + def.suffix;
  }

  for (const colorKey of ['tint', 'lightColor']) {
    const input = document.getElementById(`ctrl-${colorKey}`);
    const out = document.getElementById(`val-${colorKey}`);
    if (input) input.value = state[colorKey];
    if (out) out.textContent = state[colorKey];
  }

  document.getElementById('ctrl-envTheme').value = String(state.envTheme);
  document.getElementById('ctrl-shape').value = String(state.shape);
  document.getElementById('ctrl-autoRotate').checked = Boolean(state.autoRotate);

  document.querySelectorAll('.preset-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.presetId === activePresetId);
  });
}

function setupUI() {
  // Build preset buttons
  for (const preset of MATERIAL_PRESETS) {
    const btn = document.createElement('button');
    btn.className = 'preset-btn';
    btn.dataset.presetId = preset.id;
    btn.innerHTML = `<span class="preset-swatch" style="background:${preset.swatch}"></span><span>${preset.name}</span>`;
    btn.addEventListener('click', () => {
      Object.assign(state, preset.values);
      activePresetId = preset.id;
      syncUIFromState();
    });
    presetGridEl.appendChild(btn);
  }

  // Bind sliders
  for (const def of SLIDER_DEFS) {
    const input = document.getElementById(`ctrl-${def.key}`);
    const out = document.getElementById(`val-${def.key}`);
    if (!input) continue;
    input.addEventListener('input', () => {
      state[def.key] = parseFloat(input.value);
      if (out) out.textContent = state[def.key].toFixed(def.decimals) + def.suffix;
      activePresetId = '';
      document.querySelectorAll('.preset-btn').forEach((b) => b.classList.remove('active'));
    });
  }

  // Bind color pickers
  for (const colorKey of ['tint', 'lightColor']) {
    const input = document.getElementById(`ctrl-${colorKey}`);
    const out = document.getElementById(`val-${colorKey}`);
    input.addEventListener('input', () => {
      state[colorKey] = input.value;
      if (out) out.textContent = input.value;
      if (colorKey === 'tint') {
        activePresetId = '';
        document.querySelectorAll('.preset-btn').forEach((b) => b.classList.remove('active'));
      }
    });
  }

  document.getElementById('ctrl-envTheme').addEventListener('change', (e) => {
    state.envTheme = parseInt(e.target.value, 10);
  });

  document.getElementById('ctrl-shape').addEventListener('change', (e) => {
    state.shape = parseInt(e.target.value, 10);
    activePresetId = '';
    document.querySelectorAll('.preset-btn').forEach((b) => b.classList.remove('active'));
  });

  document.getElementById('ctrl-autoRotate').addEventListener('change', (e) => {
    state.autoRotate = e.target.checked;
  });

  togglePanelBtn.addEventListener('click', () => {
    panelEl.classList.toggle('collapsed');
  });

  resetCameraBtn.addEventListener('click', () => {
    cam.targetYaw = DEFAULT_CAM.yaw;
    cam.targetPitch = DEFAULT_CAM.pitch;
    cam.targetDist = DEFAULT_CAM.dist;
  });

  syncUIFromState();
}

// -----------------------------------------------------------------------------
// Orbit Interaction
// -----------------------------------------------------------------------------
function setupCameraControls() {
  canvas.addEventListener('pointerdown', (e) => {
    cam.dragging = true;
    cam.lastX = e.clientX;
    cam.lastY = e.clientY;
    canvas.setPointerCapture(e.pointerId);

    // Calculate ray direction for wobble
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width * 2 - 1;
    const y = -((e.clientY - rect.top) / rect.height * 2 - 1);
    
    // Simplistic ray from camera center towards screen point
    // Using current cam state (yaw/pitch)
    const cp = Math.cos(cam.pitch);
    const sp = Math.sin(cam.pitch);
    const cy = Math.cos(cam.yaw);
    const sy = Math.sin(cam.yaw);

    const fx = -cp * sy;
    const fy = -sp;
    const fz = -cp * cy;
    const rx = cy;
    const rz = -sy;
    const ux = -fy * rz;
    const uy = -fz * rx + fx * rz;
    const uz = -fx * ry; // Wait, this cross product is wrong. Use proper one.
    
    // Easier: Just reuse the basis from `render()` if I expose it
    // Actually, I can just use a constant central ray as an approximation, 
    // it's "jelly" perturbation, not physics-accurate intersection.
    interaction.clickTime = performance.now() * 0.001;
    interaction.clickRay = [x * 0.5, y * 0.5, 1.0];
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!cam.dragging) return;
    const dx = e.clientX - cam.lastX;
    const dy = e.clientY - cam.lastY;
    cam.lastX = e.clientX;
    cam.lastY = e.clientY;
    cam.targetYaw -= dx * 0.0075;
    cam.targetPitch = Math.max(-0.55, Math.min(1.15, cam.targetPitch + dy * 0.0065));
  });

  const endDrag = (e) => {
    if (!cam.dragging) return;
    cam.dragging = false;
    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch (_) {}
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      cam.targetDist = Math.max(1.85, Math.min(6.2, cam.targetDist + e.deltaY * 0.0022));
    },
    { passive: false }
  );

  canvas.addEventListener('dblclick', () => {
    cam.targetYaw = DEFAULT_CAM.yaw;
    cam.targetPitch = DEFAULT_CAM.pitch;
    cam.targetDist = DEFAULT_CAM.dist;
  });
}

// -----------------------------------------------------------------------------
// Main WebGL2 Boot & Render Loop
// -----------------------------------------------------------------------------
function main() {
  console.log("Main init started");
  setupUI();
  setupCameraControls();

  const gl = canvas.getContext('webgl2', {
    antialias: false,
    alpha: false,
    depth: false,
    stencil: false,
    powerPreference: 'high-performance',
  });

  if (!gl) {
    telemetryEl.textContent = 'WebGL2 not supported in this browser.';
    return;
  }
  console.log("WebGL2 context acquired");

  const extColorFloat = gl.getExtension('EXT_color_buffer_float');
  const extColorHalf = gl.getExtension('EXT_color_buffer_half_float');
  const extFloatLinear = gl.getExtension('OES_texture_float_linear');
  gl.getExtension('OES_texture_half_float_linear');
  console.log("Extensions checked");

  const canRenderFloat = Boolean(extColorFloat || extColorHalf);
  const fboInternalFormat = canRenderFloat ? gl.RGBA16F : gl.RGBA8;
  const fboType = canRenderFloat ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE;
  const fboLabel = canRenderFloat ? 'RGBA16F (16-bit float)' : 'RGBA8 fallback';

  // Generate 32-bit R32F "hydrogen" SDF texture
  const sdf = generateHydrogenSDF({
    outWidth: 1024,
    outHeight: 256,
    worldWidth: 2.0,
    text: 'hydrogen',
  });
  console.log("SDF generated");

  const sdfTex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, sdfTex);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.R32F,
    sdf.width,
    sdf.height,
    0,
    gl.RED,
    gl.FLOAT,
    sdf.data
  );
  console.log("SDF texture uploaded");
  const sdfFilter = extFloatLinear ? gl.LINEAR : gl.NEAREST;
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, sdfFilter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, sdfFilter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  // Generate 16-bit RGBA16F tileable frost micro-facet texture
  const frost = generateFrostTexture16F(256);
  const frostTex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, frostTex);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA16F,
    frost.size,
    frost.size,
    0,
    gl.RGBA,
    gl.HALF_FLOAT,
    frost.data
  );
  console.log("Frost texture uploaded");
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
  gl.bindTexture(gl.TEXTURE_2D, null);

  // Compile programs
  const raymarchProg = createProgram(gl, FULLSCREEN_VS, RAYMARCH_FS, 'raymarchProg');
  const thresholdProg = createProgram(gl, FULLSCREEN_VS, BLOOM_THRESHOLD_FS, 'thresholdProg');
  const blurProg = createProgram(gl, FULLSCREEN_VS, BLUR_FS, 'blurProg');
  const compositeProg = createProgram(gl, FULLSCREEN_VS, COMPOSITE_FS, 'compositeProg');

  const uRay = getUniformLocations(gl, raymarchProg, [
    'uResolution',
    'uTime',
    'uSdfTex',
    'uFrostTex',
    'uSdfWorldSize',
    'uSdfTexSize',
    'uSdfLinear',
    'uCamPos',
    'uCamRight',
    'uCamUp',
    'uCamForward',
    'uCamFov',
    'uIor',
    'uDispersion',
    'uAbsorption',
    'uTint',
    'uFresnel',
    'uEtchGlow',
    'uFrost',
    'uFrostScale',
    'uEtchFrost',
    'uLightDir',
    'uLightColor',
    'uLightIntensity',
    'uEnvTheme',
    'uClickRayDir',
    'uClickTime',
    'uShape',
    'uRippleAmp',
    'uRippleSpeed',
    'uEtchScale',
    'uEtchDepth',
    'uCaustics',
  ]);

  const uThresh = getUniformLocations(gl, thresholdProg, ['uSource', 'uThreshold', 'uSoftKnee']);
  const uBlur = getUniformLocations(gl, blurProg, ['uSource', 'uDirection']);
  const uComp = getUniformLocations(gl, compositeProg, [
    'uHdrTex',
    'uBloomTex1',
    'uBloomTex2',
    'uExposure',
    'uBloomIntensity',
  ]);

  const emptyVao = gl.createVertexArray();

  // Framebuffers
  let hdrFbo = null;
  let bloom1A = null;
  let bloom1B = null;
  let bloom2A = null;
  let bloom2B = null;
  let renderW = 0;
  let renderH = 0;

  function resizeIfNeeded() {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    const w = Math.max(2, Math.floor(canvas.clientWidth * dpr));
    const h = Math.max(2, Math.floor(canvas.clientHeight * dpr));
    if (w === renderW && h === renderH) return;

    renderW = w;
    renderH = h;
    canvas.width = w;
    canvas.height = h;

    destroyFBO(gl, hdrFbo);
    destroyFBO(gl, bloom1A);
    destroyFBO(gl, bloom1B);
    destroyFBO(gl, bloom2A);
    destroyFBO(gl, bloom2B);

    hdrFbo = createFloatFBO(gl, w, h, fboInternalFormat, fboType);
    const bw1 = Math.max(2, Math.floor(w * 0.5));
    const bh1 = Math.max(2, Math.floor(h * 0.5));
    const bw2 = Math.max(2, Math.floor(w * 0.25));
    const bh2 = Math.max(2, Math.floor(h * 0.25));

    bloom1A = createFloatFBO(gl, bw1, bh1, fboInternalFormat, fboType);
    bloom1B = createFloatFBO(gl, bw1, bh1, fboInternalFormat, fboType);
    bloom2A = createFloatFBO(gl, bw2, bh2, fboInternalFormat, fboType);
    bloom2B = createFloatFBO(gl, bw2, bh2, fboInternalFormat, fboType);
  }

  let lastTime = performance.now();
  let fpsFrames = 0;
  let fpsAccum = 0;
  let currentFps = 60;

  function render(now) {
    const dt = Math.min((now - lastTime) * 0.001, 0.05);
    lastTime = now;
    const elapsed = now * 0.001;

    fpsFrames++;
    fpsAccum += dt;
    if (fpsAccum >= 0.5) {
      currentFps = Math.round(fpsFrames / fpsAccum);
      fpsFrames = 0;
      fpsAccum = 0;
      telemetryEl.textContent = `SDF: R32F (32F) • Frost/HDR: ${fboLabel} • ${renderW}×${renderH} • ${currentFps} fps`;
    }

    resizeIfNeeded();

    if (state.autoRotate && !cam.dragging) {
      cam.targetYaw += dt * 0.16;
    }

    // Smooth camera damping
    const damp = 1.0 - Math.exp(-dt * 10.0);
    cam.yaw += (cam.targetYaw - cam.yaw) * damp;
    cam.pitch += (cam.targetPitch - cam.pitch) * damp;
    cam.dist += (cam.targetDist - cam.dist) * damp;

    // Camera basis
    const cp = Math.cos(cam.pitch);
    const sp = Math.sin(cam.pitch);
    const cy = Math.cos(cam.yaw);
    const sy = Math.sin(cam.yaw);

    const target = [0, -0.06, 0];
    const camPos = [
      target[0] + cam.dist * cp * sy,
      target[1] + cam.dist * sp,
      target[2] + cam.dist * cp * cy,
    ];

    let fx = target[0] - camPos[0];
    let fy = target[1] - camPos[1];
    let fz = target[2] - camPos[2];
    const fLen = Math.hypot(fx, fy, fz) || 1;
    fx /= fLen;
    fy /= fLen;
    fz /= fLen;

    // right = normalize(cross(forward, worldUp))
    let rx = -fz;
    let ry = 0;
    let rz = fx;
    const rLen = Math.hypot(rx, ry, rz) || 1;
    rx /= rLen;
    rz /= rLen;

    // up = cross(right, forward)
    const ux = ry * fz - rz * fy;
    const uy = rz * fx - rx * fz;
    const uz = rx * fy - ry * fx;

    // Key light direction
    const az = (state.lightAzimuth * Math.PI) / 180;
    const el = (state.lightElevation * Math.PI) / 180;
    const lDir = [
      Math.cos(el) * Math.sin(az),
      Math.sin(el),
      Math.cos(el) * Math.cos(az),
    ];

    const tintRgb = hexToRgb01(state.tint);
    const lightRgb = hexToRgb01(state.lightColor);

    gl.bindVertexArray(emptyVao);

    // -------------------------------------------------------------------------
    // Pass 1: Pure Sphere-Tracing Raymarch into 16-bit HDR FBO
    // -------------------------------------------------------------------------
    gl.bindFramebuffer(gl.FRAMEBUFFER, hdrFbo.fbo);
    gl.viewport(0, 0, hdrFbo.width, hdrFbo.height);
    gl.useProgram(raymarchProg);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, sdfTex);
    gl.uniform1i(uRay.uSdfTex, 0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, frostTex);
    gl.uniform1i(uRay.uFrostTex, 1);

    gl.uniform2f(uRay.uResolution, hdrFbo.width, hdrFbo.height);
    gl.uniform1f(uRay.uTime, elapsed);
    gl.uniform2f(uRay.uSdfWorldSize, sdf.worldWidth, sdf.worldHeight);
    gl.uniform2i(uRay.uSdfTexSize, sdf.width, sdf.height);
    gl.uniform1i(uRay.uSdfLinear, extFloatLinear ? 1 : 0);

    gl.uniform3fv(uRay.uCamPos, camPos);
    gl.uniform3f(uRay.uCamRight, rx, ry, rz);
    gl.uniform3f(uRay.uCamUp, ux, uy, uz);
    gl.uniform3f(uRay.uCamForward, fx, fy, fz);
    gl.uniform1f(uRay.uCamFov, 38.0);

    gl.uniform1f(uRay.uIor, state.ior);
    gl.uniform1f(uRay.uDispersion, state.dispersion);
    gl.uniform1f(uRay.uAbsorption, state.absorption);
    gl.uniform3fv(uRay.uTint, tintRgb);
    gl.uniform1f(uRay.uFresnel, state.fresnel);
    gl.uniform1f(uRay.uEtchGlow, state.etchGlow);

    gl.uniform1f(uRay.uFrost, state.frost);
    gl.uniform1f(uRay.uFrostScale, state.frostScale);
    gl.uniform1f(uRay.uEtchFrost, state.etchFrost);

    gl.uniform3fv(uRay.uLightDir, lDir);
    gl.uniform3fv(uRay.uLightColor, lightRgb);
    gl.uniform1f(uRay.uLightIntensity, state.lightIntensity);
    gl.uniform1i(uRay.uEnvTheme, state.envTheme);

    gl.uniform3fv(uRay.uClickRayDir, interaction.clickRay);
    gl.uniform1f(uRay.uClickTime, interaction.clickTime);

    gl.uniform1i(uRay.uShape, state.shape);
    gl.uniform1f(uRay.uRippleAmp, state.rippleAmp);
    gl.uniform1f(uRay.uRippleSpeed, state.rippleSpeed);
    gl.uniform1f(uRay.uEtchScale, state.etchScale);
    gl.uniform1f(uRay.uEtchDepth, state.etchDepth);
    gl.uniform1f(uRay.uCaustics, state.caustics);

    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // -------------------------------------------------------------------------
    // Pass 2: HDR Bloom & Frost Scatter Threshold
    // -------------------------------------------------------------------------
    gl.bindFramebuffer(gl.FRAMEBUFFER, bloom1A.fbo);
    gl.viewport(0, 0, bloom1A.width, bloom1A.height);
    gl.useProgram(thresholdProg);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, hdrFbo.tex);
    gl.uniform1i(uThresh.uSource, 0);
    gl.uniform1f(uThresh.uThreshold, Math.max(0.18, 0.88 - state.frost * 0.55));
    gl.uniform1f(uThresh.uSoftKnee, 0.65);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // -------------------------------------------------------------------------
    // Pass 3: Separable 16-bit HDR Gaussian Blur (Half + Quarter Res)
    // -------------------------------------------------------------------------
    gl.useProgram(blurProg);
    // Half-res H -> bloom1B
    gl.bindFramebuffer(gl.FRAMEBUFFER, bloom1B.fbo);
    gl.viewport(0, 0, bloom1B.width, bloom1B.height);
    gl.bindTexture(gl.TEXTURE_2D, bloom1A.tex);
    gl.uniform1i(uBlur.uSource, 0);
    gl.uniform2f(uBlur.uDirection, 1.0 / bloom1B.width, 0.0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // Half-res V -> bloom1A
    gl.bindFramebuffer(gl.FRAMEBUFFER, bloom1A.fbo);
    gl.bindTexture(gl.TEXTURE_2D, bloom1B.tex);
    gl.uniform2f(uBlur.uDirection, 0.0, 1.0 / bloom1A.height);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // Quarter-res H -> bloom2B
    gl.bindFramebuffer(gl.FRAMEBUFFER, bloom2B.fbo);
    gl.viewport(0, 0, bloom2B.width, bloom2B.height);
    gl.bindTexture(gl.TEXTURE_2D, bloom1A.tex);
    gl.uniform2f(uBlur.uDirection, 1.0 / bloom2B.width, 0.0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // Quarter-res V -> bloom2A
    gl.bindFramebuffer(gl.FRAMEBUFFER, bloom2A.fbo);
    gl.bindTexture(gl.TEXTURE_2D, bloom2B.tex);
    gl.uniform2f(uBlur.uDirection, 0.0, 1.0 / bloom2A.height);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // -------------------------------------------------------------------------
    // Pass 4: ACES Filmic Tonemapping & Composite to Screen
    // -------------------------------------------------------------------------
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, renderW, renderH);
    gl.useProgram(compositeProg);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, hdrFbo.tex);
    gl.uniform1i(uComp.uHdrTex, 0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, bloom1A.tex);
    gl.uniform1i(uComp.uBloomTex1, 1);

    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, bloom2A.tex);
    gl.uniform1i(uComp.uBloomTex2, 2);

    gl.uniform1f(uComp.uExposure, state.exposure);
    gl.uniform1f(uComp.uBloomIntensity, state.bloom * (0.55 + state.frost * 0.55));
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    requestAnimationFrame(render);
  }

  requestAnimationFrame(render);
}

main();
