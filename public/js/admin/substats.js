/* substats.js — 订阅统计（事件流版） */

const SUB_REASON_LABELS = {
  ok: '成功',
  ok_cache: '缓存命中',
  ok_exceeded: '超额空订阅',
  unknown_ua: 'UA 拦截',
  unknown_ua_observe: 'UA 观察放行',
  signature_invalid: '签名无效',
  signature_invalid_observe: '签名观察放行',
  token_rate_limited: 'Token 频率超限',
  token_abuse_detected: '行为风控',
  ip_rate_limited: 'IP 频率超限',
  invalid_token: 'Token 无效',
  level_not_allowed: '等级不足',
  empty_ua: 'UA 为空',
  legacy_ok: '旧日志成功',
};

function reasonLabel(reason) {
  const key = String(reason || '').trim();
  if (!key) return '-';
  return SUB_REASON_LABELS[key] || key;
}

function riskBadge(level) {
  const r = String(level || 'low').toLowerCase();
  const cls = r === 'high'
    ? 'bg-red-500/20 text-red-300'
    : (r === 'mid' ? 'bg-amber-500/20 text-amber-300' : 'bg-white/10 text-gray-400');
  return '<span class="text-xs px-2 py-0.5 rounded-full ' + cls + '">' + escapeHtml(r) + '</span>';
}

function resultBadge(result) {
  const r = String(result || '');
  if (r === 'deny') return '<span class="text-[10px] px-1.5 py-0.5 rounded bg-red-500/20 text-red-300">DENY</span>';
  return '<span class="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300">ALLOW</span>';
}

function fmtNum(v) {
  const n = Number(v || 0);
  return Number.isFinite(n) ? n.toLocaleString() : '0';
}

function fmtRate(v) {
  const n = Number(v || 0);
  return Number.isFinite(n) ? n.toFixed(1) + '%' : '0.0%';
}

function renderOverview(overview, source) {
  const box = document.getElementById('substats-overview');
  if (!box) return;
  if (!overview) {
    box.innerHTML = '';
    return;
  }
  const cards = [
    { k: '总请求', v: fmtNum(overview.total_requests || 0), c: 'text-white' },
    { k: '成功率', v: fmtRate(overview.allow_rate || 0), c: 'text-emerald-300' },
    { k: '拒绝请求', v: fmtNum(overview.deny_requests || 0), c: 'text-rose-300' },
    { k: '受影响用户', v: fmtNum(overview.denied_user_count || 0), c: 'text-amber-300' },
  ];
  box.innerHTML = cards.map(card =>
    '<div class="rounded-xl bg-black/20 border border-white/5 px-3 py-2">' +
      '<div class="text-[11px] text-gray-500">' + escapeHtml(card.k) + '</div>' +
      '<div class="text-sm font-medium ' + card.c + '">' + escapeHtml(card.v) + '</div>' +
    '</div>'
  ).join('');

  if (String(source || '') === 'legacy') {
    box.innerHTML += '<div class="col-span-2 md:col-span-4 text-[11px] text-amber-400">当前为旧日志回退视图，新拒绝原因统计需等待新事件数据累积。</div>';
  }
}

function setSecurityButtonState(view) {
  const subBtn = document.getElementById('security-view-substats');
  const multiBtn = document.getElementById('security-view-multinode');
  const subPanel = document.getElementById('security-substats-panel');
  const multiPanel = document.getElementById('security-multinode-panel');
  const detailPanel = document.getElementById('substats-detail-panel');
  const isSub = view === 'substats';
  if (subBtn) subBtn.className = (isSub ? 'bg-rose-600 hover:bg-rose-500 text-white' : 'glass text-gray-300 hover:text-white') + ' text-xs px-3 py-1.5 rounded-lg transition';
  if (multiBtn) multiBtn.className = (!isSub ? 'bg-rose-600 hover:bg-rose-500 text-white' : 'glass text-gray-300 hover:text-white') + ' text-xs px-3 py-1.5 rounded-lg transition';
  if (subPanel) subPanel.classList.toggle('hidden', !isSub);
  if (multiPanel) multiPanel.classList.toggle('hidden', isSub);
  if (detailPanel && !isSub) detailPanel.classList.add('hidden');
}

