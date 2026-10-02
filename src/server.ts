import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { loadConfig, saveConfig, type Config } from './config.js';
import { runScan, loadState, type ScanState } from './scanner.js';
import { plan, type PlanResult } from './plan.js';
import { runOps, type Op, type OpResult } from './cleaner.js';
import { hookStatus, installHook, uninstallHook, selfTestHook, esloggerDaemonPlist, type ShellKind } from './hook.js';
import { HISTORY_PATH, DATA_DIR, exec } from './util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(__dirname, '../web');

function describeOp(op: Op): string {
  switch (op.type) {
    case 'uninstall-formula': return `卸载 brew 包: ${op.names.join(', ')}`;
    case 'uninstall-cask': return `卸载 cask: ${op.tokens.join(', ')}`;
    case 'install-formula': return `重装 brew 包: ${op.names.join(', ')}`;
    case 'autoremove': return 'brew autoremove（清理孤儿依赖）';
    case 'brew-cache': return 'brew cleanup --prune=all（清理缓存）';
    case 'trash-app': return `应用移入废纸篓: ${op.paths.map((p) => p.split('/').pop()).join(', ')}`;
    case 'trash-file': return `文件移入废纸篓: ${op.paths.map((p) => p.split('/').pop()).join(', ')}`;
  }
}

interface DeletedItem { kind: 'formula' | 'cask'; name: string }

function appendHistory(results: OpResult[], skippedAll: string[]): void {
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
    const record = {
      time: Math.floor(Date.now() / 1000),
      ok: cleanResults.every((r) => r.ok),
      actions: cleanResults.map((r) => describeOp(r.op)),
      skipped: skippedAll,
      deleted,
    };
    fs.appendFileSync(HISTORY_PATH, JSON.stringify(record) + '\n');
  } catch { /* best effort */ }
}

