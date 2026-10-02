import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exec, fmtKB } from './util.js';
import { checkUsedBy, runningFormulae, servicesRunning, getPrefix } from './brew.js';
import { loadConfig } from './config.js';

export type Op =
  | { type: 'uninstall-formula'; names: string[] }
  | { type: 'uninstall-cask'; tokens: string[] }
  | { type: 'install-formula'; names: string[] }
  | { type: 'autoremove' }
  | { type: 'brew-cache' }
  | { type: 'dev-cache'; names: string[] }
  | { type: 'trash-app'; paths: string[] }
  | { type: 'trash-file'; paths: string[] };

export interface OpResult {
  op: Op;
  ok: boolean;
  skipped: string[];
  freedK: number | null;
  output: string[];
}

export interface CleanerHooks {
  log: (msg: string) => void;
  step: (msg: string) => void;
}

async function uninstallFormulae(names: string[], dry: boolean, hooks: CleanerHooks): Promise<OpResult> {
  const skipped: string[] = [];
  const output: string[] = [];
  let ok = true;
  const toRun: string[] = [];
  hooks.step(`复核 ${names.length} 个包的安全性（反向依赖 / 运行中进程 / 服务 / 保护名单）…`);
  const cfg = loadConfig();
  const [running, services] = await Promise.all([runningFormulae(await getPrefix()), servicesRunning().catch(() => new Set<string>())]);
  const protect = new Set(cfg.protect);
  for (const name of names) {
    if (protect.has(name)) {
      skipped.push(name);
      hooks.log(`跳过 ${name}：在保护名单中`);
      continue;
    }
    if (running.has(name) || services.has(name)) {
      skipped.push(name);
      hooks.log(`跳过 ${name}：当前有进程/后台服务正在运行`);
      continue;
    }
    const dependents = await checkUsedBy(name);
    if (dependents.length > 0) {
      skipped.push(name);
      hooks.log(`跳过 ${name}：仍被 ${dependents.join(', ')} 依赖`);
    } else {
      toRun.push(name);
    }
  }
  if (toRun.length === 0) {
    hooks.log('没有可卸载的包（全部被保护/依赖拦截）');
    return { op: { type: 'uninstall-formula', names }, ok: true, skipped, freedK: 0, output };
  }
  if (dry) {
    // brew uninstall 不支持 -n，预演只输出计划（依赖复核已真实执行）
    hooks.step(`预演: 将卸载 ${toRun.length} 个包 → ${toRun.join(' ')}`);
    hooks.log(`（brew uninstall 无官方 dry-run；上方依赖复核已真实执行，未安装版包不会被卸载）`);
    return { op: { type: 'uninstall-formula', names }, ok: true, skipped, freedK: null, output };
  }
  hooks.step(`卸载 ${toRun.length} 个包: ${toRun.join(' ')}`);
  const r = await exec('brew', ['uninstall', ...toRun], {
    timeoutMs: 600_000,
    onLine: (line) => { hooks.log(line); output.push(line); },
  });
  ok = r.code === 0;
  hooks.log(ok ? `brew uninstall 完成 (exit 0)` : `brew uninstall 失败 (exit ${r.code})`);
  return { op: { type: 'uninstall-formula', names }, ok, skipped, freedK: null, output };
}

async function uninstallCasks(tokens: string[], dry: boolean, hooks: CleanerHooks): Promise<OpResult> {
  const output: string[] = [];
  if (dry) {
    hooks.step(`预演: 将卸载 cask → ${tokens.join(' ')}`);
    return { op: { type: 'uninstall-cask', tokens }, ok: true, skipped: [], freedK: null, output };
  }
  hooks.step(`卸载 cask: ${tokens.join(' ')}`);
  const r = await exec('brew', ['uninstall', '--cask', ...tokens], {
    timeoutMs: 600_000,
    onLine: (line) => { hooks.log(line); output.push(line); },
  });
  hooks.log(r.code === 0 ? 'cask 卸载完成' : `cask 卸载失败 (exit ${r.code})`);
  return { op: { type: 'uninstall-cask', tokens }, ok: r.code === 0, skipped: [], freedK: null, output };
}

