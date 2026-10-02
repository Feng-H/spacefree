import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const DATA_DIR = path.join(os.homedir(), '.spacefree');
export const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
export const EVENTS_PATH = path.join(DATA_DIR, 'events.jsonl');
export const STATE_PATH = path.join(DATA_DIR, 'state.json');

export function ensureDataDir(): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

export interface ExecOpts {
  timeoutMs?: number;
  cwd?: string;
  onLine?: (line: string, stream: 'out' | 'err') => void;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  combined: string;
}

/** Run a command, optionally streaming each output line to onLine. Never throws. */
export function exec(cmd: string, args: string[], opts: ExecOpts = {}): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: process.env });
    let stdout = '';
    let stderr = '';
    let combined = '';
    const push = (chunk: Buffer, stream: 'out' | 'err') => {
      const text = chunk.toString('utf8');
      if (stream === 'out') stdout += text;
      else stderr += text;
      combined += text;
      if (opts.onLine) {
        for (const line of text.split('\n')) {
          if (line.length > 0) opts.onLine(line.replace(/\r$/, ''), stream);
        }
      }
    };
    child.stdout?.on('data', (d: Buffer) => push(d, 'out'));
    child.stderr?.on('data', (d: Buffer) => push(d, 'err'));
    child.on('error', (err) => {
      resolve({ code: -1, stdout, stderr: stderr + String(err), combined });
    });
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          try { child.kill('SIGKILL'); } catch { /* noop */ }
        }, opts.timeoutMs)
      : null;
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr, combined });
    });
  });
}

/** Parallel map with concurrency limit. */
export async function pmap<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) break;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

export function fmtKB(kb: number | null | undefined): string {
  if (kb == null || Number.isNaN(kb)) return '—';
  if (kb < 1024) return `${Math.round(kb)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return mb >= 100 ? `${Math.round(mb)} MB` : `${mb.toFixed(1)} MB`;
  const gb = mb / 1024;
  return gb >= 100 ? `${gb.toFixed(0)} GB` : `${gb.toFixed(1)} GB`;
}

export function fmtDate(ts: number | null | undefined): string {
  if (!ts) return '—';
  const d = new Date(ts * 1000);
  const now = Date.now() / 1000;
  const diffDays = (now - ts) / 86400;
  const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  if (diffDays < 1) return `今天 (${iso})`;
  if (diffDays < 30) return `${Math.round(diffDays)} 天前 (${iso})`;
  if (diffDays < 365) return `${Math.round(diffDays / 30)} 个月前 (${iso})`;
  return `${(diffDays / 365).toFixed(1)} 年前 (${iso})`;
}

export function ageDays(ts: number | null | undefined): number | null {
  if (!ts) return null;
  return (Date.now() / 1000 - ts) / 86400;
}

export function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

export function isExecutable(f: string): boolean {
  try {
    fs.accessSync(f, fs.constants.X_OK);
    return fs.statSync(f).isFile();
  } catch {
    return false;
  }
}

/** Extract formula name from a real path under a Homebrew Cellar, e.g. /opt/homebrew/Cellar/git/2.50.0/bin/git -> git */
export function formulaFromCellarPath(p: string): string | null {
  const m = p.match(/\/(?:Cellar|Caskroom)\/([^/]+)\//);
  return m ? m[1] : null;
}
