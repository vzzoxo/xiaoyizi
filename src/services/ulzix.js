/** Ulzix uses FOSSBilling's session-authenticated Client API. */
const BASE_URL = 'https://idc-new.ulzix.com';
const ALLOWED_METHODS = new Set(['order/get_list', 'order/get', 'order/service', 'client/get']);
/** Validate exported Ulzix cookies, discard unrelated or expired entries, and extract CSRF. */
function parseCookies(input, now = Date.now()) {
  let data;
  try { data = typeof input === 'string' ? JSON.parse(input) : input; }
  catch { throw new Error('ULZIX_COOKIES_JSON 必须是有效 JSON'); }
  if (data && Array.isArray(data.cookies)) data = data.cookies;
  if (data && !Array.isArray(data) && typeof data === 'object') data = Object.entries(data).map(([name, value]) => ({name, value}));
  if (!Array.isArray(data) || !data.length) throw new Error('Cookie JSON 必须是数组、cookies 数组或名称/值对象');
  const cookies = new Map();
  for (const c of data) {
    if (!c || typeof c.name !== 'string' || typeof c.value !== 'string') throw new Error('Cookie 名称和值必须为字符串');
    if (c.domain && !['idc-new.ulzix.com', 'ulzix.com', '.ulzix.com', '.idc-new.ulzix.com'].includes(c.domain)) continue;
    if (c.path && !'/api/client/'.startsWith(c.path)) continue;
    const expires = c.expirationDate ?? c.expires;
    if (typeof expires === 'number' && expires > 0 && expires * 1000 <= now) continue;
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(c.name) || /[\x00-\x20\x7f;,]/.test(c.value)) throw new Error('Cookie 包含无效字符');
    cookies.set(c.name, c.value);
  }
  if (!cookies.size) throw new Error('没有可用于 Ulzix 的有效 Cookie');
  let csrf = cookies.get('fossbilling_csrf') || cookies.get('CSRFToken') || '';
  try { csrf = decodeURIComponent(csrf); } catch { throw new Error('CSRF Cookie 编码无效'); }
  if (/[\r\n]/.test(csrf)) throw new Error('CSRF Cookie 无效');
  return { header: [...cookies].map(([n,v]) => `${n}=${v}`).join('; '), csrf };
}
class UlzixClient {
  /** Create a fixed-origin Ulzix client using validated server-side session cookies. */
  constructor(cookieJson = process.env.ULZIX_COOKIES_JSON, fetcher = (...args) => fetch(...args)) {
    if (!cookieJson) throw new Error('请在后台 Ulzix 集成中保存 Cookie JSON（ULZIX_COOKIES_JSON）');
    this.cookies = parseCookies(cookieJson); this.fetcher = fetcher;
  }
  /** Reuse a CSRF cookie or read the session-bound token from the Ulzix homepage. */
  async ensureCsrf() {
    if (this.cookies.csrf) return;
    // Ulzix's deployed API.js reads meta[name="csrf-token"], rather than
    // requiring a readable CSRF cookie. Load it with the supplied session.
    let response;
    try { response = await this.fetcher(BASE_URL+'/', {headers:{Cookie:this.cookies.header}, redirect:'manual',signal:AbortSignal.timeout(15000)}); }
    catch { throw new Error('无法获取 Ulzix 会话 CSRF Token'); }
    if(!response.ok) throw new Error('无法获取 Ulzix 会话 CSRF Token，请更新登录态');
    const reader=response.body.getReader(); let html='',size=0; const decoder=new TextDecoder();
    while(true) {const {done,value}=await reader.read(); if(done) break; size+=value.byteLength; if(size>2097152) {await reader.cancel(); throw new Error('Ulzix 页面响应过大');} html+=decoder.decode(value,{stream:true});}
    html+=decoder.decode();
    const tag=[...html.matchAll(/<meta\b[^>]*>/gi)].map(m=>m[0]).find(t=>/\bname\s*=\s*["']csrf-token["']/i.test(t));
    const token=tag?.match(/\bcontent\s*=\s*["']([A-Za-z0-9_-]{8,512})["']/i)?.[1];
    if(!token) throw new Error('Ulzix 页面缺少 CSRF Token，请更新登录态');
    const jar=new Map(this.cookies.header.split('; ').map(c=>{const i=c.indexOf('=');return [c.slice(0,i),c.slice(i+1)];}));
    for(const cookie of response.headers.getSetCookie?.() || []) {
      const first=cookie.split(';')[0],i=first.indexOf('=');
      if(i>0 && !/[\r\n]/.test(first)) jar.set(first.slice(0,i),first.slice(i+1));
    }
    this.cookies.header=[...jar].map(([k,v])=>k+'='+v).join('; ');
    this.cookies.csrf=token;
  }
  /** Send an allowlisted Client API request and validate its bounded JSON response. */
  async call(method, params = {}) {
    if (!ALLOWED_METHODS.has(method)) throw new Error('未支持的 Ulzix Client API 方法');
    await this.ensureCsrf();
    const headers = {Cookie: this.cookies.header, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', Origin: BASE_URL, Referer: BASE_URL+'/'};
    if (this.cookies.csrf) headers['X-CSRF-Token'] = this.cookies.csrf;
    const body = new URLSearchParams(Object.fromEntries(Object.entries(params).map(([k,v]) => [k,String(v)])));
    if (this.cookies.csrf) body.set('CSRFToken', this.cookies.csrf);
    let response;
    try { response = await this.fetcher(`${BASE_URL}/api/client/${method}`, {method:'POST', headers, body, redirect:'manual', signal: AbortSignal.timeout(15000)}); }
    catch { throw new Error('Ulzix 连接失败或超时'); }
    if ([301,302,303,307,308,401,403].includes(response.status)) throw new Error('Ulzix 登录态已失效或 CSRF 验证失败，请更新 Cookie JSON');
    if (!response.ok) throw new Error(`Ulzix API 请求失败（HTTP ${response.status}）`);
    if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('Ulzix 返回非 JSON 响应，请检查登录态');
    // Bound upstream responses before parsing (contains account-owned data).
    const reader = response.body.getReader(); const chunks = []; let size = 0;
    while (true) { const {done,value} = await reader.read(); if(done) break; size += value.byteLength; if(size > 2097152) {await reader.cancel(); throw new Error('Ulzix API 响应过大');} chunks.push(value); }
    let json;
    try { const bytes = new Uint8Array(size); let i=0; for(const c of chunks) {bytes.set(c,i); i+=c.length;} json = JSON.parse(new TextDecoder().decode(bytes)); }
    catch { throw new Error('Ulzix API 响应格式无效'); }
    if (json.error) throw new Error(`Ulzix API 拒绝请求（代码 ${Number(json.error.code) || 'unknown'}），请检查登录态与权限`);
    if (!Object.hasOwn(json,'result')) throw new Error('Ulzix API 缺少 result');
    return json.result;
  }
  /** Collect every client order page while enforcing the pagination limit. */
  async listOrders() {
    const orders = [];
    for(let page=1; page<=100; page++) {
      const result = await this.call('order/get_list', {page, per_page:100});
      if (!result || !Array.isArray(result.list)) throw new Error('Ulzix 订单列表格式无效');
      orders.push(...result.list);
      if (page >= Number(result.pages || 1)) return orders;
    }
    throw new Error('Ulzix 订单超过分页上限');
  }
}
module.exports = { UlzixClient, parseCookies, BASE_URL };
