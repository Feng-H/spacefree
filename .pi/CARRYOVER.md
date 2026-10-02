# SpaceFree（Macos-Dynamic-Space-Free）工作承接

## 项目状态：v0.2.2 已发布 GitHub + Homebrew ✅

macOS 动态磁盘清理工具：**全键盘 TUI（默认）** + 终端 CLI + 可选 Web。零运行时依赖，Node 26 + TS。git 20 次提交，GitHub Feng-H/spacefree（master）+ Release v0.2.0/v0.2.2 + tap Formula。本机 brew 版 0.2.2（npm link 已解除），~/.spacefree 数据共享，钩子 v3 继续有效。

## 发布流程（已完整走通，v0.2.2 实战）
1. 改代码 → commit → package.json bump → commit → git tag vX.Y.Z → git push + push tag
2. cd /Users/apple/pidev && tar --exclude（node_modules/.git/.pi）构造 tarball → shasum -a 256
3. gh release create vX.Y.Z tarball --repo Feng-H/spacefree
4. clone Feng-H/homebrew-tap → 改 Formula/spacefree.rb（**url 的 tag 和 tarball 文件名两处都要改**，v0.2.2 踩过 404 坑）+ sha256 → push
5. brew update && brew upgrade spacefree 验证
- npm 发布未做（brew 走 GitHub tarball；将来发 npm 按 AGENTS.md 铁律用户终端确认）

## v0.2.2 核心：全盘通用依赖发现（分享给任何人都有效）
- node_modules → mdfind 秒查（过滤路径中 node_modules 出现>1 的嵌套）
- .venv/venv/.virtualenv → find home maxdepth5 + prune(node_modules/.git/Library/.Trash/.cache)（Spotlight 对隐藏目录索引不全，3个只查到1）
- 排除 ~/.npm/.cache/.local/.bun/.cargo/.gradle/Library 等工具缓存
- 三源：roots（可选加速）/ agent（AGENTS.md/CLAUDE.md 标记+向上提升一层）/ scan（全盘）；via 标注，TUI 显示 ⌘agent/⌕全盘；同名项目加父目录前缀
- 实测：19 项目 3.3GB 全覆盖（含 ~/.agnes/skills 隐藏 venv、~/markitdown、ZCodeProject 10 个）

## 用户实战记录（2026-10-02）
- 用户已用 TUI 真实清理：8 个 agent 项目 node_modules（1.53GB）+ Keynote/Pages/CollaNote 应用；流程 a→d→x→yes 完整走通
- beijing-travel 有 .venv+venv 双依赖目录

## 设计要点（勿回退）
- 6S 整理：不用就删，重装≈一条命令；删除可逆；安全=建议+警告不剥夺选择权
- 改代码后必须重启 server（Node 模块缓存）；Spotlight/mdls 数据波动 → review 兜底

## 待办 / 下一步
- [ ] 用户走查 v0.2.2 全盘发现效果（TUI 项目页 19 个）
- [ ] 未来增强：应用残留清理、DerivedData 动作、多 HOMEBREW_PREFIX、Web 对齐 TUI、npm 发布
- [ ] eslogger 实测（需 sudo）

## 数据位置
~/.spacefree/{config.json, events.jsonl, state.json, history.jsonl, Brewfile.backup}；钩子 v3 在 ~/.zshrc（备份 ~/.zshrc.spacefree-bak）