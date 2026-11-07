const {randomUUID,createHash}=require('node:crypto');
/** Identify expected purchase failures without exposing upstream payloads or credentials. */
class PurchaseError extends Error {}
/** Initialize durable purchase records and allow only one unfinished cart mutation. */
function initialize(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS ulzix_purchases (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, state TEXT NOT NULL, quote TEXT, order_id INTEGER, invoice_hash TEXT, created_at TEXT NOT NULL, started_at INTEGER NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS ulzix_purchase_lock ON ulzix_purchases ((1)) WHERE state IN ('preparing','quoted','processing','unknown')`);
}
/** Fingerprint all cart contents and totals, so changed carts require a fresh confirmation. */
function fingerprint(cart) {
  if(!Array.isArray(cart?.items) || !Number.isFinite(Number(cart.total)) || Number(cart.total)<0 || !/^[A-Z]{3}$/.test(cart.currency?.code || '')) throw new PurchaseError('Ulzix 购物车格式无效');
  return createHash('sha256').update(JSON.stringify(cart)).digest('hex');
}
/** Return only browser-safe purchase metadata, never the account or cart fingerprint. */
function publicRecord(row) {
  const q=row.quote ? JSON.parse(row.quote) : {};
  return {token:row.token,state:row.state,orderId:row.order_id,invoiceUrl:row.invoice_hash ? 'https://idc-new.ulzix.com/invoice/'+encodeURIComponent(row.invoice_hash) : null,title:q.title,period:q.period,total:q.total,currency:q.currency,createdAt:row.created_at};
}
/** List durable purchases including pending payment and uncertain checkout outcomes. */
function list(db) {
  initialize(db);
  const cutoff=Date.now()-300000;
  db.prepare("UPDATE ulzix_purchases SET state = 'failed' WHERE state = 'preparing' AND started_at < ?").run(cutoff);
  db.prepare("UPDATE ulzix_purchases SET state = 'unknown' WHERE state = 'processing' AND started_at < ?").run(cutoff);
  return db.prepare('SELECT * FROM ulzix_purchases ORDER BY created_at DESC LIMIT 100').all().map(publicRecord);
}

/** Create one cart item and store the upstream quote before allowing any checkout. */
async function quote(db,client,userId,productId,period) {
  initialize(db);
  if(db.prepare("SELECT token FROM ulzix_purchases WHERE state IN ('preparing','quoted','processing','unknown')").get()) throw new PurchaseError('已有待确认或结果待核对的购买，请先处理');
  const token=randomUUID();
  db.prepare('INSERT INTO ulzix_purchases (token,user_id,state,created_at,started_at) VALUES (?,?,?,?,?)').run(token,userId,'preparing',new Date().toISOString(),Date.now());
  try {
    const account=await client.call('client/get');
    if(!Number.isSafeInteger(Number(account?.id)) || Number(account.id)<=0) throw new PurchaseError('Ulzix 客户信息无效');
    const product=await client.guest('product/get',{id:productId});
    if(Number(product?.id)!==productId || !['lxdapi','vps','hosting'].includes(product.type)) throw new PurchaseError('此商品不属于已支持的服务器商品');
    if(product.form_id) throw new PurchaseError('此商品需要额外配置，请到 Ulzix 控制台购买');
    const price=product.pricing;
    if(price?.type==='recurrent' ? !price.recurrent?.[period]?.enabled : !['free','once'].includes(price?.type) || period!==price.type) throw new PurchaseError('请选择商品支持的计费周期');
    const before=await client.guest('cart/get');
    if(!Array.isArray(before?.items) || before.items.length) throw new PurchaseError('Ulzix 购物车非空，请先在控制台处理，避免购买其他商品');
    await client.guest('cart/add_item',{id:productId,period,quantity:1,multiple:1});
    const cart=await client.guest('cart/get');
    const digest=fingerprint(cart);
    if(cart.items.length!==1 || Number(cart.items[0].product_id)!==productId || Number(cart.items[0].quantity)!==1) throw new PurchaseError('购物车商品与选择不符，请到 Ulzix 控制台核对');
    const q={productId,period,title:String(product.title).slice(0,300),accountId:Number(account.id),itemId:cart.items[0].id,total:cart.total,currency:cart.currency.code,fingerprint:digest};
    db.prepare('UPDATE ulzix_purchases SET state = ?, quote = ? WHERE token = ?').run('quoted',JSON.stringify(q),token);
    return publicRecord(db.prepare('SELECT * FROM ulzix_purchases WHERE token = ?').get(token));
  } catch(e) {db.prepare('UPDATE ulzix_purchases SET state = ? WHERE token = ?').run('failed',token);throw e;}
}
/** Bind quote confirmation to its local administrator and current Ulzix account. */
async function getQuote(db,client,userId,token) {
  initialize(db);
  const row=db.prepare('SELECT * FROM ulzix_purchases WHERE token = ? AND user_id = ?').get(token,userId);
  if(!row) throw new PurchaseError('购买记录不存在');
  const q=JSON.parse(row.quote || '{}');
  const account=await client.call('client/get');
  if(Number(account?.id)!==q.accountId) throw new PurchaseError('Ulzix 登录账号已变化，请使用原账号处理此购买');
  return {row,q};
}
/** Checkout once; uncertain results remain locked and must never be retried automatically. */
async function checkout(db,client,userId,token) {
  const {row,q}=await getQuote(db,client,userId,token);
  if(row.state==='ordered') return publicRecord(row);
  if(row.state!=='quoted') throw new PurchaseError('此购买已处理或结果待核对，请勿重复下单');
  const cart=await client.guest('cart/get');
  if(fingerprint(cart)!==q.fingerprint) throw new PurchaseError('购物车或金额已变化，请取消报价后重新选择');
  const changed=db.prepare("UPDATE ulzix_purchases SET state = 'processing', started_at = ? WHERE token = ? AND state = 'quoted'").run(Date.now(),token).changes;
  if(!changed) throw new PurchaseError('购买正在处理中，请勿重复提交');
  try {
    const result=await client.call('cart/checkout');
    const orderId=Number(result?.order_id);
    if(!Number.isSafeInteger(orderId) || orderId<=0 || (result.invoice_hash && !/^[a-zA-Z0-9_-]{1,128}$/.test(result.invoice_hash))) throw new PurchaseError('上游结账结果无效，请到 Ulzix 核对订单');
    db.prepare('UPDATE ulzix_purchases SET state = ?, order_id = ?, invoice_hash = ? WHERE token = ?').run('ordered',orderId,result.invoice_hash || null,token);
    return publicRecord(db.prepare('SELECT * FROM ulzix_purchases WHERE token = ?').get(token));
  } catch {db.prepare('UPDATE ulzix_purchases SET state = ? WHERE token = ?').run('unknown',token);throw new PurchaseError('结账结果待核对，可能已扣款。请到 Ulzix 检查订单，勿重复购买');}
}
/** Cancel only our quoted cart item; never clear unrelated items or a submitted checkout. */
async function cancel(db,client,userId,token) {
  const {row,q}=await getQuote(db,client,userId,token);
  if(row.state!=='quoted') throw new PurchaseError('仅可取消尚未确认的报价');
  const changed=db.prepare("UPDATE ulzix_purchases SET state = 'preparing', started_at = ? WHERE token = ? AND state = 'quoted'").run(Date.now(),token).changes;
  if(!changed) throw new PurchaseError('购买正在处理中');
  try {
    const cart=await client.guest('cart/get');
    if(cart.items?.some(i=>String(i.id)===String(q.itemId))) await client.guest('cart/remove_item',{id:q.itemId});
    db.prepare('UPDATE ulzix_purchases SET state = ? WHERE token = ?').run('cancelled',token);
  } catch(e) {db.prepare('UPDATE ulzix_purchases SET state = ? WHERE token = ?').run('quoted',token);throw e;}
}
/** Resolve an uncertain checkout only by explicitly associating an account-owned matching order. */
async function reconcile(db,client,userId,token,orderId) {
  const {row,q}=await getQuote(db,client,userId,token);
  if(row.state!=='unknown') throw new PurchaseError('此购买不需要核对关联');
  const order=await client.call('order/get',{id:orderId});
  if(Number(order?.id)!==orderId || Number(order.product_id)!==q.productId) throw new PurchaseError('订单与购买商品不匹配');
  db.prepare("UPDATE ulzix_purchases SET state = 'ordered', order_id = ? WHERE token = ? AND state = 'unknown'").run(orderId,token);
  return publicRecord(db.prepare('SELECT * FROM ulzix_purchases WHERE token = ?').get(token));
}
module.exports={PurchaseError,list,quote,checkout,cancel,reconcile};
