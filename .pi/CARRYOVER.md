# SpaceFree（Macos-Dynamic-Space-Free）工作承接

## 项目状态：v0.2 TUI 版完成 ✅

macOS 动态磁盘清理工具：**全键盘 TUI（默认）** + 终端 CLI + 可选 Web。零运行时依赖，Node 26 + TS。git 已提交 12 次。

## 本轮（2026-10-02 后半）完成
1. **TUI 交互界面**（src/tui.ts，~1100 行原生 ANSI）：默认命令；7 页签 [1]Homebrew [2]应用 [3]下载 [4]项目依赖 [5]缓存 [6]历史 [7]设置；space 勾选/**v 批量拖选（vim 风格）**/a 全选候选/A 清空//搜索/s 排序/d 预演/x 执行（**必须输入 yes**）/r 重扫/q 退出；日志页支持 x 直接执行、q/esc 返回；CJK 宽度安全渲染。测试：`(printf 'a'; sleep 1.5; ...) | script -q /dev/null node dist/cli.js`
2. **自由勾选理念（用户明确要求）**：任何行可勾选——非候选项显示黄色 [!] 警告标记（不再禁止）；执行层同步放宽：protect/运行中→警告不拦截；被依赖→依赖者同批勾选则放行（batchSet 过滤），否则跳过并提示"把它也勾进来即可一并删除"
3. **项目依赖动态清理**（src/projects.ts）：projectRoots 深度 2 扫 node_modules/.venv/venv；双信号（源码 mtime + 钩子 cwd）；>阈值 → 删依赖目录（废纸篓）源码保留。实测 4 项目判定正确（pi-carryover 1GB 等都在活跃）
4. **钩子 v3**（三字段 ts formula cwd）已装 ~/.zshrc；brew services run/start/restart 计为使用
5. **借鉴 Mole**：缓存类别（npm/pip/uv/pnpm/bun/yarn 官方命令可清[n]；Gradle/Playwright/Ollama 模型仅展示）；brew cleanup [c]；磁盘真实释放量（df before/after）；README"与 Mole 互补"定位
6. 清理历史 history.jsonl（真实执行才写入）+ TUI 历史页 [回车]重装 + Brewfile 留底（设置页 b 键）

## 设计要点（勿回退）
- 用户理念：**6S 整理**——不用就删，重装≈一条命令；删除可逆（历史+重装+Brewfile）；**安全=建议+警告，不是剥夺选择权**（自由勾选+[!]标记+执行层复核兜底）
- TUI 确定性：d 预演 → x → 输入 yes 才真删 → 完成后高亮"q/esc 返回 · r 重扫"
- 缓存展示型目录仅展示——尊重用户 Mole 白名单习惯

## 本机事实
Apple Silicon /opt/homebrew，brew 7.0.7，157 formula+12 cask（hello/tesseract-lang/openjdk@25/icu4c@77 已删）；ollama/postgresql@16 手动模式（protect 仅 git/curl）；当前候选：pngpaste + 幽灵酒桶 dbeaver-community/vts + 3 stale 应用(zoom.us 等)；npm 缓存 214MB 可清；Ollama 模型 2.3GB/Playwright 1GB 仅展示；~/pidev 4 项目含 node_modules 都活跃；服务器仍跑 8642（Web 用）

## 已知待改
- [ ] Web UI 未加"项目依赖"页签且勾选仍是旧限制（与 TUI 自由勾选不一致）；TUI 首帧闪烁；无颜色主题
- [ ] 排坑：TS 模板字面量 shell `${}` 转义；python heredoc assert 失败丢全部修改（先验证再写）；sortIdx 缺 tab 初始值 NaN 崩溃；**keypress key.name 不分大小写（A 会当 a），用 key.sequence 区分**；pty 测试按键要留足间隔

## 待办 / 下一步
- [ ] 用户 TUI 走查：v 拖选 + [!] 警告勾选体验
- [ ] npm 发布准备（bin: spacefree→dist/cli.js；AGENTS.md 铁律：AI 备好、用户终端确认；npm view + npm pack --dry-run + README 徽章 4 枚 + keywords 补 tui）
- [ ] 未来增强：应用残留清理、Xcode DerivedData 清理动作、多 HOMEBREW_PREFIX、Web 端对齐 TUI
- [ ] eslogger 守护进程实测（需 sudo，用户手动）

## 数据位置
~/.spacefree/{config.json, events.jsonl, state.json, history.jsonl, Brewfile.backup}；钩子 v3 在 ~/.zshrc（备份 ~/.zshrc.spacefree-bak）