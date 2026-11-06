// Compatibility adapter for the existing synchronous repositories. SQL remains
// synchronous and transactions use Durable Object storage, never /tmp files.
let storage;
function configureStorage(value) { storage = value; }
class Database {
  constructor() {
    if (!storage) throw new Error('Durable Object storage is not initialized');
    this.storage = storage;
    this.sql = storage.sql;
  }
  exec(sql) { this.sql.exec(sql).toArray(); return this; }
  prepare(sql) {
    const execute = (args) => this.sql.exec(sql, ...args.map(v => v === undefined ? null : v));
    return {
      all: (...args) => execute(args).toArray(),
      get: (...args) => execute(args).toArray()[0],
      run: (...args) => {
        execute(args).toArray();
        return this.sql.exec('SELECT changes() AS changes, last_insert_rowid() AS lastInsertRowid').one();
      },
    };
  }
  pragma(statement, options) {
    if (/^(journal_mode|wal_checkpoint)/i.test(statement)) return;
    const rows = this.sql.exec(`PRAGMA ${statement}`).toArray();
    return options?.simple ? Object.values(rows[0] || {})[0] : rows;
  }
  transaction(fn) { return (...args) => this.storage.transactionSync(() => fn(...args)); }
  close() {} // Storage lifetime belongs to the Durable Object.
}
module.exports = { Database, configureStorage };
