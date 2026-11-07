/* notify.js — TG 通知配置 */

async function saveTG() {
  const token = document.getElementById('tg-token').value.trim();
  const chatId = document.getElementById('tg-chat-id').value.trim();
  const res = await fetch('/admin/api/notify/config', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': window._csrf || '' }, body: JSON.stringify({ token, chatId }) });
  if (res.ok) toast('已保存'); else toast('保存失败');
}

async function testTG() {
  const res = await fetch('/admin/api/notify/test', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': window._csrf || '' } });
  const data = await res.json();
  toast(data.ok ? '测试消息已发送' : '' + (data.error || '发送失败'));
}

async function toggleEvent(el) {
  await fetch('/admin/api/notify/event', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': window._csrf || '' }, body: JSON.stringify({ key: el.dataset.key, enabled: el.checked }) });
}

async function saveAnnouncement() {
  const text = document.getElementById('announcement-text').value.trim();
  await fetch('/admin/api/announcement', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': window._csrf || '' }, body: JSON.stringify({ text }) });
  showToast(text ? '公告已更新' : '公告已清除');
}

async function saveSmtpConfig() {
  const body = {
    enabled: !!document.getElementById('smtp-enabled')?.checked,
    host: document.getElementById('smtp-host')?.value.trim() || '',
    port: parseInt(document.getElementById('smtp-port')?.value, 10) || 587,
    secure: !!document.getElementById('smtp-secure')?.checked,
    user: document.getElementById('smtp-user')?.value.trim() || '',
    pass: document.getElementById('smtp-pass')?.value || '',
    fromName: document.getElementById('smtp-from-name')?.value.trim() || '',
    fromEmail: document.getElementById('smtp-from-email')?.value.trim() || '',
  };
  const res = await fetch('/admin/api/smtp/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': window._csrf || '' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({ ok: false, error: '服务器返回异常' }));
  if (data.ok) showToast('SMTP 配置已保存');
  else showToast('' + (data.error || '保存失败'));
}

async function testSmtp() {
  const to = document.getElementById('smtp-test-to')?.value.trim() || '';
  if (!to) {
    showToast('请先输入测试收件邮箱');
    return;
  }
  const res = await fetch('/admin/api/smtp/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': window._csrf || '' },
    body: JSON.stringify({ to }),
  });
  const data = await res.json().catch(() => ({ ok: false, error: '服务器返回异常' }));
  if (data.ok) showToast('测试邮件已发送');
  else showToast('' + (data.error || '发送失败'));
}
