const test=require('node:test');
const assert=require('node:assert/strict');
const express=require('express');

async function fixture(t,errors={}) {
  const actions=[],logs=[];class BackupError extends Error {}
  const paths=['../workers/backup-routes','../workers/backups','../src/services/database','../src/services/logger'].map(p=>require.resolve(p));
  const previous=paths.map(p=>require.cache[p]);
  const backup={BackupError,createBackup(){actions.push('create');if(errors.create)throw errors.create(BackupError);return 'created.json';},restoreBackup(name){actions.push(['restore',name]);if(errors.restore)throw errors.restore(BackupError);return 'safety.json';}};
  const db={getUserById:()=>errors.missingActor ? null : {id:7},addAuditLog:(...args)=>actions.push(['audit',...args])};
  delete require.cache[paths[0]];
  for(const [i,value]of [[1,backup],[2,db],[3,{error:(...args)=>logs.push(args)}]]) require.cache[paths[i]]={id:paths[i],filename:paths[i],loaded:true,exports:value};
  const router=require('../workers/backup-routes');
  paths.forEach((p,i)=>{if(previous[i])require.cache[p]=previous[i];else delete require.cache[p];});
  const app=express();app.use(express.json());app.use((req,res,next)=>{req.user={id:7};req.clientIp='192.0.2.1';req.session={destroy:callback=>{actions.push('destroy');callback();}};next();});app.use(router);
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  return {actions,logs,post:(route,body)=>fetch(`http://127.0.0.1:${server.address().port}`+route,{method:'POST',...(body===undefined ? {} : {headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})})};
}
test('Worker restore rejects missing body or non-string names before restoring',async t=>{
  const f=await fixture(t);
  for(const body of [undefined,{}, {name:null},{name:42},{name:''}]) {
    const response=await f.post('/backups/restore',body);assert.equal(response.status,400);assert.equal((await response.json()).error,'无效备份名称');
  }
  assert.equal(f.actions.length,0);
});
test('Worker restore audits the operator and snapshot and invalidates the session',async t=>{
  const f=await fixture(t);const r=await f.post('/backups/restore',{name:'old.json'});assert.equal(r.status,200);
  const audit=f.actions.find(a=>a[0]==='audit');assert.equal(audit[1],7);assert.equal(audit[2],'backup_restore');assert.match(audit[3],/old.json.*safety.json/);assert.equal(audit[4],'192.0.2.1');assert.equal(f.actions.at(-1),'destroy');
});
test('Worker restore records the original actor even if absent from the restored snapshot',async t=>{
  const f=await fixture(t,{missingActor:true});assert.equal((await f.post('/backups/restore',{name:'old.json'})).status,200);
  const audit=f.actions.find(a=>a[0]==='audit');assert.equal(audit[1],null);assert.match(audit[3],/#7/);
});
test('Worker backup routes retain actionable expected errors',async t=>{
  const f=await fixture(t,{create:E=>new E('快照超过 8 MiB'),restore:E=>new E('备份不存在')});
  assert.equal((await (await f.post('/backups/create',{})).json()).error,'快照超过 8 MiB');
  const r=await f.post('/backups/restore',{name:'missing.json'});assert.equal(r.status,400);assert.equal((await r.json()).error,'备份不存在');assert.equal(f.logs.length,0);
});
test('Worker backup routes log unexpected failures without returning internal details',async t=>{
  const f=await fixture(t,{create:()=>new Error('private SQL /internal/path'),restore:()=>new Error('private restore stack')});
  for(const route of ['/backups/create','/backups/restore']) {const r=await f.post(route,{name:'old.json'});assert.equal(r.status,500);assert.doesNotMatch((await r.json()).error,/private|internal|stack/);}
  assert.equal(f.logs.length,2);assert.match(f.logs[0][0].err.message,/private SQL/);
});
