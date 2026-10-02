import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { exec, ensureDataDir, EVENTS_PATH } from './util.js';

export type ShellKind = 'zsh' | 'bash' | 'fish';

const START = '# >>> spacefree hook >>>';
const END = '# <<< spacefree hook <<<';

/** zsh preexec hook: pure builtins, <1ms per command. Also enables EXTENDED_HISTORY so future history gets timestamps. */
const ZSH_HOOK = `${START}
# SpaceFree 使用监控（记录 brew 包被调用的时间）——编辑请谨慎，卸载: spacefree hook uninstall
__spacefree_preexec() {
  emulate -L zsh
  local cmd=\${1%%[[:space:]]*}
  [[ -n \$cmd ]] || return 0
  [[ \$cmd == */* ]] && cmd=\${cmd:t}          # 绝对路径调用取文件名
  local f=""
  if [[ \$cmd == brew ]]; then
    # brew services run/start/restart <包名> → 计为使用该包（服务类监控盲区补丁）
    local -a w
    w=(\${(z)1})
    if [[ \${#w} -ge 4 && \${w[2]} == services && \${w[3]} == (run|start|restart) ]]; then
      f=\${w[4]}
    fi
  else
    local p=\${commands[\$cmd]-}
    [[ -n \$p ]] || return 0
    p=\${p:A}                                   # 解析符号链接到真实 Cellar 路径
    case \$p in
      */Cellar/*|*/Caskroom/*) ;;
      *) return 0 ;;
    esac
    f=\${p#*Cellar/}; f=\${f%%/*}
    [[ \$p == */Caskroom/* ]] && { f=\${p#*Caskroom/}; f=\${f%%/*}; }
  fi
  [[ -n \$f ]] || return 0
  [[ -d \$HOME/.spacefree ]] || return 0
  local now=\${(%):-%D{%s}}
  [[ \$_sf_last == "\$f:\$((now/60))" ]] && return 0
  _sf_last="\$f:\$((now/60))"
  printf '%s\\t%s\\n' "\$now" "\$f" >> \$HOME/.spacefree/events.jsonl 2>/dev/null
}
setopt EXTENDED_HISTORY HIST_SAVE_NO_DUPS   # 让新历史带时间戳（仅增量格式，安全）
preexec_functions+=(__spacefree_preexec)
${END}`;

/** bash DEBUG trap hook; macOS bash 3.2 compatible, no forks per command. */
const BASH_HOOK = `${START}
# SpaceFree 使用监控 —— 卸载: spacefree hook uninstall
__spacefree_preexec() {
  [ -n "\$COMP_LINE" ] && return 0
  local cmd="\${1%%[[:space:]]*}"
  [ -n "\$cmd" ] || return 0
  case "\$cmd" in */*) cmd="\${cmd##*/}" ;; esac
  local p
  p=\$(command -v "\$cmd" 2>/dev/null) || return 0
  case "\$p" in */Cellar/*|*/Caskroom/*) ;; *) return 0 ;; esac
  while [ -L "\$p" ]; do
    local d="\${p%/*}" t
    t=\$(readlink "\$p") || return 0
    case "\$t" in /*) p="\$t" ;; *) p="\$d/\$t" ;; esac
  done
  case "\$p" in */Cellar/*) ;; *) return 0 ;; esac
  local f="\${p#*Cellar/}"; f="\${f%%/*}"
  [ -d "\$HOME/.spacefree" ] || return 0
  local now=\$(( _sf_epoch0 + SECONDS ))
  [ "\$_sf_last" = "\$f-\$((now/60))" ] && return 0
  _sf_last="\$f-\$((now/60))"
  printf '%s\\t%s\\n' "\$now" "\$f" >> "\$HOME/.spacefree/events.jsonl" 2>/dev/null
}
_sf_epoch0=\$(( \$(date +%s) - SECONDS ))
trap '__spacefree_preexec "\$BASH_COMMAND"' DEBUG
${END}`;

const FISH_HOOK = `${START}
# SpaceFree 使用监控 —— 卸载: spacefree hook uninstall
function __spacefree_preexec --on-event fish_preexec
  set -l cmd (string split -m1 ' ' -- \$argv)[1]
  test -n "\$cmd"; or return
  set -l p (type -P \$cmd 2>/dev/null); or return
  set -l rp (realpath \$p 2>/dev/null); or set rp \$p
  string match -q '*/Cellar/*' -- \$rp; or return
  set -l f (string match -r '(?<=Cellar/)[^/]+' -- \$rp)
  test -n "\$f"; or return
  test -d \$HOME/.spacefree; or return
  set -l now (date +%s)
  if test "\$_sf_last" = "\$f-"(math "\$now / 60")
    return
  end
  set -g _sf_last "\$f-"(math "\$now / 60")
  printf '%s\\t%s\\n' \$now \$f >> \$HOME/.spacefree/events.jsonl 2>/dev/null
end
${END}`;

export function hookBlock(shell: ShellKind): string {
  if (shell === 'zsh') return ZSH_HOOK;
  if (shell === 'bash') return BASH_HOOK;
  return FISH_HOOK;
}

