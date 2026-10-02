# SpaceFree（Macos-Dynamic-Space-Free）工作承接

## 项目状态：v0.2.0 已发布 GitHub + Homebrew ✅

macOS 动态磁盘清理工具：**全键盘 TUI（默认）** + 终端 CLI + 可选 Web。零运行时依赖，Node 26 + TS。git 已提交 19 次，tag v0.2.0。

## 发布信息（本轮完成）
- **GitHub**: https://github.com/Feng-H/spacefree（public，master 分支，gh 已登录 Feng-H）
- **Release**: v0.2.0 + spacefree-0.2.0.tar.gz（源码+dist，排除 node_modules/.git/.pi；tarball 构造在 /Users/apple/pidev 下 tar --exclude）
- **Homebrew**: `brew install Feng-H/tap/spacefree`（tap 仓库 Feng-H/homebrew-tap 的 Formula/spacefree.rb；libexec.install 全部 + bin.install_symlink dist/cli.js + chmod 0755；depends_on node；sha256 f4af97…82a7）
- 本机已装 brew 版 0.2.0（npm link 已解除）；数据目录 ~/.spacefree 源码版与 brew 版无缝共享（钩子 v3 继续有效）
- **后续版本流程**：改代码 → package.json bump → commit → git tag vX.Y.Z → push → 构造 tarball（同款 exclude）→ shasum → gh release create → clone tap 改 url/sha256/version → push tap → brew upgrade 验证
- npm 发布未做（brew 走 GitHub tarball 不依赖 npm；若将来发 npm 按 AGENTS.md 铁律用户终端确认）

## 已完成功能（详见 git log 19 次提交）
- TUI：启动快捷键速查屏（? 呼出、数字穿透）、常驻模式感知键位行（已选 N 项前缀）、v 批量拖选、自由勾选（非候选 [!]）、d 预演→x→yes 确认、执行后磁盘真实释放量、任务中操作键锁定、Ctrl+C/q 彻底退出（killAllChildren+process.exit）
- agent 工作区发现：mdfind 查 AGENTS.md/CLAUDE.md（排除 node_modules/Library/Trash 假命中）→ 8 候选 1.53GB
- 项目依赖双信号判定（源码 mtime+钩子 cwd）；钩子 v3（ts formula cwd）+ brew services run 计使用
- 依赖级联保护+执行时二次复核（被依赖者同批放行）；清理历史 history.jsonl+一键重装+Brewfile；缓存类别（官方命令可清+大目录仅展示）

## 设计要点（勿回退）
- 6S 整理：不用就删，重装≈一条命令；删除可逆；安全=建议+警告不剥夺选择权
- **改代码后必须重启 server**（Node 模块缓存）
- Spotight/mdls 数据波动 → review 兜底不误删

## 本机事实
157 formula+12 cask；候选 pngpaste+幽灵酒桶+8 agent 项目 1.53GB；npm 缓存 214MB；Ollama 2.3GB/Playwright 1GB 仅展示；tap 仓库含 Casks/ 与 Formula/

## 待办 / 下一步
- [ ] 用户实际走查 brew 版 TUI + agent 项目 1.5GB 清理体验
- [ ] 观察使用后考虑发 npm（bin: spacefree；AGENTS.md 铁律 + README 徽章 4 枚）
- [ ] 未来增强：应用残留清理、DerivedData 动作、多 HOMEBREW_PREFIX、Web 对齐 TUI
- [ ] eslogger 实测（需 sudo）

## 数据位置
~/.spacefree/{config.json, events.jsonl, state.json, history.jsonl, Brewfile.backup}；钩子 v3 在 ~/.zshrc（备份 ~/.zshrc.spacefree-bak）