/* Uses textContent and DOM APIs: provider-supplied strings never become HTML. */
/** Load account-owned Ulzix orders and render node bindings with safe DOM APIs. */
async function loadUlzix() {
  await loadUlzixConfig();
  await loadUlzixPurchases();
  await loadUlzixDeployments();
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
/** Call only local administrator endpoints and display server-provided safe errors. */
async function ulzixRequest(route, body) {
  const response=await fetch('/admin/api/ulzix/'+route,{cache:'no-store',...(body ? {method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':window._csrf || ''},body:JSON.stringify(body)} : {})});
  const data=await response.json();
  if(!response.ok) throw new Error(data.error || 'Ulzix 请求失败');
  return data;
}
/** Build UI elements with textContent so catalog descriptions never execute markup. */
function ulzixElement(tag,text,className='') {
  const element=document.createElement(tag); element.textContent=text; element.className=className; return element;
}
/** Load upstream categories and products, then quote one supported server product. */
async function loadUlzixCatalog() {
  const container=document.getElementById('ulzix-catalog'); container.textContent='正在获取商品…';
  try {
    const data=await ulzixRequest('catalog'); container.replaceChildren();
    const group=ulzixElement('select','','bg-gray-800 text-white rounded px-2 py-2'); group.setAttribute('aria-label','商品分组');
    for(const category of data.categories) {const option=ulzixElement('option',category.title);option.value=category.id;group.append(option);}
    const products=ulzixElement('div','','space-y-3');
    /** Render the current category without retaining old product or price selections. */
    const render=()=>{
      products.replaceChildren();
      for(const product of data.products.filter(p=>String(p.categoryId)===group.value)) {
        const card=ulzixElement('div','','glass rounded-xl p-3 space-y-2');
        card.append(ulzixElement('p',product.title,'text-white'),ulzixElement('p',product.description || ''),ulzixElement('p',`类型：${product.type} · 库存：${product.stock ?? '不限'}`));
        const period=ulzixElement('select','','bg-gray-800 text-white rounded px-2 py-2');period.setAttribute('aria-label',product.title+' 计费周期');
        const pricing=product.pricing || {};
        const choices=pricing.type==='recurrent' ? Object.entries(pricing.recurrent || {}).filter(([,p])=>p.enabled) : [[pricing.type,pricing[pricing.type]]];
        for(const [key,price] of choices) {if(!price) continue;const option=ulzixElement('option',`${key} · 商品价 ${price.price} + 开通费 ${price.setup || 0}（币种及折扣以报价为准）`);option.value=key;period.append(option);}
        const button=ulzixElement('button','获取购买报价','glass rounded-xl px-4 py-2 text-white');button.type='button';
        button.disabled=!['lxdapi','vps','hosting'].includes(product.type) || Boolean(product.formId) || !period.options.length || product.stock===0;
        button.addEventListener('click',async()=>{
          button.disabled=true;
          try {await ulzixRequest('quote',{productId:Number(product.id),period:period.value});await loadUlzixPurchases();}
          catch(e) {showToast(e.message);await loadUlzixPurchases();} finally {button.disabled=false;}
        });
        card.append(period,button); products.append(card);
      }
      if(!products.children.length) products.textContent='此分组暂无商品';
    };
    group.addEventListener('change',render);container.append(group,products);render();
  } catch(e) {container.textContent=e.message;}
}
/** Resume persisted quotes and show confirmed orders without automatically repeating checkout. */
async function loadUlzixPurchases() {
  const container=document.getElementById('ulzix-purchases'); if(!container) return;
  try {
    const data=await ulzixRequest('purchases');container.replaceChildren();
    for(const purchase of data.purchases) {
      const row=ulzixElement('div','','glass rounded-xl p-3 space-y-2');
      row.append(ulzixElement('p',`${purchase.title || '购买记录'} · ${purchase.period || ''} · ${purchase.state}${purchase.orderId ? ' · 订单 #'+purchase.orderId : ''}`));
      if(purchase.invoiceUrl) {const link=ulzixElement('a','查看 Ulzix 账单 / 支付','text-blue-400');link.href=purchase.invoiceUrl;link.target='_blank';link.rel='noopener noreferrer';row.append(link);}
      if(purchase.state==='quoted') {
        row.append(ulzixElement('p',`购物车合计：${purchase.total} ${purchase.currency}；最终税费以 Ulzix 账单为准。确认后可能直接扣除余额。`));
        for(const [action,label] of [['checkout','确认购买'],['cancel','取消报价']]) {
          const button=ulzixElement('button',label,'glass rounded-xl px-4 py-2 text-white');button.type='button';
          button.addEventListener('click',async()=>{
            if(action==='checkout' && !window.confirm(`确认购买 ${purchase.title}（${purchase.period}）？购物车合计 ${purchase.total} ${purchase.currency}，可能直接扣除余额。`)) return;
            for(const b of row.querySelectorAll('button')) b.disabled=true;
            try {await ulzixRequest(`purchases/${purchase.token}/${action}`,{confirmed:true});showToast(action==='checkout' ? '订单已加入一键部署列表' : '报价已取消');}
            catch(e) {showToast(e.message);} finally {await loadUlzixPurchases();await loadUlzixDeployments();}
          });row.append(button);
        }
      }
      if(['processing','unknown'].includes(purchase.state)) row.append(ulzixElement('p','结账结果待核对，可能已经扣款，请到 Ulzix 检查订单，切勿重复购买。'));
      if(purchase.state==='unknown') {
        const id=ulzixElement('input','');id.type='number';id.min='1';id.placeholder='核对后填写已生成的订单 ID';id.className='bg-gray-800 text-white p-2 rounded';
        const bind=ulzixElement('button','关联已生成订单','glass rounded-xl px-4 py-2 text-white');bind.type='button';
        bind.addEventListener('click',async()=>{bind.disabled=true;try {await ulzixRequest(`purchases/${purchase.token}/reconcile`,{orderId:Number(id.value)});await loadUlzixPurchases();await loadUlzixDeployments();}catch(e){showToast(e.message);bind.disabled=false;}});row.append(id,bind);
      }
      container.append(row);
    }
  } catch(e) {container.textContent=e.message;}
}
/** Display purchased services in the existing deployment form and require activation first. */
async function loadUlzixDeployments() {
  const container=document.getElementById('ulzix-deploy-list');if(!container) return;
  try {
    const data=await ulzixRequest('purchases');const bought=data.purchases.filter(p=>p.orderId);container.replaceChildren();
    if(!bought.length) return;
    let syncError='';
    const response=await ulzixRequest('orders').catch(e=>{syncError=e.message;return {orders:[],nodes:[]};});
    for(const purchase of bought) {
      const order=response.orders.find(o=>Number(o.id)===purchase.orderId);
      const bound=response.nodes.filter(n=>Number(n.orderId)===purchase.orderId);
      const row=ulzixElement('div','','flex flex-wrap items-center gap-2');
      row.append(ulzixElement('span',`Ulzix #${purchase.orderId} · ${order?.title || purchase.title} · ${order?.status || '等待同步'}${bound.length ? ' · 已绑定 '+bound.length+' 个节点' : ''}`));
      const button=ulzixElement('button','填入部署表单','glass rounded-xl px-3 py-2 text-white');button.type='button';button.disabled=order?.status!=='active';
      button.addEventListener('click',()=>{
        const form=document.getElementById('smart-deploy-form');form.elements.ulzix_order_id.value=purchase.orderId;form.closest('details').open=true;form.scrollIntoView({behavior:'smooth'});form.elements.host.focus();showToast('已选择订单，请补填服务器 SSH 地址、端口和密码');
      });row.append(button);container.append(row);
    }
    if(syncError) container.append(ulzixElement('p','订单状态同步失败：'+syncError));
  } catch(e) {container.textContent='Ulzix 部署列表：'+e.message;}
}
document.getElementById('ulzix-catalog-refresh')?.addEventListener('click',loadUlzixCatalog);

// Scripts load after core.js: also populate a directly opened nodes or Ulzix tab.
if(location.hash==='#ulzix') loadUlzix();
else loadUlzixDeployments();
