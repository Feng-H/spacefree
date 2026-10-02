import path from 'node:path';
import { exec, formulaFromCellarPath, type ExecResult } from './util.js';

export interface FormulaInfo {
  name: string;
  desc: string;
  version: string;
  installedAt: number;      // epoch seconds, 0 if unknown
  onRequest: boolean;       // 用户主动安装（brew install xxx）
  kegOnly: boolean;
  deprecated: boolean;
  pinned: boolean;
  hasService: boolean;      // 声明了 brew service
  sizeK: number;            // KB on disk
  deps: string[];           // 直接+间接依赖（运行时，已安装的）
  usedBy: string[];         // 反向：哪些已安装 formula 依赖它
  usedByCasks: string[];    // 反向：哪些已安装 cask 依赖它
}

export interface CaskInfo {
  token: string;
  title: string;
  desc: string;
  version: string;
  installedAt: number;
  sizeK: number;
  dependsOnFormulae: string[];
}

export interface BrewData {
  prefix: string;      // /opt/homebrew or /usr/local
  cellar: string;
  caskroom: string;
  formulae: FormulaInfo[];
  casks: CaskInfo[];
  formulaByName: Map<string, FormulaInfo>;
}

interface RawInstalled {
  version: string;
  time?: number;
  installed_on_request?: boolean;
}

interface RawFormula {
  name: string;
  full_name: string;
  desc?: string | null;
  keg_only?: boolean;
  deprecated?: boolean;
  pinned?: boolean;
  service?: unknown;
  installed?: RawInstalled[];
}

interface RawCask {
  token: string;
  full_token: string;
  name?: string[];
  desc?: string | null;
  /** e.g. "25.0.5 1772497856" (version + install epoch) */
  installed?: string;
  depends_on?: { formula?: string[]; cask?: string[] };
}

export async function getPrefix(): Promise<string> {
  const r = await exec('brew', ['--prefix'], { timeoutMs: 15_000 });
  return r.stdout.trim() || '/opt/homebrew';
}

/** Parse "123.4MB" / "811.3MB" / "1.2GB" / "700KB" into KB. */
export function parseSizeToKB(s: string): number | null {
  const m = s.trim().match(/^([\d.]+)\s*([KMG])B$/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const unit = m[2].toUpperCase();
  if (unit === 'K') return n;
  if (unit === 'M') return n * 1024;
  return n * 1024 * 1024;
}

async function brewJson(): Promise<{ formulae: RawFormula[]; casks: RawCask[] }> {
  const r = await exec('brew', ['info', '--json=v2', '--installed'], { timeoutMs: 300_000 });
  if (r.code !== 0) throw new Error(`brew info 失败: ${r.stderr.slice(0, 300)}`);
  const data = JSON.parse(r.stdout);
  return { formulae: data.formulae ?? [], casks: data.casks ?? [] };
}

/** One-shot du over Cellar/Caskroom top-level dirs -> {name -> KB}. */
async function dirSizes(root: string, log?: (m: string) => void): Promise<Map<string, number>> {
  const r = await exec('du', ['-k', '-d', '1', root], { timeoutMs: 120_000 });
  const out = new Map<string, number>();
  for (const line of r.stdout.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(.*)$/);
    if (!m) continue;
    const kb = parseInt(m[1], 10);
    const dir = m[2].replace(/\/+$/, '');
    if (dir === root || dir === '') continue;
    if (path.dirname(dir) !== root.replace(/\/+$/, '')) continue;
    out.set(path.basename(dir), (out.get(path.basename(dir)) ?? 0) + kb);
  }
  log?.(`du ${root}: ${out.size} 项`);
  return out;
}

