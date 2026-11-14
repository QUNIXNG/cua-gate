#!/usr/bin/env node
/**
 * cua-gate.mjs — 给 cua_capture 装一道闸门：先算变化分，够大才值得留/才值得看。
 *
 * ## 为什么要有它
 * `cua_capture` 一次调用 = 一张图进模型上下文。盯着屏幕看变化的循环里，
 * 大部分调用拿回来的是「和上一张几乎一样」——纯烧钱。闸门在交图之前判一次：
 * 屏幕没变就别留、别读。
 *
 * ## 两条取图路径（同一条判分口径）
 *   - 默认：自己用 ffmpeg 采同一块屏幕（798×450 / rgb24 / 12fps），零额外依赖
 *   - `--mcp`：走 `cua_capture` 本身（HTTP MCP），判完只把值得看的那张落盘
 *     token：`PIDECK_CUA_TOKEN` 优先，没有就回退读 `~/.pi/agent/mcp.json` 的
 *     `mcpServers.pideck-cua.headers.Authorization`（只读、不打印、不写回）。
 *     取图默认长边 798，与默认采集同口径 —— 两种路径能比同一份状态。
 *
 * ## 写死的口径
 *   - 采集 798×450 / rgb24 / 12fps（和 dsh-see-now 同一条口径，分数刻度可比；798 是 42px 对齐后的宽度）
 *   - 变化分 = 64×36 网格 HSV 加权绝对差（frame-score.mjs，0–255）
 *   - 三档 preset（`--profile`），每个字段都能单独覆盖：
 *
 *       profile    cut  peakMul/peakAbs   accNeed  cooldown  burst/burstWindow  silentFloor  maxWait
 *       video      12   1.5× / ≥30        144      4s        2 / 15s            20s          60s
 *       game       80   1.5× / ≥30        1800     40s       1 / 10s            40s          120s
 *       subtitle   12   关                300      8s        1 / 20s            20s          60s
 *
 *     game 档的值来自评论区一位全屏动作游戏用户的实测报告（cutAbs 80 / 尖峰 1.5×且≥30 /
 *     积分 1800 / silentFloor 40s / maxWait 120s）；video 档沿用 dsh-see-now 默认。
 *     subtitle 档的 accNeed 300 是视频档与游戏档之间插的值，不是实测。
 *
 *   - 双判据：**尖峰**（单帧过 cut，且 > peakMul×上一帧分，且 ≥peakAbs）或 **积分**（acc 累加够 accNeed）。
 *     再加两条时间兜底：静默 silentFloor 秒且有微小变化 → floor；距上一帧 maxWait 秒 → maxwait（这两条不受 cooldown/burst 限制）。
 *   - burst：一轮 burstWindow 秒内最多连续出 burst 张，防止画面剧烈时刷屏（只在单次 watch 内生效）
 *   - `--region`：只算框内变化，`bottom:20%` / `top:30%` / `left:25%` / `right:25%` / `x,y,w,h`（像素）
 *     px 一律按**原图坐标**（屏幕 2560×1440 / 视频文件原始尺寸），--mcp 采的缩图会按比例换算
 *   - 「上一次值得看的帧」压成 6912 字节去比，所以静止画面连续调用分数稳定不漂
 *   - 状态存 `cua-gate.state.json`（含 acc / 上次出帧时间 / region；region 变了就当成没基线）
 *   - `tap` 发完输入会把状态文件删掉：你刚改过画面，旧基线已经不作数，下一帧按 first 判（必出），
 *     否则跳转后只能靠积分慢慢攒（实测跳一次 38.71 < 144，自动判会 skip）。
 *
 * ## 用法（可直接抄）
 *   node cua-gate.mjs once                         # 采一帧判一次，打印 JSON
 *   node cua-gate.mjs once --profile game          # 动作游戏档（cut 80 / 积分 1800）
 *   node cua-gate.mjs watch --profile auto --duration 60   # 按画面自己选档位（底带独大变→subtitle，三带齐动→game）
 *   node cua-gate.mjs once --region bottom:20%     # 只看底部 20%（读字幕）
 *   node cua-gate.mjs once --force --out now.png   # 无视门槛永远 keep，并存图
 *   node cua-gate.mjs once --full --out now.png   # keep 时按**原分辨率**重采一张（字能看清）
 *   node cua-gate.mjs once --display 1            # 看第二块屏（0 = 主屏）
 *   node cua-gate.mjs watch --profile subtitle --region bottom:20% --duration 120
 *   node cua-gate.mjs scan --duration 60 --cells 16 --out p1.png   # 两遍扫描第一遍（屏幕，4×4 联系表）
 *   node cua-gate.mjs scan --file ep.mp4 --from 900 --to 960 --cells 16 --out p2.png  # 第二遍（文件，只扫那一段）
 *   node cua-gate.mjs probe                        # 只查 MCP 在哪、通不通
 *
 * 输出每行一个 JSON：
 *   {"at":"18:52:01","src":"ddagrab","score":31.4,"verdict":"keep","min":12,"png":null}
 *
 * ## 采集引擎
 * Windows ddagrab（失败自动退 gdigrab）/ macOS avfoundation / Linux x11grab。
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync, renameSync, mkdtempSync, rmSync, statSync, copyFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir, homedir } from 'node:os';
import { join, basename } from 'node:path';
import { packHsv, unpackHsv, createScorer, scorePair, mcStats, bgStats, loadRgb, parseRegionSpec, regionRect, cropExpr, SCAN_W, SCAN_H } from './frame-score.mjs';

/**
 * 采集宽默认 798，不是 800 —— **42px 对齐**。
 *
 * 宿主按 42 像素一格计价：`token = rows × (cols + 1) + 2`，`cols = ceil(w / 42)`。
 * 800 只用到 19 格却按 20 格收费（19×42 = 798 就到顶），每晚 40px 白扔一整列：
 *   800×450 → 11×21+2 = 233 token
 *   798×450 → 11×20+2 = 222 token（-11）
 * 高 450 保持不动（11 格仍是 462 的向下取整，再降要看是否够判变化）。
 * 换宽度会让旧基线作废（readState 校验 w/h），首次调用重走 `first` 建基线，属正常。
 */
export const DEFAULT_W = 798;
export const DEFAULT_H = 450;
export const DEFAULT_MIN = 12;

/**
 * 三档 preset。game 的值来自评论区实测；video 沿用 dsh-see-now 默认；subtitle 的 accNeed 是插值。
 * peakMul <= 0 表示关掉尖峰判据。
 */
/**
 * 自动档位的判据（只用于选档位，**不参与出帧判据**）。
 * 两轴：底带占比（局部字幕式变化）与三带平均变化（满屏都在动 = 动作类内容）。
 * 阈值是先给一个能工作的值，再用 --stats 在真素材上看，偏了就调这里。
 */
export const AUTO = {
  subShare: 0.55, // 进字幕档：底带变化 / 三带总和 超过它
  subExitShare: 0.35, // 出字幕档：掉到它以下才算走（迟滞，防在两档之间抖）
  subMotion: 1.5, // 底带还得真在变（防止静态画面被当成字幕）；实测底部 1/4 画面在动 ≈ 5，整屏在动 ≈ 9+
  gameMotion: 14, // 三带平均变化超过它，且三带都不弱 → 动作型
  gameBalance: 0.45, // 三带里最小值 / 最大值（满屏在动才会高）
  holdFrames: 72, // 连续多少帧同向才切（12fps ≈ 6s），防在两种类型之间来回跳
};

/** 上/中/下三条带的平均变化（只看变化形状，不看亮度绝对值）。 */
export function bandStats(prev, cur) {
  if (!prev || !cur || prev.length !== cur.length) return null;
  const rows = SCAN_H / 3;
  const acc = [0, 0, 0];
  const cnt = [0, 0, 0];
  for (let y = 0; y < SCAN_H; y++) {
    const band = y < rows ? 0 : y < rows * 2 ? 1 : 2;
    for (let x = 0; x < SCAN_W; x++) {
      const i = (y * SCAN_W + x) * 3;
      const dh = Math.abs(cur[i] - prev[i]);
      acc[band] += (Math.min(dh, 255 - dh) + Math.abs(cur[i + 1] - prev[i + 1]) + Math.abs(cur[i + 2] - prev[i + 2])) / 3;
      cnt[band] += 1;
    }
  }
  const [top, mid, bottom] = acc.map((a, i) => a / cnt[i]);
  const sum = top + mid + bottom;
  const hi = Math.max(top, mid, bottom);
  return { top, mid, bottom, share: sum > 0 ? bottom / sum : 0, motion: sum / 3, balance: hi > 0 ? Math.min(top, mid, bottom) / hi : 0 };
}

/** 标题像浏览器/播放器——那怕铺满屏也不是游戏。 */
const PLAYER_TITLE_RE = /chrome|edge|firefox|brave|opera|vivaldi|bilibili|哔哩|youtube|mpv|potplayer|vlc|迅雷|爱奇艺|优酷|腾讯视频|播放器/i;

/**
 * 前台窗口像不像「全屏游戏」：铺满屏幕，且标题不是浏览器/播放器。
 * 像素统计分不出「看视频」和「打游戏」（两者都在持续变化），窗口信息可以。
 */
export async function foregroundGame(ep, token) {
  const call = await mcpSession(ep.url, token);
  const st = await call('cua_get_state', {});
  const fg = st?.foregroundWindow;
  if (!fg?.rect) return { game: false, full: false, title: null };
  const scr = st.display ?? { width: fg.rect.width, height: fg.rect.height };
  const full = fg.rect.width >= scr.width * 0.95 && fg.rect.height >= scr.height * 0.9;
  return { game: full && !PLAYER_TITLE_RE.test(fg.title ?? ''), full, title: fg.title ?? null };
}

/** 一帧在哪个类别：subtitle / game / video。有前台窗口信息时只信它，否则退回像素判据。 */
export function classifyAuto(s, fg = null, cur = null) {
  if (!s) return 'video';
  // 迟滞：已经在字幕档时用更低的门槛退出，避免两档之间来回跳
  const subThresh = cur === 'subtitle' ? AUTO.subExitShare : AUTO.subShare;
  // 全屏游戏窗口不判字幕：游戏 HUD 也常在底部，会和字幕撞
  if ((!fg || !fg.game) && s.share >= subThresh && s.bottom >= AUTO.subMotion) return 'subtitle';
  if (fg) return fg.game ? 'game' : 'video';
  if (s.motion >= AUTO.gameMotion && s.balance >= AUTO.gameBalance) return 'game';
  return 'video';
}

