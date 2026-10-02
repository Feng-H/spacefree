import type { ScanState } from './scanner.js';
import type { ProjectEntry } from './projects.js';
import type { Config } from './config.js';

export type Verdict = 'keep' | 'unused' | 'stale' | 'needed' | 'blocked' | 'review';

export interface FormulaPlan {
  name: string;
  desc: string;
  sizeK: number;
  version: string;
  installedAt: number;
  installAgeDays: number | null;
  onRequest: boolean;
  deprecated: boolean;
  pinned: boolean;
  usedBy: string[];
  usedByCasks: string[];
  usageCount: number;
  lastUsed: number | null;
  lastUsedDaysAgo: number | null;
  verdict: Verdict;
  reason: string;
}

export interface CaskPlan {
  token: string;
  title: string;
  sizeK: number;
  installedAt: number;
  lastUsed: number | null;
  lastUsedDaysAgo: number | null;
  useCount: number | null;
  appPath: string | null;
  verdict: Verdict;
  reason: string;
}

export interface AppPlan {
  name: string;
  path: string;
  sizeK: number;
  lastUsed: number | null;
  lastUsedDaysAgo: number | null;
  useCount: number | null;
  system: boolean;
  caskToken: string | null;
  verdict: Verdict;
  reason: string;
}

export interface ProjectPlan {
  name: string;
  path: string;
  via: 'roots' | 'agent';
  depSizeK: number;
  depPaths: string[];
  depNames: string[];
  srcMtime: number | null;
  lastRun: number | null;
  lastUsed: number | null;
  lastUsedDaysAgo: number | null;
  verdict: Verdict;
  reason: string;
}

export interface PlanResult {
  generatedAt: number;
  thresholdDays: number;
  graceDays: number;
  formulae: FormulaPlan[];
  casks: CaskPlan[];
  apps: AppPlan[];
  projects: ProjectPlan[];
  summary: {
    candidatesFormulae: number;
    candidatesFormulaeK: number;
    candidatesApps: number;
    candidatesAppsK: number;
    candidatesProjects: number;
    candidatesProjectsK: number;
    blocked: number;
    needed: number;
    kept: number;
    review: number;
  };
}

