class PersistentMap {
  constructor(namespace) {this.namespace=namespace;}
  get db() {
    const db=require('../src/services/database').getDb();
    db.exec('CREATE TABLE IF NOT EXISTS worker_maps (namespace TEXT, key TEXT, value TEXT NOT NULL, PRIMARY KEY(namespace,key))'); return db;
  }
  get(key) {const row=this.db.prepare('SELECT value FROM worker_maps WHERE namespace=? AND key=?').get(this.namespace,String(key)); return row ? JSON.parse(row.value) : undefined;}
  has(key) {return this.get(key) !== undefined;}
  set(key,value) {this.db.prepare('INSERT OR REPLACE INTO worker_maps VALUES (?,?,?)').run(this.namespace,String(key),JSON.stringify(value)); return this;}
  delete(key) {return Boolean(this.db.prepare('DELETE FROM worker_maps WHERE namespace=? AND key=?').run(this.namespace,String(key)).changes);}
  clear() {this.db.prepare('DELETE FROM worker_maps WHERE namespace=?').run(this.namespace);}
  get size() {return this.db.prepare('SELECT count(*) AS n FROM worker_maps WHERE namespace=?').get(this.namespace).n;}
  entries() {return this.db.prepare('SELECT key,value FROM worker_maps WHERE namespace=?').all(this.namespace).map(r=>[r.key,JSON.parse(r.value)])[Symbol.iterator]();}
  [Symbol.iterator]() {return this.entries();}
}
class PersistentSet {
  constructor(namespace) {this.map=new PersistentMap(namespace);}
  has(key) {return this.map.has(key);}
  add(key) {this.map.set(key,true);return this;}
  delete(key) {return this.map.delete(key);}
  [Symbol.iterator]() {return [...this.map.entries()].map(([key])=>key)[Symbol.iterator]();}
}
module.exports={PersistentMap,PersistentSet};