export const PROFILES = {
  // video：burst 2/15s 实测有效 —— 同一段 600s 素材，burst∞ 出 150 帧，burst2 出 80 帧（-47%），
  //        代价是最大间隔从 4s 拉到 11s。
  video: { cut: 12, peakMul: 1.5, peakAbs: 30, accNeed: 144, cooldown: 4, burst: 2, burstWindow: 15, silentFloor: 20, maxWait: 60, floorMin: 0.5, guard: true },
  // game：burst 实测**永不生效**（cooldown 40 > burstWindow 10，最近 10 秒永远 0 张；
  //       且 floor 要 40s 静默、maxwait 要 120s，都不可能在 40s 内出第二张）。
  //        实测：burst 1/10、8/10、15/600、∞/600 四组在 600s 素材上都是 15 帧、间隔恒 40s。
  //        保留字段只为三档结构统一，别把它当防刷屏。
  game: { cut: 80, peakMul: 1.5, peakAbs: 30, accNeed: 1800, cooldown: 40, burst: 1, burstWindow: 10, silentFloor: 40, maxWait: 120, floorMin: 1.0, guard: true },
  // subtitle：burst 1/20 会把 cooldown 8s 完全遮住（实测 30s 只出 2 张、间隔恒 20s，acc 爬到 8577），
  //          改成 3/20 后节奏才是「约 6~7 秒一张」，cooldown 8s 仍然只当兜底。
  // subtitle 关掉 guard（guard: false）：字幕本来就是"低分持续累积"，加运动补偿闸门会永远凑不满 acc。
  subtitle: { cut: 12, peakMul: 0, peakAbs: 0, accNeed: 300, cooldown: 8, burst: 3, burstWindow: 20, silentFloor: 20, maxWait: 60, floorMin: 0.2, guard: false },
};

/**
 * 切点 guard：峰值判定之外再加两道闸门，免得"同一场景在动"被当成换画面。
 * 口径移植自 dsh-see-now `src/cuts.js`（Apache-2.0），阈值沿用它的实测值。
 *
 *   ① 运动补偿闸门：整屏平移/推镜时 prev 的 ±radius 格内能找到匹配，就不算切点。
 *      实测整屏平移 8 格：radius=2 误报 194 次，radius=4 只有 5 次。
 *   ② 前景守卫：最近 6 帧里一直没动的背景格，被当前帧改掉多少。手/弹窗/遮挡只盖住
 *      一部分背景（score 小、changed 少），真换镜头会把旧背景整片换掉。
 *      稳定格少于 minStable 时 score 不可信，直接跳过这道闸门。
 *   ③ 换机位放行：score ≥ camSwitchScore 且 mc ≥ camSwitch 视为大范围重构（换镜头/换页），放行。
 */
export const GUARD = {
  radius: 4, history: 6,
  mcSpikeAbs: 20, camSwitch: 60, camSwitchScore: 6,
  bgAbs: 100, bgMaxChanged: 600, bgSpanY: 0.85, bgMinStable: 300,
  tau: 15, stableRange: 24,
};

export function resolveProfile(name, overrides = {}) {
  const base = PROFILES[name] ?? PROFILES.video;
  const p = { ...base, name: PROFILES[name] ? name : 'video' };
  for (const [k, v] of Object.entries(overrides)) if (v !== undefined && v !== null && !Number.isNaN(v)) p[k] = v;
  return p;
}
const STATE = process.env.CUA_GATE_STATE || 'cua-gate.state.json';
const CELLS = SCAN_W * SCAN_H;
const FRAME_BYTES = DEFAULT_W * DEFAULT_H * 3;

/** 采集命令。纯函数，便于换平台/换引擎。frames=null 表示持续出帧（不加 -frames:v）。 */
export function captureArgs({
  fps = 12, width = DEFAULT_W, height = DEFAULT_H, engine = 'auto', platform = process.platform,
  frames = 1, out = null, region = null, scale = true, display = 0,
  file = null, start = null, duration = null, pre = [], post = [], fit = null,
} = {}) {
  const args = ['-hide_banner', '-v', 'error', '-nostdin'];
  const filters = [];
  if (file) {
    // 文件输入：-ss/-t 放 -i 前面是「输入侧」，不解码整段，快
    if (start) args.push('-ss', String(start));
    if (duration) args.push('-t', String(duration));
    args.push('-i', file);
  } else if (platform === 'win32') {
    if (engine === 'gdigrab') {
      args.push('-f', 'gdigrab', '-framerate', String(fps), '-draw_mouse', '1', '-i', 'desktop');
    } else {
      args.push('-f', 'lavfi', '-i', `ddagrab=framerate=${fps}:draw_mouse=1${display ? `:output_idx=${display}` : ''}`);
      filters.push('hwdownload', 'format=bgra');
    }
  } else if (platform === 'darwin') {
    args.push('-f', 'avfoundation', '-framerate', String(fps), '-capture_cursor', '1', '-i', `Capture screen ${display}:none`);
  } else {
    args.push('-f', 'x11grab', '-framerate', String(fps), '-i', `${process.env.DISPLAY || ':0.0'}${display ? `.${display}` : ''}`);
  }
  // 屏幕侧 -t 放输出侧：录这么久就停
  if (duration && !file) args.push('-t', String(duration));
  // 文件要重采样到同一帧率再用（否则 24fps 素材会按 12fps 的钟算，冷却/积分全错一倍；
  // 而且真采集是 12fps，逐帧差分只在这个帧率下才和屏幕分数刻度一致）。
  if (file) filters.push(`fps=${fps}`);
  filters.push(...pre);
  // 先裁再缩：裁到 288 px 高再缩回 450，等于纵向放大 1.56×，字幕在 64×36 网格里占的格子变多
  const crop = region ? cropExpr(region) : null;
  if (crop) filters.push(crop);
  // 文件来源的长宽比往往不是 16:9（竖屏、4:3）：直接 scale 会拉扭，分数就没意义了。
  // 所以文件模式默认按比例缩 + 黑边补齐；屏幕采集仍直接缩（显示器本来就是屏幕比例）。
  const doFit = fit ?? Boolean(file);
  if (scale) {
    filters.push(doFit
      ? `scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=area,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`
      : `scale=${width}:${height}:flags=area`);
  }
  filters.push(...post);
  if (filters.length) args.push('-vf', filters.join(','));
  if (platform === 'darwin') args.push('-r', String(fps)); // avfoundation 的 -framerate 不压速，见 dsh-see-now 的坑①
  if (frames !== null) args.push('-frames:v', String(frames));
  if (out) args.push('-y', out);
  else args.push('-f', 'rawvideo', '-pix_fmt', 'rgb24', '-');
  return { args };
}

/** 时间戳一律本地时间，别一边 UTC 一边本地（踩过：baseline 显示 10:52 而 at 显示 18:52）。 */
function stamp() { return new Date().toTimeString().slice(0, 8); }

function readState(region = '') {
  try {
    const j = JSON.parse(readFileSync(STATE, 'utf8'));
    if (!j.hsv || j.w !== DEFAULT_W || j.h !== DEFAULT_H) return null;
    if ((j.region ?? '') !== (region ?? '')) return null; // 换了区域，两份分数不可比
    return {
      hsv: unpackHsv(Buffer.from(j.hsv, 'base64')), hsvB64: j.hsv,
      // raw = 上一次**判过**的帧（不管出没出帧），只用来算运动补偿；老状态文件没有这个字段
      raw: j.raw ? unpackHsv(Buffer.from(j.raw, 'base64')) : null,
      at: j.at ?? null, ms: j.ms ?? null, score: j.score ?? null,
      acc: j.acc ?? 0, lastFrame: j.lastFrame ?? null,
    };
  } catch { return null; }
}

function writeState(prev, { hsv = null, raw = null, score = 0, acc = 0, lastFrame = null, ms = 0, region = '' } = {}) {
  try {
    const hsvB64 = hsv ? Buffer.from(packHsv(hsv)).toString('base64') : prev?.hsvB64 ?? null;
    if (!hsvB64) return;
    // raw 每帧覆盖（不是只存出帧那张），否则运动补偿永远比自己比
    const rawB64 = raw ? Buffer.from(raw).toString('base64') : prev?.rawB64 ?? null;
    writeFileSync(STATE, JSON.stringify({
      w: DEFAULT_W, h: DEFAULT_H, at: stamp(), ms, score: +Number(score).toFixed(2),
      acc: +Number(acc).toFixed(2), lastFrame, region, hsv: hsvB64,
      ...(rawB64 ? { raw: rawB64 } : {}),
    }));
  } catch { /* 写不了只是每次都要重新判首帧，不影响判分 */ }
}

/** 采一帧，返回 rgb24 Buffer。失败抛错并带上可读原因。 */
function grab({ engine = 'auto', ffmpeg = 'ffmpeg', region = null, display = 0 } = {}) {
  const run = (args) => spawnSync(ffmpeg, args, { maxBuffer: 1 << 30 });
  let r = run(captureArgs({ engine, region, display }).args);  let used = process.platform === 'win32' && engine !== 'gdigrab' ? 'ddagrab' : 'native';
  // ddagrab 在非 Win10 2004+ / 远程桌面 / 无 DDA 的机器上会整条挂掉 —— 退 gdigrab 再来一次
  if ((r.error || r.status !== 0) && engine === 'auto' && process.platform === 'win32') {
    const why = r.error ? r.error.message.slice(-80) : String(r.stderr).trim().slice(-120);
    r = run(captureArgs({ engine: 'gdigrab', region, display }).args);
    used = 'gdigrab';
    if (!r.error && r.status === 0) {
      // gdigrab 没有 output_idx，退过去就拍不到指定的那块屏 —— 必须说出来，不能静默给主屏
      return { engine: used, buf: r.stdout, ...(display > 0 ? { warning: `display ${display} 不可用（ddagrab: ${why}），已退化到 gdigrab，拍的是主屏` } : {}) };
    }
  }
  if (r.error) throw new Error(`找不到 ffmpeg（${r.error.message}）—— 装一个或设 FFMPEG_PATH`);
  if (r.status !== 0) throw new Error(`采集失败：${String(r.stderr).trim().slice(-300)}`);
  if (r.stdout.length !== FRAME_BYTES) throw new Error(`拿到 ${r.stdout.length} 字节，不是一帧 ${DEFAULT_W}×${DEFAULT_H} rgb24（${FRAME_BYTES}）`);
  return { engine: used, buf: r.stdout };
}

