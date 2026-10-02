import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { exec, expandHome, pmap, STATE_PATH, fmtKB } from './util.js';
import { loadBrewData, runningFormulae, servicesRunning, parseSizeToKB, type BrewData, type FormulaInfo, type CaskInfo } from './brew.js';
import { collectUsage, spotlightUsage, type UsageData } from './usage.js';
import type { Config } from './config.js';

export interface AppEntry {
  name: string;
  path: string;
  sizeK: number;
  installedAt: number | null;   // mtime of bundle
  lastUsed: number | null;      // spotlight
  useCount: number | null;      // spotlight
  system: boolean;              // under /System
  caskToken: string | null;     // linked brew cask if any
}

export interface DownloadEntry {
  file: string;
  sizeK: number;
  modifiedAt: number;
  kind: 'dmg' | 'pkg' | 'zip';
}

export interface CacheInfo {
  brewCacheK: number;
  brewCleanupFreedK: number | null;  // what `brew cleanup --prune=all` would free
}

export interface ScanState {
  scannedAt: number;
  brewPrefix: string;
  formulae: FormulaInfo[];
  casks: CaskInfo[];
  apps: AppEntry[];
  downloads: DownloadEntry[];
  cache: CacheInfo;
  running: string[];
  services: string[];
  usage: {
    formulae: Record<string, { count: number; lastT: number | null }>;
    hookEventCount: number;
    historyCommandCount: number;
    historyHasTimestamps: boolean;
    sourcesNote: string[];
  };
}

function execSyncKB(args: string[]): number {
  try {
    const out = execFileSync('du', args, { timeout: 60_000 }).toString();
    const m = out.trim().match(/^(\d+)/);
    return m ? parseInt(m[1], 10) : 0;
  } catch {
    return 0;
  }
}

async function scanApps(cfg: Config, log: (m: string) => void, onProgress?: (m: string) => void): Promise<AppEntry[]> {
  onProgress?.('扫描应用与使用记录（Spotlight）…');
  const apps: AppEntry[] = [];
  const seen = new Set<string>();
  const dirs = cfg.appDirs.map(expandHome);
  const bundles: { p: string; system: boolean }[] = [];
  for (const dir of dirs) {
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.isDirectory() && e.name.endsWith('.app')) {
        const full = path.join(dir, e.name);
        if (seen.has(full)) continue;
        seen.add(full);
        bundles.push({ p: full, system: dir.startsWith('/System') });
      }
    }
  }
  await pmap(bundles, 6, async (b) => {
    const name = b.p.replace(/\.app$/, '').split('/').pop() ?? b.p;
    let installedAt: number | null = null;
    try { installedAt = Math.floor(fs.statSync(b.p).mtimeMs / 1000); } catch { /* ignore */ }
    const usage = await spotlightUsage(b.p).catch(() => ({ lastUsed: null, useCount: null }));
    apps.push({
      name,
      path: b.p,
      sizeK: 0, // filled below (sync du is slow per-app; use batch)
      installedAt,
      lastUsed: usage.lastUsed,
      useCount: usage.useCount,
      system: b.system,
      caskToken: null,
    });
  });
  // batch sizes with one du call
  if (bundles.length > 0) {
    const r = await exec('du', ['-sk', ...bundles.map((b) => b.p)], { timeoutMs: 300_000 });
    const sizeMap = new Map<string, number>();
    for (const line of r.stdout.split('\n')) {
      const m = line.trim().match(/^(\d+)\s+(.*)$/);
      if (m) sizeMap.set(m[2].replace(/\/$/, ''), parseInt(m[1], 10));
    }
    for (const app of apps) app.sizeK = sizeMap.get(app.path) ?? 0;
  }
  log(`应用: ${apps.length} 个`);
  return apps;
}

