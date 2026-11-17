# cua-gate


- 当前：`v0.2.0`
- 最新：`v0.2.0`（[Releases](https://github.com/QUNIXNG/cua-gate/releases)）

## 上游

`live` 的持续采集、变化选帧与拼图功能复用上游 [SAOS-3624/dsh-see-now](https://github.com/SAOS-3624/dsh-see-now)（Apache-2.0）的模块。依赖为 npm 上的 `dsh-see-now@^0.2.4`；悬浮窗用上游 0.2.4 起支持的环境变量 `DSH_SEE_NO_WINDOW=1` 关闭，不再依赖私有 fork。升级时跟随上游并核对 runner 接口。悬浮窗、语音和 DSH 宿主集成不属于本扩展的使用范围。
Pi 扩展：注册 `cua_look` 工具，在截图、连续屏幕观察和视频采样前先做本地变化评分，避免把没有实质变化的画面反复送入模型。

## 功能

- `once`：判断当前画面是否值得保留。
- `watch`：连续观察，按变化、尖峰和冷却规则输出帧。
- `live`：持续采集屏幕，复用 dsh-see-now 的选帧和拼图模块，返回变化画面的 PNG 路径；`stop=true` 停止采集。不启动 DSH 悬浮窗或语音。
- `scan`：把视频或一段时间采样为缩略表。
- `tap`：发送键盘或鼠标输入。
- `probe`：检查本机 CUA MCP 端点。
- `region`：换算屏幕区域坐标。

## 文件布局

```text
~/.pi/agent/extensions/cua-gate.ts
~/.pi/agent/lib/cua-gate/cua-gate.mjs
~/.pi/agent/lib/cua-gate/frame-score.mjs
```

入口文件只负责装配参数和启动脚本；判分、采集和输入逻辑在 `lib/cua-gate` 中。

## 环境要求

- Pi / PiDeck 的扩展运行环境。
- 使用屏幕采集时需要可访问的 CUA MCP 服务。
- 视频模式需要 FFmpeg；没有视频需求时不需要安装。
- 可通过 `CUA_GATE_DIR` 指定运行脚本目录，通过 `CUA_GATE_STATE` 指定状态文件。

运行时状态保存在用户目录，不上传状态、截图或日志。

示例：

```text
cua_look({ action: "once" })
cua_look({ action: "scan", file: "demo.mp4", duration: 20, cells: 9 })
```