/**
 * 原分辨率截图：不加 scale，让 ffmpeg 直接写 PNG。
 * 798×450 是拿来判变化的，字看不清；要真把图给模型读，得用这个。
 * 代价是多一次采集（约 0.4 s），所以只在 keep 且要 `--full` 时才跑。
 */
function grabFull({ ffmpeg = 'ffmpeg', display = 0, out }) {
  const r = spawnSync(ffmpeg, captureArgs({ frames: 1, out, scale: false, display }).args, { maxBuffer: 1 << 26 });
  if (r.error) throw new Error(`找不到 ffmpeg（${r.error.message}）`);
  if (r.status !== 0) throw new Error(`原分辨率截图失败：${String(r.stderr).trim().slice(-300)}`);
  return out;
}

/** 把内存里的 rgb24 写成 PNG（复用同一次采集，不再抓第二遍）。 */
function writePng(buf, out, ffmpeg = 'ffmpeg', w = DEFAULT_W, h = DEFAULT_H) {
  const r = spawnSync(ffmpeg, ['-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24',
    '-s', `${w}x${h}`, '-i', '-', '-y', out], { input: buf });
  if (r.error || r.status !== 0) throw new Error(`写 PNG 失败：${String(r.stderr).trim().slice(-200)}`);
  return out;
}

/**
 * 双判据 + 时间兜底。J 是可变状态（acc / prevKept / prevFrameScore / lastEmit / emissions）。
 * why ∈ first | force | cut | acc | floor | maxwait | null。floor / maxwait 不受 cooldown、burst 限制
 * （它们本身就是时间触发的，而且阈值远大于 cooldown，再卡一道只会让静止画面永远出不来帧）。
 */
export function judgeFrame(J, { score, hsv, now, force = false, mc = null, bg = null }) {
  const p = J.profile;
  let why = null;

  if (force) why = 'force';
  else if (score === null) why = 'first';
  else {
    let isCut = score >= p.cut && score >= p.peakAbs
      && (p.peakMul <= 0 || score > p.peakMul * Math.max(1, J.prevFrameScore ?? 0));
    // ── 切点 guard（只在有 prev 帧、且该档位开了 guard 时才生效）──
    if (isCut && p.guard !== false && mc) {
      const bigSwitch = score >= GUARD.camSwitchScore && mc.score >= GUARD.camSwitch;
      // ① 运动补偿：整屏平移能对上邻格的不算切点
      if (mc.score < GUARD.mcSpikeAbs && !bigSwitch) isCut = false;
      // ② 前景守卫：稳定背景几乎没被改 → 是前景在动（手/弹窗），不是换画面
      if (isCut && bg && bg.score !== null && bg.stable >= GUARD.bgMinStable
        && bg.score < GUARD.bgAbs && bg.changed <= GUARD.bgMaxChanged && mc.spanY < GUARD.bgSpanY) isCut = false;
    }
    J.acc += score;
    if (isCut) why = 'cut';
    else if (J.acc >= p.accNeed) why = 'acc';
    if (!why && J.lastEmit != null) {
      const silent = (now - J.lastEmit) / 1000;
      if (silent >= p.silentFloor && score >= p.floorMin) why = 'floor';
      else if (J.prevKept && silent >= p.maxWait && score >= p.floorMin) why = 'maxwait';
    }
  }

  if (why && !['first', 'force', 'floor', 'maxwait'].includes(why)) {
    if (J.lastEmit != null && now - J.lastEmit < p.cooldown * 1000) why = null;
    else if (J.emissions.filter((t) => now - t < p.burstWindow * 1000).length >= p.burst) why = null;
  }

  J.prevFrameScore = score ?? J.prevFrameScore;
  if (why) {
    if (hsv) J.prevKept = new Float32Array(hsv);
    J.acc = 0;
    J.lastEmit = now;
    J.emissions.push(now);
    if (J.emissions.length > 64) J.emissions = J.emissions.slice(-64);
  }
  return { fire: Boolean(why), why, acc: +J.acc.toFixed(2), ...(mc ? { mc: +mc.score.toFixed(1) } : {}), ...(bg && bg.score !== null ? { bg: +bg.score.toFixed(1), stable: bg.stable } : {}) };
}

/** 从磁盘状态起重开一个判分器（once 模式每次都新生）；burst 窗口不持久化，只在单次 watch 内生效。 */
function seat(prev, profile) {
  return {
    profile,
    prevKept: prev?.hsv ?? null,
    // 上一次**判过**的帧（不是上一次出帧），给运动补偿用；没有就 null（首帧/换档）
    prevHsv: prev?.raw ?? null,
    history: [],
    acc: prev?.acc ?? 0,
    prevFrameScore: prev?.lastFrame ?? null,
    lastEmit: prev?.ms ?? null,
    emissions: [],
  };
}

// ── CUA MCP（streamable HTTP）：只用来取图，不做别的 ──

/**
 * 本地可能挂着服务的端口。netstat 靠不住：PiDeck 的 CUA 端口 57766 在 `netstat -ano` 里
 * **根本不显示 LISTENING**（能 curl 通、有 ESTABLISHED 对端），只从 LISTENING 里扫会扫不到。
 * 所以两种都收：LISTENING 的本地端口 + 回环上 ESTABLISHED 的对端端口。
 */
function candidatePorts() {
  const r = spawnSync('netstat', ['-ano'], { encoding: 'utf8', windowsHide: true, maxBuffer: 1 << 24 });
  const ports = new Set();
  for (const line of String(r.stdout || '').split(/\r?\n/)) {
    if (/\bLISTENING\b/i.test(line)) {
      const m = /\bTCP\s+(?:127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):(\d+)/i.exec(line);
      if (m) ports.add(Number(m[1]));
    } else if (/\bESTABLISHED\b/i.test(line)) {
      const m = /\bTCP\s+\S+\s+(?:127\.0\.0\.1|\[::1?\]):(\d+)/i.exec(line);
      if (m) ports.add(Number(m[1]));
    }
  }
  ports.delete(445);
  // 经验值：PiDeck 的 CUA 端口就在 MODEL_TRACE 端口 +1 上（5765→5766），排前面先试
  const trace = /:(\d+)\/trace\//.exec(process.env.PIDECK_MODEL_TRACE_URL || '');
  if (trace) {
    ports.delete(Number(trace[1]) + 1);
    return [Number(trace[1]) + 1, ...ports];
  }
  return [...ports];
}

async function rpcBody(res) {
  const ct = res.headers.get('content-type') || '';
  const text = await res.text();
  if (ct.includes('text/event-stream')) {
    let found = null;
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      try {
        const j = JSON.parse(line.slice(5).trim());
        if (j && (j.result !== undefined || j.error !== undefined)) found = j;
      } catch { /* 心跳/空行 */ }
    }
    if (!found) throw new Error('SSE 流里没有 JSON-RPC 响应');
    return found;
  }
  try { return JSON.parse(text); } catch { throw new Error(`MCP 回了非 JSON：${text.slice(0, 200)}`); }
}

const INIT = {
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'cua-gate', version: '0.2.0' } },
};

/** 这个端口是不是 MCP：401（要 token）或 200 带 jsonrpc 都算。 */
async function probePort(port, token) {
  const url = `http://127.0.0.1:${port}/mcp`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(INIT),
      signal: AbortSignal.timeout(700),
    });
    if (res.status === 401) return { url, auth: true };
    if (res.status === 200) {
      const j = await rpcBody(res);
      if (j?.result?.protocolVersion || j?.result?.serverInfo) return { url, auth: false };
    }
    return null;
  } catch { return null; }
}

/**
 * 从 pi 自己的 MCP 配置里取 cua 的 token（只读，从不打印、从不写回）。
 * pi 把服务凭据存在 `~/.pi/agent/mcp.json` 的 `mcpServers.<name>.headers.Authorization` 里。
 * 两条路都支持：环境变量优先（`PIDECK_CUA_TOKEN`），没有就回退到这里。
 */
function tokenFromPiConfig() {
  const p = join(homedir(), '.pi', 'agent', 'mcp.json');
  let j;
  try { j = JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
  const servers = j?.mcpServers ?? j?.servers ?? {};
  const pick = (name) => {
    const h = servers?.[name]?.headers?.Authorization ?? servers?.[name]?.headers?.authorization;
    if (!h) return null;
    const m = /^Bearer\s+(.+)$/i.exec(h);
    return { token: (m ? m[1] : h).trim(), source: `mcp.json:${name}` };
  };
  const direct = pick('pideck-cua');
  if (direct) return direct;
  for (const name of Object.keys(servers)) {
    const hit = pick(name);
    if (hit && /cua/i.test(name)) return hit;
  }
  return null;
}

/** 找 CUA 的 MCP 端点：环境变量优先，否则扫本地在听的端口。 */
export async function findCuaMcp({ env = process.env } = {}) {
  if (env.PIDECK_CUA_MCP_URL) return { url: env.PIDECK_CUA_MCP_URL, source: 'env' };
  const ports = candidatePorts();
  const hits = (await Promise.all(ports.map((p) => probePort(p, env.PIDECK_CUA_TOKEN)))).filter(Boolean);
  if (hits.length === 0) throw new Error(`扫了 ${ports.length} 个本地端口都没答 MCP：设 PIDECK_CUA_MCP_URL（形如 http://127.0.0.1:57766/mcp）`);
  // 要 token 的那个才是 CUA（另一个 18810 是模型代理，/mcp 会 404）
  const pick = hits.find((h) => h.auth) ?? hits[0];
  return { url: pick.url, source: `${pick.auth ? 'scan(需 token)' : 'scan'}，扫了 ${ports.length} 个端口` };
}

/** 调一次 cua_capture，返回解码后的 {width,height,rgb}。 */
/** 开一个 MCP 会话，返回 call(name, args)；cua_capture 和 cua_get_state 共用。 */
async function mcpSession(url, token) {
  if (!token) throw new Error('没有 token：先 set PIDECK_CUA_TOKEN=...（PowerShell: $env:PIDECK_CUA_TOKEN="..."）');
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    authorization: `Bearer ${token}`,
  };
  const init = await fetch(url, { method: 'POST', headers, body: JSON.stringify(INIT) });
  if (init.status === 401) throw new Error('401：token 不对或过期');
  if (!init.ok) throw new Error(`initialize 失败：HTTP ${init.status}`);
  const sessionId = init.headers.get('mcp-session-id');
  await rpcBody(init).catch(() => null);
  const h2 = { ...headers, ...(sessionId ? { 'mcp-session-id': sessionId } : {}) };

  await fetch(url, {
    method: 'POST', headers: h2,
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  }).catch(() => null);

  let id = 1;
  return async function call(name, args = {}) {
    const res = await fetch(url, {
      method: 'POST', headers: h2,
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }),
    });
    if (!res.ok) throw new Error(`${name} 失败：HTTP ${res.status}`);
    const j = await rpcBody(res);
    if (j.error) throw new Error(`${name} 报错：${JSON.stringify(j.error).slice(0, 200)}`);
    return j.result;
  };
}

