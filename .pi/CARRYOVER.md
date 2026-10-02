# SpaceFree（Macos-Dynamic-Space-Free）工作承接

## 项目状态：v0.2 TUI 版完成 ✅

macOS 动态磁盘清理工具：**全键盘 TUI（默认）** + 终端 CLI + 可选 Web。零运行时依赖，Node 26 + TS。git 已提交 9 次。

## 本轮（2026-10-02 后半）完成
1. **TUI 交互界面**（src/tui.ts，~1000 行原生 ANSI）：默认命令（无参数=进 TUI）；7 页签 [1]Homebrew [2]应用 [3]下载 [4]项目依赖 [5]缓存 [6]历史 [7]设置；space 勾选/a 全选候选//搜索/s 排序/d 预演/x 执行（**必须输入 yes**）/r 重扫/q 退出；日志实时流；CJK 宽度安全渲染。测试方法：`(printf '4'; sleep 2; ...) | script -q /dev/null node dist/cli.js`（pty）
2. **项目依赖动态清理**（src/projects.ts）：扫描 projectRoots（默认 ~/pidev 等，config 可改）深度 2 的 node_modules/.venv/venv；**双信号判定**：源码最新 mtime（find -prune 排除依赖目录）+ 钩子 cwd 记录（事件三字段 ts formula cwd）；> 阈值 → 删依赖目录（进废纸篓），源码保留。实测发现 4 项目（pi-carryover 1GB 等）判定正确
3. **钩子 v3**：记录命令运行目录（printf 三字段），自测通过；已重装到用户 ~/.zshrc
4. **借鉴 Mole**：缓存页扩类别（npm/pip/uv/pnpm/bun/yarn 官方命令可清 [n 键]；Gradle/Cargo/Playwright/Ollama 模型仅展示）；brew cleanup [c 键]；**磁盘真实释放量**（df before/after 写入执行日志）；README 增加"与 Mole 互补"定位
5. history.ts 抽共享模块（TUI/Web 共用）；cleaner 加 install-formula/dev-cache op

## 设计要点（勿回退）
- 用户理念：**6S 整理**——不用就删，重装≈一条命令；删除可逆（历史+重装按钮+Brewfile）；保护≠永久豁免（服务类用 brew services run 计为使用）
- TUI 确定性问题（用户核心痛点）：d 预演 → x → 输入 yes 才真删；执行后磁盘释放量报告；清理历史持久化
- 缓存展示型目录（gradle/playwright/ollama models）仅展示——尊重用户 Mole 白名单习惯

## 本机事实
Apple Silicon /opt/homebrew，brew 7.0.7，157 formula+12 cask；ollama/postgresql@16 手动模式（未运行未自启，protect 仅 git/curl）；项目：~/pidev 4 个含 node_modules（都活跃，暂无候选）；npm 缓存 214MB 可清；Ollama 模型 2.3GB/Playwright 1GB 仅展示；服务器仍跑 8642（Web 用）

## 已知待改
- [ ] Web UI 未加"项目依赖"页签（TUI 已完整；web/projects 数据在 /api/state 里现成）
- [ ] TUI 首帧会有一次短暂闪烁（全清屏重画）；无颜色主题开关
- [ ] 历史排查经验全部沉淀在 git log 与本文件；新增坑：TS 模板字面量 shell `${}` 转义、python heredoc 改文件时 assert 失败会丢全部修改（先验证再写）、sortIdx 缺 tab 初始值会 NaN 崩溃

## 待办 / 下一步
- [ ] 用户 TUI 实际走查（node dist/cli.js）
- [ ] npm 发布准备（bin: spacefree→dist/cli.js；按 AGENTS.md 铁律：AI 备好、用户终端确认；npm view 校验 + npm pack --dry-run + README 徽章 4 枚 + keywords 补 tui）
- [ ] 未来增强：应用残留清理（Mole uninstall 的 leftovers 思路）、Xcode DerivedData 清理动作、多 HOMEBREW_PREFIX
- [ ] eslogger 守护进程实测（需 sudo，用户手动）

## 数据位置
~/.spacefree/{config.json, events.jsonl, state.json, history.jsonl, Brewfile.backup}；钩子 v3 在 ~/.zshrc（备份 ~/.zshrc.spacefree-bak）