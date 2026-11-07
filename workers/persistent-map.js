class PersistentMap {
  /** Select the persistent namespace used by this map or set. */
  constructor(namespace) {this.namespace=namespace;}
  /** Create and return the durable key/value backing table when needed. */
  get db() {
    const db=require('../src/services/database').getDb();
    db.exec('CREATE TABLE IF NOT EXISTS worker_maps (namespace TEXT, key TEXT, value TEXT NOT NULL, PRIMARY KEY(namespace,key))'); return db;
  }
  /** Read and decode a namespaced value, returning undefined when absent. */
  get(key) {const row=this.db.prepare('SELECT value FROM worker_maps WHERE namespace=? AND key=?').get(this.namespace,String(key)); return row ? JSON.parse(row.value) : undefined;}
  /** Check whether the namespaced key has a persisted value. */
  has(key) {return this.get(key) !== undefined;}
  /** Serialize and upsert a namespaced value, preserving Map chaining. */
  set(key,value) {this.db.prepare('INSERT OR REPLACE INTO worker_maps VALUES (?,?,?)').run(this.namespace,String(key),JSON.stringify(value)); return this;}
  /** Delete the namespaced entry and report whether it existed. */
  delete(key) {return Boolean(this.db.prepare('DELETE FROM worker_maps WHERE namespace=? AND key=?').run(this.namespace,String(key)).changes);}
  /** Delete all entries within this map namespace. */
  clear() {this.db.prepare('DELETE FROM worker_maps WHERE namespace=?').run(this.namespace);}
  /** Count entries in this map namespace. */
  get size() {return this.db.prepare('SELECT count(*) AS n FROM worker_maps WHERE namespace=?').get(this.namespace).n;}
  /** Iterate decoded key/value pairs within this map namespace. */
  entries() {return this.db.prepare('SELECT key,value FROM worker_maps WHERE namespace=?').all(this.namespace).map(r=>[r.key,JSON.parse(r.value)])[Symbol.iterator]();}
  [Symbol.iterator]() {return this.entries();}
}
class PersistentSet {
  /** Select the persistent namespace used by this map or set. */
  constructor(namespace) {this.map=new PersistentMap(namespace);}
  /** Check whether the namespaced key has a persisted value. */
  has(key) {return this.map.has(key);}
  /** Persist a set member and return the set for chaining. */
  add(key) {this.map.set(key,true);return this;}
  /** Delete the namespaced entry and report whether it existed. */
  delete(key) {return this.map.delete(key);}
  [Symbol.iterator]() {return [...this.map.entries()].map(([key])=>key)[Symbol.iterator]();}
}
module.exports={PersistentMap,PersistentSet};