async function installFormulae(names: string[], dry: boolean, hooks: CleanerHooks): Promise<OpResult> {
  const output: string[] = [];
  if (dry) {
    hooks.step(`预演: 将安装 ${names.length} 个包 → ${names.join(' ')}`);
    return { op: { type: 'install-formula', names }, ok: true, skipped: [], freedK: 0, output };
  }
  hooks.step(`安装 ${names.length} 个包（需要时会自动重装依赖）: ${names.join(' ')}`);
  const r = await exec('brew', ['install', ...names], {
    timeoutMs: 1800_000,
    onLine: (line) => { hooks.log(line); output.push(line); },
  });
  hooks.log(r.code === 0 ? '安装完成' : `安装失败 (exit ${r.code})`);
  return { op: { type: 'install-formula', names }, ok: r.code === 0, skipped: [], freedK: 0, output };
}

async function autoremove(dry: boolean, hooks: CleanerHooks): Promise<OpResult> {
  const output: string[] = [];
  hooks.step(`${dry ? '预演' : '执行'} brew autoremove（清理无主依赖）…`);
  const r = await exec('brew', ['autoremove', ...(dry ? ['-n'] : [])], {
    timeoutMs: 600_000,
    onLine: (line) => { hooks.log(line); output.push(line); },
  });
  hooks.log(r.code === 0 ? 'autoremove 完成' : `autoremove 失败 (exit ${r.code})`);
  return { op: { type: 'autoremove' }, ok: r.code === 0, skipped: [], freedK: null, output };
}

/** 官方安全清理命令（仅在对应工具存在时执行） */
const DEV_CLEAN_CMDS: Record<string, { cmd: string; args: string[] }> = {
  'npm 缓存': { cmd: 'npm', args: ['cache', 'clean', '--force'] },
  'pip 缓存': { cmd: 'pip3', args: ['cache', 'purge'] },
  'uv 缓存': { cmd: 'uv', args: ['cache', 'clean'] },
  'pnpm 存储': { cmd: 'pnpm', args: ['store', 'prune'] },
  'bun 缓存': { cmd: 'bun', args: ['pm', 'cache', 'rm'] },
  'yarn 缓存': { cmd: 'yarn', args: ['cache', 'clean'] },
};

async function cleanDevCaches(names: string[], dry: boolean, hooks: CleanerHooks): Promise<OpResult> {
  const output: string[] = [];
  let ok = true;
  for (const name of names) {
    const def = DEV_CLEAN_CMDS[name];
    if (!def) {
      hooks.log(`跳过 ${name}：无官方清理命令（仅展示类别）`);
      continue;
    }
    const which = await exec('/usr/bin/which', [def.cmd], { timeoutMs: 10_000 });
    if (which.code !== 0) {
      hooks.log(`跳过 ${name}：未安装 ${def.cmd}`);
      continue;
    }
    if (dry) {
      hooks.log(`预演: ${name} → ${def.cmd} ${def.args.join(' ')}`);
      continue;
    }
    hooks.step(`清理 ${name}: ${def.cmd} ${def.args.join(' ')}`);
    const r = await exec(def.cmd, def.args, {
      timeoutMs: 600_000,
      onLine: (line) => { hooks.log(line); output.push(line); },
    });
    if (r.code !== 0) ok = false;
  }
  return { op: { type: 'dev-cache', names }, ok, skipped: [], freedK: null, output };
}

async function brewCacheClean(dry: boolean, hooks: CleanerHooks): Promise<OpResult> {
  const output: string[] = [];
  hooks.step(`${dry ? '预演' : '执行'} brew cleanup --prune=all…`);
  const r = await exec('brew', ['cleanup', '--prune=all', ...(dry ? ['-n'] : [])], {
    timeoutMs: 600_000,
    onLine: (line) => { hooks.log(line); output.push(line); },
  });
  hooks.log(r.code === 0 ? 'cleanup 完成' : `cleanup 失败 (exit ${r.code})`);
  return { op: { type: 'brew-cache' }, ok: r.code === 0, skipped: [], freedK: null, output };
}