/** 屏幕原始尺寸，px 框的坐标基准。拿不到就返回 null（按 1:1 算）。 */
let SCREEN = null;
async function screenSize(url, token) {
  if (SCREEN) return SCREEN;
  try {
    const call = await mcpSession(url, token);
    const r = await call('cua_get_state', {});
    const txt = (r?.content ?? []).find((c) => c.type === 'text')?.text;
    const j = JSON.parse(txt);
    const d = j.display ?? j.virtualDesktop;
    if (d?.width > 0 && d?.height > 0) SCREEN = { w: d.width, h: d.height };
  } catch { /* 拿不到就 1:1 */ }
  return SCREEN;
}

/**
 * 把 region 换成「采集图上的矩形」。
 * 百分比天然与尺寸无关；**px 一律按原图（屏幕 / 视频文件）坐标解释**，
 * 采集图是缩过的就按比例换算 —— 否则同一个 `0,218,480,34` 在 scan(480 宽) 和 once(800 宽)
 * 里会指到不同位置，这是这套工具之前最容易踩的坑。
 */
export function regionInCapture(spec, srcW, srcH, capW, capH) {
  const r = parseRegionSpec(spec);
  if (!r) return null;
  if (r.kind !== 'px') return regionRect(r, capW, capH);
  const sx = srcW ? capW / srcW : 1;
  const sy = srcH ? capH / srcH : 1;
  return {
    x: Math.round(r.x * sx),
    y: Math.round(r.y * sy),
    w: Math.max(1, Math.round(r.w * sx)),
    h: Math.max(1, Math.round(r.h * sy)),
  };
}

export async function cuaCapture({ url, token, displayId = 'primary', maxLongEdge = 1280, quality = 75, ffmpeg = 'ffmpeg' } = {}) {
  const call = await mcpSession(url, token);
  const r = await call('cua_capture', { displayId, maxLongEdge, quality });
  const content = r?.content ?? [];
  const img = content.find((c) => c.type === 'image' && c.data);
  if (!img) throw new Error(`cua_capture 没返回图：${JSON.stringify(content).slice(0, 200)}`);

  // 交给 ffmpeg 解码（jpg/png 都行），解完顺手把临时文件删掉
  const tmp = join(tmpdir(), `cua-gate-${process.pid}-${Date.now()}.${(img.mimeType || 'image/jpeg').split('/')[1] || 'jpg'}`);
  writeFileSync(tmp, Buffer.from(img.data, 'base64'));
  try {
    return { ...loadRgb(tmp, { ffmpeg }), bytes: Buffer.from(img.data, 'base64') };
  } finally {
    try { unlinkSync(tmp); } catch { /* 已经没了 */ }
  }
}

// ── 模式 ──

async function once(opts) {
  const now = Date.now();
  const region = opts.region ?? null;
  const prev = readState(region ?? '');
  // --profile auto：单帧没法判断运动形态，沿用上次看屏时选定的档位（存在状态文件里）
  if (opts.auto) opts.profile = resolveProfile(prev?.mode ?? 'video');
  const J = seat(prev, opts.profile);
  let hsv;
  let engine;
  let bytes = null;
  let png = null;
  let warning = null;

  if (opts.mcp) {
    const ep = await findCuaMcp();
    const cap = await cuaCapture({ url: ep.url, token: opts.token, displayId: opts.displayId, ffmpeg: opts.ffmpeg, maxLongEdge: opts.longEdge });
    let rect = null;
    if (region) {
      const spec = parseRegionSpec(region);
      const scr = spec.kind === 'px' ? await screenSize(ep.url, opts.token) : null;
      rect = regionInCapture(region, scr?.w, scr?.h, cap.width, cap.height);
    }
    hsv = createScorer({ width: cap.width, height: cap.height, region: rect })(cap.rgb).hsv;
    engine = `cua_capture(${cap.width}×${cap.height})`;
    bytes = cap.bytes;
    // 尺寸变了就没有可比性 —— 退回「没基线」而不是给一个假分数
    if (cap.width !== DEFAULT_W || cap.height !== DEFAULT_H) J.prevKept = null;
  } else {
    const g = grab({ ffmpeg: opts.ffmpeg, region, display: opts.display });
    engine = g.engine;
    warning = g.warning ?? null;
    hsv = createScorer({ width: DEFAULT_W, height: DEFAULT_H })(g.buf).hsv;
    bytes = g.buf;
  }

  const score = J.prevKept ? scorePair(J.prevKept, hsv) : null;
  // 运动补偿跟上一次**判过**的帧比（state.raw），不是跟上一次出帧比 —— 没基线就是 null，guard 第①道自动跳过
  const mc = J.prevHsv ? mcStats(J.prevHsv, hsv, { radius: GUARD.radius, tau: GUARD.tau }) : null;
  const d = judgeFrame(J, { score, hsv, now, force: opts.force, mc });
  // --describe：只给真出帧的那张转文字，skip 的帧不花 API
  let desc = null;
  let descError = null;
  if (opts.describe && d.fire && bytes) {
    try {
      const v = visionConfig();
      const jpg = opts.mcp ? bytes : rgbToJpeg(bytes, DEFAULT_W, DEFAULT_H, opts.ffmpeg);
      desc = (await describeFrame(jpg, v, v.timeoutMs)).text;
    } catch (e) { descError = e.message; }
  }
  if (d.fire && opts.out && bytes) {
    if (opts.mcp) { writeFileSync(opts.out, bytes); png = opts.out; }
    else if (opts.full) png = grabFull({ ffmpeg: opts.ffmpeg, display: opts.display, out: opts.out });
    else png = writePng(bytes, opts.out, opts.ffmpeg);
  }
  // 没出帧也要把 acc / lastFrame 落盘，否则积分永远累不起来
  writeState(prev, {
    hsv: d.fire ? hsv : null, raw: packHsv(hsv), score: score ?? prev?.score ?? 0, acc: J.acc,
    lastFrame: score, ms: d.fire ? now : (prev?.ms ?? null), region: region ?? '',
    mode: J.profile.name,
  });

  console.log(JSON.stringify({
    at: stamp(), src: engine, profile: opts.profile.name, ...(region ? { region } : {}),
    ...(warning ? { warning } : {}),
    score: score === null ? null : +score.toFixed(2), acc: d.acc, why: d.why,
    verdict: d.fire ? 'keep' : 'skip', png, baseline: prev?.at ?? null,
    ...(desc ? { desc } : {}),
    ...(descError ? { descError } : {}),
    hint: !d.fire ? (opts.mcp ? '别调 cua_capture，省一张图' : '别调 cua_capture，省一张图')
      : d.why === 'first' ? '没有基线，先留一张当基准'
        : `值得看（${d.why}）：读 ${png ?? '(加 --out 存下来)'}`,
  }));
}