function switchSecurityView(view) {
  const target = view === 'multiNode' ? 'multiNode' : 'substats';
  setSecurityButtonState(target);
  if (target === 'substats') {
    loadSubStats(1);
  } else {
    loadMultiNodeObservations(1);
  }
}

async function loadSubStats(page) {
  setSecurityButtonState('substats');
  page = page || 1;
  const hours = document.getElementById('substats-hours').value;
  const sort = document.getElementById('substats-sort').value;
  const high = document.getElementById('substats-high').checked ? '1' : '0';
  const container = document.getElementById('substats-result');
  const pager = document.getElementById('substats-pager');
  container.innerHTML = '<p class="text-gray-500 text-sm text-center py-2">加载中...</p>';
  pager.innerHTML = '';
  try {
    const res = await fetch('/admin/api/sub-stats?hours=' + hours + '&page=' + page + '&sort=' + sort + '&high=' + high);
    const json = await res.json();
    renderOverview(json.overview, json.source);

    if (!json.data || json.data.length === 0) {
      container.innerHTML = '<p class="text-emerald-400 text-sm text-center py-4"> 无数据</p>';
      return;
    }

    container.innerHTML = '<div class="overflow-x-auto"><table class="w-full text-xs">' +
      '<thead><tr class="text-gray-500 border-b border-white/10">' +
      '<th class="py-2 text-left">用户</th><th>请求</th><th>成功率</th><th>拒绝</th><th>IP/UA</th><th>最近拉取</th><th>风险</th><th>主要拒绝</th><th></th>' +
      '</tr></thead><tbody>' +
      json.data.map(u =>
        '<tr class="border-b border-white/5 hover:bg-white/5">' +
          '<td class="py-2 text-white">' + escapeHtml(u.username) + ' <span class="text-gray-600">ID:' + escapeHtml(u.user_id) + '</span></td>' +
          '<td class="text-center text-gray-300">' + escapeHtml(fmtNum(u.request_count || u.pull_count || 0)) + '</td>' +
          '<td class="text-center text-emerald-300">' + escapeHtml(fmtRate(u.ok_rate || 0)) + '</td>' +
          '<td class="text-center ' + ((u.deny_count || 0) > 0 ? 'text-rose-300' : 'text-gray-500') + '">' + escapeHtml(fmtNum(u.deny_count || 0)) + '</td>' +
          '<td class="text-center text-gray-300">' + escapeHtml(fmtNum(u.ip_count || 0)) + '/' + escapeHtml(fmtNum(u.ua_count || 0)) + '</td>' +
          '<td class="text-center text-gray-400">' + escapeHtml(u.last_access_display || u.last_access || '-') + '</td>' +
          '<td class="text-center">' + riskBadge(u.risk_level) + '</td>' +
          '<td class="text-center text-gray-400">' + escapeHtml(reasonLabel(u.top_deny_reason)) + '</td>' +
          '<td class="text-right"><md-filled-button type="button" class="js-substats-detail text-rose-400 hover:text-rose-300" data-user-id="' + parseInt(u.user_id, 10) + '" data-hours="' + parseInt(hours, 10) + '">详情</md-filled-button></td>' +
        '</tr>'
      ).join('') + '</tbody></table></div>';

    const totalPages = Math.ceil((json.total || 0) / (json.limit || 20));
    if (totalPages > 1) {
      let html = '';
      const end = Math.min(totalPages, 10);
      for (let i = 1; i <= end; i++) {
        html += '<md-filled-button type="button" class="js-substats-page text-xs px-2 py-1 rounded ' + (i === page ? 'bg-rose-600 text-white' : 'bg-white/10 text-gray-400') + '" data-page="' + i + '">' + i + '</md-filled-button>';
      }
      pager.innerHTML = html;
    }
  } catch (e) {
    container.innerHTML = '<p class="text-red-400 text-sm">加载失败</p>';
  }
}

