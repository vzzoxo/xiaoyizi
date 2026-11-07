/* logs.js — 日志相关 */

let currentLogType = 'system';

function switchLogType(type) {
  currentLogType = type;
  document.querySelectorAll('[data-logtype]').forEach(btn => {
    btn.className = btn.dataset.logtype === type
      ? 'text-xs px-3 py-1.5 rounded-lg transition bg-rose-600 text-white'
      : 'text-xs px-3 py-1.5 rounded-lg transition glass text-gray-400 hover:text-white';
  });
  loadLogs(1);
}

async function loadLogs(page) {
  try {
  const res = await fetch('/admin/api/logs?page=' + page + '&type=' + currentLogType);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const d = await res.json();
  const tbody = document.getElementById('log-body');
  tbody.innerHTML = '';
  (d.rows || []).forEach(l => {
    const tr = document.createElement('tr');
    tr.className = 'border-b border-white/5';

    const tdTime = document.createElement('td');
    tdTime.className = 'py-2 px-4 text-xs text-gray-500';
    tdTime.textContent = l.created_at_display || l.created_at || '-';

    const tdUser = document.createElement('td');
    tdUser.className = 'py-2 px-4 text-xs';
    if (l.ip === 'system') {
      const span = document.createElement('span');
      span.className = 'text-amber-400';
      span.textContent = '系统';
      tdUser.appendChild(span);
    } else {
      tdUser.textContent = l.username || '-';
    }

    const tdAction = document.createElement('td');
    tdAction.className = 'py-2 px-4 text-xs';
    tdAction.textContent = l.action;

    const tdDetail = document.createElement('td');
    tdDetail.className = 'py-2 px-4 text-xs text-gray-500 max-w-xs truncate';
    tdDetail.textContent = l.detail || '';

    tr.append(tdTime, tdUser, tdAction, tdDetail);
    tbody.appendChild(tr);
  });
  document.getElementById('log-info').textContent = '共 ' + d.total + ' 条';
  const pager = document.getElementById('log-pager');
  pager.innerHTML = '';
  for (let i = 1; i <= d.pages; i++) {
    const btn = document.createElement('md-filled-button');
    btn.textContent = i;
    btn.className = 'text-xs px-2 py-1 rounded ' + (i === d.page ? 'bg-rose-600 text-white' : 'glass text-gray-400 hover:text-white');
    btn.onclick = () => loadLogs(i);
    pager.appendChild(btn);
  }
  } catch (e) {
    console.error('loadLogs error', e);
    const tbody = document.getElementById('log-body');
    if (tbody) tbody.innerHTML = '<tr><td colspan="4" class="py-6 px-4 text-red-400 text-xs text-center">加载失败，请刷新重试</td></tr>';
  }
}

async function clearLogs() {
  if (!await _confirm('确定清空所有日志？')) return;
  await fetch('/admin/api/logs/clear', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': window._csrf || '' } });
  loadLogs(1);
}
