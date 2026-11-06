const test=require('node:test');
const assert=require('node:assert/strict');
const {parseCookies,UlzixClient,BASE_URL}=require('../src/services/ulzix');
const cookies=JSON.stringify({fossbilling_session:'test-session',fossbilling_csrf:'test-csrf-token'});
test('Ulzix accepts exported cookie arrays, wrappers, and name/value objects',()=>{
  for(const input of [[{name:'session',value:'test'}],{cookies:[{name:'session',value:'test'}]},{session:'test'}]) assert.equal(parseCookies(JSON.stringify(input)).header,'session=test');
  const parsed=parseCookies([{name:'wrong',value:'secret',domain:'.example.com'},{name:'old',value:'old',expires:1},{name:'session',value:'current',domain:'.ulzix.com'}]);
  assert.equal(parsed.header,'session=current');
});
test('Ulzix rejects invalid JSON and header injection',()=>{
  assert.throws(()=>parseCookies('{'));
  for(const value of ['bad\r\nx: y','bad; leaked=yes','bad value']) assert.throws(()=>parseCookies({session:value}));
});
test('Ulzix sends fixed-origin Client API POST with cookie and CSRF',async()=>{
  const client=new UlzixClient(cookies,async(url,init)=>{
    assert.equal(url,BASE_URL+'/api/client/order/get'); assert.equal(init.method,'POST'); assert.equal(init.redirect,'manual');
    assert.match(init.headers.Cookie,/test-session/); assert.equal(init.headers['X-CSRF-Token'],'test-csrf-token'); assert.equal(init.body.get('id'),'42'); assert.equal(init.body.get('CSRFToken'),'test-csrf-token');
    return Response.json({result:{id:42},error:null});
  });
  assert.deepEqual(await client.call('order/get',{id:42}),{id:42});
  await assert.rejects(client.call('../admin/client/get'),/未支持/);
});
test('Ulzix reads deployed meta CSRF token with the same session',async()=>{
  let calls=0;
  const client=new UlzixClient('{"session":"existing"}',async(url,init)=>{
    calls++;
    if(calls===1) {assert.equal(url,BASE_URL+'/');assert.equal(init.headers.Cookie,'session=existing');return new Response('<meta content="test-session-csrf-token" name="csrf-token">',{headers:{'Set-Cookie':'session=refreshed; HttpOnly; Secure'}});}
    assert.equal(init.headers['X-CSRF-Token'],'test-session-csrf-token'); assert.equal(init.headers.Cookie,'session=refreshed'); return Response.json({result:{id:1},error:null});
  });
  await client.call('order/get',{id:1}); assert.equal(calls,2);
});
test('Ulzix paginates all client orders',async()=>{
  const client=new UlzixClient(cookies,async(url,init)=>{const page=Number(init.body.get('page'));return Response.json({result:{list:[{id:page}],pages:2},error:null});});
  assert.deepEqual(await client.listOrders(),[{id:1},{id:2}]);
});
test('Ulzix rejects redirects and sanitizes upstream errors',async()=>{
  await assert.rejects(new UlzixClient(cookies,async()=>new Response(null,{status:302,headers:{Location:'https://other.test'}})).call('order/get'),/登录态/);
  await assert.rejects(new UlzixClient(cookies,async()=>Response.json({error:{code:403,message:'do-not-leak-cookie'}})).call('order/get'),e=>!e.message.includes('do-not-leak-cookie') && e.message.includes('403'));
  await assert.rejects(new UlzixClient(cookies,async()=>new Response('<html>Login</html>')).call('order/get'),/非 JSON/);
});