export function plan(state: ScanState, cfg: Config): PlanResult {
  const now = Date.now() / 1000;
  const thresholdDays = cfg.thresholdDays;
  const graceDays = cfg.graceDays;
  const protect = new Set(cfg.protect);
  const running = new Set(state.running);
  const services = new Set(state.services);
  const usageMap = state.usage.formulae;

  const summary = {
    candidatesFormulae: 0,
    candidatesFormulaeK: 0,
    candidatesApps: 0,
    candidatesAppsK: 0,
    candidatesProjects: 0,
    candidatesProjectsK: 0,
    blocked: 0,
    needed: 0,
    kept: 0,
    review: 0,
  };

  const formulae: FormulaPlan[] = state.formulae.map((f) => {
    const usage = usageMap[f.name] ?? { count: 0, lastT: null };
    const installAgeDays = f.installedAt ? (now - f.installedAt) / 86400 : null;
    const lastUsedDaysAgo = usage.lastT != null ? (now - usage.lastT) / 86400 : null;

    let verdict: Verdict = 'keep';
    let reason = '';

    const usedByAll = [...f.usedBy, ...f.usedByCasks];

    if (running.has(f.name)) {
      verdict = 'blocked'; reason = '当前有进程正在运行';
    } else if (services.has(f.name)) {
      verdict = 'blocked'; reason = 'brew services 后台服务运行中';
    } else if (protect.has(f.name)) {
      verdict = 'blocked'; reason = '保护名单（设置中可修改）';
    } else if (f.pinned) {
      verdict = 'blocked'; reason = '已被 brew pin 固定版本';
    } else if (usedByAll.length > 0) {
      verdict = 'needed';
      reason = `被依赖: ${usedByAll.slice(0, 5).join(', ')}${usedByAll.length > 5 ? ` 等 ${usedByAll.length} 个` : ''}`;
    } else if (usage.count > 0 && usage.lastT != null) {
      if (lastUsedDaysAgo! > thresholdDays) {
        verdict = 'stale'; reason = `最近一次使用在 ${Math.round(lastUsedDaysAgo!)} 天前（阈值 ${thresholdDays} 天）`;
      } else {
        verdict = 'keep'; reason = `${usage.lastT != null && lastUsedDaysAgo! < 1 ? '今天仍在使用' : `最近 ${Math.round(lastUsedDaysAgo!)} 天内使用过`}，共 ${usage.count} 次`;
      }
    } else if (usage.count > 0 && usage.lastT == null) {
      verdict = 'review'; reason = `历史记录中用过 ${usage.count} 次，但历史无时间戳，无法确定最近使用时间`;
    } else if (installAgeDays != null && installAgeDays < graceDays) {
      verdict = 'review'; reason = `安装仅 ${Math.round(installAgeDays)} 天（宽限期 ${graceDays} 天），数据不足`;
    } else {
      // never used per available evidence
      verdict = 'unused';
      reason = f.onRequest
        ? `主动安装后从未记录到使用（已装 ${installAgeDays != null ? Math.round(installAgeDays) : '?'} 天）`
        : `作为依赖安装、现在无任何包依赖它且从未使用（孤儿依赖）`;
    }

    if (verdict === 'unused' || verdict === 'stale') {
      summary.candidatesFormulae += 1;
      summary.candidatesFormulaeK += f.sizeK;
    } else if (verdict === 'blocked') summary.blocked += 1;
    else if (verdict === 'needed') summary.needed += 1;
    else if (verdict === 'review') summary.review += 1;
    else summary.kept += 1;

    return {
      name: f.name,
      desc: f.desc,
      sizeK: f.sizeK,
      version: f.version,
      installedAt: f.installedAt,
      installAgeDays,
      onRequest: f.onRequest,
      deprecated: f.deprecated,
      pinned: f.pinned,
      usedBy: f.usedBy,
      usedByCasks: f.usedByCasks,
      usageCount: usage.count,
      lastUsed: usage.lastT,
      lastUsedDaysAgo,
      verdict,
      reason,
    };
  });

  // Apps & casks share verdict logic based on Spotlight lastUsed
  const appByPath = new Map(state.apps.map((a) => [a.path, a]));
  const caskTokenToApp = new Map<string, string | null>();
  for (const a of state.apps) if (a.caskToken) caskTokenToApp.set(a.caskToken, a.path);

  const casks: CaskPlan[] = state.casks.map((c) => {
    const appPath = caskTokenToApp.get(c.token) ?? null;
    const app = appPath ? appByPath.get(appPath) : undefined;
    const lastUsed = app?.lastUsed ?? null;
    const lastUsedDaysAgo = lastUsed != null ? (now - lastUsed) / 86400 : null;
    let verdict: Verdict = 'review';
    let reason = '';
    if (!app) {
      if (c.token.startsWith('font-')) {
        verdict = 'review'; reason = '字体类 cask（安装于 ~/Library/Fonts），请手动判断是否在用';
      } else {
        verdict = 'stale';
        reason = '对应 .app 不存在（可能已手动删除），卸载可清除残留元数据';
      }
    } else if (app.name.startsWith('QL')) {
      verdict = 'review'; reason = 'QuickLook 扩展由系统自动调用，使用时间不代表真实调用，谨慎处理';
    } else if (lastUsed == null) {
      verdict = 'review'; reason = 'Spotlight 无使用记录（可能从未打开）';
    } else if (lastUsedDaysAgo! > thresholdDays) {
      verdict = 'stale'; reason = `最近一次打开在 ${Math.round(lastUsedDaysAgo!)} 天前`;
    } else {
      verdict = 'keep'; reason = `最近 ${Math.round(lastUsedDaysAgo!)} 天内使用过`;
    }
    return {
      token: c.token,
      title: c.title,
      sizeK: app?.sizeK || c.sizeK,
      installedAt: c.installedAt,
      lastUsed,
      lastUsedDaysAgo,
      useCount: app?.useCount ?? null,
      appPath,
      verdict,
      reason,
    };
  });

  const apps: AppPlan[] = state.apps.map((a) => {
    const lastUsedDaysAgo = a.lastUsed != null ? (now - a.lastUsed) / 86400 : null;
    let verdict: Verdict = 'review';
    let reason = '';
    if (a.system) {
      verdict = 'blocked'; reason = '系统自带应用';
    } else if (a.caskToken) {
      verdict = 'review'; reason = `由 brew cask 管理（${a.caskToken}），请在 Homebrew 页处理`;
    } else if (a.name.startsWith('QL')) {
      verdict = 'review'; reason = 'QuickLook 扩展由系统自动调用，谨慎处理';
    } else if (a.lastUsed == null) {
      verdict = 'review'; reason = 'Spotlight 无使用记录（可能从未打开）';
    } else if (lastUsedDaysAgo! > thresholdDays) {
      verdict = 'stale'; reason = `最近一次打开在 ${Math.round(lastUsedDaysAgo!)} 天前`;
    } else {
      verdict = 'keep'; reason = `最近 ${Math.round(lastUsedDaysAgo!)} 天内使用过`;
    }
    if (verdict === 'stale' && !a.system && !a.caskToken) {
      summary.candidatesApps += 1;
      summary.candidatesAppsK += a.sizeK;
    }
    return {
      name: a.name,
      path: a.path,
      sizeK: a.sizeK,
      lastUsed: a.lastUsed,
      lastUsedDaysAgo,
      useCount: a.useCount,
      system: a.system,
      caskToken: a.caskToken,
      verdict,
      reason,
    };
  });

  // 项目依赖目录（node_modules 等）：源码保留，仅依赖可重建
  const projects: ProjectPlan[] = (state.projects ?? []).map((p) => {
    const lastUsedDaysAgo = p.lastUsed != null ? (now - p.lastUsed) / 86400 : null;
    let verdict: Verdict = 'review';
    let reason = '';
    if (p.lastUsed == null) {
      verdict = 'review'; reason = '无使用数据（源码时间与命令记录均缺失）';
    } else if (lastUsedDaysAgo! > thresholdDays) {
      verdict = 'stale';
      reason = `${Math.round(lastUsedDaysAgo!)} 天未动过（源码 ${fmtAge(p.srcMtime)}${p.lastRun ? `，最近命令 ${fmtAge(p.lastRun)}` : '，无命令记录'}）；删除仅依赖，源码保留，需要时 npm install 重建`;
    } else {
      verdict = 'keep';
      reason = `最近 ${Math.round(lastUsedDaysAgo!)} 天内有活动（${p.lastRun && (!p.srcMtime || p.lastRun > p.srcMtime) ? '命令执行' : '源码修改'}）`;
    }
    if (verdict === 'stale') {
      summary.candidatesProjects += 1;
      summary.candidatesProjectsK += p.depSizeK;
    }
    return {
      name: p.name,
      path: p.path,
      via: p.via ?? 'roots',
      depSizeK: p.depSizeK,
      depPaths: p.depDirs.map((d) => d.path),
      depNames: p.depDirs.map((d) => d.name),
      srcMtime: p.srcMtime,
      lastRun: p.lastRun,
      lastUsed: p.lastUsed,
      lastUsedDaysAgo,
      verdict,
      reason,
    };
  });

  return {
    generatedAt: Math.floor(now),
    thresholdDays,
    graceDays,
    formulae,
    casks,
    apps,
    projects,
    summary,
  };
}

function fmtAge(ts: number | null): string {
  if (ts == null) return '未知';
  const d = (Date.now() / 1000 - ts) / 86400;
  if (d < 1) return '今天有更新';
  return `${Math.round(d)} 天前有更新`;
}