/** 常驻：**一条 ffmpeg 管道**持续出帧（12fps），每帧判分，变了才打印。 */
function watch(opts) {
  const region = opts.region ?? null;
  // `--file`：把视频当「屏幕回放」，用**内容时间**当钟，且**不写屏幕基线**
  // （否则标定跑完，下一次看屏的基准就变成视频最后一帧了）。
  const fileMode = !!opts.file;
  if (fileMode && opts.to === null) throw new Error('--file 要配 --from 和 --to（秒）');
  const span = fileMode ? Math.max(0, opts.to - opts.from) : opts.duration;
  const { args } = captureArgs(fileMode
    ? { file: opts.file, start: opts.from, duration: span, fps: opts.fps, frames: null, region }
    : { fps: opts.fps, frames: null, region });
  const child = spawn(opts.ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const scorer = createScorer({ width: DEFAULT_W, height: DEFAULT_H });
  let pending = Buffer.alloc(0);
  const J = fileMode
    ? { profile: opts.profile, prevKept: null, acc: 0, prevFrameScore: null, lastEmit: null, emissions: [] }
    : seat(readState(region ?? ''), opts.profile);
  let seen = 0;
  let emitted = 0;
  let err = '';
  let stopping = false;
  const scores = [];
  const t0 = Date.now();
  // --profile auto：按画面自己选档位。切换要有持续性（连续 holdFrames 帧同向），否则会在两类之间来回跳。
  // 阈值是绝对量，见 AUTO；用 --stats 在真素材上看分位数来调。
  let autoTarget = null;
  let autoSm = null; // 平滑后的分类指标（逐帧抖动会让 hold 一直清零）
  let autoHold = 0;
  let prevHsv = null;
  // 连续帧历史，只喂切点 guard（最近 GUARD.history 帧）；scorer 复用缓冲，所以每帧都要拷贝
  const frameHist = [];
  const autoSwitches = [];
  const autoSeen = [];
  // 前台窗口（只看屏幕模式）：5 秒问一次就够，答不了就退回像素判据
  const epPromise = opts.auto && !fileMode ? findCuaMcp().catch(() => null) : null;
  let fg = null;
  let fgAt = 0;
  let fgBusy = false;
  const refreshFg = () => {
    if (!epPromise || fgBusy || Date.now() - fgAt < 5000) return;
    fgBusy = true;
    epPromise.then((ep) => (ep ? foregroundGame(ep, opts.token) : null))
      .then((r) => { if (r) { fg = r; fgAt = Date.now(); } })
      .catch(() => { fgAt = Date.now(); }) // 拿不到就别一直重试
      .finally(() => { fgBusy = false; });
  };

  // --profile auto：按画面自动选档位——底带独大变 → subtitle，三带齐动且幅度大 → game，其余 video；切换要连续 4s 同向才生效
  // --describe：出帧后把图丢给视觉模型转文字。串行排队、最多 2 张在途，不挡帧循环。
  // 配置在开跑时读一次，读不到就当场报错（而不是跑一半才发现没 key）。
  let vision = null;
  if (opts.describe) {
    try {
      vision = visionConfig();
      console.log(JSON.stringify({ at: stamp(), describe: `开：${vision.provider}/${vision.model}` }));
    } catch (e) {
      console.log(JSON.stringify({ at: stamp(), describe: `关：${e.message}` }));
    }
  }
  const descQueue = [];
  let descInflight = 0;
  const pumpDescribe = () => {
    if (!vision || descInflight >= 2 || descQueue.length === 0) return;
    const job = descQueue.shift();
    descInflight += 1;
    describeFrame(job.jpg, vision, vision.timeoutMs)
      .then((r) => console.log(JSON.stringify({ at: stamp(), descFor: job.t, desc: r.text, vision: `${r.model} ${r.ms}ms` })))
      .catch((e) => console.log(JSON.stringify({ at: stamp(), descFor: job.t, descError: e.message })))
      .finally(() => { descInflight -= 1; pumpDescribe(); });
  };

  const qpct = (arr, p) => { const a = [...arr].sort((x, y) => x - y); return +a[Math.min(a.length - 1, Math.floor(p * a.length))].toFixed(2); };
  const autoSummary = () => ({
    auto: autoSeen.length,
    shareP50: qpct(autoSeen.map((x) => x.share), 0.5), shareP90: qpct(autoSeen.map((x) => x.share), 0.9),
    motionP50: qpct(autoSeen.map((x) => x.motion), 0.5), motionP90: qpct(autoSeen.map((x) => x.motion), 0.9),
    balanceP50: qpct(autoSeen.map((x) => x.balance), 0.5),
    switched: autoSwitches.length ? autoSwitches.map((x) => `${x.from}→${x.to}`).join(",") : "none",
  });

  const stop = (why) => {
    stopping = true;
    clearTimeout(deadline);
    clearInterval(heartbeat);
    try { child.kill('SIGKILL'); } catch { /* 已经没了 */ }
    if (opts.stats && scores.length) {      const s = [...scores].sort((a, b) => a - b);
      const q = (p) => +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(2);
      const cut = opts.profile.cut;
      console.log(JSON.stringify({
        at: stamp(), stats: scores.length, p50: q(0.5), p90: q(0.9), p99: q(0.99), max: q(0.999),
        overCut: scores.filter((x) => x >= cut).length, cut,
        overAcc: scores.reduce((a, b) => a + b, 0) >= opts.profile.accNeed ? '是' : '否', accNeed: opts.profile.accNeed,
        ...(autoSeen.length ? autoSummary() : {}),
      }));
    }
    if (why) console.log(JSON.stringify({ at: stamp(), stop: why, frames: seen, emitted }));
  };

  const deadline = !fileMode && opts.duration > 0 ? setTimeout(() => stop(`跑了 ${opts.duration}s`), opts.duration * 1000) : null;
  // 长时间没变化也要让外面知道它还活着，否则调用方分不清「没变化」和「卡死了」
  const heartbeat = !fileMode
    ? setInterval(() => {
        if (Date.now() - J.lastEmit >= opts.heartbeat) console.log(JSON.stringify({ at: stamp(), alive: true, frames: seen, emitted, acc: +J.acc.toFixed(1) }));
      }, opts.heartbeat)
    : null;

  child.stderr.on('data', (d) => { err = `${err}${d}`.slice(-1000); });

  child.stdout.on('data', (chunk) => {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    while (pending.length >= FRAME_BYTES) {
      const buf = pending.subarray(0, FRAME_BYTES);
      pending = pending.subarray(FRAME_BYTES);
      const frameNo = seen;
      seen += 1;
      const { hsv } = scorer(buf);
      if (opts.auto) {
        refreshFg();
        const st = bandStats(prevHsv, hsv);
        if (st) {
          autoSeen.push(st);
          // EMA 平滑：单帧偶然跌破阈值不该让「连续同向」计数清零
          autoSm = autoSm
            ? { share: autoSm.share * 0.8 + st.share * 0.2, motion: autoSm.motion * 0.8 + st.motion * 0.2, bottom: autoSm.bottom * 0.8 + st.bottom * 0.2, balance: autoSm.balance * 0.8 + st.balance * 0.2 }
            : { ...st };
          const want = classifyAuto(autoSm, fg, J.profile.name);
          if (process.env.CUA_AUTO_DEBUG && frameNo % 20 === 0) console.log(JSON.stringify({ dbg: frameNo, share: +autoSm.share.toFixed(2), bottom: +autoSm.bottom.toFixed(2), motion: +autoSm.motion.toFixed(2), want, cur: J.profile.name, hold: autoHold }));
          if (want === J.profile.name) {
            autoTarget = null;
            autoHold = 0;
          } else {
            if (want === autoTarget) autoHold += 1;
            else { autoTarget = want; autoHold = 1; }
            if (autoHold >= AUTO.holdFrames) {
              const from = J.profile.name;
              J.profile = resolveProfile(want);
              const why = { share: +st.share.toFixed(2), motion: +st.motion.toFixed(1), balance: +st.balance.toFixed(2), ...(fg ? { win: fg.game ? 'fullscreen' : (fg.title ?? '').slice(0, 40) } : {}) };
              autoSwitches.push({ from, to: want });
              console.log(JSON.stringify({ at: stamp(), profile: `auto ${from}→${want}`, why, ...(fileMode ? { t: +(opts.from + frameNo / opts.fps).toFixed(2) } : {}) }));
              autoTarget = null;
              autoHold = 0;
            }
          }
        }
        prevHsv = Float32Array.from(hsv); // scorer 复用同一块缓冲，不拷就是自己比自己
      }
      const score = J.prevKept ? scorePair(J.prevKept, hsv) : null;
      if (score !== null) scores.push(score);
      const now = fileMode ? Math.round((opts.from + frameNo / opts.fps) * 1000) : Date.now();
      // guard 两轴：运动补偿比**上一帧**，背景模型看最近几帧稳定的格（两帧起才算得出来）
      const mc = frameHist.length ? mcStats(frameHist[frameHist.length - 1], hsv, { radius: GUARD.radius, tau: GUARD.tau }) : null;
      const bg = frameHist.length >= 2 ? bgStats(frameHist, hsv, { stableRange: GUARD.stableRange, tau: GUARD.tau }) : null;
      const d = judgeFrame(J, { score, hsv, now, mc, bg });
      frameHist.push(Float32Array.from(hsv));
      if (frameHist.length > GUARD.history) frameHist.shift();
      if (d.fire) {
        if (!fileMode) writeState(null, { hsv, raw: packHsv(hsv), score: score ?? 0, acc: J.acc, lastFrame: score, ms: now, region: region ?? '' });
        emitted += 1;
        console.log(JSON.stringify({
          at: stamp(), t: fileMode ? +(opts.from + frameNo / opts.fps).toFixed(2) : +((now - t0) / 1000).toFixed(2), frame: frameNo,
          score: score === null ? null : +score.toFixed(2), acc: d.acc, why: d.why,
          profile: opts.profile.name, ...(region ? { region } : {}),
          ...(opts.out ? { png: writePng(buf, opts.out.replace(/\.[a-z]+$/i, `-${emitted}.png`), opts.ffmpeg) } : {}),
        }));
        if (vision) {
          try {
            descQueue.push({ t: fileMode ? +(opts.from + frameNo / opts.fps).toFixed(2) : +((now - t0) / 1000).toFixed(2), jpg: rgbToJpeg(buf, DEFAULT_W, DEFAULT_H, opts.ffmpeg) });
            pumpDescribe();
          } catch (e) {
            console.log(JSON.stringify({ at: stamp(), descError: e.message }));
          }
        }
        if (opts.count > 0 && emitted >= opts.count) { stop(`攒够 ${opts.count} 次变化`); return; }
      }
    }
  });

  child.on('error', (e) => { console.log(JSON.stringify({ at: stamp(), error: `spawn 失败：${e.message}` })); stop(null); });
  child.on('close', (code) => {
    if (stopping) return; // 自己停的，别把 SIGKILL 当成采集失败报出来
    if (seen === 0) {
      console.log(JSON.stringify({ at: stamp(), error: `ffmpeg 一帧都没出（exit ${code}）${err.trim() ? `：${err.trim().slice(-200)}` : ''}` }));
    } else if (fileMode) console.log(JSON.stringify({ at: stamp(), stop: `读到 ${opts.to}s`, frames: seen, emitted }));
    stop(null);
  });

  process.on('SIGINT', () => { stop('收到 Ctrl-C'); process.exit(0); });
  // TS 侧超时/取消用 child.kill()（SIGTERM），不接这一下 ffmpeg 会变孤儿进程继续出帧
  process.on('SIGTERM', () => { stop('收到 SIGTERM'); process.exit(0); });
}

// ---------------------------------------------------------------------------
// tap：自己发输入（PiDeck 的 cua_click/cua_type 在这台机上 SendInput 恒返回 0，见 README 记录）
// 走 pwsh + Add-Type 调 user32!SendInput。一次调用一个进程，编译约 0.7s，够用。
// ---------------------------------------------------------------------------
const VK = {
  enter: 13, tab: 9, escape: 27, backspace: 8, delete: 46, space: 32,
  left: 37, up: 38, right: 39, down: 40, home: 36, end: 35,
  pageup: 33, pagedown: 34, shift: 16, ctrl: 17, alt: 18, win: 91,
};

/** 键名 → 虚拟键码：具名键 / 单个字母 / 单个数字 / F1–F12 */
function vkOf(name) {
  const n = String(name).toLowerCase();
  if (VK[n] !== undefined) return VK[n];
  if (/^[a-z]$/.test(n)) return n.toUpperCase().charCodeAt(0);
  if (/^[0-9]$/.test(n)) return n.charCodeAt(0);
  const f = /^f([1-9]|1[0-2])$/.exec(n);
  if (f) return 111 + Number(f[1]);
  throw new Error(`不认识的键：${name}（可用：${Object.keys(VK).join(' / ')} / a-z / 0-9 / f1-f12）`);
}

const INJECT_CS = String.raw`
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;

public static class Inj {
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] public struct U { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public U u; }

  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] p, int cb);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int i);

  const uint ABS = 0x8000, VDESK = 0x4000, MOVE = 0x0001;
  const uint LEFTDOWN = 0x0002, LEFTUP = 0x0004, RIGHTDOWN = 0x0008, RIGHTUP = 0x0010, MIDDLEDOWN = 0x0020, MIDDLEUP = 0x0040;
  const uint KEYUP = 0x0002;

  static int Nx(int x) { return (int)Math.Round(x * 65535.0 / (GetSystemMetrics(78) - 1)); }
  static int Ny(int y) { return (int)Math.Round(y * 65535.0 / (GetSystemMetrics(79) - 1)); }
  static INPUT Mouse(int x, int y, uint flags) { var i = new INPUT(); i.type = 0; i.u.mi.dx = x; i.u.mi.dy = y; i.u.mi.dwFlags = flags; return i; }
  static INPUT Kb(int vk, uint flags) { var i = new INPUT(); i.type = 1; i.u.ki.wVk = (ushort)vk; i.u.ki.dwFlags = flags; return i; }
  static string Send(INPUT[] a) { uint n = SendInput((uint)a.Length, a, Marshal.SizeOf(typeof(INPUT))); return n + "/" + a.Length; }

  public static string Click(int x, int y, string button, bool dbl) {
    uint down = LEFTDOWN, up = LEFTUP;
    if (button == "right") { down = RIGHTDOWN; up = RIGHTUP; }
    else if (button == "middle") { down = MIDDLEDOWN; up = MIDDLEUP; }
    string moved = Send(new INPUT[] { Mouse(Nx(x), Ny(y), MOVE | ABS | VDESK) });
    Thread.Sleep(40);
    var list = new List<INPUT>();
    int times = dbl ? 2 : 1;
    for (int i = 0; i < times; i++) { list.Add(Mouse(0, 0, down)); list.Add(Mouse(0, 0, up)); }
    return moved + " " + Send(list.ToArray());
  }

  public static string Key(int vk, int[] mods, int times, int gap) {
    var parts = new List<string>();
    for (int i = 0; i < times; i++) {
      var list = new List<INPUT>();
      foreach (int m in mods) list.Add(Kb(m, 0));
      list.Add(Kb(vk, 0)); list.Add(Kb(vk, KEYUP));
      foreach (int m in mods) list.Add(Kb(m, KEYUP));
      parts.Add(Send(list.ToArray()));
      if (i < times - 1 && gap > 0) Thread.Sleep(gap);
    }
    return string.Join(",", parts);
  }
}
`;

/** 把一次输入动作拼成一段 PowerShell，跑完删掉临时文件 */
function runInject(body) {
  const ps = `$ErrorActionPreference = "Stop"\nAdd-Type -TypeDefinition @'\n${INJECT_CS}\n'@\n${body}\n`;
  const file = join(tmpdir(), `cua-tap-${process.pid}-${Date.now()}.ps1`);
  writeFileSync(file, ps, 'utf8');
  try {
    const r = spawnSync(process.env.PWSH || 'pwsh', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], {
      encoding: 'utf8',
      windowsHide: true,
    });
    if (r.error) throw new Error(`跑不动 pwsh：${r.error.message}`);
    const out = (r.stdout || '').trim();
    if (r.status !== 0) throw new Error(`注入失败（exit ${r.status}）：${(r.stderr || out).trim().slice(0, 300)}`);
    return out;
  } finally {
    try { unlinkSync(file); } catch { /* 删不掉就算了 */ }
  }
}

