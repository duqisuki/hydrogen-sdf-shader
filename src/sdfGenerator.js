// Exact O(W*H) 2D Euclidean Distance Transform (Felzenszwalb & Huttenlocher)
// + 32-bit float (R32F) "hydrogen" SDF generator & 16-bit half-float (RGBA16F) frost micro-facet texture

const INF = 1e12;

function edt1D(f, d, v, z, n) {
  let k = 0;
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;

  for (let q = 1; q < n; q++) {
    let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }

  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) {
      k++;
    }
    const dx = q - v[k];
    d[q] = dx * dx + f[v[k]];
  }
}

function edt2D(grid, width, height) {
  const maxDim = Math.max(width, height);
  const f = new Float32Array(maxDim);
  const d = new Float32Array(maxDim);
  const v = new Int32Array(maxDim);
  const z = new Float32Array(maxDim + 1);

  // Transform along columns
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      f[y] = grid[y * width + x];
    }
    edt1D(f, d, v, z, height);
    for (let y = 0; y < height; y++) {
      grid[y * width + x] = d[y];
    }
  }

  // Transform along rows
  for (let y = 0; y < height; y++) {
    const rowOffset = y * width;
    for (let x = 0; x < width; x++) {
      f[x] = grid[rowOffset + x];
    }
    edt1D(f, d, v, z, width);
    for (let x = 0; x < width; x++) {
      grid[rowOffset + x] = Math.sqrt(d[x]);
    }
  }
}

/**
 * Generates a 32-bit float (Float32Array) 2D signed distance field for "hydrogen"
 * using 2x supersampled exact Euclidean Distance Transform.
 * Distances are normalized in world units where texture width = worldWidth.
 */
export function generateHydrogenSDF({
  outWidth = 1024,
  outHeight = 256,
  worldWidth = 2.0,
  text = 'hydrogen',
} = {}) {
  const ss = 2;
  const w = outWidth * ss;
  const h = outHeight * ss;

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');

  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // Fit font size cleanly with generous padding so Euclidean distance remains valid to edges
  let fontSize = Math.floor(h * 0.56);
  const fontFamily = '"Inter", "Segoe UI", "Helvetica Neue", Arial, sans-serif';
  ctx.font = `600 ${fontSize}px ${fontFamily}`;
  if ('letterSpacing' in ctx) {
    ctx.letterSpacing = `${Math.round(fontSize * 0.045)}px`;
  }

  let metrics = ctx.measureText(text);
  const maxAllowedWidth = w * 0.78;
  if (metrics.width > maxAllowedWidth) {
    fontSize = Math.floor(fontSize * (maxAllowedWidth / metrics.width));
    ctx.font = `600 ${fontSize}px ${fontFamily}`;
    if ('letterSpacing' in ctx) {
      ctx.letterSpacing = `${Math.round(fontSize * 0.045)}px`;
    }
  }

  // Slight vertical offset correction for optical centering of lowercase ascenders/descenders ("h", "d", "y", "g")
  ctx.fillText(text, w * 0.5, h * 0.485);

  const img = ctx.getImageData(0, 0, w, h).data;
  const count = w * h;
  const outsideDist = new Float32Array(count);
  const insideDist = new Float32Array(count);

  for (let i = 0; i < count; i++) {
    const a = img[i * 4 + 3] / 255.0;
    if (a >= 0.5) {
      outsideDist[i] = 0.0;
      insideDist[i] = INF;
    } else {
      outsideDist[i] = INF;
      insideDist[i] = 0.0;
    }
  }

  edt2D(outsideDist, w, h);
  edt2D(insideDist, w, h);

  // Combine signed distance in high-res pixels, then downsample 2x2 to outWidth x outHeight
  const worldPerHiResPx = worldWidth / w;
  const outData = new Float32Array(outWidth * outHeight);

  for (let oy = 0; oy < outHeight; oy++) {
    // Flip Y during upload logic or keep UV Y=0 at bottom in GLSL:
    // WebGL texImage2D row 0 is bottom by default if UNPACK_FLIP_Y_WEBGL is false;
    // We flip vertically here so UV (0,0) = bottom-left, UV (1,1) = top-right.
    const syBase = (outHeight - 1 - oy) * ss;
    for (let ox = 0; ox < outWidth; ox++) {
      const sxBase = ox * ss;
      let sum = 0;
      for (let dy = 0; dy < ss; dy++) {
        const row = (syBase + dy) * w;
        for (let dx = 0; dx < ss; dx++) {
          const idx = row + sxBase + dx;
          // Signed distance: positive outside glyphs, negative inside glyphs
          // Subtract 0.5 px bias so the 0-isocontour sits right on the anti-aliased glyph boundary
          const sdPx = outsideDist[idx] > 0 ? outsideDist[idx] - 0.5 : -(insideDist[idx] - 0.5);
          sum += sdPx;
        }
      }
      outData[oy * outWidth + ox] = (sum * 0.25) * worldPerHiResPx;
    }
  }

  return {
    width: outWidth,
    height: outHeight,
    worldWidth,
    worldHeight: worldWidth * (outHeight / outWidth),
    data: outData,
  };
}

