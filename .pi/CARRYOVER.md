# SpaceFree（Macos-Dynamic-Space-Free）工作承接

## 项目状态：v0.1 完成并修复浏览器卡死问题 ✅

macOS 动态磁盘清理工具：终端核心（`spacefree` CLI）+ Web 仪表盘（原生 http + SSE，零运行时依赖，Node 26 + TS）。git 已提交 3 次（feat → docs → fix）。

## 浏览器卡死排查结论（2026-10-02）
- 根因 1：AI 调试遗留的旧 serve 进程占着 8642 → 用户再启动 `serve -o` 必 EADDRINUSE 崩溃（open 先于 listen 执行，浏览器打开的是旧实例）
- 根因 2：浏览器缓存了旧版 app.js（无 renderCasks），新 index.html 调用 → TypeError → 页面卡死空白
- 修复（全部验证通过）：静态资源 `Cache-Control: no-store`；SSE `flushHeaders()` + 立即 `: connected` 首帧；EADDRINUSE 友好提示（含 kill 命令）；CLI 改为 `listening` 事件后才 spawn open；前端 window.onerror/unhandledrejection 红条兜底
- 验证手段：无头 Chrome `--dump-dom --timeout` 检查关键 DOM（172 行公式、12 cask 复选框、卡片数值）。注意：`--virtual-time-budget` 与 SSE 长连接不兼容会假性挂起，勿用
- 服务器现跑在 localhost:8642（后台，日志 /tmp/sf-serve.log）

## 已完成（功能全验证）
- 扫描：brew formula/cask 清单+大小+安装时间+依赖图（Homebrew 7 `brew deps --installed` 含 cask，需按 installed 集合分类）；应用(Spotlight mdls 带标签输出，`-raw` 多字段拼行是坑)；下载 dmg/pkg；brew 缓存
- 使用追踪三源：Shell 历史（zsh EXTENDED_HISTORY/bash/fish）+ preexec 钩子（已装用户 ~/.zshrc，备份 ~/.zshrc.spacefree-bak，git/rg 记录验证 OK）+ Spotlight；eslogger daemon 可选（`daemon plist` 生成）
- 判定：blocked/needed/unused/stale/review/keep；幽灵酒桶 stale；QL 扩展/字体 cask review；123 个包被依赖保护
- 安全执行：dry-run→确认；执行时二次复核（brew uses+ps+services+保护名单+pin）；Finder 废纸篓恢复式删除；brew uninstall 无 -n（预演=真实复核+计划输出）；BSD du 的 -s 与 -d 互斥用 `du -k -d 1`
- Web UI 中文单页（brew+cask/应用/下载/缓存/设置/日志），SSE 日志，阈值即调即算

## 本机事实
Apple Silicon /opt/homebrew，brew 7.0.7，160 formula+12 cask；运行中服务 ollama/postgresql@16（blocked 验证样本）；孤儿 openjdk@25；真实候选 tesseract-lang(654MB)/pngpaste/qlmarkdown/幽灵酒桶 dbeaver-community+miaoyan+vts；brew 缓存可清 811MB

## 待办 / 下一步
- [ ] 用户浏览器实际走查 UI（需 Cmd+Shift+R 强刷一次清掉旧缓存，之后 no-store 生效）
- [ ] npm 发布准备（bin: spacefree→dist/cli.js；按 AGENTS.md 铁律：AI 备好、用户终端确认；npm view 校验 + npm pack --dry-run + README 徽章 4 枚）
- [ ] 未来增强：npm/pip/gradle 缓存、Xcode DerivedData、多 HOMEBREW_PREFIX、homebrew-bundle 导出保留清单
- [ ] eslogger 守护进程实测（需 sudo，用户手动）

## 数据位置
~/.spacefree/{config.json, events.jsonl, state.json}