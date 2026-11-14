#!/usr/bin/env node
/**
 * frame-score.mjs — 零依赖画面变化打分器（0–255）。判「这一帧和上一帧差多少」。
 *
 * ## 用途
 * 决定一帧值不值得传/存。静止画面给 0，光标移动 0.7，换一张照片 46~63。
 * 给 cua_capture 之类「一次调用一张图」的链路当闸门：分数不够就别调。
 *
 * ## 写死的口径（改之前先想清楚，别顺手调）
 *   - 在 64×36 网格上算，每格取 4 个采样点求平均（9k 次读，约 0.2ms）
 *   - HSV 三通道加权绝对差；色相按环形处理，低饱和像素的色相降权
 *   - `score = sum / (像素数 × 3)`，所以理论上限 255，实际很少过 70
 *   - 刻度（同一套代码实测，2560×1440 屏 → 800×450）：
 *       静止            0.00
 *       光标在静止画面   0.7
 *       只改亮度         5.3
 *       色调接近的照片  16~18
 *       滚网页/切窗口   30~42
 *       完全不同的照片  46~63
 *
 * ## 输入格式（三选一）
 *   `img <file...>`                PNG 原生解码（zlib，零依赖）；jpg/webp/其它交给本机 ffmpeg
 *   `raw --w 800 --h 450`          从 stdin 读 rgb24（ffmpeg -f rawvideo 直接管道进来）
 *   `watch --w 800 --h 450 --fps 12`  stdin 持续收帧，逐帧打分，一行一帧
 *
 * 任何模式都接 `--region`：`bottom:20%` / `top:30%` / `left:25%` / `right:25%` / `x,y,w,h`（像素）。
 * 只算框内区域的变化。读字幕用 `bottom:20%`：整屏不动也能可靠出帧，游戏画面炸开也不影响字幕判定。
 *
 * ## 用法（可直接抄）
 *   node frame-score.mjs img a.png b.png
 *   node frame-score.mjs img shot-*.png            # 相邻两两比
 *   ffmpeg -i a.png -f rawvideo -pix_fmt rgb24 - | node frame-score.mjs raw --w 800 --h 450
 *   ffmpeg -f lavfi -i testsrc2 -frames:v 40 -f rawvideo -pix_fmt rgb24 - \
 *     | node frame-score.mjs watch --w 320 --h 180 --fps 12
 *
 * ## 来源与许可
 * 判据与实现移植自 dsh-see-now 的 `src/cuts.js`（Copyright © 2026 SAOS-3624，
 * Apache License 2.0）。本文件是零依赖抽取版：去掉了包内耦合，没改任何阈值与权重。
 */

import { inflateSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

export const SCAN_W = 64;
export const SCAN_H = 36;
const CELLS = SCAN_W * SCAN_H;

/** 64×36 网格：每格取 4 个采样点求平均（降噪，且只花 9k 次读）。region 为像素视口，不给就是整帧。 */
export function gridRgb(rgb, width, height, out, region) {
  const rx = region ? region.x : 0;
  const ry = region ? region.y : 0;
  const rw = region ? region.w : width;
  const rh = region ? region.h : height;
  const sx = rw / SCAN_W;
  const sy = rh / SCAN_H;
  for (let gy = 0; gy < SCAN_H; gy += 1) {
    const y0 = ((gy + 0.25) * sy + ry) | 0;
    const y1 = ((gy + 0.75) * sy + ry) | 0;
    const r0 = y0 * width;
    const r1 = y1 * width;
    for (let gx = 0; gx < SCAN_W; gx += 1) {
      const x0 = ((gx + 0.25) * sx + rx) | 0;
      const x1 = ((gx + 0.75) * sx + rx) | 0;
      const a = (r0 + x0) * 3;
      const b = (r0 + x1) * 3;
      const c = (r1 + x0) * 3;
      const d = (r1 + x1) * 3;
      const i = gy * SCAN_W + gx;
      out[i * 3] = (rgb[a] + rgb[b] + rgb[c] + rgb[d]) * 0.25;
      out[i * 3 + 1] = (rgb[a + 1] + rgb[b + 1] + rgb[c + 1] + rgb[d + 1]) * 0.25;
      out[i * 3 + 2] = (rgb[a + 2] + rgb[b + 2] + rgb[c + 2] + rgb[d + 2]) * 0.25;
    }
  }
  return out;
}

/** RGB → HSV（各通道归一到 0–255，H 由角度缩放）。就地写进 out，不分配。 */
export function rgbToHsv(rgb, out) {
  for (let i = 0, j = 0; i < rgb.length; i += 3, j += 3) {
    const rn = rgb[i] / 255;
    const gn = rgb[i + 1] / 255;
    const bn = rgb[i + 2] / 255;
    const max = rn > gn ? (rn > bn ? rn : bn) : (gn > bn ? gn : bn);
    const min = rn < gn ? (rn < bn ? rn : bn) : (gn < bn ? gn : bn);
    const d = max - min;
    let h = 0;
    if (d !== 0) {
      if (max === rn) h = ((gn - bn) / d) % 6;
      else if (max === gn) h = (bn - rn) / d + 2;
      else h = (rn - gn) / d + 4;
      h *= 60;
      if (h < 0) h += 360;
    }
    out[j] = (h / 360) * 255;
    out[j + 1] = max === 0 ? 0 : (d / max) * 255;
    out[j + 2] = max * 255;
  }
  return out;
}

/**
 * `--region` 解析：`bottom:20%` / `top:30%` / `left:25%` / `right:25%` / `x,y,w,h`（像素）。
 * 返回归一化描述，不依赖画面尺寸 —— ffmpeg 侧用表达式渲染，图片侧再乘真实尺寸。
 */
export function parseRegionSpec(spec) {
  if (!spec) return null;
  const s = String(spec).trim();
  const m = /^(bottom|top|left|right)\s*:\s*(\d+(?:\.\d+)?)\s*%$/.exec(s);
  if (m) {
    const frac = Math.min(100, Math.max(1, Number(m[2]))) / 100;
    return { kind: m[1], frac };
  }
  const px = /^(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)$/.exec(s);
  if (px) return { kind: 'px', x: +px[1], y: +px[2], w: +px[3], h: +px[4] };
  throw new Error(`--region 写法不认识：${s}（用 bottom:20% / top:30% / left:25% / right:25% / x,y,w,h）`);
}

/** 归一化描述 → 像素矩形（图片侧）。 */
export function regionRect(spec, width, height) {
  const r = typeof spec === 'string' ? parseRegionSpec(spec) : spec;
  if (!r) return { x: 0, y: 0, w: width, h: height };
  if (r.kind === 'px') {
    const w = Math.min(r.w, width);
    const h = Math.min(r.h, height);
    return { x: Math.max(0, Math.min(r.x, width - w)), y: Math.max(0, Math.min(r.y, height - h)), w, h };
  }
  if (r.kind === 'bottom') return { x: 0, y: height - Math.round(height * r.frac), w: width, h: Math.round(height * r.frac) };
  if (r.kind === 'top') return { x: 0, y: 0, w: width, h: Math.round(height * r.frac) };
  if (r.kind === 'left') return { x: 0, y: 0, w: Math.round(width * r.frac), h: height };
  return { x: width - Math.round(width * r.frac), y: 0, w: Math.round(width * r.frac), h: height };
}

/** 归一化描述 → ffmpeg crop 表达式（采集侧，不需要知道屏幕尺寸）。 */
export function cropExpr(spec) {
  const r = typeof spec === 'string' ? parseRegionSpec(spec) : spec;
  if (!r) return null;
  const f = (n) => String(Number(n.toFixed(4)));
  if (r.kind === 'px') return `crop=${r.w}:${r.h}:${r.x}:${r.y}`;
  if (r.kind === 'bottom') return `crop=iw:ih*${f(r.frac)}:0:ih*${f(1 - r.frac)}`;
  if (r.kind === 'top') return `crop=iw:ih*${f(r.frac)}:0:0`;
  if (r.kind === 'left') return `crop=iw*${f(r.frac)}:ih:0:0`;
  return `crop=iw*${f(r.frac)}:ih:iw*${f(1 - r.frac)}:0`;
}

/** 两帧 HSV 的加权绝对差均值，0–255。色相按环形处理，低饱和像素的色相降权。 */
export function scorePair(prev, cur) {
  let sum = 0;
  for (let i = 0; i < cur.length; i += 3) {
    const dh = Math.abs(cur[i] - prev[i]);
    const hueDiff = Math.min(dh, 255 - dh);
    const hueWeight = Math.min(cur[i + 1], prev[i + 1]) / 255;
    sum += hueDiff * hueWeight
      + Math.abs(cur[i + 1] - prev[i + 1])
      + Math.abs(cur[i + 2] - prev[i + 2]);
  }
  return sum / ((cur.length / 3) * 3);
}

/**
 * 运动补偿：cur 的每个变化格，能不能在 prev 的 ±radius 邻域里找到近似匹配。
 *
 * 目的：整屏都在动（推镜、平移、换机位）时，`scorePair` 会给高分，但那不是"换了一张画面"。
 * 实测整屏平移 8 格：radius=2 误报 194，radius=4 只有 5。默认 radius=4。
 *
 * 返回（全部 0–255 / 0–1 归一）：
 *   score  变化格占比 ×255
 *   bbox   变化格包围盒面积占比 ×255
 *   fill   包围盒里的填充率（稀疏 UI 条 = 小，换页 = 大）
 *   spanY  包围盒高度占画面高度的比例
 *   box    网格坐标包围盒，没变化时为 null
 *
 * 口径移植自 dsh-see-now `src/cuts.js:mcStats`（Apache-2.0，阈值未改）。
 */
export function mcStats(prev, cur, { tau = 15, radius = 4 } = {}) {
  const n = CELLS;
  let changed = 0;
  let minX = SCAN_W;
  let minY = SCAN_H;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < SCAN_H; y += 1) {
    for (let x = 0; x < SCAN_W; x += 1) {
      const p3 = (y * SCAN_W + x) * 3;
      // 先测同位置：静止画面绝大多数格在这一步就命中，radius=4 时能省 40 次比较
      let matched = false;
      {
        const dh0 = Math.abs(cur[p3] - prev[p3]);
        const hd0 = dh0 < 255 - dh0 ? dh0 : 255 - dh0;
        const hw0 = (cur[p3 + 1] < prev[p3 + 1] ? cur[p3 + 1] : prev[p3 + 1]) / 255;
        matched = (hd0 * hw0 + Math.abs(cur[p3 + 1] - prev[p3 + 1]) + Math.abs(cur[p3 + 2] - prev[p3 + 2])) / 3 <= tau;
      }
      if (!matched) {
        for (let dy = -radius; dy <= radius && !matched; dy += 1) {
          const yy = y + dy;
          if (yy < 0 || yy >= SCAN_H) continue;
          for (let dx = -radius; dx <= radius; dx += 1) {
            if (dx === 0 && dy === 0) continue;
            const xx = x + dx;
            if (xx < 0 || xx >= SCAN_W) continue;
            const q3 = (yy * SCAN_W + xx) * 3;
            const dh = Math.abs(cur[q3] - prev[p3]);
            const hueDiff = Math.min(dh, 255 - dh);
            const hueWeight = Math.min(cur[q3 + 1], prev[p3 + 1]) / 255;
            if ((hueDiff * hueWeight + Math.abs(cur[q3 + 1] - prev[p3 + 1]) + Math.abs(cur[q3 + 2] - prev[p3 + 2])) / 3 <= tau) { matched = true; break; }
          }
        }
      }
      if (!matched) {
        changed += 1;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  const w = changed === 0 ? 0 : maxX - minX + 1;
  const h = changed === 0 ? 0 : maxY - minY + 1;
  return {
    score: (changed / n) * 255,
    bbox: ((w * h) / n) * 255,
    fill: changed === 0 ? 0 : changed / (w * h),
    spanY: h / SCAN_H,
    box: changed === 0 ? null : { x0: minX, y0: minY, x1: maxX, y1: maxY },
  };
}

/**
 * 背景模型：在最近几帧里找"一直没怎么动"的格（三通道极差 ≤ stableRange），
 * 再看当前帧把这些稳定格改掉了多少。
 *
 * 前景遮挡（手、勺子、弹窗）只盖住一部分背景，稳定格大部分还在 → score 小；
 * 真正换镜头会把旧背景整片换掉 → score 大。`stable` 太小（比如 <300）时 score 不可信。
 * history 是 Float32Array 的 HSV 帧数组，给最近 6 帧即可。
 *
 * 口径移植自 dsh-see-now `src/cuts.js:bgStats`（Apache-2.0，阈值未改）。
 */
export function bgStats(history, cur, { stableRange = 24, tau = 15 } = {}) {
  const n = CELLS;
  const m = history.length;
  if (m === 0) return { score: null, stable: 0, changed: 0 };
  const vals = new Float32Array(m);
  const half = m >> 1;
  let stable = 0;
  let changed = 0;
  for (let c = 0; c < n; c += 1) {
    const p = c * 3;
    let range = 0;
    let medR = 0;
    let medG = 0;
    let medB = 0;
    for (let ch = 0; ch < 3; ch += 1) {
      for (let j = 0; j < m; j += 1) vals[j] = history[j][p + ch];
      // m ≤ 8 用插入排序：比 TypedArray#sort 快一倍多
      for (let i = 1; i < m; i += 1) {
        const v = vals[i];
        let k = i - 1;
        while (k >= 0 && vals[k] > v) { vals[k + 1] = vals[k]; k -= 1; }
        vals[k + 1] = v;
      }
      const mid = vals[half];
      if (ch === 0) medR = mid; else if (ch === 1) medG = mid; else medB = mid;
      const r = vals[m - 1] - vals[0];
      if (r > range) range = r;
    }
    if (range > stableRange) continue;
    stable += 1;
    const dh = Math.abs(cur[p] - medR);
    const hd = dh < 255 - dh ? dh : 255 - dh;
    const hw = (cur[p + 1] < medG ? cur[p + 1] : medG) / 255;
    if ((hd * hw + Math.abs(cur[p + 1] - medG) + Math.abs(cur[p + 2] - medB)) / 3 > tau) changed += 1;
  }
  return { score: stable === 0 ? null : (changed / stable) * 255, stable, changed };
}

/**
 * 打分器：内部维护上一帧的 HSV。
 * 返回 `{ score, hsv }`，score 为 null 表示这是第一帧（没有前帧可比）。
 * **hsv 是复用的缓冲**，要留着就自己 `new Float32Array(s.hsv)` 拷一份。
 */
export function createScorer({ width, height, region = null }) {
  const rgb = new Float32Array(CELLS * 3);
  let prev = null;
  const cur = new Float32Array(CELLS * 3);

  return function score(frame) {
    gridRgb(frame, width, height, rgb, region);
    rgbToHsv(rgb, cur);
    const s = prev ? scorePair(prev, cur) : null;
    const tmp = prev ?? new Float32Array(CELLS * 3);
    tmp.set(cur);
    prev = tmp;
    return { score: s, hsv: cur };
  };
}

/** 把 HSV 缓冲压成可存盘的 Uint8Array（每通道 8 位足够判「变了没」）。 */
export function packHsv(hsv) {
  const out = new Uint8Array(CELLS * 3);
  for (let i = 0; i < out.length; i += 1) {
    const v = Math.round(hsv[i]);
    out[i] = v < 0 ? 0 : v > 255 ? 255 : v;
  }
  return out;
}

export function unpackHsv(buf) {
  const out = new Float32Array(CELLS * 3);
  for (let i = 0; i < out.length; i += 1) out[i] = buf[i];
  return out;
}

// ── PNG 解码：zlib + 反滤波。零依赖，够解 ffmpeg / 截图工具产出的 8/16 位 sRGB。 ──

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** @returns {{width:number,height:number,rgb:Buffer}} rgb24 */
export function decodePng(buf) {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG');
  let pos = 8;
  let ihdr = null;
  const idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    pos += 12 + len;
    if (type === 'IHDR') {
      ihdr = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        depth: data[8],
        colorType: data[9],
        interlace: data[12],
      };
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
  }
  if (!ihdr) throw new Error('PNG 缺 IHDR');
  const { width, height, depth, colorType, interlace } = ihdr;
  if (interlace !== 0) throw new Error('PNG 是隔行扫描，先过一遍 ffmpeg');
  if (depth !== 8 && depth !== 16) throw new Error(`PNG 位深 ${depth} 不支持（只做 8/16）`);
  const channels = colorType === 2 ? 3 : colorType === 6 ? 4 : 0;
  if (!channels) throw new Error(`PNG colorType ${colorType} 不支持（只做 2=RGB / 6=RGBA），先用 ffmpeg 转 rgb24`);
  if (depth === 16) throw new Error('PNG 16 位不直接解，先用 ffmpeg 转 8 位（-pix_fmt rgb24）');

  const raw = inflateSync(Buffer.concat(idat));
  const bpp = channels;
  const stride = width * channels;
  const out = Buffer.allocUnsafe(stride * height);
  let prevRow = Buffer.alloc(stride);
  let src = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[src];
    src += 1;
    const row = raw.subarray(src, src + stride);
    src += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x += 1) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prevRow[x];
      const c = x >= bpp ? prevRow[x - bpp] : 0;
      const v = row[x];
      cur[x] = (filter === 0 ? v
        : filter === 1 ? v + a
          : filter === 2 ? v + b
            : filter === 3 ? v + ((a + b) >> 1)
              : v + paeth(a, b, c)) & 0xff;
    }
    prevRow = cur;
  }
  if (channels === 3) return { width, height, rgb: out };
  const rgb = Buffer.allocUnsafe(width * height * 3);
  for (let i = 0, j = 0; i < out.length; i += 4, j += 3) {
    rgb[j] = out[i];
    rgb[j + 1] = out[i + 1];
    rgb[j + 2] = out[i + 2];
  }
  return { width, height, rgb };
}

