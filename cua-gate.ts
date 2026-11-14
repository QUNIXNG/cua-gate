/**
 * cua-gate 扩展 — 屏幕闸门工具 `cua_look`
 *
 * 运行时脚本在 `~/.pi/agent/lib/cua-gate/`（可用 CUA_GATE_DIR 覆盖）。
 * 本文件只做三件事：装配参数 → spawn `node cua-gate.mjs` → 把脚本输出的 JSON 行原样交回。
 * 判分 / 采集 / 状态 / 视觉描述全在脚本里，出问题能脱离 pi 单独复现：
 *   node ~/.pi/agent/lib/cua-gate/cua-gate.mjs once --mcp
 *
 * 状态文件走 `$CUA_GATE_STATE`（未设则用 ~/.pi/agent/lib/cua-gate/state.json），
 * 因为屏幕是全局一份，基线不该跟着项目目录走。
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { Type } from "typebox";
import type { Static } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const HOME_CANDIDATES = [
	process.env.CUA_GATE_DIR,
	join(homedir(), ".pi", "agent", "lib", "cua-gate"),
].filter((d): d is string => Boolean(d));

function runtimeFile(): string {
	for (const dir of HOME_CANDIDATES) {
		const file = join(dir, "cua-gate.mjs");
		if (existsSync(file)) return file;
	}
	throw new Error(`找不到 cua-gate.mjs，试过：${HOME_CANDIDATES.join(" / ")}（用 CUA_GATE_DIR 指定目录）`);
}

const STATE_FILE = process.env.CUA_GATE_STATE || join(homedir(), ".pi", "agent", "lib", "cua-gate", "state.json");

const PARAMS = Type.Object({
	action: StringEnum(["once", "watch", "scan", "tap", "probe", "region"] as const, {
		description: "once=判一帧（默认）；watch=连续判；scan=两遍扫描拼缩略表；tap=发输入；probe=探端点；region=像素框换算",
		default: "once",
	}),
	profile: Type.Optional(
		StringEnum(["video", "game", "subtitle", "auto"] as const, {
			description: "档位。auto 按画面/窗口自己选；不给则用上一次的",
		}),
	),
	region: Type.Optional(Type.String({ description: "只看某块区域：bottom:25% / top:30% / x,y,w,h（真像素框）" })),
	out: Type.Optional(Type.String({ description: "落盘路径（once 存帧、scan 存缩略表）。相对路径按项目根" })),
	file: Type.Optional(Type.String({ description: "把视频当屏幕回放（配 from/to）" })),
	mcp: Type.Optional(Type.Boolean({ description: "走 cua_capture 取图（同一条采集路径，口径一致）" })),
	force: Type.Optional(Type.Boolean({ description: "once: 强制 out 输出；scan: 忽略冷却" })),
	full: Type.Optional(Type.Boolean({ description: "once: 按原分辨率重采（字能看清，多花 0.4s）" })),
	describe: Type.Optional(Type.Boolean({ description: "出帧后调用视觉桥配置把这张图转成文字（顺手，但要十几秒）" })),
	stats: Type.Optional(Type.Boolean({ description: "跑完打一行分数分布（标定用）" })),
	duration: Type.Optional(Type.Number({ description: "watch/scan 跑多久（秒）" })),
	count: Type.Optional(Type.Number({ description: "watch 结束条件：最多出几张" })),
	cells: Type.Optional(Type.Number({ description: "scan 铺几格（4/6/9/12/16）" })),
	from: Type.Optional(Type.Number({ description: "file 模式的起点（秒）；region 模式的旧采集宽" })),
	to: Type.Optional(Type.Number({ description: "file 模式的终点（秒）" })),
	longEdge: Type.Optional(Type.Number({ description: "mcp 取图长边，默认 798（42px 对齐：token 按 42px 一格计价，798 刚好 19 格不浪费）" })),
	display: Type.Optional(Type.Number({ description: "显示器序号（0 主屏、1 第二屏），once/watch/scan 有效" })),
	x: Type.Optional(Type.Number({ description: "tap：屏幕坐标 x（要和 y 成对给）" })),
	y: Type.Optional(Type.Number({ description: "tap：屏幕坐标 y（要和 x 成对给）" })),
	key: Type.Optional(Type.String({ description: "tap：按键名（space/left/enter/ctrl…）" })),
	times: Type.Optional(Type.Number({ description: "tap：连按几次" })),
	button: Type.Optional(StringEnum(["left", "right", "middle"] as const, { description: "tap：鼠标按键，默认 left" })),
	double: Type.Optional(Type.Boolean({ description: "tap：双击" })),
	interval: Type.Optional(Type.Number({ description: "tap：按键间隔（毫秒）" })),
	modifier: Type.Optional(Type.String({ description: "tap：修饰键（ctrl/alt/shift/win，逗号分隔多个）" })),
	specs: Type.Optional(Type.Array(Type.String(), { description: "region 模式：要换算的框，如 [\"0,218,480,34\"]" })),
	apply: Type.Optional(Type.String({ description: "region 模式：把换算结果写回这个文件（JSON 配置，纯文本替换）" })),
	write: Type.Optional(Type.Boolean({ description: "region 模式：配合 apply 真正落盘（默认只干跑）" })),
	cut: Type.Optional(Type.Number({ description: "覆盖阈值：单帧变化分过线即出（标定用，一般不动）" })),
	peak: Type.Optional(Type.Number({ description: "覆盖阈值：尖峰倍率 peakMul（标定用）" })),
	peakAbs: Type.Optional(Type.Number({ description: "覆盖阈值：尖峰绝对值下限（标定用）" })),
	acc: Type.Optional(Type.Number({ description: "覆盖阈值：积分门槛 accNeed（标定用）" })),
	cooldown: Type.Optional(Type.Number({ description: "覆盖阈值：出帧冷却（秒，标定用）" })),
	burst: Type.Optional(Type.Number({ description: "覆盖阈值：burstWindow 内最多连出几张（标定用）" })),
	burstWindow: Type.Optional(Type.Number({ description: "覆盖阈值：burst 窗口（秒，标定用）" })),
	silentFloor: Type.Optional(Type.Number({ description: "覆盖阈值：静默兜底（秒，标定用）" })),
	maxWait: Type.Optional(Type.Number({ description: "覆盖阈值：最长等待（秒，标定用）" })),
	floorMin: Type.Optional(Type.Number({ description: "覆盖阈值：兜底最小变化分（标定用）" })),
});

type Params = Static<typeof PARAMS>;

function buildArgs(p: Params, cwd: string): string[] {
	const args: string[] = [p.action];
	const abs = (v: string) => (isAbsolute(v) ? v : resolve(cwd, v));

	if (p.action === "region") {
		for (const spec of p.specs ?? []) args.push(spec);
		if (p.from != null) args.push("--from", String(p.from));
		if (p.apply) args.push("--apply", abs(p.apply));
		if (p.write) args.push("--write");
		return args;
	}
	if (p.action === "tap") {
		if ((p.x == null) !== (p.y == null)) throw new Error("tap 的 x 和 y 要么都给，要么都不给");
		if (p.x != null && p.y != null) args.push("--x", String(p.x), "--y", String(p.y));
		if (p.key) args.push("--key", p.key);
		if (p.times != null) args.push("--times", String(p.times));
		if (p.interval != null) args.push("--interval", String(p.interval));
		if (p.button) args.push("--button", p.button);
		if (p.double) args.push("--double");
		if (p.modifier) args.push("--modifier", p.modifier);
		return args;
	}
	if (p.profile) args.push("--profile", p.profile);
	if (p.region) args.push("--region", p.region);
	if (p.file) args.push("--file", abs(p.file));
	if (p.out) args.push("--out", abs(p.out));
	if (p.cells != null) args.push("--cells", String(p.cells));
	if (p.duration != null) args.push("--duration", String(p.duration));
	if (p.count != null) args.push("--count", String(p.count));
	if (p.from != null) args.push("--from", String(p.from));
	if (p.to != null) args.push("--to", String(p.to));
	if (p.longEdge != null) args.push("--long-edge", String(p.longEdge));
	if (p.display != null) args.push("--display", String(p.display));
	if (p.mcp) args.push("--mcp");
	if (p.force) args.push("--force");
	if (p.full) args.push("--full");
	if (p.describe) args.push("--describe");
	if (p.stats) args.push("--stats");
	if (p.cut != null) args.push("--cut", String(p.cut));
	if (p.peak != null) args.push("--peak", String(p.peak));
	if (p.peakAbs != null) args.push("--peak-abs", String(p.peakAbs));
	if (p.acc != null) args.push("--acc", String(p.acc));
	if (p.cooldown != null) args.push("--cooldown", String(p.cooldown));
	if (p.burst != null) args.push("--burst", String(p.burst));
	if (p.burstWindow != null) args.push("--burst-window", String(p.burstWindow));
	if (p.silentFloor != null) args.push("--silent-floor", String(p.silentFloor));
	if (p.maxWait != null) args.push("--max-wait", String(p.maxWait));
	if (p.floorMin != null) args.push("--floor-min", String(p.floorMin));
	return args;
}

function timeoutFor(p: Params): number {
	if (p.action === "watch") return ((p.duration ?? 30) + 30) * 1000;
	if (p.action === "scan") return ((p.duration ?? 12) * 3 + 120) * 1000;
	if (p.action === "probe") return 30_000;
	if (p.action === "once") return (p.describe || p.full) ? 120_000 : 30_000;
	return 60_000; // tap / region
}

function run(
	script: string,
	args: string[],
	cwd: string,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; code: number | null; timedOut: boolean; aborted: boolean }> {
	return new Promise((resolvePromise) => {
		const child = spawn("node", [script, ...args], {
			cwd,
			env: { ...process.env, CUA_GATE_STATE: STATE_FILE },
			windowsHide: true,
		});
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let aborted = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill();
		}, timeoutMs);
		const onAbort = () => {
			aborted = true;
			child.kill();
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		child.stdout.on("data", (b: Buffer) => (stdout += b.toString("utf8")));
		child.stderr.on("data", (b: Buffer) => (stderr += b.toString("utf8")));
		child.on("error", (err) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			resolvePromise({ stdout, stderr: `${stderr}${String(err)}`, code: -1, timedOut, aborted });
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			resolvePromise({ stdout, stderr, code, timedOut, aborted });
		});
	});
}

export default function cuaGateExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "cua_look",
		label: "Look at screen (cua-gate)",
		description:
			"看当前屏幕：截一帧按「变化积分 + 尖峰 + 冷却」判值不值得看，值得才返回；也能对一段视频/几个时间点采样成缩略表。返回 JSON。",
		promptSnippet:
			"cua_look — 判当前屏幕这一帧值不值得看（once/watch/scan/tap/probe/region），省掉盲抓图的浪费",
		promptGuidelines: [
			"用 cua_look 而不是随手截全屏：它先本地打分，verdict=skip 就别再抓图。",
			"cua_look 的 once 返回 verdict=keep 时才值得取图（加 out 落盘），skip 说明画面没实质变化。",
			"要看视频/网页里「哪一段有意思」用 cua_look 的 action=scan，别自己抽帧拼图。",
			"cua_look 的 tap 能发键盘/鼠标（绕开 PiDeck 注入失效的那条路），回看视频用 tap 跳进度。",
		],
		parameters: PARAMS,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const p = params as Params;
			const script = runtimeFile();
			const args = buildArgs(p, ctx.cwd);
			const result = await run(script, args, ctx.cwd, timeoutFor(p), signal);

			const head = result.aborted ? "已取消：\n" : result.timedOut ? `超时被中止（${timeoutFor(p) / 1000}s）：\n` : "";
			const err = result.code !== 0 && !result.timedOut && !result.aborted ? `退出码 ${result.code}：\n` : "";
			const out = result.stdout.trim();
			const errOut = result.stderr.trim();
			// 脚本失败时 stderr 里的报错比 stdout 更有用，别只留 stdout
			const text = result.code !== 0 && !result.timedOut && !result.aborted && errOut
				? (out ? `${out}\n${errOut}` : errOut)
				: (out || errOut || "（没有输出）");
			const lines = text.split(/\r?\n/).filter(Boolean);
			const parsed: unknown[] = [];
			for (const line of lines) {
				try {
					parsed.push(JSON.parse(line));
				} catch {
					// 非 JSON 行（用法提示、ffmpeg 噪音）原样留在 text 里
				}
			}
			return {
				content: [{ type: "text", text: `${head}${err}${text}` }],
				details: { action: p.action, args, code: result.code, timedOut: result.timedOut, aborted: result.aborted, lines: parsed },
			};
		},
	});
}
