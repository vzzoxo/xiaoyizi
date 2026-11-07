const test=require('node:test');
const assert=require('node:assert/strict');
const Database=require('better-sqlite3');
const fs=require('node:fs');
const settings=require('../src/services/ulzixSettings');
/** Exercise the D1 prepared-statement contract with real SQLite storage. */
function adapter(db) {
  return {prepare(sql) {return {bind(...args) {return {first:async()=>db.prepare(sql).get(...args) || null,run:async()=>db.prepare(sql).run(...args)};}};}};
}
test('D1 cookie updates encrypt, decrypt, reject bad input, and recover from key changes',async()=>{
  const db=new Database(':memory:');
  db.exec(fs.readFileSync('migrations/0001_integration_credentials.sql','utf8'));
  const binding=adapter(db);
  settings.configure(binding,'test-encryption-secret');
  assert.equal(await settings.read(),null);
  const first=JSON.stringify({session:'test-first-secret'});
  await settings.save(first);
  assert.equal(await settings.read(),first);
  assert.ok(!JSON.stringify(await settings.status()).includes('test-first-secret'));
  const row=db.prepare('SELECT encrypted_value FROM integration_credentials').get();
  assert.ok(!row.encrypted_value.includes('test-first-secret'));
  await assert.rejects(settings.save('{'));
  assert.equal(await settings.read(),first);
  const second=JSON.stringify({session:'test-second-secret'});
  await settings.save(second);
  assert.equal(await settings.read(),second,'Read fresh credentials without reconfiguration');
  settings.configure(binding,'changed-secret');
  await assert.rejects(settings.read(),/解密失败/);
  await settings.save(first);
  assert.equal(await settings.read(),first);
  settings.configure(null);
  db.close();
});
