import fs from 'node:fs';
import { HISTORY_PATH } from './util.js';
import type { Op, OpResult } from './cleaner.js';

export interface DeletedItem { kind: 'formula' | 'cask'; name: string }

export interface HistoryRecord {
  time: number;
  ok: boolean;
  actions: string[];
  skipped: string[];
  deleted?: DeletedItem[];
}

export function describeOp(op: Op): string {
  switch (op.type) {
    case 'uninstall-formula': return `卸载 brew 包: ${op.names.join(', ')}`;
    case 'uninstall-cask': return `卸载 cask: ${op.tokens.join(', ')}`;
    case 'install-formula': return `重装 brew 包: ${op.names.join(', ')}`;
    case 'autoremove': return 'brew autoremove（清理孤儿依赖）';
    case 'brew-cache': return 'brew cleanup --prune=all（清理缓存）';
    case 'trash-app': return `应用移入废纸篓: ${op.paths.map((p) => p.split('/').pop()).join(', ')}`;
    case 'trash-file': return `文件移入废纸篓: ${op.paths.map((p) => p.split('/').pop()).join(', ')}`;
    case 'dev-cache': return `清理开发缓存: ${op.names.join(', ')}`;
    default: return String(op);
  }
}

export function appendHistory(results: OpResult[], skippedAll: string[]): void {
  try {
    // 重装操作不属于清理历史
    const cleanResults = results.filter((r) => r.op.type !== 'install-formula');
    if (cleanResults.length === 0) return;
    const skipped = new Set(skippedAll);
    const deleted: DeletedItem[] = [];
    for (const r of cleanResults) {
      if (r.op.type === 'uninstall-formula') {
        for (const n of r.op.names) if (!skipped.has(n)) deleted.push({ kind: 'formula', name: n });
      } else if (r.op.type === 'uninstall-cask') {
        for (const t of r.op.tokens) if (!skipped.has(t)) deleted.push({ kind: 'cask', name: t });
      }
    }
    const record: HistoryRecord = {
      time: Math.floor(Date.now() / 1000),
      ok: cleanResults.every((r) => r.ok),
      actions: cleanResults.map((r) => describeOp(r.op)),
      skipped: skippedAll,
      deleted,
    };
    fs.appendFileSync(HISTORY_PATH, JSON.stringify(record) + '\n');
  } catch { /* best effort */ }
}

export function readHistory(limit = 50): HistoryRecord[] {
  try {
    const lines = fs.readFileSync(HISTORY_PATH, 'utf8').split('\n').filter(Boolean);
    return lines.slice(-limit).reverse().map((l) => JSON.parse(l) as HistoryRecord);
  } catch {
    return [];
  }
}

/** 从历史提取全部可一键重装的 formula 名（去重） */
export function reinstallableFromHistory(records: HistoryRecord[]): string[] {
  const set = new Set<string>();
  for (const r of records) {
    for (const d of r.deleted ?? []) {
      if (d.kind === 'formula') set.add(d.name);
    }
  }
  return [...set];
}