/**
 * tap：发一次点击或按键。
 *   --x --y [--button left|right|middle] [--double]
 *   --key right --times 6 --interval 60 [--modifier ctrl]
 * 用于「回看」：视频页点进度条 / 按方向键跳几秒。
 */
function tap(opts) {
  const mods = opts.modifier ? String(opts.modifier).split(',').map((m) => vkOf(m.trim())) : [];
  if (opts.key) {
    const vk = vkOf(opts.key);
    const times = Math.max(1, Math.min(50, opts.times));
    const out = runInject(`[Inj]::Key(${vk}, @(${mods.join(', ')}), ${times}, ${Math.max(0, opts.gap)})`);
    const sent = out.split(',');
    const ok = sent.every((s) => s.split('/')[0] === s.split('/')[1]);
    console.log(JSON.stringify({ at: new Date().toISOString().slice(11, 19), tap: 'key', key: opts.key, vk, modifiers: opts.modifier ?? null, times, sent: ok ? `${times}/${times}` : out, baseline: ok ? dropBaseline() : 'kept' }));
    if (!ok) process.exitCode = 1;
    return;
  }
  if (opts.x === null || opts.x === undefined || opts.y === null || opts.y === undefined) {
    throw new Error('tap 要么给 -key，要么给 -x 和 -y');
  }
  const out = runInject(`[Inj]::Click(${opts.x}, ${opts.y}, "${opts.button}", ${opts.double ? '$true' : '$false'})`);
  const [moved, buttons] = out.split(' ');
  const ok = moved === '1/1' && buttons.split('/')[0] === buttons.split('/')[1];
  console.log(JSON.stringify({ at: new Date().toISOString().slice(11, 19), tap: 'click', x: opts.x, y: opts.y, button: opts.button, double: opts.double, moved, buttons: ok ? 'ok' : buttons, baseline: ok ? dropBaseline() : 'kept' }));
  if (!ok) process.exitCode = 1;
}

/** 发完输入就把基线删掉：画面既然被我改过，旧的「上一次值得看的帧」就不能再拿来比 */
function dropBaseline() {
  try {
    if (existsSync(STATE)) { unlinkSync(STATE); return 'cleared'; }
    return 'none';
  } catch {
    return 'failed';
  }
}

async function probe() {
  const auto = process.env.PIDECK_CUA_TOKEN ? null : tokenFromPiConfig();
  const token = process.env.PIDECK_CUA_TOKEN || auto?.token || '';
  const ep = await findCuaMcp();
  const out = { url: ep.url, source: ep.source, token: token ? `有（${process.env.PIDECK_CUA_TOKEN ? 'env' : auto?.source}）` : '没有' };
  if (token) {
    try {
      const cap = await cuaCapture({ url: ep.url, token, maxLongEdge: 320, quality: 60 });
      out.capture = `ok ${cap.width}×${cap.height}`;
      out.mean = +(cap.rgb.reduce((a, b) => a + b, 0) / cap.rgb.length).toFixed(1);
    } catch (e) { out.capture = `失败：${e.message}`; }
  }
  console.log(JSON.stringify(out, null, 2));
}

// ── 两遍扫描 ──

/**
 * 第一遍：把一段时间均匀采样成 cells 帧，拼成一张 contact sheet（细格 tile）。
 * 第二遍就是拿 `--from/--to` 把窗口收窄、或者把 `--cells` 调大，再来一张。
 *
 * 采样靠 ffmpeg 的 fps + tile：`fps=cells/window` 把整段均匀压成 cells 帧，
 * `tile=cols x rows` 直接拼好 —— 不自己解码、不自己拼图。
 *
 * 屏幕没有时间轴，**不能倒回去重扫**：第一遍看到的第 9 格已经过去了。
 * 真两遍扫描必须给视频文件（`--file`）；看网页直播只能往后捋（重新扫下一段）。
 */
function scan(opts) {
  if (opts.mcp) return scanMcp(opts);
  const window = opts.file ? opts.to - opts.from : opts.duration;
  if (!(window > 0)) throw new Error('窗口必须 > 0 秒：屏幕用 `--duration 60`，文件用 `--from 300 --to 360`');
  if (opts.file && (opts.to === null || opts.to === undefined)) throw new Error('给了 --file 就得同时给 --from 和 --to（单位：秒）');
  const rows = Math.ceil(opts.cells / opts.cols);
  const rate = opts.cells / window;
  const pre = [`fps=${rate.toFixed(6)}`];
  const post = [`scale=${opts.cell}:-2:flags=area`, `tile=${opts.cols}x${rows}:padding=2:margin=2`];
  // 屏幕侧先按 2×率录，再 fps 重采样；否则 ddagrab 的低帧率会有抖动
  const inFps = Math.max(2, Math.min(15, Math.ceil(rate * 2)));
  const args = captureArgs({
    ...(opts.file ? { file: opts.file, start: opts.from, duration: window } : { fps: inFps, duration: window }),
    frames: 1, out: opts.out, region: opts.region, scale: false, display: opts.display, pre, post,
  }).args;
  const t0 = Date.now();
  const r = spawnSync(opts.ffmpeg, args, { maxBuffer: 1 << 28 });
  if (r.error) throw new Error(`找不到 ffmpeg（${r.error.message}）`);
  if (r.status !== 0) throw new Error(`扫描失败：${String(r.stderr).trim().slice(-400)}`);
  const step = window / opts.cells;
  console.log(JSON.stringify({
    at: stamp(), mode: 'scan',
    ...(opts.file ? { file: opts.file, from: opts.from, to: opts.to } : { live: opts.duration }),
    ...(opts.region ? { region: opts.region } : {}),
    window: +window.toFixed(2), cells: opts.cells, cols: opts.cols, rows, cell: opts.cell,
    step: +step.toFixed(3), png: opts.out, took: +((Date.now() - t0) / 1000).toFixed(2),
    hint: `第 i 格（从左到右、从上到下，从 0 数）= 起点 + i×${step.toFixed(2)}s；看不清就把 --cells 加大，或用 --from/--to 只扫那一段再来一张`,
  }));
}

/**
 * `scan --mcp`：没有 ffmpeg 采集权限时的退路 —— 按间隔抓 cells 次 cua_capture，
 * 再把 PNG 拼成同一张联系表。代价是每格都要等一次取图（约 0.4s），且**不能回看**。
 */
