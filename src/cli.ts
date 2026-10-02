#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { loadConfig, saveConfig } from './config.js';
import { runScan, loadState } from './scanner.js';
import { plan } from './plan.js';
import { fmtKB, fmtDate } from './util.js';
import { startServer } from './server.js';
import { hookStatus, installHook, uninstallHook, selfTestHook, esloggerDaemonPlist, type ShellKind } from './hook.js';
import { runOps, type Op } from './cleaner.js';

const HELP = `
SpaceFree — macOS 动态磁盘清理工具（基于真实使用频率）

用法: spacefree [命令]
无参数时直接进入交互式 TUI（推荐，所有操作都在终端完成）。

命令:
  tui                     交互式终端界面（默认）
  scan                    全量扫描（Homebrew / 应用 / 下载 / 缓存 / 使用记录）
  report [--days N]       基于最近一次扫描结果输出报告（--days 覆盖阈值）
  serve [--port N] [-o]   启动 Web 仪表盘（-o 自动打开浏览器，默认 http://localhost:8642）
  clean [--days N] [--yes] [--autoremove] [--cache]
                          终端模式清理：默认预演(dry-run)，--yes 真正执行
  hook install|uninstall|status [--zsh] [--bash] [--fish]
                          安装/卸载/查看使用监控钩子（默认 zsh）
  hook selftest           钩子逻辑自检（不影响 rc 文件）
  daemon plist            生成 eslogger 全局监控 LaunchDaemon 配置（高级，可选）
  settings                打印当前配置
  help                    显示本帮助

示例:
  spacefree scan && spacefree report --days 60
  spacefree clean --days 90 --autoremove --cache --yes
  spacefree hook install
`;

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i > 0 ? process.argv[i + 1] : undefined;
}
function has(flag: string): boolean {
  return process.argv.includes(flag);
}

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? 'tui';
  const cfg = loadConfig();
  const log = (m: string) => process.stdout.write(`[spacefree] ${m}\n`);

  if (cmd === 'tui' || cmd === 'ui') {
    const { runTui } = await import('./tui.js');
    await runTui();
    return;
  }

  if (cmd === 'scan') {
    await runScan(cfg, log, (m) => process.stdout.write(`… ${m}\n`));
    const p = plan(loadState()!, cfg);
    printReport(p);
    return;
  }

  if (cmd === 'report') {
    const state = loadState();
    if (!state) { console.log('尚无扫描数据，先运行: spacefree scan'); return; }
    const days = arg('--days');
    const eff = days ? { ...cfg, thresholdDays: parseInt(days, 10) || cfg.thresholdDays } : cfg;
    printReport(plan(state, eff));
    return;
  }

  if (cmd === 'serve') {
    const port = arg('--port') ? parseInt(arg('--port')!, 10) : undefined;
    const server = startServer(port);
    server.on('listening', () => {
      const addr = server.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : port ?? cfg.port;
      console.log(`\n  🧹 SpaceFree Web 仪表盘已启动: http://localhost:${actualPort}\n  Ctrl+C 停止\n`);
      if (has('-o') || has('--open')) {
        spawn('open', [`http://localhost:${actualPort}`], { stdio: 'ignore', detached: true }).unref();
      }
    });
    return;
  }

  if (cmd === 'clean') {
    const state = loadState();
    if (!state) { console.log('尚无扫描数据，先运行: spacefree scan'); return; }
    const days = arg('--days');
    const eff = days ? { ...cfg, thresholdDays: parseInt(days, 10) || cfg.thresholdDays } : cfg;
    const p = plan(state, eff);
    const names = p.formulae.filter((f) => f.verdict === 'unused' || f.verdict === 'stale').map((f) => f.name);
    if (names.length === 0 && !has('--cache')) {
      console.log(`阈值 ${eff.thresholdDays} 天内没有可清理的 brew 包。`);
      return;
    }
    console.log(`\n候选清理（${names.length} 个，共 ${fmtKB(names.reduce((a, n) => a + (p.formulae.find((f) => f.name === n)?.sizeK ?? 0), 0))}）:`);
    for (const n of names.slice(0, 30)) {
      const f = p.formulae.find((x) => x.name === n)!;
      console.log(`  ${f.name.padEnd(24)} ${fmtKB(f.sizeK).padStart(9)}  ${f.reason}`);
    }
    if (names.length > 30) console.log(`  …及另外 ${names.length - 30} 个`);
    const ops: Op[] = [];
    if (names.length > 0) ops.push({ type: 'uninstall-formula', names });
    if (has('--autoremove')) ops.push({ type: 'autoremove' });
    if (has('--cache')) ops.push({ type: 'brew-cache' });
    const dry = !has('--yes');
    if (dry) console.log('\n预演模式（加 --yes 真正执行）\n');
    else console.log('\n正式执行\n');
    await runOps(ops, dry, { log: (m) => console.log(`  ${m}`), step: (m) => console.log(`\n▶ ${m}`) });
    return;
  }

  if (cmd === 'hook') {
    const sub = process.argv[3] ?? 'status';
    const shells: ShellKind[] = [];
    if (has('--zsh')) shells.push('zsh');
    if (has('--bash')) shells.push('bash');
    if (has('--fish')) shells.push('fish');
    if (shells.length === 0) shells.push('zsh');
    if (sub === 'install') {
      for (const r of installHook(shells)) console.log(`${r.shell}: ${r.message} (${r.file})`);
      const t = await selfTestHook();
      console.log(`自测: ${t.ok ? '✅ 通过' : '❌ 失败'} — ${t.detail}`);
    } else if (sub === 'uninstall') {
      for (const r of uninstallHook(shells)) console.log(`${r.shell}: ${r.message}`);
    } else if (sub === 'selftest') {
      const t = await selfTestHook();
      console.log(t.ok ? `✅ ${t.detail}` : `❌ ${t.detail}`);
    } else {
      console.log(JSON.stringify(hookStatus(), null, 2));
    }
    return;
  }

  if (cmd === 'daemon' && process.argv[3] === 'plist') {
    console.log(esloggerDaemonPlist());
    console.log('# 保存为 /Library/LaunchDaemons/com.spacefree.eslogger.plist 并按注释中的命令安装（需要 sudo，请人工执行）');
    return;
  }

  if (cmd === 'settings') {
    console.log(JSON.stringify(cfg, null, 2));
    return;
  }

  console.log(HELP);
}