function renderMultiNodeOverview(overview) {
  const box = document.getElementById('multinode-overview');
  if (!box) return;
  if (!overview) {
    box.innerHTML = '';
    return;
  }
  const cards = [
    { k: '观察事件', v: fmtNum(overview.total_events || 0), c: 'text-white' },
    { k: '涉及用户', v: fmtNum(overview.user_count || 0), c: 'text-emerald-300' },
    { k: '高风险(4+节点)', v: fmtNum(overview.high_count || 0), c: 'text-rose-300' },
    { k: '中风险(2-3节点)', v: fmtNum(overview.mid_count || 0), c: 'text-amber-300' },
  ];
  box.innerHTML = cards.map(card =>
    '<div class="rounded-xl bg-black/20 border border-white/5 px-3 py-2">' +
      '<div class="text-[11px] text-gray-500">' + escapeHtml(card.k) + '</div>' +
      '<div class="text-sm font-medium ' + card.c + '">' + card.v + '</div>' +
    '</div>'
  ).join('');
}

async function loadMultiNodeObservations(page) {
  page = page || 1;
  const hoursEl = document.getElementById('multinode-hours');
  const hours = hoursEl ? hoursEl.value : '24';
  const container = document.getElementById('multinode-result');
  const pager = document.getElementById('multinode-pager');
  if (!container || !pager) return;
  container.innerHTML = '<p class="text-gray-500 text-sm text-center py-2">加载中...</p>';
  pager.innerHTML = '';
  try {
    const res = await fetch('/admin/api/security/multi-node-observe?hours=' + encodeURIComponent(hours) + '&page=' + page);
    const json = await res.json();
    renderMultiNodeOverview(json.overview);

    if (!json.data || json.data.length === 0) {
      container.innerHTML = '<p class="text-emerald-400 text-sm text-center py-4"> 当前窗口无并发多节点观察事件</p>';
      return;
    }

    container.innerHTML = '<div class="overflow-x-auto"><table class="w-full text-xs">' +
      '<thead><tr class="text-gray-500 border-b border-white/10">' +
      '<th class="py-2 text-left">时间</th><th>用户</th><th>节点数</th><th>流量</th><th>节点ID</th><th>风险</th><th>详情</th>' +
      '</tr></thead><tbody>' +
      json.data.map(r =>
        '<tr class="border-b border-white/5 hover:bg-white/5">' +
          '<td class="py-2 text-gray-400">' + escapeHtml(r.time_display || '-') + '</td>' +
          '<td class="text-center text-white">' + escapeHtml((r.username || '-') + (r.user_id ? ' (#' + r.user_id + ')' : '')) + '</td>' +
          '<td class="text-center text-amber-300">' + escapeHtml(String(r.node_count || 0)) + '</td>' +
          '<td class="text-center text-gray-300">' + escapeHtml(r.total_traffic_mb ? r.total_traffic_mb + ' MB' : '0 MB') + '</td>' +
          '<td class="text-center text-gray-300 font-mono">' + escapeHtml((r.nodes || []).join(',')) + '</td>' +
          '<td class="text-center">' + riskBadge(r.risk_level) + '</td>' +
          '<td class="text-gray-500 truncate max-w-xs">' + escapeHtml(r.detail || '') + '</td>' +
        '</tr>'
      ).join('') +
      '</tbody></table></div>';

    const totalPages = Math.ceil((json.total || 0) / (json.limit || 20));
    if (totalPages > 1) {
      let html = '';
      const end = Math.min(totalPages, 10);
      for (let i = 1; i <= end; i++) {
        html += '<md-filled-button type="button" class="js-multinode-page text-xs px-2 py-1 rounded ' + (i === page ? 'bg-rose-600 text-white' : 'bg-white/10 text-gray-400') + '" data-page="' + i + '">' + i + '</md-filled-button>';
      }
      pager.innerHTML = html;
    }
  } catch (e) {
    container.innerHTML = '<p class="text-red-400 text-sm">加载失败</p>';
  }
}

