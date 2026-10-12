import readline from 'node:readline';
import path from 'node:path';
import fs from 'node:fs';
import { loadConfig, saveConfig, type Config } from './config.js';
import { runScan, loadState, type ScanState } from './scanner.js';
import { plan, type PlanResult, type FormulaPlan, type CaskPlan, type AppPlan } from './plan.js';
import { runOps, type Op } from './cleaner.js';
import { installHook, hookStatus, selfTestHook } from './hook.js';
import { appendHistory, readHistory, reinstallableFromHistory, type HistoryRecord } from './history.js';
import { exec, DATA_DIR, fmtKB, fmtDate, killAllChildren } from './util.js';

/* ---------- ANSI / 宽度工具 ---------- */
const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m',
  gray: '\x1b[90m', white: '\x1b[97m',
  bgSel: '\x1b[48;5;236m', bgTab: '\x1b[48;5;240m',
};

function charW(cp: number): number {
  if (cp >= 0x1100 && (
    cp <= 0x115f || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) || (cp >= 0x20000 && cp <= 0x3fffd))) return 2;
  return 1;
}
function dwidth(s: string): number {
  let w = 0;
  for (const ch of s) w += charW(ch.codePointAt(0)!);
  return w;
}
function pad(s: string, n: number): string {
  const d = n - dwidth(s);
  return s + (d > 0 ? ' '.repeat(d) : '');
}
function trunc(s: string, n: number): string {
  if (n < 1) return '';
  if (dwidth(s) <= n) return s;
  let w = 0, out = '';
  for (const ch of s) {
    const cw = charW(ch.codePointAt(0)!);
    if (w + cw > n - 1) break;
    out += ch; w += cw;
  }
  return out + '…';
}
function padTrunc(s: string, n: number): string { return pad(trunc(s, n), n); }

function fmtDays(ts: number | null | undefined): string {
  if (ts == null) return '从未';
  const d = (Date.now() / 1000 - ts) / 86400;
  if (d < 1) return '今天';
  if (d < 60) return `${Math.round(d)}天前`;
  if (d < 365) return `${Math.round(d / 30)}月前`;
  return `${(d / 365).toFixed(1)}年前`;
}

type Verdict = FormulaPlan['verdict'];
const V_LABEL: Record<Verdict, string> = {
  unused: '🔴从未使用', stale: '🟠久未使用', keep: '🟢在用',
  needed: '🔗被依赖', blocked: '⛔已阻止', review: '🔵待复核',
};
const V_PLAIN: Record<Verdict, string> = {
  unused: '从未使用', stale: '久未使用', keep: '在用',
  needed: '被依赖', blocked: '已阻止', review: '待复核',
};
function isCand(v: Verdict): boolean { return v === 'unused' || v === 'stale'; }

/* ---------- TUI ---------- */
interface Row {
  key: string;              // 唯一标识 formula:cask:app:path:file:setting:history index
  candidate: boolean;       // 可勾选
  cells: string[];          // 各列（已含颜色）
  plain: string;            // 搜索用纯文本
  sortVals: Record<string, string | number | null>;
}

type TabId = 'brew' | 'apps' | 'downloads' | 'projects' | 'cache' | 'history' | 'settings';

interface InputState { prompt: string; value: string; purpose: 'yes' | 'search' | 'number' | 'text' | 'protect' }

export class Tui {
  private cfg: Config;
  private state: ScanState | null = null;
  private p: PlanResult | null = null;
  private history: HistoryRecord[] = [];

  private tab: TabId = 'brew';
  private tabs: { id: TabId; label: string }[] = [
    { id: 'brew', label: 'Homebrew' },
    { id: 'apps', label: '应用' },
    { id: 'downloads', label: '下载' },
    { id: 'projects', label: '项目依赖' },
    { id: 'cache', label: '缓存' },
    { id: 'history', label: '历史' },
    { id: 'settings', label: '设置' },
  ];
  private cursor = 0;
  private offset = 0;
  private sortIdx: Record<string, number> = { brew: 0, apps: 0, downloads: 0, projects: 0, cache: 0 };

  private selF = new Set<string>();   // formula
  private selC = new Set<string>();   // cask
  private selA = new Set<string>();   // app path (for uninstall)
  private selU = new Set<string>();   // app name (for user data clear)
  private selD = new Set<string>();   // download file
  private selP = new Set<string>();   // project path
  private selX = new Set<string>();   // cache 大目录 path

  private filter = '';
  private mode: 'table' | 'log' | 'input' | 'help' = 'help';
  private input: InputState | null = null;
  private busy = false;
  private busyMsg = '';
  private status = '';
  private statusAt = 0;
  private logLines: string[] = [];
  private logFollow = true;
  private dryPreviewed = false;
  private visual = false;
  private visualAnchor = 0;
  private visualTarget = true;
  private lastExecSummary = '';
  private running = true;
  private renderQueued = false;

  constructor() {
    this.cfg = loadConfig();
  }

