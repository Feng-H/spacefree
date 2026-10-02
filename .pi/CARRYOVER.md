# SpaceFree（Macos-Dynamic-Space-Free）工作承接

## 项目状态：v0.1 已完成并全流程验证通过 ✅

macOS 动态磁盘清理工具：终端核心（`spacefree` CLI）+ Web 仪表盘（原生 http + SSE，零运行时依赖，Node 26 + TS）。

## 已完成
- 扫描引擎：brew formula/cask 清单+大小+安装时间+依赖图（Homebrew 7 的 `brew deps --installed` 含 cask，已按 installed 集合分类）
- 使用追踪三源：Shell 历史（zsh EXTENDED_HISTORY/bash/fish）+ preexec 钩子（zsh/bash/fish，已装到用户 ~/.zshrc，端到端验证 git/rg 记录正确）+ Spotlight（mdls 带标签输出；注意 `-raw` 多字段会拼行，已踩坑修复）
- 判定引擎：blocked/needed/unused/stale/review/keep；幽灵酒桶（.app 已删）标 stale；QL 扩展与字体 cask 标 review
- 安全执行：dry-run → 确认；执行时二次复核（brew uses + ps 运行中 + services + 保护名单 + pin）；应用/文件走 Finder 废纸篓（osascript 验证通过）；brew uninstall 无 -n 参数（踩坑），预演=真实依赖复核+计划输出
- Web UI：中文单页（brew/cask/应用/下载/缓存/设置/日志），排序筛选、阈值即调即算、SSE 日志
- eslogger LaunchDaemon 可选 root 级监控（`spacefree daemon plist` 生成，需用户 sudo 安装）
- 服务器跑在 localhost:8642（用户浏览器已打开）；git 已初始化并提交 2 次

## 关键环境事实
- 本机：Apple Silicon /opt/homebrew，brew 7.0.7，160 formula + 12 cask，zsh（用户 .zsh_history 原本无时间戳，钩子已 setopt EXTENDED_HISTORY）
- 运行中服务样本：ollama、postgresql@16（被 blocked 验证）；孤儿样本 openjdk@25；真实候选 tesseract-lang(654MB)/pngpaste/qlmarkdown
- 用户 .zshrc 备份于 ~/.zshrc.spacefree-bak
- BSD du：-s 与 -d 互斥，用 `du -k -d 1`

## 待办 / 下一步（未做）
- [ ] Web UI 视觉走查（功能 API 已验证，浏览器已打开但未截图确认渲染细节）
- [ ] 让 clean --yes CLI 也走执行时复核（cleaner.uninstallFormulae 已内置复核，CLI 路径已复用，仅指 UI 交互细节）
- [ ] npm 发布准备（package.json bin 已配 spacefree→dist/cli.js；按 AGENTS.md 发布铁律：AI 备好一切、用户终端确认；发布前需 npm view 校验 + npm pack --dry-run + README 徽章块 4 枚规范）
- [ ] 未来增强：npm/pip/gradle 缓存清理、Xcode DerivedData、多用户/多 HOMEBREW_PREFIX、homebrew-bundle 导出保留清单
- [ ] eslogger 守护进程实测（需 sudo，用户手动）

## 数据位置
~/.spacefree/{config.json, events.jsonl, state.json}