async function trash(paths: string[], hooks: CleanerHooks): Promise<OpResult> {
  const output: string[] = [];
  const skipped: string[] = [];
  const existing = paths.filter((p) => fs.existsSync(p));
  for (const p of paths) if (!fs.existsSync(p)) skipped.push(p);
  if (existing.length === 0) {
    hooks.log('没有可删除的文件');
    return { op: { type: 'trash-app', paths }, ok: true, skipped, freedK: 0, output };
  }
  hooks.step(`移入废纸篓 ${existing.length} 项…`);
  const list = existing.map((p) => `POSIX file "${p}"`).join(', ');
  const script = `tell application "Finder" to delete {${list}}`;
  const r = await exec('osascript', ['-e', script], {
    timeoutMs: 120_000,
    onLine: (line) => { hooks.log(line); output.push(line); },
  });
  if (r.code !== 0) {
    hooks.log('Finder 移入废纸篓失败，尝试直接移动到 ~/.Trash …');
    let fail = false;
    for (const p of existing) {
      const dest = path.join(os.homedir(), '.Trash', `${path.basename(p)}.${Date.now()}`);
      try {
        fs.renameSync(p, dest);
      } catch (err) {
        fail = true;
        hooks.log(`移动失败 ${p}: ${err instanceof Error ? err.message : err}`);
      }
    }
    return { op: { type: 'trash-app', paths }, ok: !fail, skipped, freedK: null, output };
  }
  hooks.log(`已移入废纸篓 ${existing.length} 项（可在 Finder 废纸篓中恢复）`);
  return { op: { type: 'trash-app', paths }, ok: true, skipped, freedK: null, output };
}

export async function runOps(ops: Op[], dry: boolean, hooks: CleanerHooks): Promise<OpResult[]> {
  const freeBefore = dry ? null : await diskFreeK();
  const results: OpResult[] = [];
  for (const op of ops) {
    try {
      if (op.type === 'uninstall-formula') results.push(await uninstallFormulae(op.names, dry, hooks));
      else if (op.type === 'uninstall-cask') results.push(await uninstallCasks(op.tokens, dry, hooks));
      else if (op.type === 'install-formula') results.push(await installFormulae(op.names, dry, hooks));
      else if (op.type === 'autoremove') results.push(await autoremove(dry, hooks));
      else if (op.type === 'brew-cache') results.push(await brewCacheClean(dry, hooks));
      else if (op.type === 'dev-cache') results.push(await cleanDevCaches(op.names, dry, hooks));
      else if (op.type === 'trash-app') results.push(await trash(op.paths, hooks));
      else if (op.type === 'trash-file') results.push(await trash(op.paths, hooks));
    } catch (err) {
      hooks.log(`操作异常: ${err instanceof Error ? err.message : String(err)}`);
      results.push({ op, ok: false, skipped: [], freedK: null, output: [] });
    }
  }
  if (!dry && freeBefore != null) {
    const freeAfter = await diskFreeK();
    if (freeAfter != null && freeAfter !== freeBefore) {
      const deltaK = freeAfter - freeBefore;
      hooks.log(`磁盘可用空间: ${fmtKB(freeBefore)} → ${fmtKB(freeAfter)} (${deltaK > 0 ? '+' : ''}${fmtKB(Math.abs(deltaK))})`);
    }
  }
  return results;
}

async function diskFreeK(): Promise<number | null> {
  const r = await exec('df', ['-k', '/'], { timeoutMs: 15_000 });
  const line = r.stdout.split('\n')[1] ?? '';
  const m = line.match(/\S+\s+\S+\s+\S+\s+(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}
