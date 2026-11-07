/* Uses textContent and DOM APIs: provider-supplied strings never become HTML. */
/** Load account-owned Ulzix orders and render node bindings with safe DOM APIs. */
async function loadUlzix() {
  await loadUlzixConfig();
  const output = document.getElementById('ulzix-orders');
  const nodes = document.getElementById('ulzix-nodes');
  output.textContent = '正在加载…'; nodes.replaceChildren();
  try {
    const response = await fetch('/admin/api/ulzix/orders', {cache:'no-store'});
    const data = await response.json(); if(!response.ok) throw new Error(data.error || '加载失败');
    output.replaceChildren();
    if(!data.orders.length) output.textContent = '暂无订单';
    for(const order of data.orders) {
      const row = document.createElement('p'); row.textContent = `#${order.id} · ${order.title} · ${order.status} · ${order.expires_at || '无到期日期'}`; output.append(row);
    }
    for(const node of data.nodes) {
      const row = document.createElement('div'); const label = document.createElement('span'); label.textContent=node.name+' ';
      const select = document.createElement('select'); select.className='bg-gray-800 text-white rounded px-2 py-1';
      const empty = document.createElement('option'); empty.value=''; empty.textContent='未绑定'; select.append(empty);
      for(const o of data.orders) {const option=document.createElement('option'); option.value=o.id; option.textContent=`#${o.id} ${o.title}`; select.append(option);}
      select.value=node.orderId || '';
      const save = document.createElement('button'); save.textContent='保存绑定'; save.className='glass rounded-xl px-3 py-1 ml-2 text-white';
      save.addEventListener('click', async () => {
        save.disabled=true;
        try {
          const result=await fetch(`/admin/api/nodes/${node.id}/ulzix-bind`,{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':window._csrf || ''},body:JSON.stringify({orderId:select.value ? Number(select.value) : null})});
          const json=await result.json(); if(!result.ok) throw new Error(json.error || '保存失败'); showToast('已保存 Ulzix 绑定');
        } catch(e) {showToast(e.message);} finally {save.disabled=false;}
      });
      row.append(label,select,save); nodes.append(row);
    }
  } catch(e) {output.textContent=e.message;}
}
document.getElementById('ulzix-refresh')?.addEventListener('click', loadUlzix);
/** Display only credential metadata; saved cookie contents are never fetched. */
async function loadUlzixConfig() {
  const status = document.getElementById('ulzix-cookie-status');
  try {
    const response = await fetch('/admin/api/ulzix/config',{cache:'no-store'});
    const data = await response.json();
    if (!response.ok) throw new Error('读取登录态配置失败');
    document.getElementById('ulzix-cookie-save').disabled = !data.writable;
    status.textContent = data.configured ? `已配置${data.updatedAt ? '，更新于 '+new Date(data.updatedAt).toLocaleString() : ''}` : '尚未配置，请粘贴最新 Cookie JSON';
    if (!data.writable) status.textContent += '（当前环境未绑定 D1，无法在线更新）';
  } catch(e) {status.textContent=e.message;}
}
document.getElementById('ulzix-cookie-form')?.addEventListener('submit', async event => {
  event.preventDefault();
  const input = document.getElementById('ulzix-cookie-json');
  const button = document.getElementById('ulzix-cookie-save');
  const status = document.getElementById('ulzix-cookie-status');
  button.disabled = true;
  try {
    const response = await fetch('/admin/api/ulzix/config',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':window._csrf || ''},body:JSON.stringify({cookies:input.value})});
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '保存失败');
    input.value = '';
    await loadUlzixConfig();
    showToast('Ulzix 登录态已保存');
    await loadUlzix();
  } catch(e) {status.textContent=e.message;} finally {button.disabled=false;}
});
