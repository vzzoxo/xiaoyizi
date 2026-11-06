module.exports = session => class DurableSessionStore extends session.Store {
  constructor({ client }) {
    super(); this.db = client;
    client.exec('CREATE TABLE IF NOT EXISTS worker_sessions (sid TEXT PRIMARY KEY, data TEXT NOT NULL, expires INTEGER NOT NULL)');
  }
  get(sid, cb) {
    try {
      const row = this.db.prepare('SELECT data FROM worker_sessions WHERE sid = ? AND expires > ?').get(sid, Date.now());
      cb(null, row ? JSON.parse(row.data) : null);
    } catch (err) { cb(err); }
  }
  set(sid, value, cb = () => {}) {
    try {
      const expires = value.cookie?.expires ? +new Date(value.cookie.expires) : Date.now() + 604800000;
      this.db.prepare('INSERT OR REPLACE INTO worker_sessions VALUES (?, ?, ?)').run(sid, JSON.stringify(value), expires);
      cb(null);
    } catch (err) { cb(err); }
  }
  touch(sid, value, cb) { this.set(sid, value, cb); }
  destroy(sid, cb = () => {}) {
    try { this.db.prepare('DELETE FROM worker_sessions WHERE sid = ?').run(sid); cb(null); }
    catch (err) { cb(err); }
  }
};
