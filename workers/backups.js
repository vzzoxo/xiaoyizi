const {getDb}=require('../src/services/database');
/** An operator-correctable backup size, lookup, or validation failure. */
class BackupError extends Error {}
const MAX_SIZE=8*1024*1024, CHUNK_SIZE=64000;
/** Quote a SQLite identifier without allowing embedded quotes to escape. */
const quote = name => '"'+name.replaceAll('"','""')+'"';
/** Create the persistent snapshot metadata and chunk tables if absent. */
function initialize() {
  getDb().exec(`CREATE TABLE IF NOT EXISTS worker_backups(name TEXT PRIMARY KEY, created_at TEXT NOT NULL, size INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS worker_backup_chunks(name TEXT NOT NULL, seq INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(name,seq));`);
}
/** List application tables while excluding snapshots and platform-owned storage. */
function tables() {return getDb().prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'worker_backup%' AND substr(name,1,4) != '_cf_' ORDER BY name").all().map(r=>r.name);}
/** Persist a bounded, Unicode-safe snapshot transactionally and prune retained backups. */
function createBackup() {
  initialize(); const db=getDb();
  return db.transaction(() => {
    const snapshot={format:'xiaoyizi-worker-v1', tables:{}}; let size=0;
    for(const table of tables()) {
      if(table==='worker_sessions') continue;
      const rows=[];
      for(let offset=0; ; offset+=500) {
        const batch=db.prepare(`SELECT * FROM ${quote(table)} LIMIT 500 OFFSET ?`).all(offset);
        if(!batch.length) break;
        for(const row of batch) {size+=Buffer.byteLength(JSON.stringify(row)); if(size>MAX_SIZE) throw new BackupError('快照超过 8 MiB，请使用 Cloudflare Time Travel 备份'); rows.push(row);}
      }
      snapshot.tables[table]=rows;
    }
    const data=JSON.stringify(snapshot); if(Buffer.byteLength(data)>MAX_SIZE) throw new BackupError('快照超过 8 MiB');
    const created=new Date().toISOString(), name='panel-'+created.replace(/[:.]/g,'-')+'-'+require('node:crypto').randomUUID().slice(0,8)+'.json';
    db.prepare('INSERT INTO worker_backups VALUES (?,?,?)').run(name,created,Buffer.byteLength(data));
    const insert=db.prepare('INSERT INTO worker_backup_chunks VALUES (?,?,?)');
    for(let i=0,seq=0; i<data.length; seq++) {
      let end=Math.min(i+CHUNK_SIZE,data.length);
      if(end<data.length && data.charCodeAt(end-1)>=0xD800 && data.charCodeAt(end-1)<=0xDBFF) end--;
      insert.run(name,seq,data.slice(i,end)); i=end;
    }
    const old=db.prepare("SELECT name FROM worker_backups WHERE datetime(created_at) < datetime('now','-7 days') OR name NOT IN (SELECT name FROM worker_backups ORDER BY created_at DESC LIMIT 14)").all();
    for(const row of old) {db.prepare('DELETE FROM worker_backup_chunks WHERE name=?').run(row.name);db.prepare('DELETE FROM worker_backups WHERE name=?').run(row.name);}
    return name;
  })();
}
/** Reassemble an existing snapshot from ordered persistent chunks, or return null. */
function readBackup(name) {
  initialize(); const db=getDb();
  if(!db.prepare('SELECT name FROM worker_backups WHERE name=?').get(name)) return null;
  return db.prepare('SELECT data FROM worker_backup_chunks WHERE name=? ORDER BY seq').all(name).map(r=>r.data).join('');
}
/** Validate and transactionally restore a snapshot after saving the current data. */
function restoreBackup(name) {
  const data=readBackup(name); if(!data) throw new BackupError('备份不存在');
  let snapshot;
  try { snapshot=JSON.parse(data); } catch { throw new BackupError('无效备份格式'); }
  if(!snapshot || snapshot.format!=='xiaoyizi-worker-v1') throw new BackupError('无效备份格式');
  if(!snapshot.tables || typeof snapshot.tables!=='object' || Array.isArray(snapshot.tables)) throw new BackupError('备份数据结构无效');
  const db=getDb(), allowed=tables();
  for(const [table,rows] of Object.entries(snapshot.tables)) if(!allowed.includes(table) || !Array.isArray(rows)) throw new BackupError('备份数据结构无效');
  const safetyBackup=createBackup();
  db.transaction(()=>{
    db.exec('PRAGMA defer_foreign_keys = ON');
    for(const table of allowed) db.exec(`DELETE FROM ${quote(table)}`);
    for(const [table,rows] of Object.entries(snapshot.tables)) {
      const columns=db.prepare(`PRAGMA table_info(${quote(table)})`).all().map(c=>c.name);
      for(const row of rows) {
        const keys=Object.keys(row); if(keys.some(k=>!columns.includes(k))) throw new BackupError('备份字段与当前版本不兼容');
        db.prepare(`INSERT INTO ${quote(table)} (${keys.map(quote).join(',')}) VALUES (${keys.map(()=>'?').join(',')})`).run(...keys.map(k=>row[k]));
      }
    }
  })();
  return safetyBackup;
}
module.exports={BackupError,initialize,createBackup,readBackup,restoreBackup};
