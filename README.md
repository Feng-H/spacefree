# SpaceFree · macOS 动态磁盘清理工具

> 按程序和包的**真实使用频率**智能清理磁盘 —— 终端核心 + Web 仪表盘，零运行时依赖。

[![GitHub release](https://img.shields.io/github/v/release/Feng-H/spacefree?color=blue)](https://github.com/Feng-H/spacefree/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## 安装

### Homebrew（推荐）

```bash
brew install Feng-H/tap/spacefree
spacefree          # 直接进入 TUI
```

### 从源码

```bash
git clone https://github.com/Feng-H/spacefree.git
cd spacefree && npm install && npm run build
node dist/cli.js   # 或 npm link 后直接 spacefree
```

> 要求：macOS 12+ / Node.js ≥ 20（brew 安装会自动带上 node 依赖）

## 为什么需要它

Homebrew 装了 160+ 个包，不知道哪些有用、哪些能删？SpaceFree 回答三个问题：

1. **这个包上次是什么时候用的？** 用了多少次？
2. **删掉它会不会连累别的包？**（依赖保护）
3. **哪些东西占着空间却从没动过？**

## 核心特性

| 能力 | 说明 |
|---|---|
| 🔍 **使用频率追踪** | 多源融合：Shell 历史（zsh/bash/fish，支持时间戳解析）+ **Shell 钩子**（精确记录每次调用，<1ms 开销）+ Spotlight（GUI 应用的最后打开时间与次数） |
| 🛡️ **依赖级联保护** | 基于 `brew deps` 构建全量依赖图：被任何已装包依赖的 formula 标记为"被依赖"不可删；执行前还会用 `brew uses` 二次复核 |
| 🚦 **安全判定引擎** | 运行中进程（ps）、brew services、保护名单、brew pin、新装宽限期 —— 层层拦截 |
| 🧹 **五类清理** | brew formula / brew cask（含幽灵酒桶）/ 应用与下载安装包（移入**废纸篓可恢复**）/ brew 与开发工具缓存 / **项目依赖目录（node_modules）** |
| 📦 **项目依赖动态清理** | 扫描项目根目录下的 node_modules/.venv：双信号判定（源码最新修改时间 + 监控钩子记录的命令执行 cwd）；长期不动的项目 → 仅删依赖目录，源码保留，需要时 `npm install` 一键重建 |
| 🖥 **全键盘 TUI** | 默认交互界面：七个页签浏览/勾选/搜索/排序，Dry-run 预演 → 输入 `yes` 确认执行 → 实时日志 + 磁盘真实释放量报告（另保留 Web 模式 `serve`） |
| ⌨️ **纯终端模式** | `scan` / `report` / `clean` 全套 CLI，不开浏览器也能用 |
| 🔬 **进阶监控（可选）** | 生成 eslogger LaunchDaemon 配置，root 级记录全系统进程启动（覆盖 GUI/IDE 调用） |

## 快速开始

```bash
# 本地运行（Node ≥ 20）
npm install
npm run build

# 1. 安装使用监控钩子（推荐！记录命令调用 + 运行目录）
node dist/cli.js hook install

# 2. 进入 TUI（默认界面，全键盘操作）
node dist/cli.js                   # 或 node dist/cli.js tui
#    首次进入自动扫描；数字 1-7 切页，space 勾选，d 预演，x 执行（输入 yes 确认）

# 纯终端工作流
node dist/cli.js report --days 90  # 查看报告
node dist/cli.js clean --days 90 --autoremove --cache --yes

# Web 模式（可选）
node dist/cli.js serve -o          # http://localhost:8642
```

## 与 Mole 等静态清理工具的关系

[Mole](https://github.com/tw93/Mole) 解决的是"垃圾清空"（缓存/日志/残留），SpaceFree 解决的是"**按用不用决定去留**"（动态删除）：同一个包/应用/项目，用得少就删、需要时一键装回。两者互补，可共存。SpaceFree 的缓存页也覆盖了 brew/npm/pip/uv 等官方安全清理命令，并对 Gradle/Playwright/Ollama 模型等大目录采取"仅展示不自动删"的保守策略（与你 Mole 白名单的习惯一致）。

## 使用监控：三层方案

macOS 的 APFS 不更新文件 atime，无法靠文件系统"看到"程序被调用。SpaceFree 用三层方案：

1. **Shell 历史（存量数据，零安装）**
   自动解析 `~/.zsh_history`（含 EXTENDED_HISTORY 时间戳格式）、bash、fish 历史，把命令名通过 PATH 符号链接解析回 Cellar 中的 formula。装钩子时会顺带 `setopt EXTENDED_HISTORY`，让新历史自动带时间戳。

2. **Shell 钩子（增量数据，精确到秒）**
   `preexec` 钩子在你敲下每条命令的瞬间，把可执行文件解析到真实 Cellar 路径并追加一行事件到 `~/.spacefree/events.jsonl`。纯 shell 内建实现，无 fork、<1ms。60 秒窗口内同包去重。支持 zsh（默认）/ bash / fish，随时 `spacefree hook uninstall` 卸载。

3. **eslogger 守护进程（可选，覆盖面最广）**
   Shell 钩子只看得到终端里的命令；IDE 调用 clang-format、GUI 调用 ffmpeg 这类"看不见的调用"需要 root 级监控。`spacefree daemon plist` 生成基于 Apple Endpoint Security 的 LaunchDaemon 配置，按注释安装即可，SpaceFree 会自动解析其日志并计入使用统计。

> ⚠️ 判定语义说明：**"从未使用" = 在所有可用数据源中都没有出现过**。刚装的包有 30 天宽限期；历史无时间戳的"用过但不知何时"会标记为"待复核"而不是直接判可删。

## 判定规则（每个包的 verdict）

```
运行中进程 / brew services / 保护名单 / pin  → 🔒 已阻止
被其他已安装包依赖                             → 🔗 被依赖（不可删）
主动安装 + 从未使用 + 超过宽限期               → 🔴 从未使用（候选）
最后使用 > 阈值天数（默认 90 天）              → 🟠 久未使用（候选）
用过但历史无时间戳 / 刚装不久                  → 🔵 待复核
其余                                          → 🟢 保留
```

cask 的"幽灵酒桶"（.app 已被手动删除）自动标记可清理；QuickLook 扩展和字体类 cask 标记待复核避免误删。

## 执行时的四重安全

1. **预演优先**：Web 端必须先 Dry-run；预演完成后会弹窗展示安全复核结果，需点红色"确认执行清理"才真正执行
2. **执行时复核**：即使页面数据过期，卸载前重新跑 `brew uses --installed` + 运行进程 + 服务 + 保护名单检查
3. **可恢复删除**：应用和安装包走 Finder 废纸篓（AppleScript），随时可还原
4. **孤儿依赖自动善后**：Homebrew 7 在 `brew uninstall` 后会自动 autoremove 无主依赖（如本机验证时顺带清掉了 openjdk@25）

> 已实测验证（E2E）：`brew install hello` → 判定为"从未使用"候选 → Dry-run 仅输出计划不删 → 确认后真实卸载（Cellar/brew list/PATH 三处确认）；假应用删除后可在 Finder 废纸篓中恢复。

## 数据存储

所有数据在 `~/.spacefree/`：`config.json`（设置）、`events.jsonl`（使用事件）、`state.json`（最近扫描快照）。不联网、不上传。

## 已知局限

- Shell 钩子只记录终端直接调用的命令（间接调用请启用 eslogger 守护进程）
- `brew uninstall` 官方无 dry-run，预演阶段做的是真实依赖复核 + 计划输出
- Spotlight 对 QuickLook 扩展的 LastUsedDate 不反映系统实际调用（已按"待复核"处理）
- 判定依据的是"可用证据"，未来版本可结合 `brew autoremove -n` 输出交叉验证

## 开发

```bash
npm run dev -- scan      # tsx 直跑
npm run typecheck
```

架构：`src/brew.ts`（清单/大小/依赖图）· `src/usage.ts`（多源使用追踪）· `src/hook.ts`（钩子安装器）· `src/plan.ts`（判定引擎）· `src/cleaner.ts`（安全执行器）· `src/server.ts`（原生 http + SSE）· `web/`（零依赖单页前端）

## License

MIT