  async start(): Promise<void> {
    const out = process.stdout;
    const input = process.stdin;
    if (!out.isTTY || !input.isTTY) {
      console.log('当前环境不是交互式终端，无法启动 TUI。可用: spacefree report 查看报告');
      return;
    }
    readline.emitKeypressEvents(input);
    input.setRawMode(true);
    input.resume();
    out.write('\x1b[?1049h\x1b[?25l\x1b[2J');
    process.on('SIGWINCH', () => this.scheduleRender());
    process.on('SIGINT', () => this.quitNow());
    input.on('keypress', (_s: string, key: any) => {
      try { this.onKey(key); } catch (err) { this.setStatus(`内部错误: ${err instanceof Error ? err.message : err}`); }
    });
    const onExit = () => this.cleanup();
    process.on('exit', onExit);
    process.on('SIGTERM', () => { this.cleanup(); process.exit(0); });

    this.loadAll();
    if (!this.state) {
      this.setStatus('尚无扫描数据，开始首次扫描…');
      void this.doScan();
    }
    this.render();
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => { if (!this.running) { clearInterval(timer); resolve(); } }, 200);
    });
  }

  private cleanup(): void {
    try {
      process.stdin.setRawMode(false);
    } catch { /* ignore */ }
    try {
      process.stdout.write('\x1b[?25h\x1b[?1049l');
    } catch { /* ignore */ }
  }

  /** 彻底退出：恢复终端 → 杀活动子进程 → 立即退出进程 */
  private quitNow(code = 0): void {
    this.running = false;
    this.cleanup();
    killAllChildren();
    process.exit(code);
  }

  /* ---------- 数据 ---------- */
  private loadAll(): void {
    this.state = loadState();
    this.cfg = loadConfig();
    if (this.state) this.p = plan(this.state, this.cfg);
    this.history = readHistory();
  }

  private setStatus(msg: string): void {
    this.status = msg;
    this.statusAt = Date.now();
    this.scheduleRender();
  }

  private log(msg: string): void {
    this.logLines.push(msg);
    if (this.logLines.length > 5000) this.logLines.splice(0, 2000);
    if (this.mode === 'log') this.scheduleRender();
  }

  /* ---------- 行构建 ---------- */
  private buildRows(): Row[] {
    if (!this.state || !this.p) return [];
    const rows: Row[] = [];
    if (this.tab === 'brew') {
      const fl = this.p.formulae;
      const ck = this.p.casks;
      const filteredF = fl.filter((f) => this.match(f.name + ' ' + f.desc));
      const filteredC = ck.filter((c) => this.match(c.token + ' ' + c.title));
      for (const f of filteredF) {
        const cand = isCand(f.verdict);
        rows.push({
          key: `f:${f.name}`,
          candidate: cand,
          cells: [
            this.selMark(this.selF.has(f.name), cand) + ' ',
            padTrunc(f.name, 24),
            pad(fmtKB(f.sizeK), 10),
            pad(f.installedAt ? fmtDays(f.installedAt) : '—', 9),
            pad(f.lastUsed ? fmtDays(f.lastUsed) : '从未', 9),
            pad(String(f.usageCount || 0), 6),
            this.verdictCell(f.verdict),
            C.gray + trunc(f.reason, 40) + C.reset,
          ],
          plain: `${f.name} ${f.desc} ${V_PLAIN[f.verdict]} ${f.reason}`,
          sortVals: { name: f.name, sizeK: f.sizeK, installedAt: f.installedAt, lastUsed: f.lastUsed ?? -1, usageCount: f.usageCount },
        });
      }
      for (const c of filteredC) {
        const cand = isCand(c.verdict);
        rows.push({
          key: `c:${c.token}`,
          candidate: cand,
          cells: [
            this.selMark(this.selC.has(c.token), cand) + ' ',
            padTrunc(C.magenta + c.token + C.reset, 24),
            pad(fmtKB(c.sizeK), 10),
            pad(c.installedAt ? fmtDays(c.installedAt) : '—', 9),
            pad(c.lastUsed ? fmtDays(c.lastUsed) : '无记录', 9),
            pad(String(c.useCount ?? '—'), 6),
            this.verdictCell(c.verdict),
            C.gray + trunc(c.reason, 40) + C.reset,
          ],
          plain: `${c.token} ${c.title} ${V_PLAIN[c.verdict]} ${c.reason}`,
          sortVals: { name: c.token, sizeK: c.sizeK, installedAt: c.installedAt, lastUsed: c.lastUsed ?? -1, usageCount: c.useCount ?? -1 },
        });
      }
      this.sortRows(rows, [{ key: 'sizeK', label: '大小' }, { key: 'name', label: '名称' }, { key: 'installedAt', label: '安装时间' }, { key: 'lastUsed', label: '最后使用' }, { key: 'usageCount', label: '次数' }]);
      return rows;
    }
    if (this.tab === 'apps') {
      for (const a of this.p.apps) {
        if (!this.match(a.name)) continue;
        const candA = a.verdict === 'stale' && !a.system && !a.caskToken;
        const ad = this.p.appData?.find((x) => x.appPath === a.path || x.name === a.name);
        const candU = !!(ad && ad.verdict === 'stale' && !ad.running && !ad.system && ad.dataSizeK > 0);
        const selApp = this.selA.has(a.path);
        const selData = ad ? this.selU.has(ad.name) : false;

        // 勾选状态标记：
        //   [x]全删: 删本体 (含数据)
        //   [u]仅数: 仅清数据保留本体
        //   [ ]未选: 未选中
        let mark = C.dim + '[ ]' + C.reset;
        if (selApp) {
          mark = candA ? C.green + '[x]' + C.reset : C.yellow + '[!]' + C.reset;
        } else if (selData) {
          mark = candU ? C.cyan + '[u]' + C.reset : C.yellow + '[!]' + C.reset;
        }

        const runTag = ad?.running ? C.gray + ' 🟢' + C.reset : '';
        const nameDisplay = padTrunc(a.name + runTag, 26);
        const appSizeCell = pad(fmtKB(a.sizeK), 10);
        const dataSizeCell = pad(ad && ad.dataSizeK > 0 ? fmtKB(ad.dataSizeK) : '—', 10);
        const lastUsedCell = pad(a.lastUsed ? fmtDays(a.lastUsed) : '无记录', 9);
        const verdictCell = this.verdictCell(a.verdict);

        let desc = a.reason;
        if (selApp) {
          desc = `⚡ 将移入废纸篓卸载 App 本体${ad && ad.dataSizeK > 0 ? '（建议联动清除数据）' : ''}`;
        } else if (selData) {
          desc = `🧹 仅清除用户数据 ~${fmtKB(ad?.dataSizeK ?? 0)}，App 本体保留`;
        } else if (ad?.running) {
          desc = `🟢 运行中；数据 ~${fmtKB(ad.dataSizeK)}（需退出后清理）`;
        } else if (ad && ad.dataSizeK > 1024) {
          desc = `数据 ~${fmtKB(ad.dataSizeK)}；${a.reason}`;
        }

        rows.push({
          key: `a:${a.path}`,
          candidate: candA || candU,
          cells: [
            mark + ' ',
            nameDisplay,
            appSizeCell,
            dataSizeCell,
            lastUsedCell,
            verdictCell,
            C.gray + trunc(desc, 34) + C.reset,
          ],
          plain: `${a.name} ${fmtKB(a.sizeK)} 数据:${ad ? fmtKB(ad.dataSizeK) : '0'} ${V_PLAIN[a.verdict]} ${a.reason}`,
          sortVals: {
            name: a.name,
            sizeK: a.sizeK,
            dataSizeK: ad?.dataSizeK ?? 0,
            lastUsed: a.lastUsed ?? -1,
          },
        });
      }
      this.sortRows(rows, [
        { key: 'sizeK', label: '本体大小' },
        { key: 'dataSizeK', label: '数据大小' },
        { key: 'name', label: '名称' },
        { key: 'lastUsed', label: '最后打开' },
      ]);
      return rows;
    }
    if (this.tab === 'downloads') {
      for (const d of this.state.downloads) {
        if (!this.match(path.basename(d.file))) continue;
        rows.push({
          key: `d:${d.file}`,
          candidate: true,
          cells: [
            this.selMark(this.selD.has(d.file), true) + ' ',
            padTrunc(path.basename(d.file), 50),
            pad(fmtKB(d.sizeK), 10),
            pad(fmtDays(d.modifiedAt), 9),
            '.' + d.kind,
          ],
          plain: path.basename(d.file),
          sortVals: { name: d.file, sizeK: d.sizeK, modifiedAt: d.modifiedAt },
        });
      }
      this.sortRows(rows, [{ key: 'modifiedAt', label: '时间' }, { key: 'sizeK', label: '大小' }, { key: 'name', label: '名称' }]);
      return rows;
    }
    if (this.tab === 'projects') {
      for (const pr of this.p?.projects ?? []) {
        if (!this.match(pr.name + ' ' + pr.path)) continue;
        const cand = pr.verdict === 'stale';
        rows.push({
          key: `p:${pr.path}`,
          candidate: cand,
          cells: [
            this.selMark(this.selP.has(pr.path), cand) + ' ',
            padTrunc(pr.name + (pr.via === 'agent' ? C.gray + ' ⌘agent' + C.reset : pr.via === 'scan' ? C.gray + ' ⌕全盘' + C.reset : ''), 26),
            pad(fmtKB(pr.depSizeK), 10),
            padTrunc(pr.depNames.join('+'), 14),
            pad(pr.srcMtime ? fmtDays(pr.srcMtime) : '未知', 9),
            pad(pr.lastRun ? fmtDays(pr.lastRun) : '无', 9),
            this.verdictCell(pr.verdict),
            C.gray + trunc(pr.reason, 34) + C.reset,
          ],
          plain: `${pr.name} ${pr.path} ${V_PLAIN[pr.verdict]} ${pr.reason}`,
          sortVals: { name: pr.name, sizeK: pr.depSizeK, lastUsed: pr.lastUsed ?? -1 },
        });
      }
      this.sortRows(rows, [{ key: 'sizeK', label: '大小' }, { key: 'name', label: '名称' }, { key: 'lastUsed', label: '最近活动' }]);
      return rows;
    }
    if (this.tab === 'cache') {
      const cache = this.state?.cache;
      // 官方命令类（c/n 快捷键处理，行内展示）
      for (const d of (cache?.devCaches ?? []).filter((x) => x.safe)) {
        rows.push({
          key: `ncmd:${d.name}`,
          candidate: false,
          cells: [
            C.dim + ' ─ ' + C.reset + ' ',
            padTrunc(d.name, 24),
            pad(fmtKB(d.sizeK), 10),
            C.gray + trunc(d.cleanCmd ? `${d.cleanCmd} [n 全部清理]` : '[n 全部清理]', 58) + C.reset,
          ],
          plain: `${d.name} ${d.cleanCmd ?? ''}`,
          sortVals: {},
        });
      }
      // 可勾选大目录类（space 勾选 → d/x/yes 统一流程，移入废纸篓可恢复）
      const bigDirs: { name: string; path: string; sizeK: number; note: string }[] = [
        ...(cache?.devCaches ?? []).filter((x) => !x.safe).map((x) => ({ name: x.name, path: x.path, sizeK: x.sizeK, note: x.note ?? '删除=移入废纸篓，可恢复' })),
      ];
      if (cache && cache.libraryCachesK > 0) bigDirs.push({ name: '~/Library/Caches', path: cache.libraryCachesPath, sizeK: cache.libraryCachesK, note: '⚠️ 全部应用缓存，删后各应用首次启动变慢' });
      if (cache && cache.derivedDataK > 0) bigDirs.push({ name: 'Xcode DerivedData', path: cache.derivedDataPath, sizeK: cache.derivedDataK, note: 'Xcode 构建产物，删后下次构建全量重编' });
      for (const d of bigDirs) {
        rows.push({
          key: `x:${d.path}`,
          candidate: true,
          cells: [
            this.selMark(this.selX.has(d.path), true) + ' ',
            padTrunc(C.white + d.name + C.reset, 24),
            pad(fmtKB(d.sizeK), 10),
            C.gray + trunc(d.note, 58) + C.reset,
          ],
          plain: `${d.name} ${d.note}`,
          sortVals: { sizeK: d.sizeK, name: d.name },
        });
      }
      this.sortRows(rows, [{ key: 'sizeK', label: '大小' }]);
      return rows;
    }
    if (this.tab === 'history') {
      this.history.forEach((h, i) => {
        const t = new Date(h.time * 1000);
        const time = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')} ${t.toTimeString().slice(0, 5)}`;
        const del = (h.deleted ?? []).map((d) => d.name).join(',');
        rows.push({
          key: `h:${i}`,
          candidate: (h.deleted ?? []).some((d) => d.kind === 'formula'),
          cells: [
            C.dim + ' ↳ ' + C.reset + ' ',
            padTrunc(time, 18),
            (h.ok ? C.green : C.red) + (h.ok ? '✅ ' : '⚠️ ') + C.reset + padTrunc((h.actions ?? []).join('；') + (del ? C.reset + '' : ''), 70),
            (h.deleted ?? []).length > 0 ? C.cyan + `[回车]重装: ${trunc(del, 24)}` + C.reset : '',
          ],
          plain: `${time} ${(h.actions ?? []).join(';')} ${del}`,
          sortVals: {},
        });
      });
      return rows;
    }
    if (this.tab === 'settings') {
      const hook = hookStatus();
      const items: [string, string, string][] = [
        ['阈值天数（多久未使用→可清理）', String(this.cfg.thresholdDays), '回车修改'],
        ['宽限期天数（新装包不判定）', String(this.cfg.graceDays), '回车修改'],
        ['保护名单（永不清理）', this.cfg.protect.join(' ') || '（空）', '回车编辑（空格分隔）'],
        ['扫描 .zip 安装包', this.cfg.includeZip ? '开' : '关', '回车切换'],
        ['监控钩子 zsh/bash/fish', [hook.zsh ? '✅zsh' : '—', hook.bash ? '✅bash' : '—', hook.fish ? '✅fish' : '—'].join(' '), 'h 安装'],
        ['Brewfile 留底', fs.existsSync(path.join(DATA_DIR, 'Brewfile.backup')) ? '已导出' : '未导出', 'b 导出'],
      ];
      items.forEach(([label, value, hint], i) => {
        rows.push({
          key: `s:${i}`,
          candidate: false,
          cells: [C.dim + ' · ' + C.reset + ' ', padTrunc(label, 34), padTrunc(C.white + value + C.reset, 46), C.gray + hint + C.reset],
          plain: `${label} ${value}`,
          sortVals: {},
        });
      });
      return rows;
    }
    return rows;
  }

  /** 勾选标记：候选=绿色[x]，非候选主动勾选=黄色[!]警告 */
  private selMark(selected: boolean, cand: boolean): string {
    if (selected) return cand ? C.green + '[x]' + C.reset : C.yellow + '[!]' + C.reset;
    return C.dim + '[ ]' + C.reset;
  }

  private verdictCell(v: Verdict): string {
    return padTrunc(V_LABEL[v], 12);
  }

  private match(text: string): boolean {
    if (!this.filter) return true;
    return text.toLowerCase().includes(this.filter.toLowerCase());
  }

  private sortDefs: Record<string, { key: string; label: string }[]> = {};
  private sortRows(rows: Row[], defs: { key: string; label: string }[]): void {
    this.sortDefs[this.tab] = defs;
    const def = defs[(this.sortIdx[this.tab] ?? 0) % defs.length];
    if (!def) return;
    rows.sort((a, b) => {
      const va = a.sortVals[def.key], vb = b.sortVals[def.key];
      if (def.key === 'name') return String(va).localeCompare(String(vb));
      return (Number(vb) || 0) - (Number(va) || 0);
    });
  }

  /* ---------- 操作 ---------- */
  private buildOps(): Op[] {
    const ops: Op[] = [];
    if (this.selF.size > 0) ops.push({ type: 'uninstall-formula', names: [...this.selF] });
    if (this.selC.size > 0) ops.push({ type: 'uninstall-cask', tokens: [...this.selC] });
    if (this.selA.size > 0) ops.push({ type: 'trash-app', paths: [...this.selA] });
    if (this.selU.size > 0 && this.p) {
      const selectedPlans = this.p.appData.filter((x) => this.selU.has(x.name));
      const allPaths = selectedPlans.flatMap((x) => x.paths.map((p) => p.path));
      ops.push({ type: 'trash-app-data', names: [...this.selU], paths: allPaths });
    }
    if (this.selD.size > 0) ops.push({ type: 'trash-file', paths: [...this.selD] });
    if (this.selP.size > 0 && this.p) {
      const paths = this.p.projects.filter((x) => this.selP.has(x.path)).flatMap((x) => x.depPaths);
      if (paths.length > 0) ops.push({ type: 'trash-file', paths });
    }
    if (this.selX.size > 0) ops.push({ type: 'trash-file', paths: [...this.selX] });
    return ops;
  }

  private selTotals(): { n: number; k: number } {
    let n = 0, k = 0;
    if (!this.state || !this.p) return { n, k };
    for (const name of this.selF) { const f = this.p.formulae.find((x) => x.name === name); if (f) { k += f.sizeK; n++; } }
    for (const t of this.selC) { const c = this.p.casks.find((x) => x.token === t); if (c) { k += c.sizeK; n++; } }
    for (const p of this.selA) { const a = this.p.apps.find((x) => x.path === p); if (a) { k += a.sizeK; n++; } }
    for (const name of this.selU) { const ad = this.p.appData.find((x) => x.name === name); if (ad) { k += ad.dataSizeK; n++; } }
    for (const f of this.selD) { const d = this.state.downloads.find((x) => x.file === f); if (d) { k += d.sizeK; n++; } }
    for (const pp of this.selP) { const pr = this.p?.projects.find((x) => x.path === pp); if (pr) { k += pr.depSizeK; n++; } }
    for (const xp of this.selX) {
      const cache = this.state?.cache;
      const dev = (cache?.devCaches ?? []).find((d) => d.path === xp);
      if (dev) { k += dev.sizeK; n++; }
      else if (xp === cache?.libraryCachesPath) { k += cache.libraryCachesK ?? 0; n++; }
      else if (xp === cache?.derivedDataPath) { k += cache.derivedDataK ?? 0; n++; }
    }
    return { n, k };
  }

  private async doScan(): Promise<void> {
    this.busy = true;
    this.busyMsg = '扫描中…';
    this.logLines = [];
    try {
      const state = await runScan(this.cfg, (m) => this.log(m), (m) => { this.busyMsg = m; this.scheduleRender(); });
      this.state = state;
      this.p = plan(state, this.cfg);
      this.history = readHistory();
      this.selF.clear(); this.selC.clear(); this.selA.clear(); this.selU.clear(); this.selD.clear(); this.selP.clear(); this.selX.clear();
      this.dryPreviewed = false;
      this.mode = 'table';
      this.setStatus(`扫描完成: ${state.formulae.length} 包 / ${state.apps.length} 应用`);
    } catch (err) {
      this.setStatus(`扫描失败: ${err instanceof Error ? err.message : err}`);
    } finally {
      this.busy = false;
      this.scheduleRender();
    }
  }

  private async doRun(ops: Op[], dry: boolean, after?: () => Promise<void> | void): Promise<void> {
    this.busy = true;
    this.busyMsg = dry ? '预演中…' : '执行中…';
    this.mode = 'log';
    this.logLines = [];
    this.logFollow = true;
    this.log(`${dry ? '── Dry-run 预演开始（不会真正删除）──' : '── 真实执行清理 ──'}`);
    try {
      const results = await runOps(ops, dry, {
        log: (m) => this.log(m),
        step: (m) => this.log(C.cyan + '▶ ' + C.reset + m),
      }, dry ? this.selTotals().k : 0);
      const skipped = results.flatMap((r) => r.skipped ?? []);
      const ok = results.every((r) => r.ok);
      if (!dry) {
        appendHistory(results, skipped);
        this.log('');
        this.log(`── 执行完成（${ok ? '全部成功' : '部分失败'}）· 已写入清理历史 ──`);
        if (skipped.length > 0) this.log(C.yellow + `跳过: ${skipped.join('、')}` + C.reset);
        this.lastExecSummary = `${ok ? '✅' : '⚠️'} ${dry ? '预演' : '执行'}完成` + (skipped.length ? `，跳过 ${skipped.length} 项` : '');
        this.log(C.bold + '按 q/esc 返回列表 · 建议 r 重新扫描刷新数据' + C.reset);
        this.selF.clear(); this.selC.clear(); this.selA.clear(); this.selU.clear(); this.selD.clear(); this.selP.clear(); this.selX.clear();
        this.dryPreviewed = false;
      } else {
        this.dryPreviewed = true;
        this.log('');
        this.log(C.bold + '── 预演完成 ──' + C.reset);
        this.log(C.bold + '确认无误后按 x 并输入 yes 执行真实清理；q/esc 返回列表' + C.reset);
      }
      if (after) await after();
    } catch (err) {
      this.log(`异常: ${err instanceof Error ? err.message : err}`);
    } finally {
      this.busy = false;
      this.scheduleRender();
    }
  }

  /* ---------- 按键 ---------- */
  private onKey(key: any): void {
    if (!key) return;
    if (key.ctrl && (key.name === 'c' || key.name === 'd')) {
      this.quitNow(); return;
    }
    if (this.mode === 'help') {
      if (key.name === 'q') this.quitNow();
      else {
        this.mode = 'table';
        const numTab: Record<string, TabId> = { '1': 'brew', '2': 'apps', '3': 'downloads', '4': 'projects', '5': 'cache', '6': 'history', '7': 'settings' };
        const seq = key.sequence ?? '';
        if (numTab[seq]) { this.tab = numTab[seq]; this.cursor = 0; this.offset = 0; }
        this.render();
      }
      return;
    }
    if (this.busy && this.mode === 'log') {
      if (key.name === 'up' || key.name === 'k') { this.logFollow = false; this.scrollLog(-1); }
      else if (key.name === 'down' || key.name === 'j') { this.scrollLog(1); }
      else if (key.name === 'g') { this.logFollow = false; this.render(); }
      else if (key.name === 'q' || key.name === 'escape' || key.name === 'x' || key.name === 'r') {
        this.setStatus(`⏳ ${this.busyMsg} — 操作键已锁定，完成后自动解锁（q/Ctrl+C 退出）`);
      }
      return;
    }
    if (this.busy) {
      // 任务进行中：仅放行纯视图操作（切页/移动/排序/退出），操作键锁定防重复触发
      const seq = key.sequence ?? '';
      const nav = ['up', 'down', 'k', 'j', 'left', 'right', 'q'].includes(key.name) || seq === 'G';
      const isNum = ['1', '2', '3', '4', '5', '6', '7', '8'].includes(seq);
      const isSort = key.name === 's' && seq === 's';
      if (nav || isNum || isSort) { this.handleTableKey(key); return; }
      this.setStatus(`⏳ ${this.busyMsg} — 操作键已锁定，完成后自动解锁（q/Ctrl+C 退出）`);
      return;
    }

    if (this.mode === 'input') { this.handleInputKey(key); return; }
    if (this.mode === 'log') { this.handleLogKey(key); return; }
    this.handleTableKey(key);
  }

  private handleInputKey(key: any): void {
    const inp = this.input!;
    if (key.name === 'escape') {
      this.input = null; this.mode = 'table'; this.render(); return;
    }
    if (key.name === 'return' || key.name === 'enter') {
      const value = inp.value.trim();
      this.input = null;
      this.mode = 'table';
      this.submitInput(inp, value);
      return;
    }
    if (key.name === 'backspace') { inp.value = inp.value.slice(0, -1); this.render(); return; }
    if (key.name === 'space' && inp.purpose === 'yes') { inp.value += ' '; this.render(); return; }
    if (key.sequence && key.sequence.length === 1 && !key.ctrl && !key.meta) {
      inp.value += key.sequence;
      this.render();
    }
  }

  private submitInput(inp: InputState, value: string): void {
    if (inp.purpose === 'yes') {
      const ops = this.pendingOps ?? this.buildOps();
      this.pendingOps = null;
      if (value === 'yes') {
        if (ops.length > 0) void this.doRun(ops, false);
      } else {
        this.setStatus('已取消（未执行任何删除）');
      }
      return;
    }
    if (inp.purpose === 'search') {
      this.filter = value;
      this.cursor = 0; this.offset = 0;
      this.render(); return;
    }
    if (inp.purpose === 'number') {
      const n = parseInt(value, 10);
      if (!Number.isFinite(n) || n < 1) { this.setStatus('无效数字，保持原值'); return; }
      if (this.cursor === 0) { this.cfg.thresholdDays = n; this.saveAndReplan('阈值'); }
      else if (this.cursor === 1) { this.cfg.graceDays = n; this.saveAndReplan('宽限期'); }
      return;
    }
    if (inp.purpose === 'protect') {
      this.cfg.protect = value.split(/[\s,]+/).filter(Boolean);
      this.saveAndReplan('保护名单');
      return;
    }
    if (inp.purpose === 'text') {
      // 未用
    }
  }

  private saveAndReplan(label: string): void {
    saveConfig(this.cfg);
    if (this.state) this.p = plan(this.state, this.cfg);
    this.setStatus(`${label}已保存`);
    this.render();
  }

  private handleLogKey(key: any): void {
    if (key.name === 'q' || key.name === 'escape') { this.mode = 'table'; this.render(); return; }
    if (key.name === 'r') { void this.doScan(); return; }
    if (key.name === 'x') { this.startExecute(); return; }
    if (key.name === 'up' || key.name === 'k') { this.logFollow = false; this.scrollLog(-1); }
    else if (key.name === 'down' || key.name === 'j') this.scrollLog(1);
    else if (key.name === 'g') { this.logFollow = false; this.render(); }
    else if (key.name === 'G') { this.logFollow = true; this.render(); }
  }

  private scrollLog(delta: number): void {
    this.logFollow = this.logFollow && delta > 0;
    this.render();
  }

  private isRowSelected(row: Row): boolean {
    const [kind, ...rest] = row.key.split(':');
    const val = rest.join(':');
    return (kind === 'f' ? this.selF : kind === 'c' ? this.selC : kind === 'a' ? this.selA : kind === 'u' ? this.selU : kind === 'p' ? this.selP : kind === 'x' ? this.selX : this.selD).has(val);
  }

  private setRowSel(row: Row, sel: boolean): void {
    const [kind, ...rest] = row.key.split(':');
    const val = rest.join(':');
    const set = kind === 'f' ? this.selF : kind === 'c' ? this.selC : kind === 'a' ? this.selA : kind === 'u' ? this.selU : kind === 'p' ? this.selP : kind === 'x' ? this.selX : this.selD;
    if (sel) set.add(val); else set.delete(val);
  }

  private applyVisual(rows: Row[]): void {
    const lo = Math.min(this.visualAnchor, this.cursor);
    const hi = Math.max(this.visualAnchor, this.cursor);
    for (let i = lo; i <= hi && i < rows.length; i++) {
      if (rows[i].key.startsWith('h:') || rows[i].key.startsWith('s:')) continue; // 历史/设置行不可选
      this.setRowSel(rows[i], this.visualTarget);
    }
    this.dryPreviewed = false;
  }

  private handleTableKey(key: any): void {
    const rows = this.buildRows();
    const name = key.name as string | undefined;

    // ── visual 批量拖选模式 ──
    if (this.visual) {
      if (name === 'v' || name === 'escape' || name === 'return' || name === 'enter' || name === 'q') {
        this.visual = false;
        this.render();
        return;
      }
      let moved = false;
      if (name === 'up' || name === 'k') { this.cursor = Math.max(0, this.cursor - 1); moved = true; }
      else if (name === 'down' || name === 'j') { this.cursor = Math.min(Math.max(rows.length - 1, 0), this.cursor + 1); moved = true; }
      else if (name === 'g') { this.cursor = 0; moved = true; }
      else if (name === 'G') { this.cursor = Math.max(rows.length - 1, 0); moved = true; }
      if (moved) { this.applyVisual(rows); this.render(); }
      return;
    }

    // 数字切 tab
    const numTab: Record<string, TabId> = { '1': 'brew', '2': 'apps', '3': 'downloads', '4': 'projects', '5': 'cache', '6': 'history', '7': 'settings' };
    if (key.sequence && numTab[key.sequence]) {
      this.tab = numTab[key.sequence];
      this.cursor = 0; this.offset = 0;
      this.render(); return;
    }

    if (name === 'q') { this.quitNow(); return; }
    if (name === 'left' || name === 'right') {
      const i = this.tabs.findIndex((t) => t.id === this.tab);
      this.tab = this.tabs[(i + (name === 'right' ? 1 : this.tabs.length - 1)) % this.tabs.length].id;
      this.cursor = 0; this.offset = 0;
      this.render(); return;
    }
    if (name === 'r' && this.tab !== 'settings') { void this.doScan(); return; }
    if (name === 'up' || name === 'k') { this.cursor = Math.max(0, this.cursor - 1); this.render(); return; }
    if (name === 'down' || name === 'j') { this.cursor = Math.min(Math.max(rows.length - 1, 0), this.cursor + 1); this.render(); return; }
    if (name === 'g' && !key.shift) { this.cursor = 0; this.render(); return; }
    if (name === 'g' && (key.shift || (key.sequence ?? '') === 'G')) { this.cursor = Math.max(rows.length - 1, 0); this.render(); return; }
    if (name === '/') {
      this.mode = 'input';
      this.input = { prompt: '搜索:', value: this.filter, purpose: 'search' };
      this.render(); return;
    }
    if (name === 's') {
      this.sortIdx[this.tab] = ((this.sortIdx[this.tab] ?? 0) + 1) % (this.sortDefs[this.tab]?.length ?? 1);
      this.render(); return;
    }
    if ((key.sequence ?? '') === '?') { this.mode = 'help'; this.render(); return; }
    if (name === 'v' && rows.length > 0) {
      this.visual = true;
      this.visualAnchor = this.cursor;
      this.visualTarget = !this.isRowSelected(rows[Math.min(this.cursor, rows.length - 1)]);
      this.applyVisual(rows);
      this.render(); return;
    }
    if (name === 'u' && this.tab === 'apps' && rows.length > 0) {
      this.toggleAppDataOnly(rows); return;
    }
    if (name === 'U' && this.tab === 'apps') {
      this.selectAllAppDataCandidates(); return;
    }
    if (name === 'space' || name === 'return' || name === 'enter') {
      this.activateRow(rows); return;
    }
    const seq = key.sequence ?? '';
    if (name === 'a' && !key.shift) { this.selectAllCandidates(); return; }
    if (seq === 'A') { this.selF.clear(); this.selC.clear(); this.selA.clear(); this.selU.clear(); this.selD.clear(); this.selP.clear(); this.selX.clear(); this.dryPreviewed = false; this.render(); return; }
    if (name === 'd') { this.startDry(); return; }
    if (name === 'x') { this.startExecute(); return; }
    if (name === 'c' && this.tab === 'cache') { this.startCacheClean(); return; }
    if (name === 'n' && this.tab === 'cache') { this.startDevCacheClean(); return; }
    if (name === 'h' && this.tab === 'settings') { void this.installHookFlow(); return; }
    if (name === 'b' && this.tab === 'settings') { void this.exportBrewfile(); return; }
  }

  private activateRow(rows: Row[]): void {
    if (rows.length === 0) return;
    const row = rows[Math.min(this.cursor, rows.length - 1)];
    if (this.tab === 'history') {
      const idx = parseInt(row.key.split(':')[1], 10);
      const h = this.history[idx];
      if (!h || !(h.deleted ?? []).some((d) => d.kind === 'formula')) return;
      const names = (h.deleted ?? []).filter((d) => d.kind === 'formula').map((d) => d.name);
      this.mode = 'input';
      this.input = { prompt: `重装 ${names.join(' ')} — 输入 yes 确认:`, value: '', purpose: 'yes' };
      this.pendingOps = [{ type: 'install-formula', names }];
      this.render(); return;
    }
    if (this.tab === 'settings') {
      const i = parseInt(row.key.split(':')[1], 10);
      if (i === 0 || i === 1) {
        this.cursor = i;
        this.mode = 'input';
        this.input = { prompt: i === 0 ? '阈值天数:' : '宽限期天数:', value: String(i === 0 ? this.cfg.thresholdDays : this.cfg.graceDays), purpose: 'number' };
      } else if (i === 2) {
        this.mode = 'input';
        this.input = { prompt: '保护名单（空格分隔）:', value: this.cfg.protect.join(' '), purpose: 'protect' };
      } else if (i === 3) {
        this.cfg.includeZip = !this.cfg.includeZip;
        saveConfig(this.cfg);
        this.setStatus(this.cfg.includeZip ? '将扫描 .zip（下次扫描生效）' : '不再扫描 .zip');
      }
      this.render(); return;
    }
    // 勾选/取消（任何行均可；非候选标记 [!] 警告，执行层复核兜底）
    const [kind, ...rest] = row.key.split(':');
    const val = rest.join(':');

    // 应用页特殊三态交互：
    // 未选 [ ] → 仅清数据 [u] (若有数据) → 全卸本体 [x] → 取消 [ ]
    // 若该应用无数据，则直接 [ ] ⇄ [x]
    if (this.tab === 'apps' && kind === 'a') {
      const appPath = val;
      const app = this.p?.apps.find((x) => x.path === appPath);
      const ad = this.p?.appData.find((x) => x.appPath === appPath || (app && x.name === app.name));
      const hasData = !!(ad && ad.dataSizeK > 0);
      const selApp = this.selA.has(appPath);
      const selData = ad ? this.selU.has(ad.name) : false;

      if (!selApp && !selData) {
        // 第一击：如果有数据优先进 [u] 仅清数据；无数据直接进 [x] 卸本体
        if (hasData) {
          this.selU.add(ad.name);
          this.setStatus(`已标记仅清数据: ${ad.name} (~${fmtKB(ad.dataSizeK)})；再按切换为卸载本体`);
        } else {
          this.selA.add(appPath);
          this.setStatus(`已标记卸载本体: ${app?.name ?? appPath}`);
        }
      } else if (selData && !selApp) {
        // 第二击：从 [u] 切换到 [x] 卸载本体
        if (ad) this.selU.delete(ad.name);
        this.selA.add(appPath);
        this.setStatus(`已切换为卸载 App 本体: ${app?.name ?? appPath}`);
      } else {
        // 第三击（或已在 selApp）：彻底取消
        this.selA.delete(appPath);
        if (ad) this.selU.delete(ad.name);
        this.setStatus(`已取消选择: ${app?.name ?? appPath}`);
      }
      this.dryPreviewed = false;
      this.render();
      return;
    }

    const set = kind === 'f' ? this.selF : kind === 'c' ? this.selC : kind === 'a' ? this.selA : kind === 'u' ? this.selU : kind === 'p' ? this.selP : kind === 'x' ? this.selX : this.selD;
    if (set.has(val)) set.delete(val); else set.add(val);
    this.dryPreviewed = false;
    this.render();
  }

  /** 在应用页单按 u：直接在【仅清数据】和【未选】之间切换 */
  private toggleAppDataOnly(rows: Row[]): void {
    if (rows.length === 0) return;
    const row = rows[Math.min(this.cursor, rows.length - 1)];
    const [kind, ...rest] = row.key.split(':');
    if (kind !== 'a') return;
    const appPath = rest.join(':');
    const app = this.p?.apps.find((x) => x.path === appPath);
    const ad = this.p?.appData.find((x) => x.appPath === appPath || (app && x.name === app.name));
    if (!ad || ad.dataSizeK === 0) {
      this.setStatus(`该应用暂无关联的用户数据`);
      return;
    }
    // 互斥：清掉 selA，toggle selU
    this.selA.delete(appPath);
    if (this.selU.has(ad.name)) {
      this.selU.delete(ad.name);
      this.setStatus(`取消清除数据: ${ad.name}`);
    } else {
      this.selU.add(ad.name);
      this.setStatus(`已标记仅清数据: ${ad.name} (~${fmtKB(ad.dataSizeK)})，App 本体保留`);
    }
    this.dryPreviewed = false;
    this.render();
  }

  /** 应用页按 U：全选所有久未使用的应用用户数据候选（保留 App 本体） */
  private selectAllAppDataCandidates(): void {
    if (!this.p) return;
    let count = 0;
    for (const ad of this.p.appData) {
      if (ad.verdict === 'stale' && !ad.running && !ad.system && ad.dataSizeK > 0) {
        this.selU.add(ad.name);
        count++;
      }
    }
    this.setStatus(`已全选 ${count} 个应用的用户数据候选 (~${fmtKB(this.selTotals().k)})`);
    this.dryPreviewed = false;
    this.render();
  }

  private pendingOps: Op[] | null = null;

  private selectAllCandidates(): void {
    if (!this.state || !this.p) return;
    if (this.tab === 'brew') {
      for (const f of this.p.formulae) if (isCand(f.verdict)) this.selF.add(f.name);
      for (const c of this.p.casks) if (isCand(c.verdict)) this.selC.add(c.token);
    } else if (this.tab === 'apps') {
      // a: 优先全选待卸载 App 本体；若用户想要仅清数据可用大写 U
      for (const a of this.p.apps) if (a.verdict === 'stale' && !a.system && !a.caskToken) this.selA.add(a.path);
    } else if (this.tab === 'downloads') {
      for (const d of this.state.downloads) this.selD.add(d.file);
    } else if (this.tab === 'projects') {
      for (const pr of this.p?.projects ?? []) if (pr.verdict === 'stale') this.selP.add(pr.path);
    }
    this.dryPreviewed = false;
    this.render();
  }

  private startDry(): Promise<void> | void {
    const ops = this.buildOps();
    if (ops.length === 0) { this.setStatus('未选择任何项（空格勾选候选项）'); return; }
    void this.doRun(ops, true);
  }

  private startExecute(): void {
    const ops = this.buildOps();
    if (ops.length === 0) { this.setStatus('未选择任何项'); return; }
    if (!this.dryPreviewed) { this.setStatus(C.yellow + '请先按 d 预演并核对，再执行' + C.reset); return; }
    const { n, k } = this.selTotals();
    this.pendingOps = ops;
    this.mode = 'input';
    this.input = { prompt: `将真实删除 ${n} 项 (~${fmtKB(k)}) — 输入 yes 确认:`, value: '', purpose: 'yes' };
    this.render();
  }

  private startCacheClean(): void {
    this.pendingOps = [{ type: 'brew-cache' }];
    this.mode = 'input';
    this.input = { prompt: '执行 brew cleanup --prune=all — 输入 yes 确认:', value: '', purpose: 'yes' };
    this.render();
  }

  private startDevCacheClean(): void {
    const devs = (this.state?.cache.devCaches ?? []).filter((d) => d.safe).map((d) => d.name);
    if (devs.length === 0) { this.setStatus('未发现可清理的开发缓存'); return; }
    this.pendingOps = [{ type: 'dev-cache', names: devs }];
    this.mode = 'input';
    this.input = { prompt: `官方命令清理 ${devs.join('、')} — 输入 yes 确认:`, value: '', purpose: 'yes' };
    this.render();
  }

  private async installHookFlow(): Promise<void> {
    this.busy = true; this.busyMsg = '安装钩子…';
    this.render();
    const results = installHook(['zsh']);
    const t = await selfTestHook();
    this.busy = false;
    this.setStatus(`钩子: ${results[0].message} · 自测${t.ok ? '通过' : '失败 ' + t.detail}`);
    this.render();
  }

  private async exportBrewfile(): Promise<void> {
    this.busy = true; this.busyMsg = '导出 Brewfile…';
    this.render();
    const file = path.join(DATA_DIR, 'Brewfile.backup');
    const r = await exec('brew', ['bundle', 'dump', '--force', `--file=${file}`], { timeoutMs: 120_000 });
    this.busy = false;
    this.setStatus(r.code === 0 ? `已导出 ${file}（brew bundle --file 可恢复整套环境）` : `导出失败: ${r.stderr.slice(0, 120)}`);
    this.render();
  }

  /** 渲染锁定的表头行（带高亮、对齐与下划线） */
  private renderHeader(): string {
    const H_STYLE = C.bold + C.cyan;
    const padH = (s: string, n: number) => padTrunc(H_STYLE + s + C.reset, n);
    let cells: string[] = [];

    if (this.tab === 'brew') {
      cells = [
        '   ',
        padH('名称 / Token', 24),
        padH('大小', 10),
        padH('安装时间', 9),
        padH('最后使用', 9),
        padH('次数', 6),
        padH('判定', 12),
        padH('原因 / 说明', 36),
      ];
    } else if (this.tab === 'apps') {
      cells = [
        '   ',
        padH('应用名称', 26),
        padH('本体大小', 10),
        padH('数据大小', 10),
        padH('最后打开', 9),
        padH('判定', 12),
        padH('当前动作 / 说明', 34),
      ];
    } else if (this.tab === 'downloads') {
      cells = [
        '   ',
        padH('文件名', 50),
        padH('大小', 10),
        padH('下载时间', 9),
        padH('类型', 8),
      ];
    } else if (this.tab === 'projects') {
      cells = [
        '   ',
        padH('项目名称', 26),
        padH('依赖大小', 10),
        padH('依赖目录', 14),
        padH('修改时间', 9),
        padH('最后运行', 9),
        padH('判定', 12),
        padH('说明', 34),
      ];
    } else if (this.tab === 'cache') {
      cells = [
        '   ',
        padH('缓存项目 / 路径', 24),
        padH('大小', 10),
        padH('清理命令 / 风险提示', 58),
      ];
    } else if (this.tab === 'history') {
      cells = [
        '   ',
        padH('清理时间', 18),
        padH('清理动作与结果', 70),
        padH('快速重装', 24),
      ];
    } else if (this.tab === 'settings') {
      cells = [
        '   ',
        padH('配置项', 34),
        padH('当前值', 46),
        padH('操作提示', 20),
      ];
    }

    return ' ' + cells.join('');
  }

  /* ---------- 渲染 ---------- */
  private scheduleRender(): void {
    if (this.renderQueued) return;
    this.renderQueued = true;
    setImmediate(() => { this.renderQueued = false; this.render(); });
  }

  private render(): void {
    if (!this.running) return;
    const W = process.stdout.columns || 100;
    const H = process.stdout.rows || 30;
    const out: string[] = [];

    // 头部
    const scanTime = this.state ? `${fmtDate(this.state.scannedAt)} ${new Date(this.state.scannedAt * 1000).toTimeString().slice(0, 5)}` : '未扫描';
    const hook = hookStatus();
    out.push(C.bold + C.white + ' 🧹 SpaceFree' + C.reset + C.gray + ' · macOS 动态磁盘清理（按真实使用频率）' + C.reset + '  ' + C.gray + `扫描于 ${scanTime}` + C.reset + '  ' + (hook.zsh || hook.bash || hook.fish ? C.green + '监控:✅' + C.reset : C.yellow + '监控:未装' + C.reset));
    if (this.busy) {
      out.push(C.cyan + ` ⏳ ${this.busyMsg}` + C.reset);
    } else if (this.p) {
      const candK = this.p.summary.candidatesFormulaeK + this.p.summary.candidatesAppsK + this.p.summary.candidatesAppDataK + this.p.summary.candidatesProjectsK;
      const candN = this.p.summary.candidatesFormulae + this.p.summary.candidatesApps + this.p.summary.candidatesAppData + this.p.summary.candidatesProjects;
      out.push(` 可清理: ${C.yellow}${candN} 项 (~${fmtKB(candK)})${C.reset} · 缓存可释放 ${C.cyan}${fmtKB(this.state?.cache.brewCleanupFreedK ?? 0)}${C.reset} · 阈值 ${this.cfg.thresholdDays}天 · 宽限 ${this.cfg.graceDays}天` + (this.filter ? C.gray + ` · 过滤:"${this.filter}"` + C.reset : ''));
    } else {
      out.push(C.gray + ' 无扫描数据' + C.reset);
    }

    // tab 行
    const tabStr = this.tabs.map((t, i) => {
      const active = t.id === this.tab;
      const label = `[${i + 1}]${t.label}`;
      return active ? C.bgTab + C.white + C.bold + ` ${label} ` + C.reset : C.gray + ` ${label} ` + C.reset;
    }).join('');
    out.push(' ' + tabStr);
    // 常驻快捷键行（按模式切换内容；前缀=当前选择统计）
    let keys: string;
    const selT = this.selTotals();
    const selPart = selT.n > 0
      ? C.bold + (this.dryPreviewed ? C.green : C.yellow) + `已选 ${selT.n} 项 ~${fmtKB(selT.k)}` + (this.dryPreviewed ? ' ✓已预演' : '') + C.reset + C.gray + ' ┃ '
      : '';
    if (this.mode === 'help') keys = '任意键进入主界面 · q 退出';
    else if (this.mode === 'input') keys = 'enter 确认 · esc 取消';
    else if (this.mode === 'log') keys = this.busy
      ? 'j/k 滚动 · Ctrl+C 退出'
      : this.lastExecSummary ? 'q/esc 返回 · r 重扫刷新 · j/k 滚动'
      : this.dryPreviewed ? C.bold + 'x 输入yes执行' + C.reset + C.gray + ' · q/esc 返回 · r 重扫' : 'q/esc 返回 · r 重扫 · j/k 滚动';
    else if (this.visual) keys = C.bold + '拖选中: ↑↓/jk/G 批量勾选 · v/esc 结束' + C.reset;
    else if (this.busy) keys = '任务中: 操作键已锁定 · 1-8 切页 · j/k 移动 · q/Ctrl+C 退出';
    else if (this.tab === 'apps') keys = 'space 切换[u]清数据/[x]卸本体 · u 仅清数据 · a 全选App · U 全选数据 · / 搜索 · s 排序 · d 预演 · x 执行';
    else keys = 'space 勾选 · v 拖选 · a 全选 · / 搜索 · s 排序 · d 预演 · x 执行 · r 重扫 · ? 帮助 · q 退出';
    out.push(C.gray + ' ⌨ ' + selPart + keys + C.reset);
    out.push(C.gray + '─'.repeat(Math.max(W - 2, 20)) + C.reset);

    if (this.mode === 'help') {
      out.push('');
      out.push(C.bold + C.white + '   🧹 SpaceFree · 快捷键速查' + C.reset + C.gray + '   （按任意键进入主界面 · 之后随时按 ? 呼出 · q 退出）' + C.reset);
      out.push('');
      const section = (t: string) => out.push(C.cyan + C.bold + '   ── ' + t + ' ' + C.reset + C.gray + '─'.repeat(Math.max(W - 20 - t.length * 2, 6)) + C.reset);
      const row2 = (k: string, d: string) => out.push('     ' + C.yellow + C.bold + pad(k, 22) + C.reset + C.gray + d + C.reset);
      section('页签');
      row2('1-7 / ←→', 'Homebrew · 应用(含数据) · 下载安装包 · 项目依赖 · 缓存 · 清理历史 · 设置');
      section('浏览与选择');
      row2('↑/k  ↓/j', '上下移动光标          g / G: 跳到顶部 / 底部');
      row2('空格', '勾选/取消：常规页[x]勾选；应用页循环切换 [ ]未选 → [u]仅清数据 → [x]卸载本体');
      row2('u / U (应用页)', 'u: 快速切换【仅清数据】；U: 全选所有久未使用的应用用户数据');
      row2('v', '批量拖选（vim 风格）：进入后移动光标整批勾选/取消，再按 v 结束');
      row2('a / A', '全选候选 / 清空全部选择');
      row2('/  搜索', '输入关键字过滤（enter 结束输入，esc 返回，内容保留）');
      row2('s', '切换排序列（大小 / 名称 / 时间 …）');
      section('执行清理（安全流程）');
      row2('d', 'Dry-run 预演：只输出计划不删除，日志页实时显示安全复核过程');
      row2('x', '执行清理：需先预演；输入 yes 回车才真正删除（输错=取消）');
      row2('r', '重新扫描（约 1 分钟；任务中操作键自动锁定，完成后解锁）');
      row2('q / Ctrl+C', '彻底退出（随时，含扫描/执行中）');
      section('各页签专用键');
      row2('历史页 enter', '一键重装该条记录删除的包');
      row2('设置页 enter/h/b', '修改阈值·宽限·保护名单 / 装监控钩子 / 导出 Brewfile 留底');
      row2('缓存页 c / n', '清 brew 缓存 / 用官方命令清开发缓存（npm·pip·uv…）');
      section('标记说明');
      out.push(C.gray + '     [x] 已选卸载/删除   [u] 仅清用户数据(保留App)   [!] 非候选(警告)   [ ] 未选' + C.reset);
      out.push(C.gray + '     🔴从未使用  🟠久未使用  🟢在用  🔗被依赖  ⛔已阻止  🔵待复核' + C.reset);
      out.push('');
      if (this.busy) out.push(C.cyan + `   ⏳ ${this.busyMsg}` + C.reset);
      else if (this.state) out.push(C.gray + `   数据: 扫描于 ${fmtDate(this.state.scannedAt)}（按 r 刷新）` + C.reset);
      this.finish(out, W, H);
      return;
    }

    if (this.tab === 'apps' && this.mode === 'table') {
      out.push(`  ${C.bold}应用与数据一体化${C.reset}：${C.cyan}[u]仅清数据${C.reset}(保留本体，免卸载) · ${C.green}[x]卸载本体${C.reset} · space/u 切换 · 大写 U 全选久未使用的应用数据`);
      out.push(C.gray + '─'.repeat(Math.max(W - 2, 20)) + C.reset);
    }

    if (this.tab === 'cache' && this.mode === 'table') {
      const cache = this.state?.cache;
      out.push(`  ${C.bold}brew 缓存${C.reset}  ${fmtKB(cache?.brewCacheK ?? 0)} · cleanup 可释放 ${C.green}${fmtKB(cache?.brewCleanupFreedK ?? 0)}${C.reset}  ${C.gray}[c 清理]${C.reset}   ${C.bold}官方命令类${C.reset} ${C.gray}[n 全部清理]；下方大目录 ${C.bold}space 可勾选${C.reset} → d 预演 → x 执行（移入废纸篓可恢复）`);
      out.push(C.gray + '─'.repeat(Math.max(W - 2, 20)) + C.reset);
    }

    if (this.mode === 'log') {
      const bodyH = H - 7;
      const total = this.logLines.length;
      let start = 0;
      if (this.logFollow) start = Math.max(0, total - bodyH);
      const visible = this.logLines.slice(start, start + bodyH);
      for (const line of visible) out.push(' ' + trunc(line.replace(/\t/g, '  '), W - 2));
      while (out.length < H - 5) out.push('');
      this.finish(out, W, H);
      return;
    }

    // 表格表头（锁定固定显示）
    out.push(this.renderHeader());
    out.push(C.gray + ' ' + '┄'.repeat(Math.max(W - 4, 20)) + C.reset);

    // 表格数据行
    const rows = this.buildRows();
    const bodyH = Math.max(H - 9, 3);
    if (rows.length === 0) {
      out.push(C.gray + ' （无数据 — ' + (this.filter ? '无匹配项，esc 清除过滤' : '尚未扫描，按 r 开始') + '）' + C.reset);
    }
    if (this.cursor >= rows.length) this.cursor = Math.max(0, rows.length - 1);
    if (this.cursor < this.offset) this.offset = this.cursor;
    if (this.cursor >= this.offset + bodyH) this.offset = this.cursor - bodyH + 1;
    const visible = rows.slice(this.offset, this.offset + bodyH);
    visible.forEach((row, i) => {
      const idx = this.offset + i;
      const cursorMark = idx === this.cursor ? C.bgSel + C.white + '›' + C.reset : ' ';
      const line = row.cells.join('');
      const plainLen = dwidth(line.replace(/\x1b\[[0-9;]*m/g, ''));
      out.push(cursorMark + line + (plainLen < W - 2 ? '' : ''));
    });
    if (rows.length > 0) {
      out.push(C.gray + ` ${Math.min(this.offset + 1, rows.length)}-${Math.min(this.offset + bodyH, rows.length)}/${rows.length} 行` + (this.sortDefs[this.tab]?.length ? ` · 排序: ${this.sortDefs[this.tab][(this.sortIdx[this.tab] ?? 0) % this.sortDefs[this.tab].length].label} (s 切换)` : '') + C.reset);
    }
    this.finish(out, W, H);
  }

  private finish(out: string[], W: number, H: number): void {
    // 输入行
    if (this.mode === 'input' && this.input) {
      out.push(' ' + C.cyan + this.input.prompt + C.reset + C.white + this.input.value + '▌' + C.reset);
    }
    // 状态行
    if (this.status && Date.now() - this.statusAt < 60000) {
      out.push(' ' + C.yellow + trunc(this.status, W - 2) + C.reset);
    } else if (this.lastExecSummary && this.mode === 'log') {
      out.push(' ' + C.green + this.lastExecSummary + C.reset);
    }
    while (out.length < H - 1) out.push('');
    out.length = Math.min(out.length, H - 1);

    // 一次性写出
    let buf = '\x1b[H';
    for (let i = 0; i < out.length; i++) {
      buf += '\x1b[2K' + out[i] + '\x1b[1G' + (i < out.length - 1 ? '\x1b[1B' : '');
    }
    buf += '\x1b[0J';
    process.stdout.write(buf);
  }
}

export async function runTui(): Promise<void> {
  const tui = new Tui();
  await tui.start();
}