async function scanMcp(opts) {
  const span = opts.duration;
  if (!(span > 0)) throw new Error('--mcp 扫描要 --duration（秒）：没有时间窗就没法均匀取样');
  const ep = await findCuaMcp();
  const step = span / opts.cells;
  const rows = Math.ceil(opts.cells / opts.cols);
  const dir = mkdtempSync(join(tmpdir(), 'cua-scan-'));
  const t0 = Date.now();
  let cropFilter = null;
  try {
    for (let i = 0; i < opts.cells; i++) {
      const wait = t0 + i * step * 1000 - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      const cap = await cuaCapture({ url: ep.url, token: opts.token, displayId: opts.displayId, ffmpeg: opts.ffmpeg, maxLongEdge: opts.cell });
      writePng(cap.rgb, join(dir, `p${String(i).padStart(2, '0')}.png`), opts.ffmpeg, cap.width, cap.height);
      // px 框按原图坐标解释：拿第一张的尺寸做换算基准，所有格子尺寸一致
      if (opts.region && !cropFilter) {
        const spec = parseRegionSpec(opts.region);
        const scr = spec.kind === 'px' ? await screenSize(ep.url, opts.token) : null;
        const rr = regionInCapture(opts.region, scr?.w, scr?.h, cap.width, cap.height);
        cropFilter = `crop=${rr.w}:${rr.h}:${rr.x}:${rr.y}`;
      }
    }
    const r = spawnSync(opts.ffmpeg, ['-hide_banner', '-v', 'error', '-y', '-framerate', '1', '-i', join(dir, 'p%02d.png'),
      '-vf', `${cropFilter ? `${cropFilter},` : ''}tile=${opts.cols}x${rows}:padding=2:margin=2`, '-frames:v', '1', opts.out], { maxBuffer: 1 << 28 });
    if (r.status !== 0) throw new Error(`拼图失败：${String(r.stderr).trim().slice(-300)}`);
    console.log(JSON.stringify({
      at: stamp(), mode: 'scan', src: 'cua_capture', live: span,
      ...(opts.region ? { region: opts.region } : {}),
      window: +span.toFixed(2), cells: opts.cells, cols: opts.cols, rows, cell: opts.cell,
      step: +step.toFixed(3), png: opts.out, took: +((Date.now() - t0) / 1000).toFixed(2),
      hint: `第 i 格 = 起点 + i×${step.toFixed(2)}s；每格是一次独立取图（约 0.4s），格子时间会有这点误差`,
    }));
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* 临时目录删不掉就算了 */ }
  }
}

function usage() {
  console.log(`cua-gate — 先判变化，再决定要不要看这一张

  node cua-gate.mjs once [--profile game] [--region bottom:20%] [--full --out now.png]
  node cua-gate.mjs watch [--profile video|game|subtitle] [--duration 60] [--count 3] [--out keep.png]
  node cua-gate.mjs scan --duration 60 --cells 16 --out p1.png                    # 第一遍：屏幕录 60s 拼 4×4
  node cua-gate.mjs scan --file ep.mp4 --from 900 --to 960 --cells 16 --out p2.png  # 第二遍：只看那一段
  node cua-gate.mjs watch --file ep.mp4 --from 0 --to 600 --profile game --stats   # 拿真素材标定
  node cua-gate.mjs scan --mcp --duration 12 --cells 6 --out s.png                # 走 cua_capture 采样（不需要 ffmpeg 采集）
  node cua-gate.mjs once --mcp --describe --force                            # 出帧后交给视觉桥转文字（只转真出帧那一张）
  node cua-gate.mjs watch --describe --duration 30                           # 每出一帧异步转文字，不挡帧循环
  node cua-gate.mjs tap --x 1280 --y 1225                                          # 点一下（进度条 / 按钮）
  node cua-gate.mjs tap --key right --times 6                                      # 按 6 次 →（视频跳 6 个步长）
  node cua-gate.mjs region 0,218,480,34                                            # 旧 px（按采集图算）→ 原图坐标，宽度自动猜
  node cua-gate.mjs region 0,218,480,34 0,218,480,52 0,1180,2560,260               # 批量，混着来源也行
  node cua-gate.mjs region 0,100,200,50@800                                        # 猜错时 @ 指定旧采集宽
  node cua-gate.mjs region 0,218,480,52 --apply cfg.json                           # 写回配置文件（干跑）
  node cua-gate.mjs region 0,218,480,52 --apply cfg.json --write                    # 真写，先备份到 %TEMP%
  node cua-gate.mjs probe

口径：798×450 rgb24，64×36 HSV 加权差，0–255。
刻度：静止 0 · 光标 0.7 · 只改亮度 5.3 · 淡色换照片 16~18 · 滚屏/切窗 30~42 · 换照片 46~63

profile（可逐项覆盖）：
  video      cut 12  积分 144   冷却 4s   静默 20s   最多等 60s
  game       cut 80  积分 1800  冷却 40s  静默 40s   最多等 120s
  subtitle   cut 12  积分 300   冷却 8s   静默 20s   最多等 60s（配 --region bottom:20%）
  auto       按画面自己选：底带独大变→subtitle，前台是全屏非播放器窗口→game，其余 video

可覆盖的旋钮：--cut --peak --peak-abs --acc --cooldown --burst --burst-window --silent-floor --max-wait --floor-min
--region：bottom:20% / top:30% / left:25% / right:25% / x,y,w,h（像素）
  px 按原图坐标算：屏幕就是 2560×1440 那种原始分辨率，视频文件就是文件自己的分辨率；
  --mcp / --cell 采的是缩图，内部按比例换算，所以同一个 px 框在 once 和 scan 里指同一块地方
  百分比永远安全（与尺寸无关），只在本机固定分辨率下才用 px
--describe：出帧后把这张图交给视觉模型转文字（复用 ~/.pi/agent/pi-deck-vision.json 的供应商/模型/提示词；skip 的帧不调）
--out：keep 时落盘（798×450）；加 --full 就改成原分辨率重采一张（字能看清，多花 0.4s）
tap：自己发输入（PiDeck 的 cua_click/cua_type 在本机 SendInput 恒回 0），发完顺手作废基线
  --x/--y [--button left|right|middle] [--double]   点一下
  --key right --times 6 [--interval 60] [--modifier ctrl]   按键 / 组合键（键名：left right up down space enter escape tab home end pageup pagedown + a-z 0-9 f1-f12）
--display：显示器序号（0 主屏、1 第二屏），ddagrab/x11grab 有效
--mcp：走 cua_capture 取图（token 先看 PIDECK_CUA_TOKEN，没有就读 ~/.pi/agent/mcp.json 的 pideck-cua 头，只读不打印）
--long-edge：--mcp 取图的尺寸，默认 798（42px 对齐：19 格刚好用满；与默认采集同口径，才能和历史基线比）
watch：一条 ffmpeg 管道连续判，出帧才打印（--heartbeat 秒数，心跳行带当前 acc）
  --file：把视频当屏幕回放（配 --from/--to），用内容时间当钟，不写屏幕基线；非 16:9 自动补黑边不拉扭
  --stats：跑完打一行分数分布（p50/p90/p99/max、overCut），标定用`);
}

/** 旧 px 值（按采集图算的）→ 新 px（原图坐标）+ 等价百分比。 */
/** 旧采集宽度就这几种（scan 的 --cell / once 的 --long-edge / 原图），16:9 推定高度。 */
const CAPTURE_WIDTHS = [480, 798, 800, 1280, 2560];

/**
 * 猜这个 px 框当初是在多宽的采集图上画的。
 * 判据只有一条硬的：框必须装得下（x+w<=宽、y+h<=高）；剩下靠「贴边」加分——
 * 有用的框基本都是横跨整宽的一条带子，所以贴底/贴边的候选赢。
 */
function guessCapture(spec) {
  const cands = CAPTURE_WIDTHS.map((w) => ({ w, h: Math.round((w * 9) / 16) }))
    .filter((c) => spec.x + spec.w <= c.w + 1 && spec.y + spec.h <= c.h + 1);
  if (cands.length === 0) return null;
  const tags = (c) => {
    const t = [];
    if (spec.x === 0 && spec.x + spec.w >= c.w - 1) t.push("整宽");
    if (spec.y === 0 && spec.y + spec.h >= c.h - 1) t.push("整高");
    if (spec.y + spec.h >= c.h - 1 && !(spec.y === 0)) t.push("贴底");
    if (spec.y === 0 && !(spec.y + spec.h >= c.h - 1)) t.push("贴顶");
    if (spec.x === 0 && !(spec.x + spec.w >= c.w - 1)) t.push("贴左");
    if (spec.x + spec.w >= c.w - 1 && !(spec.x === 0)) t.push("贴右");
    return t;
  };
  const ranked = cands.map((c) => ({ ...c, t: tags(c) })).map((c) => ({ ...c, s: c.t.length * 3 + (c.t.some((x) => x === "整宽" || x === "整高") ? 2 : 0) }))
    .sort((a, b) => b.s - a.s || a.w - b.w);
  const top = ranked[0];
  const tie = ranked.filter((r) => r.s === top.s).length > 1;
  return { from: top.w, why: top.t.length ? top.t.join("+") : "只是装得下", ambiguous: tie };
}

/** 单个框的换算（不打印）；批量时复用同一份屏幕尺寸。 */
function convertRegion(specText, { from, W, H }) {
  const m = /^(.*?)@(\d+)$/.exec(String(specText).trim());
  const body = m ? m[1] : String(specText).trim();
  const forced = m ? Number(m[2]) : 0;
  const spec = parseRegionSpec(body);
  if (spec.kind !== "px") return { old: body, now: null, pct: body, hint: "本来就是百分比，不用换" };
  let guess = null;
  let srcFrom = forced || from;
  if (!srcFrom) {
    guess = guessCapture(spec);
    if (!guess) throw new Error("装不进任何已知采集尺寸，用 @<旧采集宽> 指定，比如 " + body + "@800");
    srcFrom = guess.from;
  }
  const k = W / srcFrom;
  const box = {
    x: Math.round(spec.x * k), y: Math.round(spec.y * k),
    w: Math.round(spec.w * k), h: Math.round(spec.h * k),
  };
  // 百分比只有四种写法，且都是「贴边的一块」：top:X% = 上边 X% 高、bottom:X% = 下边 X% 高，左右同理。
  // 没贴边就算不进来，宁可给 null 也不给一个会指向别的区域的假百分比。
  const atTop = box.y === 0;
  const atBottom = box.y + box.h >= H - 1;
  const atLeft = box.x === 0;
  const atRight = box.x + box.w >= W - 1;
  let pct = null;
  if (atTop && !atBottom) pct = `top:${(box.h / H * 100).toFixed(1)}%`;
  else if (atBottom && !atTop) pct = `bottom:${(box.h / H * 100).toFixed(1)}%`;
  else if (atLeft && !atRight) pct = `left:${(box.w / W * 100).toFixed(1)}%`;
  else if (atRight && !atLeft) pct = `right:${(box.w / W * 100).toFixed(1)}%`;
  const how = forced ? "指定 @" + forced : guess ? (guess.ambiguous ? "猜的（多个候选都装得下，取了最窄）" : "猜的（" + guess.why + "）") : "指定";
  return {
    old: body, oldCapture: srcFrom, detect: how, screen: `${W}×${H}`, scale: +k.toFixed(4),
    now: `${box.x},${box.y},${box.w},${box.h}`, pct,
    hint: pct ? `推荐用百分比：--region ${pct}（与尺寸无关）` : "不贴边，百分比表达不了，用 now 的 px（原图坐标）",
  };
}

