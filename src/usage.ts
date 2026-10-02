import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { exec, EVENTS_PATH, isExecutable, formulaFromCellarPath, pmap } from './util.js';

export interface UsageStat {
  count: number;
  lastT: number | null;   // epoch seconds; null when history has no timestamps
}

export interface UsageData {
  /** formula name -> usage from all sources merged */
  formulae: Map<string, UsageStat>;
  hookEventCount: number;
  historyCommandCount: number;
  historyHasTimestamps: boolean;
  sourcesNote: string[];
}

interface HistStat {
  count: number;
  lastT: number | null;
}

/**
 * Parse zsh history. Supports both extended (`: 1699999999:0;cmd`) and plain formats.
 * Returns map: first command word -> {count, lastT|null}.
 */
function parseZshHistory(file: string): Map<string, HistStat> {
  const out = new Map<string, HistStat>();
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return out;
  }
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let cmd: string | null = null;
    let ts: number | null = null;
    const m = line.match(/^: (\d+):\d+;(.*)$/);
    if (m) {
      ts = parseInt(m[1], 10);
      cmd = m[2];
    } else if (!line.startsWith(': ') && i > 0 && !/^\s*$/.test(line)) {
      // plain format: every line is a command (continuation lines of multi-line cmds are indistinguishable; acceptable)
      cmd = line;
    }
    if (!cmd) continue;
    // strip leading env assignments / sudo for better attribution
    const word = firstWord(cmd);
    if (!word) continue;
    bump(out, word, ts);
  }
  return out;
}

function parseBashHistory(file: string): Map<string, HistStat> {
  const out = new Map<string, HistStat>();
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const word = firstWord(line);
      if (word) bump(out, word, null);
    }
  } catch { /* absent */ }
  return out;
}

/** fish history (~/.local/share/fish/fish_history): YAML-ish `- cmd: xxx` with optional `- when: epoch`. */
function parseFishHistory(file: string): Map<string, HistStat> {
  const out = new Map<string, HistStat>();
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    let pending: string | null = null;
    for (const line of lines) {
      const cm = line.match(/^\s*- cmd:\s?(.*)$/);
      if (cm) {
        pending = cm[1];
        continue;
      }
      const wm = line.match(/^\s*- when:\s?(\d+)\s*$/);
      if (wm && pending != null) {
        const w = firstWord(pending);
        if (w) bump(out, w, parseInt(wm[1], 10));
        pending = null;
      }
    }
  } catch { /* absent */ }
  return out;
}

function firstWord(cmd: string): string | null {
  const t = cmd.trim().replace(/^(sudo|env|nice|nohup|command)\s+/i, '').split(/\s+/)[0] ?? '';
  if (!t || t.startsWith('-') || t.startsWith('#')) return null;
  // strip path if user ran an absolute/relative binary
  return path.basename(t) || null;
}

function bump(map: Map<string, HistStat>, word: string, ts: number | null): void {
  if (!word) return;
  const cur = map.get(word) ?? { count: 0, lastT: null };
  cur.count += 1;
  if (ts != null && (cur.lastT == null || ts > cur.lastT)) cur.lastT = ts;
  map.set(word, cur);
}

export function collectHistories(): {
  cmds: Map<string, HistStat>;
  hasTimestamps: boolean;
  files: string[];
} {
  const home = os.homedir();
  const candidates = [
    path.join(home, '.zsh_history'),
    path.join(home, '.bash_history'),
    path.join(home, '.local/share/fish/fish_history'),
  ];
  const merged = new Map<string, HistStat>();
  let hasTimestamps = false;
  const files: string[] = [];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    files.push(file);
    let parsed: Map<string, HistStat>;
    if (file.endsWith('.zsh_history')) parsed = parseZshHistory(file);
    else if (file.endsWith('fish_history')) parsed = parseFishHistory(file);
    else parsed = parseBashHistory(file);
    if (file.endsWith('.zsh_history')) {
      for (const v of parsed.values()) if (v.lastT != null) hasTimestamps = true;
    }
    if (file.endsWith('fish_history')) {
      for (const v of parsed.values()) if (v.lastT != null) hasTimestamps = true;
    }
    for (const [k, v] of parsed) {
      const cur = merged.get(k) ?? { count: 0, lastT: null };
      cur.count += v.count;
      if (v.lastT != null && (cur.lastT == null || v.lastT > cur.lastT)) cur.lastT = v.lastT;
      merged.set(k, cur);
    }
  }
  return { cmds: merged, hasTimestamps, files };
}

/**
 * Build mapping: executable command name -> brew formula, by scanning PATH dirs
 * and resolving symlinks (pure Node, no shell). Only resolves names in `names`.
 */
export async function buildCommandFormulaMap(names: Iterable<string>, cellarPrefixes: string[]): Promise<Map<string, string>> {
  const wanted = new Set(names);
  const result = new Map<string, string>();
  const pathDirs = (process.env.PATH ?? '').split(':').filter(Boolean);
  const extra = ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/usr/local/sbin', path.join(os.homedir(), '.cargo/bin'), path.join(os.homedir(), '.local/bin')];
  const dirs = [...new Set([...pathDirs, ...extra])];
  await pmap(dirs, 4, async (dir) => {
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (!wanted.has(name) || result.has(name)) continue;
      const full = path.join(dir, name);
      if (!isExecutable(full)) continue;
      try {
        const real = fs.realpathSync(full);
        const f = formulaFromCellarPath(real);
        if (f && cellarPrefixes.some((p) => real.startsWith(p))) result.set(name, f);
      } catch { /* broken symlink */ }
    }
  });
  return result;
}

