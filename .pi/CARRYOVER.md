# SpaceFree（Macos-Dynamic-Space-Free）工作承接

## 项目状态：v0.1 完成，清理链路已 E2E 实证 + 清理历史可追溯 ✅

macOS 动态磁盘清理工具：终端核心（`spacefree` CLI）+ Web 仪表盘（原生 http + SSE，零运行时依赖，Node 26 + TS）。git 已提交 6 次。服务器跑在 localhost:8642（日志 /tmp/sf-serve.log）。

## 本轮关键事件（2026-10-02）
- 用户反馈"选了删除但下次扫描又出现"→ 排查：**用户只走了 Dry-run 没点红色确认按钮**，包根本没删
- 已代用户真实删除 tesseract-lang（685.7MB），tesseract 主包因被 ghostscript 依赖正确保留；brew 7 顺带 autoremove 了 icu4c@77
- **新增清理历史功能**：真实执行写入 ~/.spacefree/history.jsonl + /api/history + 日志页顶部展示——"删没删"永远可查
- **用户要求 ollama/postgresql@16 不开机自启**：已 `brew services stop` 两个服务（LaunchAgent plist 已移除、进程已结束），并已加入 protect 名单防止被误判为清理候选。用户将手动启动（教过 `brew services run` = 只跑一次不自启，区别于 `start` = 注册自启）
- 验证链完整：157 formula（159-2）✓，候选只剩 1（pngpaste）

## 用户教育要点（下次沟通确认用户已理解）
- 流程必须是：勾选 → 预览清理 → **预演完成弹窗里的红色「确认执行清理」按钮** → 真正执行
- 预演/取消/Esc 关弹窗都不会删除；删没删看「日志页顶部的清理记录」
- 手动启动服务用 `brew services run ollama`（run=一次性，start=注册自启）

## 历史排查经验（已沉淀）
1. 页面卡死：旧进程占 8642 + 缓存旧 app.js 混新 HTML → 静态 no-store、SSE flushHeaders、EADDRINUSE 友好提示、listening 后 open、onerror 红条
2. 空悬浮窗：display:flex 覆盖 hidden 属性 → 全局 `[hidden]{display:none!important}` + 遮罩点击/Esc 关闭
3. 通用：UI 验证必须查 getComputedStyle（临时页+无头 Chrome dump-dom 技巧）；`--virtual-time-budget` 与 SSE 不兼容假性挂起，用 `--timeout`
4. brew 7：uninstall 默认 autoremove 孤儿（hello→openjdk@25、tesseract-lang→icu4c@77）；brew uninstall 无 -n 参数；BSD du 的 -s/-d 互斥用 `du -k -d 1`；mdls -raw 多字段拼行要用带标签输出

## 本机事实
Apple Silicon /opt/homebrew，brew 7.0.7，现在 157 formula+12 cask；ollama/postgresql@16 已停止自启（protect: git/curl/ollama/postgresql@16）；剩余候选 pngpaste/qlmarkdown/幽灵酒桶 dbeaver-community+miaoyan+vts；brew 缓存可清 811MB；钩子已装 ~/.zshrc（备份 ~/.zshrc.spacefree-bak）

## 待办 / 下一步
- [ ] 用户浏览器走查：新确认流程 + 日志页清理历史
- [ ] npm 发布准备（bin: spacefree→dist/cli.js；按 AGENTS.md 铁律：AI 备好、用户终端确认；npm view 校验 + npm pack --dry-run + README 徽章 4 枚）
- [ ] 未来增强：npm/pip/gradle 缓存、Xcode DerivedData、多 HOMEBREW_PREFIX、homebrew-bundle 导出保留清单
- [ ] eslogger 守护进程实测（需 sudo，用户手动）

## 数据位置
~/.spacefree/{config.json, events.jsonl, state.json, history.jsonl}