/**
 * 把换算结果写回配置文件。
 * 只做**纯文本替换**（"旧值" → "新值"），不重新序列化整个 JSON —— 保住原文件的缩进与字段顺序。
 * 落盘前做 CAS：读时记 sha256 + mtime，写前再核一次，不一致就中止（别的进程改过同一文件时不覆盖）。
 */
function applyToFile(file, pairs, write) {
  if (!existsSync(file)) throw new Error(`没有这个文件：${file}`);
  const raw = readFileSync(file, 'utf8');
  const st0 = statSync(file);
  const sig0 = createHash('sha256').update(raw).digest('hex');
  let out = raw;
  const hits = [];
  for (const { old, now } of pairs) {
    if (!now) continue;
    if (now === old) continue; // 原图坐标的框换算后不变，不用动文件
    const needle = `"${old}"`;
    const n = out.split(needle).length - 1;
    if (n > 0) {
      out = out.split(needle).join(`"${now}"`);
      hits.push({ old, now, n });
    }
  }
  if (hits.length === 0) return { file, written: false, hits, note: '没找到任何「旧值」字面量，文件没动' };
  try {
    JSON.parse(out); // 改完必须还是合法 JSON，否则不写
  } catch {
    throw new Error(`替换后不再是合法 JSON，已中止（没有写入）：${file}`);
  }
  if (!write) return { file, written: false, hits, note: '干跑：确认无误后加 --write 落盘' };
  const st1 = statSync(file);
  const sig1 = createHash('sha256').update(readFileSync(file, 'utf8')).digest('hex');
  if (sig1 !== sig0 || st1.mtimeMs !== st0.mtimeMs) throw new Error('文件在换算期间被改过（sha256/mtime 不一致），中止，没有写入');
  const backup = join(tmpdir(), `cua-gate.bak-${basename(file)}-${Date.now()}`);
  copyFileSync(file, backup);
  writeFileSync(file, out);
  return { file, written: true, hits, backup };
}

/**
 * 读 PiDeck 视觉桥的配置（`~/.pi/agent/pi-deck-vision.json`）。
 * 只读，不改；key 优先用视觉桥自己的，其次退回 models.json 里同供应商的。
 * 返回的 key 只在内存里走，不打印、不写回。
 */
function visionConfig() {
  const file = join(homedir(), '.pi', 'agent', 'pi-deck-vision.json');
  if (!existsSync(file)) throw new Error(`没有视觉桥配置：${file}（设置 → 视觉桥 里开一次）`);
  let cfg;
  try { cfg = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { throw new Error(`视觉桥配置读不出来（${file}）：${e.message}`); }
  if (cfg.enabled === false) throw new Error('视觉桥是关的（设置 → 视觉桥 → 启用视觉桥）');
  if (!cfg.provider || !cfg.model) throw new Error('视觉桥没选供应商/模型');
  let prov = null;
  const mf = join(homedir(), '.pi', 'agent', 'models.json');
  if (existsSync(mf)) {
    try { prov = JSON.parse(readFileSync(mf, 'utf8')).providers?.[cfg.provider] ?? null; } catch { prov = null; } // 读不动就当没有，退到视觉桥自己的字段
  }
  const api = cfg.api ?? prov?.api ?? 'openai-completions';
  if (api !== 'openai-completions') throw new Error(`只接了 openai-completions 风格，这家是 ${api}（要接的话得照它自己的格式拼）`);
  const baseUrl = cfg.baseUrl ?? prov?.baseUrl;
  if (!baseUrl) throw new Error(`拿不到 baseUrl：视觉桥配置和 models.json 都没写 ${cfg.provider}`);
  const apiKey = cfg.apiKey ?? prov?.apiKey;
  if (!apiKey) throw new Error(`拿不到 key：视觉桥配置和 models.json 都没写 ${cfg.provider}`);
  return {
    provider: cfg.provider, model: cfg.model, baseUrl: baseUrl.replace(/\/+$/, ''), apiKey,
    prompt: cfg.promptTemplate ?? '请详细描述这张图片的内容。如果图片中有文字，请完整准确地转录所有可见文字。输出使用中文。',
    maxTokens: cfg.maxTokens ?? 4096,
    timeoutMs: cfg.timeoutMs ?? 120000,
  };
}

/** 把一帧 rgb24 编成 jpg——视觉模型只吃真实图片格式，不接受裸像素。 */
function rgbToJpeg(buf, width, height, ffmpeg = 'ffmpeg') {
  const r = spawnSync(ffmpeg, [
    '-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${width}x${height}`, '-i', 'pipe:0',
    '-frames:v', '1', '-q:v', '4', '-f', 'image2', '-c:v', 'mjpeg', 'pipe:1',
  ], { input: buf, maxBuffer: 1 << 26, windowsHide: true });
  if (r.status !== 0 || !r.stdout?.length) throw new Error(`rgb 转 jpg 失败：${String(r.stderr || '').trim().slice(-160)}`);
  return r.stdout;
}

/** 交给视觉模型转文字。返回 {text, ms, model}；失败抛错，不编内容。 */
async function describeFrame(jpeg, cfg, timeoutMs = cfg.timeoutMs) {
  const t0 = Date.now();
  const body = {
    model: cfg.model,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: cfg.prompt },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${jpeg.toString('base64')}` } },
      ],
    }],
    ...(cfg.maxTokens > 0 ? { max_tokens: cfg.maxTokens } : {}),
    stream: false,
  };
  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}：${raw.replace(/\s+/g, ' ').slice(0, 200)}`);
  let m = null;
  try { m = JSON.parse(raw).choices?.[0]?.message?.content ?? ''; } catch { throw new Error(`返回不是 JSON：${raw.slice(0, 200)}`); }
  if (typeof m !== 'string' || !m.trim()) throw new Error('模型返回了空描述');
  return { text: m.trim(), ms: Date.now() - t0, model: cfg.model };
}

/** 批量换算：一行一个框，一个参数一个框。 */
async function regionConvert(specTexts, opts) {
  if (specTexts.length === 0) throw new Error('给至少一个 px 框：node cua-gate.mjs region 0,218,480,34 --from 480');
  const ep = await findCuaMcp().catch(() => null);
  const scr = ep ? await screenSize(ep.url, opts.token) : null;
  const W = opts.screenW ?? scr?.w;
  const H = opts.screenH ?? scr?.h;
  if (!W || !H) throw new Error('拿不到屏幕尺寸，补 --screen 2560x1440');
  const pairs = [];
  for (const t of specTexts) {
    try {
      const r = convertRegion(t, { from: opts.from > 0 ? opts.from : 0, W, H });
      console.log(JSON.stringify(r));
      if (r.now) pairs.push({ old: r.old, now: r.now });
    } catch (e) {
      console.log(JSON.stringify({ old: t, error: e.message }));
    }
  }
  if (opts.apply) console.log(JSON.stringify(applyToFile(opts.apply, pairs, opts.write)));
}

async function main(argv) {
  if (argv.length === 0) { usage(); return; }
  const [mode = 'once', ...rest] = argv;
  const opt = (name, def) => {
    const i = rest.indexOf(`--${name}`);
    return i >= 0 && rest[i + 1] !== undefined ? rest[i + 1] : def;
  };
  const flag = (name) => rest.includes(`--${name}`);
  const num = (name, def) => { const v = opt(name, undefined); return v === undefined ? def : Number(v); };
  const overrides = {
    cut: num('cut', num('min', undefined)),
    peakMul: num('peak', undefined), peakAbs: num('peak-abs', undefined),
    accNeed: num('acc', undefined),
    cooldown: num('cooldown', undefined),
    burst: num('burst', undefined), burstWindow: num('burst-window', undefined),
    silentFloor: num('silent-floor', undefined), maxWait: num('max-wait', undefined),
    floorMin: num('floor-min', undefined),
  };
  const cells = num('cells', 16);
  const opts = {
    profile: resolveProfile(opt('profile', 'video'), overrides),
    region: opt('region', null),
    force: flag('force'),
    out: opt('out', null),
    fps: num('fps', 12),
    heartbeat: num('heartbeat', 30) * 1000,
    duration: num('duration', 0),
    count: num('count', 0),
    mcp: flag('mcp'),
    longEdge: num('long-edge', 798),
    stats: flag('stats'),
    cells,
    cols: num('cols', Math.ceil(Math.sqrt(cells))),
    cell: num('cell', 480),
    file: opt('file', null),
    from: num('from', 0),
    to: num('to', null),
    token: opt('token', process.env.PIDECK_CUA_TOKEN || tokenFromPiConfig()?.token || ''),
    tokenSource: process.env.PIDECK_CUA_TOKEN ? 'env' : (tokenFromPiConfig() ? tokenFromPiConfig().source : null),
    displayId: opt('display', 'primary'),
    display: Number.parseInt(opt('display', '0'), 10) || 0,
    full: flag('full'),
    ffmpeg: process.env.FFMPEG_PATH || 'ffmpeg',
    key: opt('key', null),
    x: num('x', null),
    y: num('y', null),
    times: num('times', 1),
    gap: num('interval', 60),
    button: opt('button', 'left'),
    double: flag('double'),
    modifier: opt('modifier', null),
    screenW: Number(String(opt('screen', '') || '').split(/[x×,]/)[0]) || undefined,
    screenH: Number(String(opt('screen', '') || '').split(/[x×,]/)[1]) || undefined,
    apply: opt('apply', null),
    write: flag('write'),
    describe: flag('describe'),
    auto: opt('profile', 'video') === 'auto',
  };

  if (mode === 'region') {
    // 只把「长得像 region」的参数当输入，其余（--from 的值、其它 flag）全不碰
    const specs = rest.filter((a) => /^(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*\d+\s*(@\d+)?\s*|\s*(top|bottom|left|right)\s*:.*)$/i.test(a));
    return regionConvert(specs, opts);
  }
  if (mode === 'tap') return tap(opts);
  if (mode === 'once') return once(opts);
  if (mode === 'watch') return watch(opts);
  if (mode === 'scan') return scan(opts);
  if (mode === 'probe') return probe();
  usage();
}

if (process.argv[1]?.endsWith('cua-gate.mjs')) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(`cua-gate: ${e.message}`);
    process.exitCode = 1;
  });
}

export { existsSync, renameSync, CELLS };
