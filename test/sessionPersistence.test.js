const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const express = require('express');
const session = require('express-session');
const Database = require('better-sqlite3');
const SqliteStore = require('better-sqlite3-session-store')(session);

// 上游库会启动定时清理 interval 且不 unref，测试进程会被常驻句柄阻塞退出。
SqliteStore.prototype.startInterval = function startIntervalForTest() {
  const timer = setInterval(
    this.clearExpiredSessions.bind(this),
    this.expired.intervalMs
  );
  if (typeof timer.unref === 'function') timer.unref();
};

if (!process.env.SESSION_SECRET) {
  process.env.SESSION_SECRET = 'test-session-secret';
}
// env stubs removed (OAuth removed)

async function startServer(app) {
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const addr = server.address();
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  return { server, baseUrl };
}

async function withMockedDatabaseForAdmin(fn) {
  const dbPath = require.resolve('../src/services/database');
  const prevDb = require.cache[dbPath];
  const purged = [];
  for (const k of Object.keys(require.cache)) {
    if (
      k.includes('/src/routes/admin') ||
      k.endsWith('/src/routes/adminApi.js') ||
      k.endsWith('/src/middleware/auth.js')
    ) {
      purged.push([k, require.cache[k]]);
      delete require.cache[k];
    }
  }

  const adminUser = { id: 1, username: 'admin', is_admin: 1, is_blocked: 0 };
  const mockDb = {
    getDb: () => ({
      prepare: () => ({ run: () => ({ changes: 1 }) }),
    }),
    getUserById: (id) => (Number(id) === 1 ? { ...adminUser } : null),
    getAllUsersPaged: () => ({ rows: [{ id: 1, username: 'admin' }], total: 1 }),
    setSetting: () => {},
    addAuditLog: () => {},
  };
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: mockDb };

  try {
    await fn();
  } finally {
    delete require.cache[dbPath];
    if (prevDb) require.cache[dbPath] = prevDb;
    for (const [k, v] of purged) {
      require.cache[k] = v;
    }
  }
}

test('persistent sqlite session survives server restart for admin api', async (t) => {
  await withMockedDatabaseForAdmin(async () => {
    const { setupAuth } = require('../src/middleware/auth');
    const adminApiRoutes = require('../src/routes/adminApi');
    const { csrfProtection } = require('../src/middleware/csrf');

    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'vless-session-'));
    const sessionDbPath = path.join(dir, 'sessions.db');
    const sessionDb = new Database(sessionDbPath);

    t.after(async () => {
      try { sessionDb.close(); } catch (_) {}
      await fsp.rm(dir, { recursive: true, force: true });
    });

    const buildApp = () => {
      const app = express();
      app.use(express.json());
      app.use(session({
        store: new SqliteStore({ client: sessionDb }),
        secret: 'test-session-secret',
        resave: false,
        saveUninitialized: false,
      }));
      setupAuth(app);
      app.post('/test-login', (req, res, next) => {
        req.logIn({ id: 1, is_admin: 1, is_blocked: 0 }, (err) => {
          if (err) return next(err);
          req.session.csrfToken = 'session-test-csrf-token';
        req.session.save(err => err ? next(err) : res.json({ ok: true }));
        });
      });
      app.use('/admin/api', csrfProtection, adminApiRoutes);
      return app;
    };

    const first = await startServer(buildApp());
    const loginResp = await fetch(`${first.baseUrl}/test-login`, { method: 'POST' });
    assert.equal(loginResp.status, 200);
    const cookie = (loginResp.headers.get('set-cookie') || '').split(';')[0];
    assert.ok(cookie.includes('connect.sid='));
    await new Promise((resolve) => first.server.close(resolve));

    const second = await startServer(buildApp());
    t.after(() => new Promise((resolve) => second.server.close(resolve)));

    const usersResp = await fetch(`${second.baseUrl}/admin/api/users`, {
      headers: { Cookie: cookie },
    });
    assert.equal(usersResp.status, 200);
    const usersData = await usersResp.json();
    assert.equal(usersData.total, 1);

    const postResp = await fetch(`${second.baseUrl}/admin/api/default-traffic-limit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
        Origin: second.baseUrl,
        'X-CSRF-Token': 'session-test-csrf-token',
      },
      body: JSON.stringify({ limit: 1 }),
    });
    assert.equal(postResp.status, 200);
    assert.deepEqual(await postResp.json(), { ok: true });
  });
});
