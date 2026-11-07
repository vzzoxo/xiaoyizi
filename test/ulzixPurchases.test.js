const test=require('node:test');
const assert=require('node:assert/strict');
const Database=require('better-sqlite3');
const service=require('../src/services/ulzixPurchases');
/** Model the documented FOSSBilling cart and client API without making real purchases. */
function fixture(t) {
  const db=new Database(':memory:');t.after(()=>db.close());
  const state={accountId:7,items:[],total:4.5,checkouts:0,delay:null,timeout:false,removed:[]};
  const client={
    async call(method,params) {
      if(method==='client/get') return {id:state.accountId};
      if(method==='order/get') return {id:params.id,product_id:67,status:'active'};
      assert.equal(method,'cart/checkout');state.checkouts++;
      if(state.delay) await state.delay;
      if(state.timeout) throw new Error('timeout');
      state.items=[];return {order_id:991,invoice_hash:'test-invoice-hash'};
    },
    async guest(method,params) {
      if(method==='product/get') return {id:params.id,title:'Test NAT',type:'lxdapi',pricing:{type:'recurrent',recurrent:{'1Y':{enabled:true,price:4.5,setup:0}}}};
      if(method==='cart/get') return {items:state.items.map(i=>({...i})),total:state.total,currency:{code:'CNY'}};
      if(method==='cart/add_item') {assert.equal(params.multiple,1,'Never reset the shared cart');state.items.push({id:12,product_id:params.id,period:params.period,quantity:1});return true;}
      assert.equal(method,'cart/remove_item');state.removed.push(params.id);state.items=state.items.filter(i=>i.id!==params.id);return true;
    }
  };
  return {db,client,state};
}
test('Ulzix quote never checks out; confirmation is durable and idempotent',async t=>{
  const {db,client,state}=fixture(t);
  const quote=await service.quote(db,client,1,67,'1Y');assert.equal(state.checkouts,0);assert.equal(quote.total,4.5);assert.equal(quote.currency,'CNY');
  const result=await service.checkout(db,client,1,quote.token);assert.equal(result.orderId,991);assert.match(result.invoiceUrl,/invoice\/test-invoice-hash$/);
  assert.equal((await service.checkout(db,client,1,quote.token)).orderId,991);assert.equal(state.checkouts,1);
  assert.equal(service.list(db)[0].orderId,991);
});
test('Ulzix preserves nonempty carts and rejects unsupported periods',async t=>{
  const {db,client,state}=fixture(t);
  state.items=[{id:99,product_id:99,quantity:1}];
  await assert.rejects(service.quote(db,client,1,67,'1Y'),/购物车非空/);assert.equal(state.items[0].id,99);assert.equal(state.checkouts,0);
  state.items=[];
  await assert.rejects(service.quote(db,client,1,67,'1M'),/周期/);assert.deepEqual(state.items,[]);
});
test('Ulzix rejects changed quotes, changed accounts, and another administrator',async t=>{
  const {db,client,state}=fixture(t);const q=await service.quote(db,client,1,67,'1Y');
  state.total=9;await assert.rejects(service.checkout(db,client,1,q.token),/金额已变化/);assert.equal(state.checkouts,0);
  state.accountId=8;await assert.rejects(service.checkout(db,client,1,q.token),/账号已变化/);
  await assert.rejects(service.checkout(db,client,2,q.token),/不存在/);
});
test('Ulzix concurrent checkout and uncertain outcomes never repeat a charge',async t=>{
  const {db,client,state}=fixture(t);const q=await service.quote(db,client,1,67,'1Y');
  let release;state.delay=new Promise(resolve=>{release=resolve;});state.timeout=true;
  const first=service.checkout(db,client,1,q.token);const second=service.checkout(db,client,1,q.token);
  release();const outcomes=await Promise.allSettled([first,second]);assert.ok(outcomes.every(o=>o.status==='rejected'));assert.equal(state.checkouts,1);
  assert.equal(service.list(db)[0].state,'unknown');
  await assert.rejects(service.checkout(db,client,1,q.token),/勿重复/);
  await assert.rejects(service.quote(db,client,1,67,'1Y'),/待核对/);
  const resolved=await service.reconcile(db,client,1,q.token,991);assert.equal(resolved.orderId,991);assert.equal(state.checkouts,1);
});
test('Ulzix cancel removes only the quoted item and leaves other cart items alone',async t=>{
  const {db,client,state}=fixture(t);const q=await service.quote(db,client,1,67,'1Y');
  state.items.push({id:99,product_id:99,quantity:1});await service.cancel(db,client,1,q.token);
  assert.deepEqual(state.items.map(i=>i.id),[99]);assert.deepEqual(state.removed,[12]);assert.equal(state.checkouts,0);
});
