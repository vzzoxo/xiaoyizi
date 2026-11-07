const router = require('express').Router();
const db = require('../../services/database');
const { UlzixClient, BASE_URL, parseCookies } = require('../../services/ulzix');
const settings = require('../../services/ulzixSettings');
const { asyncHandler } = require('../../utils/asyncHandler');
/** Accept only positive safe-integer IDs from route and request parameters. */
const positiveId = value => /^\d+$/.test(String(value)) && Number.isSafeInteger(Number(value)) && Number(value)>0 ? Number(value) : null;
router.use('/ulzix', (req,res,next) => {res.set('Cache-Control','no-store'); next();});
router.get('/ulzix/config', asyncHandler(async (req,res) => res.json({...await settings.status(), baseUrl:BASE_URL})));
router.post('/ulzix/config', asyncHandler(async (req,res) => {
  const input = req.body?.cookies;
  if (typeof input !== 'string' || Buffer.byteLength(input,'utf8') > 65536) return res.status(400).json({error:'请提供不超过 64 KB 的 Cookie JSON 字符串'});
  try { parseCookies(input); } catch(e) {return res.status(400).json({error:e.message});}
  try {
    const result = await settings.save(input);
    db.addAuditLog(req.user.id,'ulzix_cookie_update','更新 Ulzix 登录态 Cookie',req.clientIp || req.ip);
    res.json({ok:true,...result});
  } catch {res.status(500).json({error:'保存 Ulzix 登录态失败，请稍后重试'});}
}));
router.get('/ulzix/orders', asyncHandler(async (req,res) => {
  try {
    const orders = await new UlzixClient(await settings.read()).listOrders();
    res.json({orders: orders.map(o => ({id:o.id, title:o.title, status:o.status, service_type:o.service_type, expires_at:o.expires_at, period:o.period})), nodes:db.getAllNodes().map(n=>({id:n.id,name:n.name,orderId:n.ulzix_order_id}))});
  } catch(e) { res.status(502).json({error:e.message}); }
}));
router.post('/nodes/:id/ulzix-bind', asyncHandler(async (req,res) => {
  const id = positiveId(req.params.id), orderId = req.body.orderId === null ? null : positiveId(req.body.orderId);
  if (!id || (req.body.orderId !== null && !orderId)) return res.status(400).json({error:'无效节点或订单 ID'});
  if (!db.getNodeById(id)) return res.status(404).json({error:'节点不存在'});
  if(orderId) {
    try { await new UlzixClient(await settings.read()).call('order/get', {id:orderId}); }
    catch(e) { return res.status(502).json({error:e.message}); }
  }
  db.updateNode(id, {ulzix_order_id:orderId});
  db.addAuditLog(req.user.id, 'ulzix_bind', `节点 ${id} 绑定 Ulzix 订单 ${orderId || '解除'}`, req.clientIp || req.ip);
  res.json({ok:true});
}));
module.exports = router;