function printReport(p: ReturnType<typeof plan>): void {
  const sum = p.summary;
  console.log(`
━━━ SpaceFree 报告 ━━━
阈值: ${p.thresholdDays} 天未使用视为可清理 | 宽限期: ${p.graceDays} 天
可清理 brew 包: ${sum.candidatesFormulae} 个 (${fmtKB(sum.candidatesFormulaeK)})
可清理应用: ${sum.candidatesApps} 个 (${fmtKB(sum.candidatesAppsK)})
可清理项目依赖: ${sum.candidatesProjects} 个 (${fmtKB(sum.candidatesProjectsK)})
被依赖保护: ${sum.needed} | 阻止(运行/服务/保护名单): ${sum.blocked} | 数据不足待复核: ${sum.review} | 保留: ${sum.kept}

Top 候选:`);
  const cands = p.formulae
    .filter((f) => f.verdict === 'unused' || f.verdict === 'stale')
    .sort((a, b) => b.sizeK - a.sizeK)
    .slice(0, 15);
  for (const f of cands) {
    const last = f.lastUsed ? fmtDate(f.lastUsed) : '从未记录到';
    console.log(`  ${f.name.padEnd(22)} ${fmtKB(f.sizeK).padStart(9)}  最后使用: ${last.padEnd(18)} ${f.onRequest ? '主动安装' : '依赖装入'}`);
  }
  console.log(`\n终端执行: spacefree clean --days ${p.thresholdDays} [--yes] | Web 面板: spacefree serve -o`);
}

main().catch((err) => {
  console.error('错误:', err instanceof Error ? err.message : err);
  process.exit(1);
});
