/* users.js — 用户管理相关（setTrafficLimit, setExpiry, saveDefaultTrafficLimit, applyDefaultTrafficLimit） */
/* 注意：loadUsers 定义在 admin-sections.ejs 的 IIFE 中，因为它依赖 EJS 变量 csrfToken */

async function setTrafficLimit(userId, username, currentLimit) {
  const currentGB = currentLimit < 0 ? '-1' : (currentLimit / 1073741824).toFixed(2);
  const input = await _prompt('设置 ' + username + ' 的流量限额', { value: currentGB, placeholder: '-1 = 无限', hint: '单位：GB，-1 = 无限' });
  if (input === null) return;
  const limitGB = parseFloat(input);
  if (isNaN(limitGB)) return;
  const res = await fetch('/admin/api/users/' + userId + '/traffic-limit', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': window._csrf || '' },
    body: JSON.stringify({ limit: limitGB })
  });
  if (res.ok) { showToast(limitGB < 0 ? '已设为无限' : '已设为 ' + limitGB + ' GB'); setTimeout(() => location.reload(), 500); }
  else showToast('设置失败');
}

async function setExpiry(userId, username, currentExpiry) {
  const input = await _prompt('设置 ' + username + ' 的到期时间', { value: currentExpiry ? currentExpiry.slice(0, 10) : '', placeholder: 'YYYY-MM-DD（留空=永不过期）', hint: '格式：2025-12-31，留空则永不过期' });
  if (input === null) return;
  const expires_at = input.trim() ? new Date(input.trim() + 'T23:59:59+08:00').toISOString().replace('T', ' ').slice(0, 19) : '';
  const res = await fetch('/admin/api/users/' + userId + '/set-expiry', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': window._csrf || '' },
    body: JSON.stringify({ expires_at })
  });
  if (res.ok) { showToast(input.trim() ? '已设为 ' + input.trim() : '已设为永不过期'); loadUsers(); }
  else showToast('设置失败');
}

async function saveDefaultTrafficLimit() {
  const limitGB = parseFloat(document.getElementById('default-traffic-limit').value) || 0;
  const res = await fetch('/admin/api/default-traffic-limit', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': window._csrf || '' },
    body: JSON.stringify({ limit: limitGB })
  });
  if (res.ok) showToast(limitGB < 0 ? '默认限额已设为无限' : '默认限额已设为 ' + limitGB + ' GB');
  else showToast('保存失败');
}

async function applyDefaultTrafficLimit() {
  if (!await _confirm('将当前默认流量限额覆盖应用到全部用户（包括已手动设置过的）？')) return;
  const res = await fetch('/admin/api/default-traffic-limit/apply', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': window._csrf || '' } });
  const d = await res.json().catch(() => ({}));
  if (res.ok && d.ok) {
    showToast('已覆盖应用到 ' + (d.updated || 0) + ' 个用户');
    setTimeout(() => location.reload(), 600);
  } else {
    showToast('应用失败');
  }
}
