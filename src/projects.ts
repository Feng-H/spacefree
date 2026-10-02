import fs from 'node:fs';
import path from 'node:path';
import { exec, expandHome, EVENTS_PATH, pmap } from './util.js';
import type { Config } from './config.js';

/** 项目依赖目录（可整体重建，源码保留） */
export interface DepDir {
  name: string;        // node_modules / .venv / venv
  path: string;
  sizeK: number;
}

export interface ProjectEntry {
  name: string;
  path: string;
  via: 'roots' | 'agent' | 'scan';   // 来源: 配置根目录 | agent 标志文件 | 全盘依赖目录扫描
  depDirs: DepDir[];
  depSizeK: number;
  srcMtime: number | null;    // 最新源码修改时间（排除依赖目录与 .git）
  lastRun: number | null;     // 钩子记录的该项目目录下最近命令执行
  lastUsed: number | null;    // max(srcMtime, lastRun)
}

/** 项目目录下的依赖目录名（仅识别项目根下这些精确名称） */
const DEP_NAMES = ['node_modules', '.venv', 'venv'];

function isProject(dir: string): boolean {
  for (const name of DEP_NAMES) {
    const full = path.join(dir, name);
    try {
      if (fs.statSync(full).isDirectory()) return true;
    } catch { /* 此依赖名不存在，继续查下一个 */ }
  }
  return false;
}

function walkProjects(dir: string, depth: number, out: string[]): void {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue;
    const full = path.join(dir, e.name);
    if (isProject(full)) out.push(full);
    if (depth > 0) walkProjects(full, depth - 1, out);
  }
}

/** 深度 2 的项目发现（跳过 node_modules/.git/隐藏目录） */
function findProjects(root: string): string[] {
  const out: string[] = [];
  walkProjects(root, 1, out);
  return out;
}

/**
 * AI agent 工作区发现：AGENTS.md / CLAUDE.md 是 harness 生成项目的标志文件。
 * 用 Spotlight(mdfind) 全盘秒查，取其所在目录（或子目录深度 2）内的依赖项目。
 * 排除 node_modules/Library/Trash 内的假命中与模糊匹配。
 */
async function findAgentProjects(log: (m: string) => void): Promise<string[]> {
  const home = process.env.HOME ?? '';
  const out: string[] = [];
  const seen = new Set<string>();
  let markers = 0;
  for (const marker of ['AGENTS.md', 'CLAUDE.md']) {
    const r = await exec('mdfind', ['-name', marker], { timeoutMs: 30_000 });
    if (r.code !== 0) {
      log(`Spotlight(mdfind) 不可用，跳过 agent 标记发现（${marker}）`);
      continue;
    }
    for (const line of r.stdout.split('\n').filter(Boolean)) {
      if (!line.startsWith(home + '/')) continue;
      if (line.includes('/Library/') || line.includes('/node_modules/') || line.includes('/.Trash/')) continue;
      if (path.basename(line) !== marker) continue; // mdfind 会模糊匹配（如 machine_agent.md）
      markers += 1;
      const dir = path.dirname(line);
      if (isProject(dir)) {
        if (!seen.has(dir)) { seen.add(dir); out.push(dir); }
      } else {
        const sub: string[] = [];
        walkProjects(dir, 2, sub); // 标记在上层（如 ~/pidev），扫子目录
        for (const p of sub) {
          if (!seen.has(p)) { seen.add(p); out.push(p); }
        }
      }
      // 向上提升一层：标记常在项目内，而 harness 工作区根在其上一层
      // （如 ZCodeProject/xhsz/AGENTS.md → 工作区根 ZCodeProject 下还有多个无标记的兄弟项目）
      const parent = path.dirname(dir);
      const parentOk = parent.startsWith(home + '/') && parent !== home
        && !parent.includes('/Library/') && !parent.includes('/.Trash/');
      if (parentOk) {
        const sub2: string[] = [];
        walkProjects(parent, 2, sub2);
        for (const p of sub2) {
          if (!seen.has(p)) { seen.add(p); out.push(p); }
        }
      }
    }
  }
  log(`Agent 工作区标记 (AGENTS.md/CLAUDE.md): ${markers} 处 → ${out.length} 个含依赖目录的项目`);
  return out;
}

