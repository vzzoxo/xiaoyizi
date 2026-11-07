const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {parse}=require('acorn');

function fixture({handlerFails=false,storageFails=false}={}) {
  const source=fs.readFileSync(require.resolve('../workers/entry.mjs'),'utf8');
  const ast=parse(source,{ecmaVersion:'latest',sourceType:'module'});
  const panel=ast.body.find(n=>n.type==='ExportNamedDeclaration'&&n.declaration?.id?.name==='Panel').declaration;
  const method=panel.body.body.find(n=>n.key.name==='fetch');
  const logs=[],stored=new Map();let calls=0,writes=0;
  const fetch=vm.runInNewContext(`({${source.slice(method.start,method.end)}}).fetch`,{
    URL,Response,Uint8Array,TextDecoder,Date,Promise,Number,console:{error:(...args)=>logs.push(args)},
    require:path=>{
      if(path==='../src/utils/securityTokens.js')return require('../src/utils/securityTokens');
      if(path==='./lifetime')return require('../workers/lifetime');
      if(path==='../src/services/tgbot.js')return {async processUpdate(){calls++;if(handlerFails)throw new Error('handler failed after side effects');}};
      throw new Error('Unexpected module: '+path);
    },
  });
  const target={env:{TG_WEBHOOK_SECRET:'test-webhook-secret',TG_BOT_TOKEN:'test-bot-token'},telegramInFlight:new Map(),ctx:{storage:{
    async get(key){return stored.get(key);},async put(key,value){writes++;if(storageFails)throw new Error('storage unavailable');stored.set(key,value);},
  }}};
  return {stored,logs,target,get calls(){return calls;},get writes(){return writes;},send:()=>fetch.call(target,new Request('https://panel.test/telegram/webhook',{method:'POST',headers:{'X-Telegram-Bot-Api-Secret-Token':'test-webhook-secret'},body:JSON.stringify({update_id:42})}))};
}
test('Telegram handler failures are logged and marked handled without repeating side effects',async()=>{
  const f=fixture({handlerFails:true});assert.equal((await f.send()).status,200);
  assert.equal(f.logs.length,1);assert.match(f.logs[0][2].message,/handler failed/);assert.ok(f.stored.has('telegram-update:42'));
  assert.equal((await f.send()).status,200);assert.equal(f.calls,1);assert.equal(f.writes,1);assert.equal(f.target.telegramInFlight.size,0);
});
test('Telegram completion storage failures propagate and leave no handled marker',async()=>{
  for(const handlerFails of [false,true]) {
    const f=fixture({handlerFails,storageFails:true});await assert.rejects(f.send(),/storage unavailable/);
    assert.equal(f.stored.size,0);assert.equal(f.target.telegramInFlight.size,0);assert.equal(f.writes,1);
  }
});