// IEEE-754 float32 -> float16 encoder for 16-bit half-float textures
const _f32 = new Float32Array(1);
const _u32 = new Uint32Array(_f32.buffer);

export function floatToHalf(val) {
  _f32[0] = val;
  const x = _u32[0];
  let bits = (x >> 16) & 0x8000;
  let m = (x >> 12) & 0x07ff;
  const e = (x >> 23) & 0xff;
  if (e < 103) return bits;
  if (e > 142) {
    bits |= 0x7c00;
    bits |= (e === 255 ? 0 : 1) && (x & 0x007fffff);
    return bits;
  }
  if (e < 113) {
    m |= 0x0800;
    bits |= (m >> (114 - e)) + ((m >> (113 - e)) & 1);
    return bits;
  }
  bits |= ((e - 112) << 10) | (m >> 1);
  bits += m & 1;
  return bits;
}

function hash2(ix, iy, period) {
  const x = ((ix % period) + period) % period;
  const y = ((iy % period) + period) % period;
  let n = Math.imul(x, 374761393) + Math.imul(y, 668265263);
  n = (n ^ (n >> 13)) * 1274126177;
  n = n ^ (n >> 16);
  return (n >>> 0) / 4294967295.0;
}

function tileableValueNoise(u, v, period) {
  const x = u * period;
  const y = v * period;
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3.0 - 2.0 * fx);
  const uy = fy * fy * (3.0 - 2.0 * fy);

  const a = hash2(ix, iy, period);
  const b = hash2(ix + 1, iy, period);
  const c = hash2(ix, iy + 1, period);
  const d = hash2(ix + 1, iy + 1, period);

  return (a * (1 - ux) + b * ux) * (1 - uy) + (c * (1 - ux) + d * ux) * uy;
}

/**
 * Generates a tileable 16-bit half-float (RGBA16F) frost & micro-facet texture.
 * R: macro frost fBm [0..1]
 * G: fine crystalline grain [0..1]
 * B: micro-facet normal tangent dX [-1..1]
 * A: micro-facet normal tangent dY [-1..1]
 */
export function generateFrostTexture16F(size = 256) {
  const halfData = new Uint16Array(size * size * 4);
  const macro = new Float32Array(size * size);
  const micro = new Float32Array(size * size);

  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const idx = y * size + x;
      const n1 = tileableValueNoise(u, v, 8);
      const n2 = tileableValueNoise(u, v, 16);
      const n3 = tileableValueNoise(u, v, 32);
      const n4 = tileableValueNoise(u, v, 64);
      const n5 = tileableValueNoise(u, v, 128);

      macro[idx] = n1 * 0.5 + n2 * 0.3 + n3 * 0.2;
      micro[idx] = n3 * 0.35 + n4 * 0.4 + n5 * 0.25;
    }
  }

  for (let y = 0; y < size; y++) {
    const ym = (y - 1 + size) % size;
    const yp = (y + 1) % size;
    for (let x = 0; x < size; x++) {
      const xm = (x - 1 + size) % size;
      const xp = (x + 1) % size;
      const idx = y * size + x;

      const gx = (micro[y * size + xp] - micro[y * size + xm]) * 6.0;
      const gy = (micro[yp * size + x] - micro[ym * size + x]) * 6.0;

      const outIdx = idx * 4;
      halfData[outIdx + 0] = floatToHalf(macro[idx]);
      halfData[outIdx + 1] = floatToHalf(micro[idx]);
      halfData[outIdx + 2] = floatToHalf(gx);
      halfData[outIdx + 3] = floatToHalf(gy);
    }
  }

  return { size, data: halfData };
}