async function duK(p: string): Promise<number> {
  const r = await exec('du', ['-sk', p], { timeoutMs: 60_000 });
  const m = r.stdout.trim().match(/^(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}

/** 最新源码 mtime（排除 node_modules / .venv / venv / .git） */
async function srcMtime(proj: string): Promise<number | null> {
  const script = `/usr/bin/find ${JSON.stringify(proj)} \\( -name node_modules -o -name .venv -o -name venv -o -name .git \\) -prune -o -type f -exec stat -f '%m' {} + | sort -rn | head -1`;
  const r = await exec('/bin/bash', ['-c', script], { timeoutMs: 120_000 });
  const m = r.stdout.trim().match(/^(\d{9,})$/m);
  return m ? parseInt(m[1], 10) : null;
}

/** 读取钩子事件的 cwd → 最近执行时间（三字段格式: ts\tformula\tcwd） */
function readCwdUsage(): Map<string, number> {
  const map = new Map<string, number>();
  try {
    const raw = fs.readFileSync(EVENTS_PATH, 'utf8');
    for (const line of raw.split('\n')) {
      const parts = line.split('\t');
      if (parts.length >= 3) {
        const ts = parseInt(parts[0], 10);
        const cwd = parts.slice(2).join('\t');
        if (Number.isFinite(ts) && cwd.startsWith('/')) {
          const cur = map.get(cwd) ?? 0;
          if (ts > cur) map.set(cwd, ts);
        }
      }
    }
  } catch { /* no events yet */ }
  return map;
}

/** 排除的工具缓存/系统目录（这些位置的依赖属缓存页范畴，不作为项目） */
const SCAN_EXCLUDE_PARTS = ['/Library/', '/.Trash/', '/.cache/', '/.local/', '/.npm/', '/.bun/', '/.cargo/', '/.rustup/', '/.gradle/', '/.pnpm-store/', '/Library/pnpm/'];

/**
 * 全盘依赖目录发现（通用方案，不依赖任何目录命名约定）：
 * - node_modules（非隐藏名，Spotlight 索引可靠）→ mdfind 秒查，过滤嵌套（路径中仅出现一次）
 * - .venv / venv / .virtualenv（隐藏名 Spotlight 索引不全）→ find + prune 受控全扫（~1-2s）
 * 返回：项目根目录集合（依赖目录的父目录）
 */
async function findGlobalDepProjects(home: string, log: (m: string) => void): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>(); // 项目根 -> 发现的依赖名
  const addRoot = (dir: string, dep: string) => {
    const list = out.get(dir) ?? [];
    if (!list.includes(dep)) list.push(dep);
    out.set(dir, list);
  };

  // 1) node_modules via Spotlight
  let mdCount = 0;
  const r = await exec('mdfind', ['-name', 'node_modules'], { timeoutMs: 30_000 });
  if (r.code === 0) {
    for (const line of r.stdout.split('\n').filter(Boolean)) {
      if (!line.startsWith(home + '/') || line !== line.trim()) continue;
      if (SCAN_EXCLUDE_PARTS.some((p) => line.includes(p))) continue;
      if (path.basename(line) !== 'node_modules') continue;
      // 只保留最外层（路径中 node_modules 仅出现一次，排除嵌套依赖）
      if (line.split('/').filter((s) => s === 'node_modules').length !== 1) continue;
      mdCount += 1;
      addRoot(path.dirname(line), 'node_modules');
    }
  }

  // 2) python 类 venv 目录 via find（Spotlight 对隐藏目录索引不全）
  let findCount = 0;
  const script = `/usr/bin/find ${JSON.stringify(home)} -maxdepth 5 \\( -name node_modules -o -name .git -o -name Library -o -name .Trash -o -name .cache \\) -prune -o \\( -name .venv -o -name venv -o -name .virtualenv \\) -type d -print 2>/dev/null`;
  const rf = await exec('/bin/bash', ['-c', script], { timeoutMs: 120_000 });
  for (const line of rf.stdout.split('\n').filter(Boolean)) {
    if (SCAN_EXCLUDE_PARTS.some((p) => line.includes(p))) continue;
    findCount += 1;
    addRoot(path.dirname(line), path.basename(line));
  }
  log(`全盘依赖发现: node_modules×${mdCount}（Spotlight）+ venv 类×${findCount}（find）→ ${out.size} 个项目根`);
  return out;
}

function lastRunFor(projPath: string, cwdUsage: Map<string, number>): number | null {
  let best: number | null = null;
  for (const [cwd, ts] of cwdUsage) {
    if (cwd === projPath || cwd.startsWith(projPath + '/')) {
      if (best == null || ts > best) best = ts;
    }
  }
  return best;
}

export async function scanProjects(cfg: Config, log: (m: string) => void, onProgress?: (m: string) => void): Promise<ProjectEntry[]> {
  onProgress?.('扫描项目依赖目录（node_modules 等）…');
  const roots = cfg.projectRoots.map(expandHome).filter((r) => fs.existsSync(r) && fs.statSync(r).isDirectory());
  const seen = new Set<string>();
  const projects: string[] = [];
  const viaMap = new Map<string, 'roots' | 'agent' | 'scan'>();
  for (const root of roots) {
    for (const p of findProjects(root)) {
      if (!seen.has(p)) { seen.add(p); projects.push(p); viaMap.set(p, 'roots'); }
    }
  }
  log(`项目根目录: ${roots.map((r) => path.basename(r)).join(', ') || '无'}；发现 ${projects.length} 个含依赖目录的项目`);
  onProgress?.('扫描 AI agent 工作区（AGENTS.md/CLAUDE.md）…');
  for (const p of await findAgentProjects(log)) {
    if (!seen.has(p)) { seen.add(p); projects.push(p); viaMap.set(p, 'agent'); }
  }
  onProgress?.('全盘发现依赖目录（node_modules/.venv，不依赖目录命名）…');
  const home = process.env.HOME ?? '';
  for (const [root] of await findGlobalDepProjects(home, log)) {
    if (!seen.has(root)) { seen.add(root); projects.push(root); viaMap.set(root, 'scan'); }
  }
  const cwdUsage = readCwdUsage();

  const entries = await pmap(projects, 3, async (proj): Promise<ProjectEntry | null> => {
    const depDirs: DepDir[] = [];
    for (const name of DEP_NAMES) {
      const full = path.join(proj, name);
      try {
        if (fs.statSync(full).isDirectory()) {
          depDirs.push({ name, path: full, sizeK: await duK(full) });
        }
      } catch { /* ignore */ }
    }
    if (depDirs.length === 0) return null;
    const [mtime, lastRun] = await Promise.all([srcMtime(proj), Promise.resolve(lastRunFor(proj, cwdUsage))]);
    const lastUsed = [mtime, lastRun].filter((x): x is number => x != null).reduce<number | null>((a, b) => (a == null ? b : Math.max(a, b)), null);
    return {
      name: path.basename(proj),
      path: proj,
      via: viaMap.get(proj) ?? 'scan',
      depDirs,
      depSizeK: depDirs.reduce((a, b) => a + b.sizeK, 0),
      srcMtime: mtime,
      lastRun,
      lastUsed,
    };
  });
  const result = entries.filter((e): e is ProjectEntry => e != null).sort((a, b) => b.depSizeK - a.depSizeK);
  // 同名项目（不同路径）加父目录前缀区分
  const nameCount = new Map<string, number>();
  for (const e of result) nameCount.set(e.name, (nameCount.get(e.name) ?? 0) + 1);
  for (const e of result) {
    if ((nameCount.get(e.name) ?? 0) > 1) e.name = `${path.basename(path.dirname(e.path))}/${e.name}`;
  }
  const totalK = result.reduce((a, b) => a + b.depSizeK, 0);
  log(`项目依赖: ${result.length} 个项目共 ${Math.round(totalK / 1024)} MB`);
  return result;
}
