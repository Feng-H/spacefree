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
  depDirs: DepDir[];
  depSizeK: number;
  srcMtime: number | null;    // 最新源码修改时间（排除依赖目录与 .git）
  lastRun: number | null;     // 钩子记录的该项目目录下最近命令执行
  lastUsed: number | null;    // max(srcMtime, lastRun)
}

/** 项目目录下的依赖目录名（仅识别项目根下这些精确名称） */
const DEP_NAMES = ['node_modules', '.venv', 'venv'];

function isProject(dir: string): boolean {
  try {
    for (const name of DEP_NAMES) {
      if (fs.statSync(path.join(dir, name)).isDirectory()) return true;
    }
  } catch { /* not a project */ }
  return false;
}

/** 深度 2 的项目发现（跳过 node_modules/.git/隐藏目录） */
function findProjects(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue;
      const full = path.join(dir, e.name);
      if (isProject(full)) out.push(full);
      if (depth > 0) walk(full, depth - 1);
    }
  };
  walk(root, 1);
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
  for (const root of roots) {
    for (const p of findProjects(root)) {
      if (!seen.has(p)) { seen.add(p); projects.push(p); }
    }
  }
  log(`项目根目录: ${roots.map((r) => path.basename(r)).join(', ') || '无'}；发现 ${projects.length} 个含依赖目录的项目`);
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
      depDirs,
      depSizeK: depDirs.reduce((a, b) => a + b.sizeK, 0),
      srcMtime: mtime,
      lastRun,
      lastUsed,
    };
  });
  const result = entries.filter((e): e is ProjectEntry => e != null).sort((a, b) => b.depSizeK - a.depSizeK);
  const totalK = result.reduce((a, b) => a + b.depSizeK, 0);
  log(`项目依赖: ${result.length} 个项目共 ${Math.round(totalK / 1024)} MB`);
  return result;
}