/** 任意图片 → rgb24。PNG 走内置解码；其它格式交给本机 ffmpeg（找不到就报清楚）。 */
export function loadRgb(path, { ffmpeg = 'ffmpeg' } = {}) {
  const buf = readFileSync(path);
  if (buf.length > 8 && buf.readUInt32BE(0) === 0x89504e47) return decodePng(buf);
  const r = spawnSync(ffmpeg, ['-v', 'error', '-i', path, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
    { maxBuffer: 1 << 30 });
  if (r.error) throw new Error(`读不了 ${path}：不是 PNG，且找不到 ffmpeg（${r.error.message}）`);
  if (r.status !== 0) throw new Error(`ffmpeg 解不了 ${path}：${String(r.stderr).trim().slice(-200)}`);
  const probe = spawnSync(ffmpeg === 'ffmpeg' ? 'ffprobe' : ffmpeg.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1'),
    ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', path],
    { encoding: 'utf8' });
  const m = /(\d+),(\d+)/.exec(String(probe.stdout || '').trim());
  if (!m) throw new Error(`拿不到 ${path} 的尺寸`);
  const width = Number(m[1]);
  const height = Number(m[2]);
  if (r.stdout.length !== width * height * 3) {
    throw new Error(`${path} 像素数对不上：${r.stdout.length} vs ${width}×${height}×3`);
  }
  return { width, height, rgb: r.stdout };
}

// ── CLI ──

function fmt(n) { return n === null ? '  —  ' : n.toFixed(2).padStart(6); }

function main(argv) {
  const [mode, ...rest] = argv;
  const opt = (name, def) => {
    const i = rest.indexOf(`--${name}`);
    return i >= 0 && rest[i + 1] !== undefined ? rest[i + 1] : def;
  };
  if (mode === 'img') {
    const list = rest.filter((a) => /\.(png|jpe?g|webp|bmp)$/i.test(a));
    if (list.length === 0) throw new Error('给几个图片路径：node frame-score.mjs img a.png b.png');
    let prev = null;
    let prevName = null;
    const regionSpec = opt('region', null);
    for (const f of list) {
      const { width, height, rgb } = loadRgb(f, { ffmpeg: opt('ffmpeg', 'ffmpeg') });
      const rect = regionRect(regionSpec, width, height);
      if (rect.w < SCAN_W || rect.h < SCAN_H) {
        throw new Error(`--region 太小：${rect.w}×${rect.h}，网格是 ${SCAN_W}×${SCAN_H}`);
      }
      const hsv = rgbToHsv(gridRgb(rgb, width, height, new Float32Array(CELLS * 3), regionSpec ? rect : null), new Float32Array(CELLS * 3));
      if (prev) {
        // 尺寸不同就没有可比性，直接说清楚而不是给一个看着像真的数
        if (prev.width !== width || prev.height !== height) {
          console.log(`${prevName} → ${f}`);
          console.log(`  跳过：尺寸不同（${prev.width}×${prev.height} vs ${width}×${height}），先缩到同一尺寸再比`);
        } else {
          console.log(`${prevName} → ${f}  ${fmt(scorePair(prev.hsv, hsv))}  (${width}×${height})`);
        }
      }
      prev = { width, height, hsv };
      prevName = f;
    }
    return;
  }

  if (mode === 'raw' || mode === 'watch') {
    const width = Number(opt('w', 0));
    const height = Number(opt('h', 0));
    if (!width || !height) throw new Error('要给 --w 和 --h（和上游 ffmpeg 的 scale 一致）');
    const need = width * height * 3;
    const regionSpec = opt('region', null);
    const score = createScorer({ width, height, region: regionSpec ? regionRect(regionSpec, width, height) : null });
    let pending = Buffer.alloc(0);
    let i = 0;
    process.stdin.on('data', (chunk) => {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      while (pending.length >= need) {
        const buf = pending.subarray(0, need);
        pending = pending.subarray(need);
        const { score: s } = score(buf);
        if (mode === 'watch') console.log(JSON.stringify({ i, t: +(i / Number(opt('fps', 12))).toFixed(3), score: s }));
        else if (s !== null || i === 0) console.log(JSON.stringify({ i, score: s }));
        i += 1;
      }
    });
    process.stdin.on('end', () => { if (i === 0) console.log(JSON.stringify({ i: 0, score: null, error: `stdin 不到一帧（需要 ${need} 字节/帧）` })); });
    return;
  }

  console.log(`frame-score — 64×36 HSV 变化分（0–255）

  node frame-score.mjs img a.png b.png [c.png ...]        相邻两两打分
  node frame-score.mjs img a.png b.png --region bottom:20%  只看底部 20%
  node frame-score.mjs raw --w 800 --h 450 --region bottom:20%  stdin 读一帧（只看底部 20%）
  node frame-score.mjs watch --w 800 --h 450 --fps 12     stdin 连续读帧，一行一帧

刻度：静止 0.00 · 光标 0.7 · 淡色照片 16~18 · 滚屏/切窗 30~42 · 换照片 46~63`);
}

if (process.argv[1]?.endsWith('frame-score.mjs')) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error(`frame-score: ${e.message}`);
    process.exitCode = 1;
  }
}
