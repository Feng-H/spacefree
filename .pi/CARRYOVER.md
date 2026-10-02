# SpaceFree（Macos-Dynamic-Space-Free）工作承接

## 项目状态：v0.1 完成，清理链路已 E2E 实证 ✅

macOS 动态磁盘清理工具：终端核心（`spacefree` CLI）+ Web 仪表盘（原生 http + SSE，零运行时依赖，Node 26 + TS）。git 已提交 5 次。服务器跑在 localhost:8642（日志 /tmp/sf-serve.log）。

## E2E 实证结论（2026-10-02）
- brew 包：`brew install hello` → 判 unused 候选 → Dry-run 只出计划不删（复核日志：反向依赖/进程/服务/保护名单）→ 确认后真实卸载（Cellar/brew list/PATH 三处验证消失）
- **brew 7 行为发现**：`brew uninstall` 默认自动 autoremove 孤儿（验证时顺带删了 openjdk@25，~380MB）——符合预期但需用户知情，README 已说明
- 应用：假 .app 真实删除 → 源路径消失 + Finder 废纸篓中存在（可恢复）
- 清理后自动重扫，state 刷新验证（161-2=159 ✓）
- 测试时临时改过 graceDays=0，已恢复 30

## 新增 UX（本次）
- Dry-run 完成弹窗：展示安全拦截项 + 红色"确认执行清理"按钮（必须显式确认才真正执行）
- 清理完成弹窗：成功/跳过摘要 + 自动重扫提示；执行后清除勾选并重渲染表格
- clean-done SSE 事件携带 skipped 名单

## 历史排查经验（已沉淀）
1. 页面卡死：旧进程占 8642 + 缓存旧 app.js 混新 HTML → 静态 no-store、SSE flushHeaders、EADDRINUSE 友好提示、listening 后 open、onerror 红条
2. 空悬浮窗：`.modal-mask`/`.action-bar` 的 display:flex 覆盖 hidden 属性 → 全局 `[hidden]{display:none!important}` + 遮罩点击/Esc 关闭
3. 通用：UI 验证必须查 getComputedStyle（临时页+无头 Chrome dump-dom 技巧）；`--virtual-time-budget` 与 SSE 不兼容假性挂起，用 `--timeout`

## 本机事实
Apple Silicon /opt/homebrew，brew 7.0.7，现在 159 formula+12 cask（hello/openjdk@25 已删）；服务 ollama/postgresql@16 运行中；真实候选 tesseract-lang(654MB)/pngpaste/qlmarkdown/幽灵酒桶 dbeaver-community+miaoyan+vts；brew 缓存可清 811MB；钩子已装 ~/.zshrc（备份 ~/.zshrc.spacefree-bak）

## 待办 / 下一步
- [ ] 用户浏览器走查新确认流程（刷新即可）
- [ ] npm 发布准备（bin: spacefree→dist/cli.js；按 AGENTS.md 铁律：AI 备好、用户终端确认；npm view 校验 + npm pack --dry-run + README 徽章 4 枚）
- [ ] 未来增强：npm/pip/gradle 缓存、Xcode DerivedData、多 HOMEBREW_PREFIX、homebrew-bundle 导出保留清单
- [ ] eslogger 守护进程实测（需 sudo，用户手动）

## 数据位置
~/.spacefree/{config.json, events.jsonl, state.json}