function rcPath(shell: ShellKind): string {
  const home = os.homedir();
  if (shell === 'zsh') return path.join(home, '.zshrc');
  if (shell === 'bash') return path.join(home, '.bashrc');
  return path.join(home, '.config/fish/conf.d/spacefree.fish');
}

function blockPresent(shell: ShellKind): boolean {
  try {
    return fs.readFileSync(rcPath(shell), 'utf8').includes(START);
  } catch {
    return false;
  }
}

export interface HookStatus {
  zsh: boolean;
  bash: boolean;
  fish: boolean;
}

export function hookStatus(): HookStatus {
  return { zsh: blockPresent('zsh'), bash: blockPresent('bash'), fish: blockPresent('fish') };
}

export interface InstallResult {
  shell: ShellKind;
  ok: boolean;
  file: string;
  message: string;
}

export function installHook(shells: ShellKind[]): InstallResult[] {
  ensureDataDir();
  // touch event file so hooks can append even before first scan
  try { fs.appendFileSync(EVENTS_PATH, ''); } catch { /* ignore */ }
  const results: InstallResult[] = [];
  for (const shell of shells) {
    const file = rcPath(shell);
    try {
      if (blockPresent(shell)) {
        results.push({ shell, ok: true, file, message: '已存在，跳过' });
        continue;
      }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
      fs.writeFileSync(file, existing + (existing.endsWith('\n') || existing === '' ? '' : '\n') + '\n' + hookBlock(shell) + '\n');
      results.push({ shell, ok: true, file, message: '已安装，重启终端或新开窗口后生效' });
    } catch (err) {
      results.push({ shell, ok: false, file, message: `安装失败: ${err instanceof Error ? err.message : String(err)}` });
    }
  }
  return results;
}

export function uninstallHook(shells: ShellKind[]): InstallResult[] {
  const results: InstallResult[] = [];
  for (const shell of shells) {
    const file = rcPath(shell);
    try {
      if (!fs.existsSync(file)) {
        results.push({ shell, ok: true, file, message: '未安装' });
        continue;
      }
      const content = fs.readFileSync(file, 'utf8');
      const start = content.indexOf(START);
      const end = content.indexOf(END);
      if (start === -1 || end === -1 || end < start) {
        results.push({ shell, ok: true, file, message: '未安装' });
        continue;
      }
      const cleaned = (content.slice(0, start) + content.slice(end + END.length)).replace(/\n{3,}/g, '\n\n');
      fs.writeFileSync(file, cleaned);
      results.push({ shell, ok: true, file, message: '已卸载' });
    } catch (err) {
      results.push({ shell, ok: false, file, message: `卸载失败: ${err instanceof Error ? err.message : String(err)}` });
    }
  }
  return results;
}

/** Validate the hook actually logs, without touching user rc files: runs zsh -c with hook sourced. */
export async function selfTestHook(): Promise<{ ok: boolean; detail: string }> {
  ensureDataDir();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spacefree-test-'));
  const eventFile = path.join(dir, 'events.jsonl');
  const script = `${ZSH_HOOK.replace(/\$HOME\/\.spacefree\/events\.jsonl/g, eventFile)}
__spacefree_preexec "git status"
__spacefree_preexec "brew services run ollama"
__spacefree_preexec "brew services stop postgresql@16"
__spacefree_preexec "nonexistent-command-xyz"
`;
  const r = await exec('zsh', ['-c', script], { timeoutMs: 15_000 });
  let logged = '';
  try { logged = fs.readFileSync(eventFile, 'utf8').trim(); } catch { /* none */ }
  fs.rmSync(dir, { recursive: true, force: true });
  const lines = logged.split('\n');
  const okGit = /^\d+\tgit$/m.test(logged);
  const okSvc = /^\d+\tollama$/m.test(logged);
  const noStop = !/\tpostgresql@16$/.test(logged);   // stop 不计为使用
  const ok = okGit && okSvc && noStop && r.code === 0;
  return { ok, detail: ok ? `自测通过: 直接命令→git ✓, 服务启动→ollama ✓, stop 不计数 ✓` : `自测失败 (exit ${r.code})，输出: ${r.stdout}|${r.stderr}|log=${logged}` };
}

/** Generate a LaunchDaemon plist for root-level process monitoring via eslogger (advanced, optional). */
export function esloggerDaemonPlist(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- 安装方法（需要管理员权限，AI 不会代跑）：
  sudo cp com.spacefree.eslogger.plist /Library/LaunchDaemons/
  sudo chown root:wheel /Library/LaunchDaemons/com.spacefree.eslogger.plist
  sudo launchctl bootstrap system /Library/LaunchDaemons/com.spacefree.eslogger.plist
  卸载：
  sudo launchctl bootout system /Library/LaunchDaemons/com.spacefree.eslogger.plist
  sudo rm /Library/LaunchDaemons/com.spacefree.eslogger.plist
说明：通过 Apple Endpoint Security (eslogger) 记录全系统进程启动事件（含非终端调用），
SpaceFree 会自动解析 ~/.spacefree/es-exec.log 中的 Cellar 路径并计入使用统计。 -->
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.spacefree.eslogger</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/eslogger</string>
    <string>exec</string>
    <string>--json</string>
  </array>
  <key>StandardOutPath</key>
  <string>${os.homedir()}/.spacefree/es-exec.log</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
</dict>
</plist>
`;
}