/** Read hook event log. Supports our TSV format and eslogger JSON lines (deep path search). */
export function readHookEvents(): { stats: Map<string, UsageStat>; total: number } {
  const stats = new Map<string, UsageStat>();
  let total = 0;
  let raw: string;
  try {
    raw = fs.readFileSync(EVENTS_PATH, 'utf8');
  } catch {
    return { stats, total };
  }
  const dedupe = new Map<string, number>(); // formula -> last credited epoch
  for (const line of raw.split('\n')) {
    if (!line) continue;
    const formula = parseEventFormula(line);
    if (!formula) continue;
    total += 1;
    const ts = parseEventTime(line) ?? Math.floor(Date.now() / 1000);
    const last = dedupe.get(formula) ?? 0;
    if (ts - last < 60) continue; // dedupe within 60s window
    dedupe.set(formula, ts);
    const cur = stats.get(formula) ?? { count: 0, lastT: null };
    cur.count += 1;
    if (cur.lastT == null || ts > cur.lastT) cur.lastT = ts;
    stats.set(formula, cur);
  }
  return { stats, total };
}

function parseEventFormula(line: string): string | null {
  // TSV: "<epoch>\t<formula>\t<cmd?>"
  if (/^\d+\t/.test(line)) {
    return line.split('\t')[1] || null;
  }
  // eslogger JSON: deep-search any Cellar path
  if (line.startsWith('{')) {
    try {
      const obj: unknown = JSON.parse(line);
      const found = deepFindCellar(obj, 0);
      if (found) return found;
    } catch { /* skip */ }
  }
  return null;
}

function parseEventTime(line: string): number | null {
  if (/^\d+\t/.test(line)) {
    return parseInt(line.split('\t')[0], 10);
  }
  if (line.startsWith('{')) {
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      const t = (obj.time as { wall_time?: number } | undefined)?.wall_time;
      if (typeof t === 'number') return t;
    } catch { /* skip */ }
  }
  return null;
}

function deepFindCellar(obj: unknown, depth: number): string | null {
  if (depth > 8) return null;
  if (typeof obj === 'string') {
    const m = obj.match(/\/(?:Cellar)\/([^/]+)\//);
    return m ? m[1] : null;
  }
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const r = deepFindCellar(item, depth + 1);
      if (r) return r;
    }
    return null;
  }
  if (obj && typeof obj === 'object') {
    for (const v of Object.values(obj)) {
      const r = deepFindCellar(v, depth + 1);
      if (r) return r;
    }
  }
  return null;
}

/** Aggregate usage from every source into one map keyed by formula name. */
export async function collectUsage(
  cellarPrefixes: string[],
  log: (m: string) => void,
): Promise<UsageData> {
  const sourcesNote: string[] = [];
  const merged = new Map<string, UsageStat>();
  const mergeStat = (formula: string, stat: UsageStat) => {
    const cur = merged.get(formula) ?? { count: 0, lastT: null };
    cur.count += stat.count;
    if (stat.lastT != null && (cur.lastT == null || stat.lastT > cur.lastT)) cur.lastT = stat.lastT;
    merged.set(formula, cur);
  };

  // 1. hook events (precise, forward-looking)
  const hook = readHookEvents();
  for (const [f, s] of hook.stats) mergeStat(f, s);
  sourcesNote.push(`监控钩子事件: ${hook.total} 条，覆盖 ${hook.stats.size} 个包`);

  // 2. shell histories (retroactive baseline)
  const hist = collectHistories();
  let histMapped = 0;
  if (hist.cmds.size > 0) {
    const nameMap = await buildCommandFormulaMap(hist.cmds.keys(), cellarPrefixes);
    for (const [cmdName, stat] of hist.cmds) {
      const formula = nameMap.get(cmdName);
      if (!formula) continue;
      histMapped += 1;
      mergeStat(formula, { count: stat.count, lastT: stat.lastT });
    }
    sourcesNote.push(`Shell 历史: ${hist.files.map((f) => path.basename(f)).join(', ')}${hist.hasTimestamps ? '' : '（无时间戳，仅有使用次数）'}`);
  } else {
    sourcesNote.push('Shell 历史: 未找到');
  }
  log(`使用数据: hook ${hook.total} 条; 历史命令 ${hist.cmds.size} 个（${histMapped} 个映射到 brew 包）`);

  return {
    formulae: merged,
    hookEventCount: hook.total,
    historyCommandCount: hist.cmds.size,
    historyHasTimestamps: hist.hasTimestamps,
    sourcesNote,
  };
}

/** Spotlight last-used info for an app bundle (labeled output, robust parsing). */
export interface AppUsage {
  lastUsed: number | null;  // epoch seconds
  useCount: number | null;
}

export async function spotlightUsage(appPath: string): Promise<AppUsage> {
  const r = await exec('mdls', [
    '-name', 'kMDItemLastUsedDate', '-name', 'kMDItemUseCount', appPath,
  ], { timeoutMs: 15_000 });
  if (r.code !== 0) return { lastUsed: null, useCount: null };
  let lastUsed: number | null = null;
  let useCount: number | null = null;
  for (const line of r.stdout.split('\n')) {
    const m = line.match(/^kMDItem(LastUsedDate|UseCount)\s*=\s*(.*)$/);
    if (!m) continue;
    const val = m[2].trim();
    if (m[1] === 'LastUsedDate' && val !== 'null') {
      const d = new Date(val);
      if (!Number.isNaN(d.getTime())) lastUsed = Math.floor(d.getTime() / 1000);
    } else if (m[1] === 'UseCount' && val !== 'null') {
      const n = parseInt(val, 10);
      if (Number.isFinite(n)) useCount = n;
    }
  }
  return { lastUsed, useCount };
}
