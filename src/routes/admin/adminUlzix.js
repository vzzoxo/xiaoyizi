const router = require('express').Router();
const db = require('../../services/database');
const { UlzixClient, BASE_URL, parseCookies } = require('../../services/ulzix');
const purchases = require('../../services/ulzixPurchases');
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
/** Forward only safe failure text; persisted checkout uncertainty is handled by the purchase service. */
function purchaseFailure(res,error) {
  if(error instanceof purchases.PurchaseError) return res.status(409).json({error:error.message});
  return res.status(502).json({error:'Ulzix 操作失败，请检查登录态、库存和控制台购物车后重试'});
}
router.get('/ulzix/catalog', asyncHandler(async (req,res) => {
  try {
    const client=new UlzixClient(await settings.read());
    const categories=await client.catalog('product/category_get_list');
    const products=await client.catalog('product/get_list');
    res.json({categories:categories.map(c=>({id:c.id,title:c.title,description:c.description})),products:products.map(p=>({id:p.id,categoryId:p.product_category_id,title:p.title,description:p.description,type:p.type,pricing:p.pricing,stock:p.stock_control ? p.quantity_in_stock : null,formId:p.form_id}))});
  } catch(e) {purchaseFailure(res,e);}
}));
router.get('/ulzix/purchases', (req,res) => res.json({purchases:purchases.list(db.getDb())}));
router.post('/ulzix/quote', asyncHandler(async (req,res) => {
  const productId=positiveId(req.body?.productId),period=req.body?.period;
  if(!productId || typeof period!=='string' || !/^(free|once|[1-9][0-9]?[DWMY])$/.test(period)) return res.status(400).json({error:'商品或周期无效'});
  try {res.json(await purchases.quote(db.getDb(),new UlzixClient(await settings.read()),req.user.id,productId,period));}
  catch(e) {purchaseFailure(res,e);}
}));
router.post('/ulzix/purchases/:token/checkout', asyncHandler(async (req,res) => {
  if(req.body?.confirmed!==true) return res.status(400).json({error:'请确认购买金额与扣款'});
  try {
    const result=await purchases.checkout(db.getDb(),new UlzixClient(await settings.read()),req.user.id,req.params.token);
    db.addAuditLog(req.user.id,'ulzix_purchase',`Ulzix 购买订单 ${result.orderId}`,req.clientIp || req.ip);
    res.json(result);
  } catch(e) {purchaseFailure(res,e);}
}));
router.post('/ulzix/purchases/:token/cancel', asyncHandler(async (req,res) => {
  try {await purchases.cancel(db.getDb(),new UlzixClient(await settings.read()),req.user.id,req.params.token);res.json({ok:true});}
  catch(e) {purchaseFailure(res,e);}
}));
router.post('/ulzix/purchases/:token/reconcile', asyncHandler(async (req,res) => {
  const orderId=positiveId(req.body?.orderId);
  if(!orderId) return res.status(400).json({error:'订单 ID 无效'});
  try {res.json(await purchases.reconcile(db.getDb(),new UlzixClient(await settings.read()),req.user.id,req.params.token,orderId));}
  catch(e) {purchaseFailure(res,e);}
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
