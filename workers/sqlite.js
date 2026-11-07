// Compatibility adapter for the existing synchronous repositories. SQL remains
// synchronous and transactions use Durable Object storage, never /tmp files.
let storage;
/** Bind the singleton panel database adapter to its Durable Object storage. */
function configureStorage(value) { storage = value; }
/**
 * Compile named placeholders to positional slots in SQL occurrence order.
 * Quoted literals/identifiers and comments are copied without interpreting names.
 */
function namedBindings(sql) {
  const names=[];
  const query=sql.replace(/'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|--[^\r\n]*|\/\*[\s\S]*?\*\/|([@:$][A-Za-z_][A-Za-z0-9_]*)/g,(token,name)=>{
    if(!name) return token;
    names.push(name);
    return '?';
  });
  return {query,names};
}
class Database {
  /** Use the configured Durable Object SQL storage instead of a local database file. */
  constructor() {
    if (!storage) throw new Error('Durable Object storage is not initialized');
    this.storage = storage;
    this.sql = storage.sql;
  }
  /** Execute schema or maintenance SQL and consume its cursor. */
  exec(sql) { this.sql.exec(sql).toArray(); return this; }
  /** Expose synchronous statement methods with positional or named-object bindings. */
  prepare(sql) {
    const named=namedBindings(sql);
    /** Bind named values in SQL order; ignore unused search fields in unfiltered queries. */
    const execute = (args) => {
      const parameters=args[0];
      const objectStyle=args.length===1 && parameters!==null && typeof parameters==='object' && !Array.isArray(parameters) && !ArrayBuffer.isView(parameters) && !(parameters instanceof ArrayBuffer);
      const values=objectStyle ? named.names.map(name=>{
        const key=Object.hasOwn(parameters,name) ? name : name.slice(1);
        if(!Object.hasOwn(parameters,key)) throw new TypeError(`Missing named SQL parameter: ${name}`);
        return parameters[key];
      }) : args;
      return this.sql.exec(objectStyle ? named.query : sql, ...values.map(v => v === undefined ? null : v));
    };
    return {
      all: (...args) => execute(args).toArray(),
      get: (...args) => execute(args).toArray()[0],
      run: (...args) => {
        execute(args).toArray();
        return this.sql.exec('SELECT changes() AS changes, last_insert_rowid() AS lastInsertRowid').one();
      },
    };
  }
  /** Apply supported SQLite pragmas while ignoring file-only WAL operations. */
  pragma(statement, options) {
    if (/^(journal_mode|wal_checkpoint)/i.test(statement)) return;
    const rows = this.sql.exec(`PRAGMA ${statement}`).toArray();
    return options?.simple ? Object.values(rows[0] || {})[0] : rows;
  }
  /** Wrap a synchronous repository callback in a durable storage transaction. */
  transaction(fn) { return (...args) => this.storage.transactionSync(() => fn(...args)); }
  /** Leave database lifetime management to its owning Durable Object. */
  close() {} // Storage lifetime belongs to the Durable Object.
}
module.exports = { Database, configureStorage };