async function showSubStatDetail(userId, hours) {
  const panel = document.getElementById('substats-detail-panel');
  const container = document.getElementById('substats-detail');
  panel.classList.remove('hidden');
  container.innerHTML = '<p class="text-gray-500 text-xs">加载中...</p>';
  try {
    const res = await fetch('/admin/api/sub-stats/' + userId + '/detail?hours=' + hours);
    const d = await res.json();
    const s = d.summary || {};
    const reasons = Array.isArray(d.reasons) ? d.reasons : [];
    const routes = Array.isArray(d.routes) ? d.routes : [];
    const ips = Array.isArray(d.ips) ? d.ips : [];
    const uas = Array.isArray(d.uas) ? d.uas : [];
    const timeline = Array.isArray(d.timeline) ? d.timeline : [];

    let html = '';
    html += '<div class="grid grid-cols-2 md:grid-cols-5 gap-2 mb-4">' +
      '<div class="rounded-xl bg-black/20 border border-white/5 px-3 py-2"><div class="text-[11px] text-gray-500">总请求</div><div class="text-sm text-white">' + escapeHtml(fmtNum(s.request_count || 0)) + '</div></div>' +
      '<div class="rounded-xl bg-black/20 border border-white/5 px-3 py-2"><div class="text-[11px] text-gray-500">成功率</div><div class="text-sm text-emerald-300">' + escapeHtml(fmtRate(s.ok_rate || 0)) + '</div></div>' +
      '<div class="rounded-xl bg-black/20 border border-white/5 px-3 py-2"><div class="text-[11px] text-gray-500">拒绝</div><div class="text-sm text-rose-300">' + escapeHtml(fmtNum(s.deny_count || 0)) + '</div></div>' +
      '<div class="rounded-xl bg-black/20 border border-white/5 px-3 py-2"><div class="text-[11px] text-gray-500">IP/UA</div><div class="text-sm text-white">' + escapeHtml(fmtNum(s.ip_count || 0)) + '/' + escapeHtml(fmtNum(s.ua_count || 0)) + '</div></div>' +
      '<div class="rounded-xl bg-black/20 border border-white/5 px-3 py-2"><div class="text-[11px] text-gray-500">风险</div><div class="text-sm">' + riskBadge(s.risk_level) + '</div></div>' +
    '</div>';

    html += '<div class="grid grid-cols-1 md:grid-cols-3 gap-4">';
    html += '<div><h4 class="text-gray-400 text-xs mb-2">拒绝原因 TOP</h4><div class="space-y-1 max-h-72 overflow-y-auto pr-1">' +
      (reasons.length ? reasons.map(r =>
        '<div class="flex justify-between p-1.5 rounded bg-black/20 text-xs">' +
          '<span class="text-gray-300">' + escapeHtml(reasonLabel(r.reason)) + '</span>' +
          '<span class="text-gray-500">' + escapeHtml(fmtNum(r.count)) + '</span>' +
        '</div>'
      ).join('') : '<div class="text-[11px] text-gray-600">无拒绝记录</div>') +
    '</div></div>';

    html += '<div><h4 class="text-gray-400 text-xs mb-2">IP 分布</h4><div class="space-y-1 max-h-72 overflow-y-auto pr-1">' +
      (ips.length ? ips.map(ip =>
        '<div class="p-1.5 rounded bg-black/20 text-xs">' +
          '<div class="flex justify-between"><span class="text-gray-300 font-mono">' + escapeHtml(ip.ip) + '</span><span class="text-gray-500">' + escapeHtml(fmtNum(ip.count)) + '次</span></div>' +
          '<div class="text-[10px] text-gray-600">ok ' + escapeHtml(fmtNum(ip.ok_count || 0)) + ' / deny ' + escapeHtml(fmtNum(ip.deny_count || 0)) + '</div>' +
        '</div>'
      ).join('') : '<div class="text-[11px] text-gray-600">无数据</div>') +
    '</div></div>';

    html += '<div><h4 class="text-gray-400 text-xs mb-2">UA TOP</h4><div class="space-y-1 max-h-72 overflow-y-auto pr-1">' +
      (uas.length ? uas.map(ua =>
        '<div class="p-1.5 rounded bg-black/20 text-xs">' +
          '<div class="text-gray-300 break-all">' + escapeHtml(ua.ua || '(empty)') + '</div>' +
          '<div class="text-[10px] text-gray-500">' + escapeHtml(fmtNum(ua.count)) + '次 · ok ' + escapeHtml(fmtNum(ua.ok_count || 0)) + ' / deny ' + escapeHtml(fmtNum(ua.deny_count || 0)) + '</div>' +
        '</div>'
      ).join('') : '<div class="text-[11px] text-gray-600">无数据</div>') +
    '</div></div>';
    html += '</div>';

    html += '<div class="mt-4"><h4 class="text-gray-400 text-xs mb-2">路由分布</h4><div class="flex flex-wrap gap-2">' +
      (routes.length ? routes.map(r =>
        '<span class="text-[11px] px-2 py-1 rounded-lg bg-black/20 border border-white/5 text-gray-300">' +
          escapeHtml(r.route || 'sub') + ' · ' + escapeHtml(fmtNum(r.count || 0)) +
          ' (deny ' + escapeHtml(fmtNum(r.deny_count || 0)) + ')' +
        '</span>'
      ).join('') : '<span class="text-[11px] text-gray-600">无数据</span>') +
    '</div></div>';

    html += '<div class="mt-4"><h4 class="text-gray-400 text-xs mb-2">最近事件</h4><div class="space-y-1 max-h-72 overflow-y-auto pr-1">' +
      (timeline.length ? timeline.map(t =>
        '<div class="p-1.5 rounded bg-black/20 text-xs">' +
          '<div class="flex items-center justify-between gap-2">' +
            '<span class="text-gray-400">' + escapeHtml(t.time_display || t.time || '') + '</span>' +
            '<span>' + resultBadge(t.result) + '</span>' +
          '</div>' +
          '<div class="text-gray-300 mt-1 font-mono">' + escapeHtml(t.ip || '-') + '</div>' +
          '<div class="text-[10px] text-gray-500 mt-0.5">' +
            escapeHtml(reasonLabel(t.reason)) +
            ' · ' + escapeHtml(t.route || '-') +
            ' · HTTP ' + escapeHtml(t.http_status || '-') +
            (t.client_type ? (' · ' + escapeHtml(t.client_type)) : '') +
          '</div>' +
        '</div>'
      ).join('') : '<div class="text-[11px] text-gray-600">无数据</div>') +
    '</div></div>';

    container.innerHTML = html;
    document.getElementById('substats-detail-title').textContent = '用户 #' + userId + ' 详情';
  } catch (e) {
    container.innerHTML = '<p class="text-red-400 text-xs">加载失败</p>';
  }
}