/** brew deps --installed output: "name: dep1 dep2 ..." (Homebrew 7 includes casks as keys too). Classify by installed sets. */
async function depsGraph(
  formulaNames: Set<string>,
  caskTokens: Set<string>,
  log?: (m: string) => void,
): Promise<{ formulaDeps: Map<string, string[]>; caskDeps: Map<string, string[]> }> {
  const formulaDeps = new Map<string, string[]>();
  const caskDeps = new Map<string, string[]>();
  const r = await exec('brew', ['deps', '--installed'], { timeoutMs: 300_000 });
  for (const line of r.stdout.split('\n')) {
    const m = line.match(/^(\S+):\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    const deps = m[2].trim() ? m[2].trim().split(/\s+/) : [];
    const base = key.includes('/') ? key.split('/').pop()! : key;
    if (caskTokens.has(key) || caskTokens.has(base)) caskDeps.set(key, deps);
    else if (formulaNames.has(key) || formulaNames.has(base)) formulaDeps.set(key, deps);
    else {
      // unknown: treat as formula key by default
      formulaDeps.set(key, deps);
    }
  }
  log?.(`依赖图: ${formulaDeps.size} formula, ${caskDeps.size} cask`);
  return { formulaDeps, caskDeps };
}

export async function loadBrewData(log: (m: string) => void, onProgress?: (msg: string) => void): Promise<BrewData> {
  onProgress?.('获取 Homebrew 前缀…');
  const prefix = await getPrefix();
  const cellar = path.join(prefix, 'Cellar');
  const caskroom = `${prefix}/Caskroom`;

  onProgress?.('读取已安装包清单（brew info，可能需要一点时间）…');
  const { formulae: rawFormulae, casks: rawCasks } = await brewJson();
  const installedNames = new Set(rawFormulae.map((f) => f.name));
  const caskTokens = new Set(rawCasks.map((c) => c.token));

  const [cellSizes, caskSizes, graphs] = await Promise.all([
    dirSizes(cellar, log).catch(() => new Map<string, number>()),
    dirSizes(caskroom, log).catch(() => new Map<string, number>()),
    depsGraph(installedNames, caskTokens, log),
  ]);

  const formulae: FormulaInfo[] = rawFormulae.map((f) => {
    const inst = f.installed?.[0];
    // deps graph keyed by full name usually equals name for core tap
    const depsAll = graphs.formulaDeps.get(f.name) ?? graphs.formulaDeps.get(f.full_name) ?? [];
    return {
      name: f.name,
      desc: f.desc ?? '',
      version: inst?.version ?? '',
      installedAt: inst?.time ?? 0,
      onRequest: inst?.installed_on_request ?? false,
      kegOnly: f.keg_only ?? false,
      deprecated: f.deprecated ?? false,
      pinned: f.pinned ?? false,
      hasService: f.service != null,
      sizeK: cellSizes.get(f.name) ?? 0,
      deps: depsAll,
      usedBy: [],
      usedByCasks: [],
    };
  });

  const casks: CaskInfo[] = rawCasks
    .filter((c) => c.installed)
    .map((c) => {
      const parts = c.installed!.split(/\s+/);
      const version = parts[0] ?? '';
      const t = parts.length > 1 ? parseInt(parts[1], 10) : 0;
      return {
        token: c.token,
        title: c.name?.[0] ?? c.token,
        desc: c.desc ?? '',
        version,
        installedAt: Number.isFinite(t) ? t : 0,
        sizeK: caskSizes.get(c.token) ?? 0,
        dependsOnFormulae: (c.depends_on?.formula ?? []).filter((d) => installedNames.has(d)),
      };
    });

  // Build reverse dependency maps (installed formula -> dependents)
  const byName = new Map(formulae.map((f) => [f.name, f]));
  for (const f of formulae) {
    for (const dep of f.deps) {
      const target = byName.get(dep);
      if (target && dep !== f.name) target.usedBy.push(f.name);
    }
  }
  for (const c of casks) {
    for (const dep of c.dependsOnFormulae) {
      const target = byName.get(dep);
      if (target) target.usedByCasks.push(c.token);
    }
  }

  log(`Homebrew: ${formulae.length} formulae (${[...cellSizes.values()].reduce((a, b) => a + b, 0)} KB Cellar), ${casks.length} casks`);
  return { prefix, cellar, caskroom, formulae, casks, formulaByName: byName };
}

/** Re-verify at execute time that nothing installed depends on `name`. Returns dependents or []. */
export async function checkUsedBy(name: string): Promise<string[]> {
  const r: ExecResult = await exec('brew', ['uses', '--installed', name], { timeoutMs: 300_000 });
  if (r.code !== 0) return ['<检查失败，已保守跳过>'];
  return r.stdout.split(/\s+/).filter(Boolean);
}

/** Extract formula names from running process command lines (Cellar + opt paths). */
export async function runningFormulae(prefix: string, log?: (m: string) => void): Promise<Set<string>> {
  const running = new Set<string>();
  const r = await exec('ps', ['ax', '-o', 'command='], { timeoutMs: 30_000 });
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`${escaped}/(?:Cellar|opt)/([^/\\s)\"']+)`, 'g');
  for (const line of r.stdout.split('\n')) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) {
      running.add(m[1]);
    }
  }
  // exclude our own scanner subprocesses pattern
  running.delete('brew');
  log?.(`运行中的 brew 相关进程: ${[...running].join(', ') || '无'}`);
  return running;
}

export async function servicesRunning(log?: (m: string) => void): Promise<Set<string>> {
  const running = new Set<string>();
  const r = await exec('brew', ['services', 'list'], { timeoutMs: 60_000 });
  for (const line of r.stdout.split('\n').slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length >= 2 && ['started', 'error', 'unknown'].includes(cols[1])) {
      running.add(cols[0]);
    }
  }
  log?.(`brew services 运行中: ${[...running].join(', ') || '无'}`);
  return running;
}

export { formulaFromCellarPath };
