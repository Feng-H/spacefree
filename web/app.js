/* SpaceFree Web 仪表盘 */
'use strict';

const $ = (id) => document.getElementById(id);
const state = {
  data: null,          // { state, plan, config, hook, job }
  tab: 'brew',
  selFormulae: new Set(),
  selCasks: new Set(),
  selApps: new Set(),
  selDownloads: new Set(),
  dryPreviewed: false,
  sort: { brew: { key: 'sizeK', dir: -1 }, apps: { key: 'sizeK', dir: -1 }, dl: { key: 'modifiedAt', dir: -1 } },
};

/* ---------- helpers ---------- */
function fmtKB(kb) {
  if (kb == null || Number.isNaN(kb)) return '—';
  if (kb < 1024) return `${Math.round(kb)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return mb >= 100 ? `${Math.round(mb)} MB` : `${mb.toFixed(1)} MB`;
  const gb = mb / 1024;
  return gb >= 100 ? `${gb.toFixed(0)} GB` : `${gb.toFixed(1)} GB`;
}
function fmtDaysAgo(ts) {
  if (ts == null) return '从未记录';
  const d = (Date.now() / 1000 - ts) / 86400;
  if (d < 1) return '今天';
  if (d < 60) return `${Math.round(d)} 天前`;
  if (d < 365) return `${Math.round(d / 30)} 个月前`;
  return `${(d / 365).toFixed(1)} 年前`;
}
function fmtDate(ts) {
  if (!ts) return '—';
  const d = new Date(ts * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const VERDICT_LABEL = {
  unused: '从未使用', stale: '久未使用', keep: '在用', needed: '被依赖',
  blocked: '已阻止', review: '待复核', cand: '可清理',
};

/* ---------- data loading ---------- */
async function loadAll() {
  try {
    const r = await fetch('/api/state');
    if (r.status === 404) { showEmpty(); return; }
    state.data = await r.json();
    state.dryPreviewed = false;
    render();
  } catch (e) {
    console.error(e);
  }
}

function showEmpty() {
  $('empty').hidden = false;
  $('main').hidden = true;
  $('chip-scan').textContent = '未扫描';
}

/* ---------- render ---------- */
function render() {
  if (!state.data) return;
  const { plan: p, state: s, config: cfg, hook } = state.data;
  $('empty').hidden = true;
  $('main').hidden = false;
  $('chip-scan').textContent = `扫描于 ${fmtDate(s.scannedAt)} ${new Date(s.scannedAt * 1000).toTimeString().slice(0, 5)}`;
  const hookOn = hook.zsh || hook.bash || hook.fish;
  const chipHook = $('chip-hook');
  chipHook.textContent = hookOn ? `监控: 已开启 (${['zsh', 'bash', 'fish'].filter((k) => hook[k]).join('/')})` : '监控: 未安装';
  chipHook.className = `chip${hookOn ? ' on' : ''}`;

  $('card-brew').textContent = `${p.summary.candidatesFormulae} / ${p.formulae.length}`;
  $('card-apps').textContent = `${p.summary.candidatesApps} / ${s.apps.length}`;
  $('card-cache').textContent = fmtKB(s.cache.brewCleanupFreedK ?? s.cache.brewCacheK);
  $('card-downloads').textContent = `${s.downloads.length} 个 (${fmtKB(s.downloads.reduce((a, b) => a + b.sizeK, 0))})`;
  const totalK = p.summary.candidatesFormulaeK + p.summary.candidatesAppsK + (s.cache.brewCleanupFreedK ?? 0) + s.downloads.reduce((a, b) => a + b.sizeK, 0);
  $('card-total').textContent = fmtKB(totalK);

  $('days').value = p.thresholdDays;
  $('cache-info').innerHTML = `brew 下载缓存当前占用 <b>${fmtKB(s.cache.brewCacheK)}</b>；执行 cleanup --prune=all 预计释放 <b>${fmtKB(s.cache.brewCleanupFreedK)}</b>（删除旧版本下载文件，安全）。`;

  renderBrew();
  renderCasks();
  renderApps();
  renderDownloads();
  renderSettings();
  renderActionBar();
}

function renderBrew() {
  const { plan: p } = state.data;
  const tbody = $('brew-table').querySelector('tbody');
  const q = ($('brew-search').value || '').toLowerCase();
  const filter = $('brew-filter').value;
  let rows = p.formulae.slice();
  if (q) rows = rows.filter((f) => f.name.toLowerCase().includes(q) || (f.desc || '').toLowerCase().includes(q));
  if (filter === 'cand') rows = rows.filter((f) => f.verdict === 'unused' || f.verdict === 'stale');
  else if (filter !== 'all') rows = rows.filter((f) => f.verdict === filter);
  const { key, dir } = state.sort.brew;
  rows.sort((a, b) => {
    const va = a[key] ?? -1, vb = b[key] ?? -1;
    return (typeof va === 'string' ? va.localeCompare(vb) : va - vb) * dir;
  });
  tbody.innerHTML = rows.map((f) => {
    const cand = f.verdict === 'unused' || f.verdict === 'stale';
    const checked = state.selFormulae.has(f.name);
    return `<tr class="${cand ? '' : 'disabled'} ${checked ? 'selected' : ''}" data-name="${esc(f.name)}">
      <td class="w-check"><input type="checkbox" ${checked ? 'checked' : ''} ${cand ? '' : 'disabled'} data-sel="${esc(f.name)}"></td>
      <td><div class="pkg-name">${esc(f.name)}</div><div class="pkg-desc" title="${esc(f.desc)}">${esc(f.desc)}</div></td>
      <td class="num">${fmtKB(f.sizeK)}</td>
      <td>${fmtDate(f.installedAt)}</td>
      <td>${f.lastUsed ? fmtDaysAgo(f.lastUsed) : '<span class="muted">从未记录</span>'}</td>
      <td class="num">${f.usageCount || 0}</td>
      <td><span class="badge ${f.verdict}">${VERDICT_LABEL[f.verdict]}</span> <span class="muted">${esc(f.reason)}</span></td>
    </tr>`;
  }).join('');
  tbody.querySelectorAll('input[data-sel]').forEach((el) => {
    el.addEventListener('change', () => {
      const name = el.dataset.sel;
      if (el.checked) state.selFormulae.add(name); else state.selFormulae.delete(name);
      state.dryPreviewed = false;
      el.closest('tr').classList.toggle('selected', el.checked);
      renderActionBar();
    });
  });
}

function renderCasks() {
  const { plan: p } = state.data;
  const tbody = $('cask-table').querySelector('tbody');
  const q = ($('brew-search').value || '').toLowerCase();
  let rows = p.casks.slice();
  if (q) rows = rows.filter((c) => c.token.toLowerCase().includes(q) || c.title.toLowerCase().includes(q));
  rows.sort((a, b) => (b.sizeK ?? -1) - (a.sizeK ?? -1));
  tbody.innerHTML = rows.map((c) => {
    const cand = c.verdict === 'stale';
    const checked = state.selCasks.has(c.token);
    return `<tr class="${cand ? '' : 'disabled'} ${checked ? 'selected' : ''}">
      <td class="w-check"><input type="checkbox" ${checked ? 'checked' : ''} ${cand ? '' : 'disabled'} data-cask="${esc(c.token)}"></td>
      <td><div class="pkg-name">${esc(c.token)}</div><div class="pkg-desc">${esc(c.title)}</div></td>
      <td class="num">${fmtKB(c.sizeK)}</td>
      <td>${fmtDate(c.installedAt)}</td>
      <td>${c.lastUsed ? fmtDaysAgo(c.lastUsed) : '<span class="muted">无记录</span>'}</td>
      <td class="num">${c.useCount ?? '—'}</td>
      <td><span class="badge ${c.verdict}">${VERDICT_LABEL[c.verdict]}</span> <span class="muted">${esc(c.reason)}</span></td>
    </tr>`;
  }).join('');
  tbody.querySelectorAll('input[data-cask]').forEach((el) => {
    el.addEventListener('change', () => {
      const t = el.dataset.cask;
      if (el.checked) state.selCasks.add(t); else state.selCasks.delete(t);
      state.dryPreviewed = false;
      el.closest('tr').classList.toggle('selected', el.checked);
      renderActionBar();
    });
  });
}

function renderApps() {
  const { plan: p } = state.data;
  const tbody = $('app-table').querySelector('tbody');
  const q = ($('app-search').value || '').toLowerCase();
  const filter = $('app-filter').value;
  let rows = p.apps.slice();
  if (q) rows = rows.filter((a) => a.name.toLowerCase().includes(q));
  if (filter !== 'all') rows = rows.filter((a) => a.verdict === filter);
  const { key, dir } = state.sort.apps;
  rows.sort((a, b) => {
    const va = a[key] ?? -1, vb = b[key] ?? -1;
    return (typeof va === 'string' ? va.localeCompare(vb) : va - vb) * dir;
  });
  tbody.innerHTML = rows.map((a) => {
    const cand = a.verdict === 'stale';
    const checked = state.selApps.has(a.path);
    return `<tr class="${cand ? '' : 'disabled'} ${checked ? 'selected' : ''}">
      <td class="w-check"><input type="checkbox" ${checked ? 'checked' : ''} ${cand ? '' : 'disabled'} data-app="${esc(a.path)}"></td>
      <td>${esc(a.name)}${a.caskToken ? ` <span class="badge needed">cask:${esc(a.caskToken)}</span>` : ''}</td>
      <td class="num">${fmtKB(a.sizeK)}</td>
      <td>${a.lastUsed ? fmtDaysAgo(a.lastUsed) : '<span class="muted">无记录</span>'}</td>
      <td class="num">${a.useCount ?? '—'}</td>
      <td><span class="badge ${a.verdict}">${VERDICT_LABEL[a.verdict]}</span> <span class="muted">${esc(a.reason)}</span></td>
    </tr>`;
  }).join('');
  tbody.querySelectorAll('input[data-app]').forEach((el) => {
    el.addEventListener('change', () => {
      const path = el.dataset.app;
      if (el.checked) state.selApps.add(path); else state.selApps.delete(path);
      state.dryPreviewed = false;
      el.closest('tr').classList.toggle('selected', el.checked);
      renderActionBar();
    });
  });
}

function renderDownloads() {
  const { state: s } = state.data;
  const tbody = $('dl-table').querySelector('tbody');
  const rows = s.downloads.slice();
  const { key, dir } = state.sort.dl;
  rows.sort((a, b) => {
    const va = a[key] ?? -1, vb = b[key] ?? -1;
    return (typeof va === 'string' ? va.localeCompare(vb) : va - vb) * dir;
  });
  tbody.innerHTML = rows.map((d) => {
    const checked = state.selDownloads.has(d.file);
    return `<tr class="${checked ? 'selected' : ''}">
      <td class="w-check"><input type="checkbox" ${checked ? 'checked' : ''} data-dl="${esc(d.file)}"></td>
      <td title="${esc(d.file)}">${esc(d.file.split('/').pop())}</td>
      <td class="num">${fmtKB(d.sizeK)}</td>
      <td>${fmtDaysAgo(d.modifiedAt)} (${fmtDate(d.modifiedAt)})</td>
      <td>.${d.kind}</td>
    </tr>`;
  }).join('');
  tbody.querySelectorAll('input[data-dl]').forEach((el) => {
    el.addEventListener('change', () => {
      const f = el.dataset.dl;
      if (el.checked) state.selDownloads.add(f); else state.selDownloads.delete(f);
      state.dryPreviewed = false;
      el.closest('tr').classList.toggle('selected', el.checked);
      renderActionBar();
    });
  });
}

function renderSettings() {
  const { config: cfg, hook, state: s } = state.data;
  $('set-days').value = cfg.thresholdDays;
  $('set-grace').value = cfg.graceDays;
  $('set-protect').value = cfg.protect.join('\n');
  $('set-zip').checked = !!cfg.includeZip;
  $('hook-status').innerHTML = ['zsh', 'bash', 'fish']
    .map((k) => `${k}: ${hook[k] ? '✅ 已安装' : '— 未安装'}`)
    .join(' &nbsp;·&nbsp; ');
  $('usage-summary').innerHTML = (s.usage.sourcesNote || []).map(esc).join('<br>');
}

/* ---------- action bar & ops ---------- */
function buildOps() {
  const ops = [];
  if (state.selFormulae.size > 0) ops.push({ type: 'uninstall-formula', names: [...state.selFormulae] });
  if (state.selCasks.size > 0) ops.push({ type: 'uninstall-cask', tokens: [...state.selCasks] });
  if (state.selApps.size > 0) ops.push({ type: 'trash-app', paths: [...state.selApps] });
  if (state.selDownloads.size > 0) ops.push({ type: 'trash-file', paths: [...state.selDownloads] });
  return ops;
}
function selTotals() {
  const { plan: p, state: s } = state.data;
  let k = 0, n = 0;
  for (const name of state.selFormulae) {
    const f = p.formulae.find((x) => x.name === name);
    if (f) { k += f.sizeK; n += 1; }
  }
  for (const t of state.selCasks) {
    const c = p.casks.find((x) => x.token === t);
    if (c) { k += c.sizeK; n += 1; }
  }
  for (const path of state.selApps) {
    const a = s.apps.find((x) => x.path === path);
    if (a) { k += a.sizeK; n += 1; }
  }
  for (const f of state.selDownloads) {
    const d = s.downloads.find((x) => x.file === f);
    if (d) { k += d.sizeK; n += 1; }
  }
  return { n, k };
}
function renderActionBar() {
  const { n, k } = selTotals();
  const bar = $('action-bar');
  if (n === 0) {
    bar.hidden = true;
    $('btn-execute').hidden = true;
    return;
  }
  bar.hidden = false;
  $('sel-info').textContent = `已选 ${n} 项 · 约 ${fmtKB(k)}`;
  $('btn-execute').hidden = !state.dryPreviewed;
  $('btn-preview').hidden = state.dryPreviewed;
}

async function preview() {
  const ops = buildOps();
  if (ops.length === 0) return;
  const names = [...state.selFormulae];
  const body = { ops, dry: true };
  const r = await fetch('/api/execute', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (r.status === 202) {
    appendLog('── Dry-run 预演开始，完成后请在日志页核对，再点"确认执行" ──', 'ok');
    switchTab('log');
    state.dryPreviewed = true;
    renderActionBar();
  } else {
    const j = await r.json().catch(() => ({}));
    alert(j.error ?? '预演失败');
  }
}

async function executeReal() {
  const ops = buildOps();
  if (ops.length === 0) return;
  const names = [...state.selFormulae];
  const apps = [...state.selApps];
  const files = [...state.selDownloads];
  const body = { ops, dry: false };
  const r = await fetch('/api/execute', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (r.status === 202) {
    appendLog('── 正式执行清理 ──', 'ok');
    switchTab('log');
    state.dryPreviewed = false;
    state.selFormulae.clear(); state.selCasks.clear(); state.selApps.clear(); state.selDownloads.clear();
    renderActionBar();
  } else {
    const j = await r.json().catch(() => ({}));
    alert(j.error ?? '执行失败');
  }
}

/* ---------- log / SSE ---------- */
function appendLog(msg, cls) {
  const el = $('log');
  const time = new Date().toTimeString().slice(0, 8);
  const line = document.createElement('div');
  line.innerHTML = `<span class="t">${time}</span><span class="${cls ?? ''}">${esc(msg)}</span>`;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
}
function connectSSE() {
  const es = new EventSource('/api/events');
  es.addEventListener('log', (e) => appendLog(JSON.parse(e.data)));
  es.addEventListener('progress', (e) => {
    const msg = JSON.parse(e.data);
    $('progress-wrap').hidden = !msg || msg === '扫描完成' ? msg === '扫描完成' ? false : !msg : false;
    if (msg) {
      $('progress-text').textContent = msg;
      const fill = $('progress-fill');
      const p = Math.min(92, (parseFloat(fill.style.width) || 5) + 9);
      fill.style.width = `${p}%`;
    }
  });
  es.addEventListener('scan-done', () => {
    $('progress-fill').style.width = '100%';
    setTimeout(() => { $('progress-wrap').hidden = true; $('progress-fill').style.width = '0%'; }, 800);
    appendLog('── 扫描完成，刷新数据 ──', 'ok');
    loadAll();
  });
  es.addEventListener('clean-done', (e) => {
    const d = JSON.parse(e.data);
    appendLog(d.dry ? '── 预演完成 ──' : `── 清理完成 (${d.ok ? '成功' : '部分失败'})，建议重新扫描 ──`, d.ok ? 'ok' : 'err');
    if (!d.dry) setTimeout(() => scan(), 1500);
  });
}

/* ---------- actions ---------- */
async function scan() {
  const r = await fetch('/api/scan', { method: 'POST' });
  if (r.status === 202) {
    $('progress-wrap').hidden = false;
    $('progress-fill').style.width = '5%';
    appendLog('── 开始扫描 ──');
  } else {
    const j = await r.json().catch(() => ({}));
    appendLog(`扫描启动失败: ${j.error ?? r.status}`, 'err');
  }
}
async function replan() {
  const days = parseInt($('days').value, 10);
  if (!Number.isFinite(days) || days < 1) return;
  const r = await fetch('/api/plan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ thresholdDays: days }) });
  if (r.ok) {
    const p = await r.json();
    state.data.plan = p;
    state.data.config.thresholdDays = days;
    state.selFormulae.clear();
    state.selCasks.clear();
    render();
  }
}
async function hookAction(action) {
  const r = await fetch('/api/hook', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, shells: ['zsh'] }),
  });
  const j = await r.json().catch(() => ({}));
  if (j.selfTest) appendLog(`钩子自测: ${j.selfTest.ok ? '✅' : '❌'} ${j.selfTest.detail}`, j.selfTest.ok ? 'ok' : 'err');
  loadAll();
}

/* ---------- tabs ---------- */
function switchTab(tab) {
  state.tab = tab;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
  document.querySelectorAll('.panel').forEach((p) => { p.hidden = p.id !== `panel-${tab}`; });
}

/* ---------- wire up ---------- */
document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));
  document.querySelectorAll('th.sortable').forEach((th) => {
    th.addEventListener('click', () => {
      const tableId = th.closest('table').id;
      const key = th.dataset.sort;
      const sortKey = tableId === 'brew-table' ? 'brew' : tableId === 'cask-table' ? 'cask' : tableId === 'app-table' ? 'apps' : 'dl';
      const s = state.sort[sortKey] ?? { key: 'sizeK', dir: -1 };
      state.sort[sortKey] = s;
      if (s.key === key) s.dir *= -1; else { s.key = key; s.dir = -1; }
      document.querySelectorAll(`#${tableId} th.sortable`).forEach((h) => h.classList.remove('sorted-asc', 'sorted-desc'));
      th.classList.add(s.dir === 1 ? 'sorted-asc' : 'sorted-desc');
      if (sortKey === 'brew') renderBrew(); else if (sortKey === 'cask') renderCasks(); else if (sortKey === 'apps') renderApps(); else renderDownloads();
    });
  });
  $('btn-rescan').addEventListener('click', scan);
  $('btn-first-scan').addEventListener('click', scan);
  $('btn-empty-scan').addEventListener('click', scan);
  $('brew-search').addEventListener('input', () => { renderBrew(); renderCasks(); });
  $('brew-filter').addEventListener('change', renderBrew);
  $('app-search').addEventListener('input', renderApps);
  $('app-filter').addEventListener('change', renderApps);
  $('days').addEventListener('change', replan);
  $('btn-select-cand').addEventListener('click', () => {
    const { plan: p } = state.data;
    for (const f of p.formulae) if (f.verdict === 'unused' || f.verdict === 'stale') state.selFormulae.add(f.name);
    for (const c of p.casks) if (c.verdict === 'stale') state.selCasks.add(c.token);
    state.dryPreviewed = false;
    renderBrew(); renderCasks(); renderActionBar();
  });
  $('btn-select-apps').addEventListener('click', () => {
    const { plan: p } = state.data;
    for (const a of p.apps) if (a.verdict === 'stale') state.selApps.add(a.path);
    state.dryPreviewed = false;
    renderApps(); renderActionBar();
  });
  $('btn-select-downloads').addEventListener('click', () => {
    const { state: s } = state.data;
    for (const d of s.downloads) state.selDownloads.add(d.file);
    state.dryPreviewed = false;
    renderDownloads(); renderActionBar();
  });
  $('btn-clear-sel').addEventListener('click', () => {
    state.selFormulae.clear(); state.selCasks.clear(); state.selApps.clear(); state.selDownloads.clear();
    state.dryPreviewed = false;
    render(); renderActionBar();
  });
  $('btn-preview').addEventListener('click', preview);
  $('btn-execute').addEventListener('click', () => {
    const { n, k } = selTotals();
    showModal(
      '确认执行清理',
      `<p>即将<b>真正执行</b>以下操作（建议先 Dry-run 预演并核对日志）：</p>
       <div class="ops-list">${[...state.selFormulae].map((n) => '[brew 卸载] ' + esc(n)).join('\n')}${[...state.selCasks].map((n) => '\n[cask 卸载] ' + esc(n)).join('')}${[...state.selApps].map((n) => '\n[移入废纸篓] ' + esc(n)).join('')}${[...state.selDownloads].map((n) => '\n[移入废纸篓] ' + esc(n)).join('')}</div>
       <p>共 ${n} 项，约 ${fmtKB(k)}。brew 卸载后 autoremove 可清孤儿依赖；应用/文件移入废纸篓可恢复。</p>`,
      executeReal,
    );
  });
  $('btn-clean-cache').addEventListener('click', async () => {
    const r = await fetch('/api/execute', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ops: [{ type: 'brew-cache' }], dry: false }),
    });
    if (r.status === 202) { switchTab('log'); appendLog('── 开始清理 brew 缓存 ──', 'ok'); }
  });
  $('btn-save-settings').addEventListener('click', async () => {
    const body = {
      thresholdDays: parseInt($('set-days').value, 10),
      graceDays: parseInt($('set-grace').value, 10),
      protect: $('set-protect').value.split('\n').map((s) => s.trim()).filter(Boolean),
      includeZip: $('set-zip').checked,
    };
    const r = await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (r.ok) { appendLog('设置已保存', 'ok'); loadAll(); }
  });
  $('btn-hook-install').addEventListener('click', () => hookAction('install'));
  $('btn-hook-uninstall').addEventListener('click', () => hookAction('uninstall'));

  $('modal-cancel').addEventListener('click', hideModal);
  $('modal-ok').addEventListener('click', () => { hideModal(); modalOkFn?.(); });

  connectSSE();
  loadAll();
});

let modalOkFn = null;
function showModal(title, bodyHtml, onOk) {
  $('modal-title').textContent = title;
  $('modal-body').innerHTML = bodyHtml;
  modalOkFn = onOk;
  $('modal').hidden = false;
}
function hideModal() {
  $('modal').hidden = true;
  modalOkFn = null;
}