function bindSubstatsActions() {
  const result = document.getElementById('substats-result');
  const pager = document.getElementById('substats-pager');
  const multinodePager = document.getElementById('multinode-pager');

  if (result && !result.dataset.boundActions) {
    result.addEventListener('click', (e) => {
      const btn = e.target.closest('.js-substats-detail');
      if (!btn) return;
      const userId = parseInt(btn.dataset.userId || '0', 10);
      const hours = parseInt(btn.dataset.hours || '24', 10);
      if (!Number.isFinite(userId) || userId <= 0) return;
      showSubStatDetail(userId, Number.isFinite(hours) && hours > 0 ? hours : 24);
    });
    result.dataset.boundActions = '1';
  }

  if (pager && !pager.dataset.boundActions) {
    pager.addEventListener('click', (e) => {
      const btn = e.target.closest('.js-substats-page');
      if (!btn) return;
      const page = parseInt(btn.dataset.page || '1', 10);
      if (!Number.isFinite(page) || page <= 0) return;
      loadSubStats(page);
    });
    pager.dataset.boundActions = '1';
  }

  if (multinodePager && !multinodePager.dataset.boundActions) {
    multinodePager.addEventListener('click', (e) => {
      const btn = e.target.closest('.js-multinode-page');
      if (!btn) return;
      const page = parseInt(btn.dataset.page || '1', 10);
      if (!Number.isFinite(page) || page <= 0) return;
      loadMultiNodeObservations(page);
    });
    multinodePager.dataset.boundActions = '1';
  }
}

async function checkAbuse() { switchSecurityView('substats'); }
function loadAbuse() { switchSecurityView('substats'); }

async function showDetail(userId, hours) {
  return showSubStatDetail(userId, hours);
}

window.switchSecurityView = switchSecurityView;
window.loadMultiNodeObservations = loadMultiNodeObservations;
window.loadSubStats = loadSubStats;
window.showSubStatDetail = showSubStatDetail;
window.showDetail = showDetail;
window.loadAbuse = loadAbuse;
window.checkAbuse = checkAbuse;
bindSubstatsActions();