async function scanDownloads(cfg: Config, log: (m: string) => void): Promise<DownloadEntry[]> {
  const out: DownloadEntry[] = [];
  const exts: Record<string, DownloadEntry['kind']> = { '.dmg': 'dmg', '.pkg': 'pkg', '.zip': 'zip' };
  for (const dirCfg of cfg.downloadDirs) {
    const dir = expandHome(dirCfg);
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    const targets = entries.filter((e) => e.isFile() && (exts[path.extname(e.name).toLowerCase()] !== undefined));
    for (const e of targets) {
      const kind = exts[path.extname(e.name).toLowerCase()];
      if (kind === 'zip' && !cfg.includeZip) continue;
      const full = path.join(dir, e.name);
      try {
        const st = fs.statSync(full);
        out.push({ file: full, sizeK: Math.round(st.size / 1024), modifiedAt: Math.floor(st.mtimeMs / 1000), kind });
      } catch { /* ignore */ }
    }
  }
  const totalK = out.reduce((a, b) => a + b.sizeK, 0);
  log(`下载目录安装包: ${out.length} 个 (${fmtKB(totalK)})`);
  return out;
}

async function scanCache(log: (m: string) => void): Promise<CacheInfo> {
  const homeCache = path.join(process.env.HOME ?? '', 'Library/Caches/Homebrew');
  const brewCacheK = fs.existsSync(homeCache) ? execSyncKB(['-sk', homeCache]) : 0;
  const dry = await exec('brew', ['cleanup', '--prune=all', '-n'], { timeoutMs: 300_000 });
  let freedK: number | null = null;
  const m = dry.stdout.match(/free approximately ([\d.]+\s*[KMG]B)/i);
  if (m) freedK = parseSizeToKB(m[1]);
  log(`brew 缓存: ${fmtKB(brewCacheK)}；brew cleanup 可释放 ${freedK ? fmtKB(freedK) : '未知'}`);
  return { brewCacheK, brewCleanupFreedK: freedK };
}

function linkCasksToApps(casks: CaskInfo[], apps: AppEntry[]): void {
  for (const cask of casks) {
    const tokenBase = cask.token.replace(/-/g, ' ').toLowerCase();
    let best: AppEntry | undefined;
    for (const app of apps) {
      const n = app.name.toLowerCase();
      if (n === cask.token || n === tokenBase || n.includes(tokenBase) || tokenBase.includes(n)) {
        if (!best || n.length > best.name.length) best = app;
      }
    }
    if (best) best.caskToken = cask.token;
  }
}

export async function runScan(cfg: Config, log: (m: string) => void, onProgress?: (msg: string) => void): Promise<ScanState> {
  onProgress?.('读取 Homebrew 数据…');
  const brew: BrewData = await loadBrewData(log, onProgress);
  onProgress?.('分析使用记录（历史 + 监控事件）…');
  const usage: UsageData = await collectUsage([brew.cellar, brew.caskroom], log);
  const [running, services] = await Promise.all([
    runningFormulae(brew.prefix, log),
    servicesRunning(log).catch(() => new Set<string>()),
  ]);
  const apps = await scanApps(cfg, log, onProgress);
  const downloads = await scanDownloads(cfg, log);
  onProgress?.('计算缓存占用…');
  const cache = await scanCache(log);
  linkCasksToApps(brew.casks, apps);

  const state: ScanState = {
    scannedAt: Math.floor(Date.now() / 1000),
    brewPrefix: brew.prefix,
    formulae: brew.formulae,
    casks: brew.casks,
    apps,
    downloads,
    cache,
    running: [...running],
    services: [...services],
    usage: {
      formulae: Object.fromEntries(usage.formulae),
      hookEventCount: usage.hookEventCount,
      historyCommandCount: usage.historyCommandCount,
      historyHasTimestamps: usage.historyHasTimestamps,
      sourcesNote: usage.sourcesNote,
    },
  };
  try {
    fs.writeFileSync(STATE_PATH, JSON.stringify(state));
    log(`扫描完成，状态已保存 (${fmtKB(Math.round(fs.statSync(STATE_PATH).size / 1024))})`);
  } catch (err) {
    log(`状态保存失败: ${err instanceof Error ? err.message : err}`);
  }
  return state;
}

export function loadState(): ScanState | null {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')) as ScanState;
  } catch {
    return null;
  }
}
