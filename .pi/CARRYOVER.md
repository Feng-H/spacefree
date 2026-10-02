# SpaceFree（Macos-Dynamic-Space-Free）工作承接

## 项目状态：v0.1 完成，浏览器两大卡死/悬浮窗问题已修复 ✅

macOS 动态磁盘清理工具：终端核心（`spacefree` CLI）+ Web 仪表盘（原生 http + SSE，零运行时依赖，Node 26 + TS）。git 已提交 4 次（feat → docs → fix×2）。

## 前端两轮排查结论（2026-10-02）
1. 页面卡死：旧 serve 进程占 8642（用户启动必 EADDRINUSE）+ 浏览器缓存旧 app.js 与新 HTML 混搭 → TypeError。修复：静态资源 no-store、SSE flushHeaders+首帧、EADDRINUSE 友好提示、CLI listening 后才 open、window.onerror 红条兜底
2. 空悬浮窗：`.modal-mask`/`footer.action-bar` 的 `display:flex` 覆盖 HTML `hidden` 属性 → 空弹窗常驻点不掉。修复：全局 `[hidden]{display:none!important}` + 遮罩点击/Esc 关闭。验证方式：临时测试页 + 无头 Chrome dump-dom 读取 getComputedStyle（data-modal-display="none"）
- 通用经验：UI 验证必须查计算样式与视觉状态，DOM 转储只证明结构不证明可见性；`--virtual-time-budget` 与 SSE 不兼容会假性挂起，用 `--timeout` 代替

## 已完成（功能全验证）
- 扫描：brew formula/cask 清单+大小+安装时间+依赖图（Homebrew 7 `brew deps --installed` 含 cask，按 installed 集合分类）；应用（Spotlight mdls 带标签输出，`-raw` 多字段拼行是坑）；下载 dmg/pkg；brew 缓存
- 使用追踪三源：Shell 历史（zsh EXTENDED_HISTORY/bash/fish）+ preexec 钩子（已装用户 ~/.zshrc，备份 ~/.zshrc.spacefree-bak）+ Spotlight；eslogger daemon 可选（`daemon plist`）
- 判定：blocked/needed/unused/stale/review/keep；幽灵酒桶 stale；QL 扩展/字体 cask review；123 包被依赖保护
- 安全执行：dry-run→确认；执行时二次复核（brew uses+ps+services+保护名单+pin）；Finder 废纸篓恢复式删除；brew uninstall 无 -n（预演=真实复核+计划输出）；BSD du 的 -s/-d 互斥用 `du -k -d 1`
- Web UI 中文单页（brew+cask/应用/下载/缓存/设置/日志），SSE 日志，阈值即调即算

## 本机事实
Apple Silicon /opt/homebrew，brew 7.0.7，160 formula+12 cask；运行中服务 ollama/postgresql@16；孤儿 openjdk@25；真实候选 tesseract-lang(654MB)/pngpaste/qlmarkdown/幽灵酒桶 dbeaver-community+miaoyan+vts；brew 缓存可清 811MB；服务器现跑 localhost:8642（日志 /tmp/sf-serve.log）

## 待办 / 下一步
- [ ] 用户浏览器走查 UI（普通刷新即可，no-store 已生效）
- [ ] npm 发布准备（bin: spacefree→dist/cli.js；按 AGENTS.md 铁律：AI 备好、用户终端确认；npm view 校验 + npm pack --dry-run + README 徽章 4 枚）
- [ ] 未来增强：npm/pip/gradle 缓存、Xcode DerivedData、多 HOMEBREW_PREFIX、homebrew-bundle 导出保留清单
- [ ] eslogger 守护进程实测（需 sudo，用户手动）

## 数据位置
~/.spacefree/{config.json, events.jsonl, state.json}