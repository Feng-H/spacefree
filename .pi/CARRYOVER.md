# SpaceFree（Macos-Dynamic-Space-Free）工作承接

## 项目状态：v0.1 完成，6S 理念已产品化（删得果断、重装一键）✅

macOS 动态磁盘清理工具：终端核心（`spacefree` CLI）+ Web 仪表盘（原生 http + SSE，零运行时依赖，Node 26 + TS）。git 已提交 8 次。服务器跑在 localhost:8642（日志 /tmp/sf-serve.log）。

## 核心理念（用户明确要求，已贯彻）
- **6S 整理**：现在不需要的果断删，重装成本 ≈ 一条命令（互联网+brew 在）
- 保护 ≠ 永久豁免：ollama/postgresql@16 已移出 protect，改为钩子识别 `brew services run/start/restart <包>` 计为使用（stop 不计）——手动启动即算使用，长期不用按阈值正常判候选
- 删除可逆：清理历史每条带「重装」按钮；「一键重装全部已删的包」；「导出 Brewfile 留底」（brew bundle dump → ~/.spacefree/Brewfile.backup，可用 brew bundle --file 恢复整套环境）

## 本轮关键事件（2026-10-02）
- 用户"选了删除但没删"→ 只走了 Dry-run 没点红色确认按钮；已真实删除 tesseract-lang(685.7MB)（tesseract 主包被 ghostscript 依赖正确保留；brew 7 顺带 autoremove icu4c@77）
- 清理历史：~/.spacefree/history.jsonl + /api/history + 日志页展示；真实执行才写入（install 不写入清理历史）；deleted 字段结构化记录可重装项（旧记录已迁移）
- E2E 验证重装闭环：hello 删除→install-formula 一键重装→再删除 ✓
- ollama/postgresql@16：已停服务+取消自启（用户手动 `brew services run`）；测试中误启的 ollama 已再停
- 期间还执行过一次 brew cleanup（811MB 缓存，9:40）

## 用户教育要点（下次沟通确认用户已理解）
- 流程：勾选 → 预览清理 → **预演完成弹窗里的红色「确认执行清理」按钮** → 真正执行
- 预演/取消/Esc 不删除；删没删看「日志页顶部的清理记录」；后悔了同页一键重装
- 手动启动服务 `brew services run ollama`（run=一次性且计为使用；start=注册自启）

## 历史排查经验（已沉淀）
1. 页面卡死：旧进程占 8642 + 缓存旧 app.js 混新 HTML → 静态 no-store、SSE flushHeaders、EADDRINUSE 友好提示、listening 后 open、onerror 红条
2. 空悬浮窗：display:flex 覆盖 hidden 属性 → 全局 `[hidden]{display:none!important}` + 遮罩点击/Esc 关闭
3. UI 验证必须查 getComputedStyle（临时页+无头 Chrome dump-dom）；`--virtual-time-budget` 与 SSE 不兼容假性挂起用 `--timeout`
4. brew 7：uninstall 默认 autoremove 孤儿；brew uninstall 无 -n；BSD du -s/-d 互斥用 `du -k -d 1`；mdls -raw 多字段拼行用带标签输出
5. TS 模板字面量里 shell 的 `${...}` 必须写成 `\${...}`

## 本机事实
Apple Silicon /opt/homebrew，brew 7.0.7，157 formula+12 cask；ollama/postgresql@16 未运行未自启（protect 仅 git/curl）；剩余候选 pngpaste/qlmarkdown/幽灵酒桶 dbeaver-community+miaoyan+vts；brew 缓存已清；钩子 v2 已装 ~/.zshrc 含服务识别（备份 ~/.zshrc.spacefree-bak）

## 待办 / 下一步
- [ ] 用户浏览器走查：确认流程 + 清理历史 + 重装按钮 + Brewfile 导出
- [ ] npm 发布准备（bin: spacefree→dist/cli.js；按 AGENTS.md 铁律：AI 备好、用户终端确认；npm view 校验 + npm pack --dry-run + README 徽章 4 枚）
- [ ] 未来增强：npm/pip/gradle 缓存、Xcode DerivedData、多 HOMEBREW_PREFIX、按 6S 理念可考虑缩短默认阈值/宽限期的设置引导
- [ ] eslogger 守护进程实测（需 sudo，用户手动）

## 数据位置
~/.spacefree/{config.json, events.jsonl, state.json, history.jsonl, Brewfile.backup}