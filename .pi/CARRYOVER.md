# SpaceFree（Macos-Dynamic-Space-Free）工作承接

## 项目状态：v0.2 TUI 版完成 ✅

macOS 动态磁盘清理工具：**全键盘 TUI（默认）** + 终端 CLI + 可选 Web。零运行时依赖，Node 26 + TS。git 已提交 15 次。`spacefree` 全局命令已 npm link。

## 本轮（2026-10-02 晚）完成
1. **AI agent 工作区发现**（src/projects.ts）：mdfind 全盘秒查 AGENTS.md/CLAUDE.md 标志文件（排除 node_modules/Library/Trash 假命中、basename 精确匹配防 mdfind 模糊），标记目录及其子目录(深度2)纳入扫描；via='agent' 标注来源，TUI 项目名后显示 ⌘agent；实测新发现 11 项目 1.64GB（~/claudecode 等），8 个超 90 天成候选共 1.53GB
2. **TUI 体验**：启动全屏快捷键速查（任意键进入，? 随时呼出，数字键穿透直达页签）；页签下常驻模式感知快捷键行（含"已选 N 项"前缀）；扫描中操作键锁定+提示（r/d/x/a/v/space 锁定，数字/移动/排序/q 放行）；Ctrl+C/q 彻底退出（恢复终端+killAllChildren+process.exit）；v 批量拖选（vim）；自由勾选（非候选 [!] 黄标）；x 在日志页可直接执行；日志模式注册 x 键；yes 后 q/esc 返回提示
3. 修复：keypress key.name 不分大小写（用 sequence）；sortIdx 缺 tab 初始值 NaN；大写 G 跳底部；帮助屏吃数字键

## 设计要点（勿回退）
- 6S 整理：不用就删，重装≈一条命令；删除可逆（历史+重装+Brewfile）
- **安全=建议+警告，不剥夺选择权**（自由勾选+[!]+执行层复核兜底）；被依赖项依赖者同批勾选则放行
- TUI 确定性：d → x → 输入 yes → 磁盘真实释放量
- 项目判定双信号：源码 mtime + 钩子 cwd；Spotlight 数据波动会落 review 不误删
- **改代码后必须重启 server**（Node 模块缓存——15:58 扫描用旧代码的教训）

## 本机事实
157 formula+12 cask；ollama/postgresql@16 手动模式（protect 仅 git/curl）；候选：pngpaste+幽灵酒桶+8 个 agent 项目 1.53GB；~/claudecode 是 agent 项目主产区；npm 缓存 214MB；Ollama 模型 2.3GB/Playwright 1GB 仅展示；服务器 8642 运行中（16:00 后新代码）

## 已知待改
- [ ] Web UI 未加项目页签且勾选是旧限制；TUI 首帧闪烁；无颜色主题
- [ ] mdfind 假命中已防（basename 精确），但 AGENT.md 单数/其他 harness 标志（.cursor/pearai 等）未纳入——按需扩
- [ ] 排坑沉淀：TS 模板 shell `${}` 转义；python heredoc assert 失败丢修改；keypress 大小写；pty 按键留间隔；mdls 数据源波动→review 兜底

## 待办 / 下一步
- [ ] 用户 TUI 走查：agent 项目候选清理体验（8 项 1.5GB 现成可试）
- [ ] npm 发布准备（bin: spacefree；AGENTS.md 铁律；npm view+pack+徽章 4 枚+keywords 补 tui）
- [ ] 未来增强：应用残留清理、DerivedData 动作、多 HOMEBREW_PREFIX、Web 对齐
- [ ] eslogger 实测（需 sudo）

## 数据位置
~/.spacefree/{config.json, events.jsonl, state.json, history.jsonl, Brewfile.backup}；钩子 v3（ts formula cwd）在 ~/.zshrc