function readHistory(limit = 20): unknown[] {
  try {
    const lines = fs.readFileSync(HISTORY_PATH, 'utf8').split('\n').filter(Boolean);
    return lines.slice(-limit).reverse().map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

export class Bus extends EventEmitter {
  publish(event: string, data: unknown): void {
    this.emit('message', { event, data, ts: Date.now() });
  }
  log(msg: string): void {
    this.publish('log', msg);
  }
  progress(msg: string): void {
    this.publish('progress', msg);
  }
}

interface Job {
  running: boolean;
  kind: 'scan' | 'clean';
}

export function startServer(port?: number): http.Server {
  const bus = new Bus();
  bus.setMaxListeners(100);
  const job: Job = { running: false, kind: 'scan' };

  const getPlan = (): PlanResult | null => {
    const state = loadState();
    if (!state) return null;
    return plan(state, loadConfig());
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const pathname = decodeURIComponent(url.pathname);

    // --- SSE ---
    if (pathname === '/api/events' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.flushHeaders();
      // 立即发一条注释帧，避免浏览器等待首帧
      res.write(': connected\n\n');
      const send = (msg: { event: string; data: unknown; ts: number }) => {
        res.write(`id: ${msg.ts}\nevent: ${msg.event}\ndata: ${JSON.stringify(msg.data)}\n\n`);
      };
      bus.on('message', send);
      const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
      req.on('close', () => {
        clearInterval(ping);
        bus.off('message', send);
      });
      return;
    }

    // --- static ---
    if (req.method === 'GET' && !pathname.startsWith('/api/')) {
      const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
      const file = path.normalize(path.join(WEB_ROOT, rel));
      if (!file.startsWith(WEB_ROOT)) {
        res.writeHead(403).end('forbidden');
        return;
      }
      let content: Buffer;
      try {
        content = fs.readFileSync(file);
      } catch {
        res.writeHead(404).end('not found');
        return;
      }
      const types: Record<string, string> = {
        '.html': 'text/html; charset=utf-8',
        '.js': 'text/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.svg': 'image/svg+xml',
        '.png': 'image/png',
        '.ico': 'image/x-icon',
      };
      // 开发工具页面：禁用缓存，避免旧 JS 与新 HTML 混搭导致渲染中断
      res.writeHead(200, {
        'Content-Type': types[path.extname(file)] ?? 'application/octet-stream',
        'Cache-Control': 'no-store, must-revalidate',
        'Pragma': 'no-cache',
      });
      res.end(content);
      return;
    }

    const json = (code: number, data: unknown) => {
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(data));
    };
    const readBody = (): Promise<any> =>
      new Promise((resolve) => {
        let raw = '';
        req.on('data', (c) => { raw += c; if (raw.length > 5_000_000) req.destroy(); });
        req.on('end', () => {
          try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); }
        });
      });

    try {
      // --- API ---
      if (pathname === '/api/state' && req.method === 'GET') {
        const state: ScanState | null = loadState();
        const p = getPlan();
        if (!state || !p) { json(404, { error: '尚未扫描，请先执行扫描' }); return; }
        const cfg = loadConfig();
        json(200, {
          state,
          plan: p,
          config: cfg,
          hook: hookStatus(),
          job,
        });
        return;
      }

      if (pathname === '/api/scan' && req.method === 'POST') {
        if (job.running) { json(409, { error: '已有任务在执行' }); return; }
        job.running = true; job.kind = 'scan';
        const cfg0 = loadConfig();
        runScan(cfg0, (m) => bus.log(m), (m) => bus.progress(m))
          .then((state) => {
            bus.progress('扫描完成');
            bus.publish('scan-done', { scannedAt: state.scannedAt });
          })
          .catch((err) => {
            bus.log(`扫描失败: ${err instanceof Error ? err.message : String(err)}`);
            bus.progress('扫描失败');
          })
          .finally(() => { job.running = false; });
        json(202, { ok: true, message: '扫描已开始' });
        return;
      }

      if (pathname === '/api/plan' && req.method === 'POST') {
        const body = await readBody();
        const cfg: Config = { ...loadConfig(), ...(typeof body.thresholdDays === 'number' ? { thresholdDays: body.thresholdDays } : {}) };
        const state = loadState();
        if (!state) { json(404, { error: '尚未扫描' }); return; }
        json(200, plan(state, cfg));
        return;
      }

      if (pathname === '/api/execute' && req.method === 'POST') {
        if (job.running) { json(409, { error: '已有任务在执行' }); return; }
        const body = await readBody();
        const ops = (body.ops ?? []) as Op[];
        const dry = body.dry !== false;
        if (!Array.isArray(ops) || ops.length === 0) { json(400, { error: 'ops 为空' }); return; }
        job.running = true; job.kind = 'clean';
        bus.log(`开始${dry ? '预演' : '执行'}清理（${ops.length} 组操作）`);
        runOps(ops, dry, {
          log: (m) => bus.log(m),
          step: (m) => { bus.progress(m); bus.log(m); },
        })
          .then((results) => {
            const skipped = results.flatMap((r) => r.skipped ?? []);
            if (!dry) {
              appendHistory(results, skipped);
              bus.log(`已写入清理历史 (${HISTORY_PATH})`);
            }
            bus.publish('clean-done', { dry, ok: results.every((r) => r.ok), skipped, opsCount: ops.length });
            bus.progress(dry ? '预演完成' : '清理完成');
          })
          .catch((err) => bus.log(`清理异常: ${err instanceof Error ? err.message : String(err)}`))
          .finally(() => { job.running = false; });
        json(202, { ok: true, message: dry ? '预演已开始' : '清理已开始' });
        return;
      }

      if (pathname === '/api/settings' && req.method === 'GET') {
        json(200, { config: loadConfig(), hook: hookStatus() });
        return;
      }
      if (pathname === '/api/settings' && req.method === 'POST') {
        const body = await readBody();
        const cfg = loadConfig();
        if (typeof body.thresholdDays === 'number' && body.thresholdDays >= 1) cfg.thresholdDays = Math.floor(body.thresholdDays);
        if (typeof body.graceDays === 'number' && body.graceDays >= 0) cfg.graceDays = Math.floor(body.graceDays);
        if (Array.isArray(body.protect)) cfg.protect = body.protect.filter((x: unknown) => typeof x === 'string' && x.trim()).map((x: string) => x.trim());
        if (typeof body.includeZip === 'boolean') cfg.includeZip = body.includeZip;
        saveConfig(cfg);
        json(200, { ok: true, config: cfg });
        return;
      }

      if (pathname === '/api/hook' && req.method === 'POST') {
        const body = await readBody();
        const action = body.action as string;
        if (action === 'install' || action === 'uninstall') {
          const shells: ShellKind[] = Array.isArray(body.shells) && body.shells.length > 0
            ? body.shells.filter((s: string) => ['zsh', 'bash', 'fish'].includes(s))
            : ['zsh'];
          const results = action === 'install' ? installHook(shells) : uninstallHook(shells);
          for (const r of results) bus.log(`hook ${r.shell}: ${r.message} (${r.file})`);
          if (action === 'install') {
            const test = await selfTestHook();
            bus.log(`hook 自测: ${test.ok ? '通过' : '失败'} — ${test.detail}`);
            json(200, { ok: true, results, selfTest: test });
            return;
          }
          json(200, { ok: true, results });
          return;
        }
        if (action === 'status') { json(200, hookStatus()); return; }
        json(400, { error: '未知 action' });
        return;
      }

      if (pathname === '/api/history' && req.method === 'GET') {
        json(200, readHistory());
        return;
      }

      if (pathname === '/api/export-brewfile' && req.method === 'POST') {
        const file = path.join(DATA_DIR, 'Brewfile.backup');
        const r = await exec('brew', ['bundle', 'dump', '--force', `--file=${file}`], { timeoutMs: 120_000 });
        if (r.code === 0) {
          bus.log(`Brewfile 已导出留底: ${file}`);
          json(200, { ok: true, file });
        } else {
          json(500, { error: r.stderr.slice(0, 300) });
        }
        return;
      }

      if (pathname === '/api/eslogger-plist' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8' });
        res.end(esloggerDaemonPlist());
        return;
      }

      json(404, { error: 'not found' });
    } catch (err) {
      json(500, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  const cfg = loadConfig();
  const listenPort = port ?? cfg.port;
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n  ❌ 端口 ${listenPort} 已被占用（可能已有一个 spacefree serve 在运行）。
  解决：换端口 --port ${listenPort + 1}，或先停掉旧进程：\n     lsof -ti :${listenPort} | xargs kill\n`);
    } else {
      console.error(`服务器错误: ${err.message}`);
    }
    process.exit(1);
  });
  server.listen(listenPort);
  return server;
}
