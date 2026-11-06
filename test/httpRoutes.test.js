const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const session = require('express-session');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');

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

async function withMockedAdminBackupRouter(mocks, fn) {
  const routePath = require.resolve('../src/routes/admin/adminBackup');
  const dbPath = require.resolve('../src/services/database');
  const backupPath = require.resolve('../src/services/backup');
  const backupRestorePath = require.resolve('../src/services/backupRestore');

  const prev = {
    route: require.cache[routePath],
    db: require.cache[dbPath],
    backup: require.cache[backupPath],
    backupRestore: require.cache[backupRestorePath],
  };

  delete require.cache[routePath];
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: mocks.db };
  require.cache[backupPath] = { id: backupPath, filename: backupPath, loaded: true, exports: mocks.backup };
  require.cache[backupRestorePath] = { id: backupRestorePath, filename: backupRestorePath, loaded: true, exports: mocks.backupRestore };

  try {
    const router = require('../src/routes/admin/adminBackup');
    await fn(router);
  } finally {
    delete require.cache[routePath];
    if (prev.route) require.cache[routePath] = prev.route; else delete require.cache[routePath];
    if (prev.db) require.cache[dbPath] = prev.db; else delete require.cache[dbPath];
    if (prev.backup) require.cache[backupPath] = prev.backup; else delete require.cache[backupPath];
    if (prev.backupRestore) require.cache[backupRestorePath] = prev.backupRestore; else delete require.cache[backupRestorePath];
  }
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

test('GET /sub/:token rejects unknown UA in enforce mode', async (t) => {
  const oldMode = process.env.SUB_CLIENT_FILTER_MODE;
  process.env.SUB_CLIENT_FILTER_MODE = 'enforce';
  const db = require('../src/services/database');
  t.mock.method(db, 'getUserBySubToken', (token) => (
    token === 'test-token'
      ? { id: 1, username: 'tester', sub_token: token, is_blocked: 0, is_frozen: 0 }
      : null
  ));
  t.mock.method(db, 'getAllNodes', () => []);
  t.mock.method(db, 'logSubAccess', () => {});
  t.mock.method(db, 'logSubAccessEvent', () => {});
  t.mock.method(db, 'getSetting', () => null);

  const subRoutePath = require.resolve('../src/routes/subscription');
  delete require.cache[subRoutePath];
  const subRoutes = require('../src/routes/subscription');

  const app = express();
  app.use('/', subRoutes);
  const { server, baseUrl } = await startServer(app);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  t.after(() => {
    if (oldMode == null) delete process.env.SUB_CLIENT_FILTER_MODE;
    else process.env.SUB_CLIENT_FILTER_MODE = oldMode;
    delete require.cache[subRoutePath];
  });

  const resp = await fetch(`${baseUrl}/sub/test-token`, {
    headers: { 'User-Agent': 'SomeBot/1.0' },
  });
  assert.equal(resp.status, 403);
  const text = await resp.text();
  assert.equal(text, '订阅请求被拒绝');
});

test('POST /admin/backups/restore validates filename contract', async (t) => {
  const app = express();
  app.use(express.json());
  app.use('/admin', require('../src/routes/admin/adminBackup'));

  const { server, baseUrl } = await startServer(app);
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const resp = await fetch(`${baseUrl}/admin/backups/restore`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '../evil.db' }),
  });
  assert.equal(resp.status, 400);
  const data = await resp.json();
  assert.deepEqual(data, { error: '无效文件名' });
});

test('POST /admin/backups/create returns success contract when backup succeeds', async (t) => {
  await withMockedAdminBackupRouter({
    db: {
      getDb: () => ({}),
      addAuditLog: () => {},
    },
    backup: {
      BACKUP_DIR: '/tmp',
      performBackup: async () => ({ ok: true, backupPath: '/tmp/panel-test.db' }),
    },
    backupRestore: {
      restoreDatabaseFromBackup: async () => ({ ok: true, message: 'ok' }),
    },
  }, async (router) => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = { id: 1 };
      req.clientIp = '127.0.0.1';
      next();
    });
    app.use('/admin', router);

    const { server, baseUrl } = await startServer(app);
    t.after(() => new Promise((resolve) => server.close(resolve)));

    const resp = await fetch(`${baseUrl}/admin/backups/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(resp.status, 200);
    const data = await resp.json();
    assert.deepEqual(data, { ok: true, backup: 'panel-test.db' });
  });
});

test('POST /admin/backups/restore returns success contract when restore succeeds', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'vless-admin-backup-'));
  const backupName = 'panel-success.db';
  const backupPath = path.join(dir, backupName);
  await fsp.writeFile(backupPath, 'sqlite', 'utf8');

  t.after(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  await withMockedAdminBackupRouter({
    db: {
      addAuditLog: () => {},
    },
    backup: {
      BACKUP_DIR: dir,
      performBackup: async () => ({ ok: true, backupPath }),
    },
    backupRestore: {
      restoreDatabaseFromBackup: async () => ({ ok: true, message: '数据库恢复成功' }),
    },
  }, async (router) => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = { id: 1 };
      req.clientIp = '127.0.0.1';
      next();
    });
    app.use('/admin', router);

    const { server, baseUrl } = await startServer(app);
    t.after(() => new Promise((resolve) => server.close(resolve)));

    const resp = await fetch(`${baseUrl}/admin/backups/restore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: backupName }),
    });
    assert.equal(resp.status, 200);
    const data = await resp.json();
    assert.deepEqual(data, { ok: true, message: '数据库恢复成功' });
  });
});

test('GET /admin/api/users redirects to login when unauthenticated', async (t) => {
  const app = express();
  app.use((req, _res, next) => {
    req.isAuthenticated = () => false;
    next();
  });
  app.use('/admin/api', require('../src/routes/adminApi'));

  const { server, baseUrl } = await startServer(app);
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const resp = await fetch(`${baseUrl}/admin/api/users`, { redirect: 'manual' });
  assert.equal(resp.status, 302);
  assert.equal(resp.headers.get('location'), '/auth/login');
});

test('csrfProtection rejects json request when Origin is missing or mismatched', async (t) => {
  const { csrfProtection } = require('../src/middleware/csrf');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.isAuthenticated = () => true;
    req.user = { id: 1, is_admin: 1, is_blocked: 0 };
    req.session = {};
    next();
  });
  app.post('/admin/api/ping', csrfProtection, (_req, res) => res.json({ ok: true }));

  const { server, baseUrl } = await startServer(app);
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const r1 = await fetch(`${baseUrl}/admin/api/ping`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ a: 1 }),
  });
  assert.equal(r1.status, 403);
  assert.deepEqual(await r1.json(), { error: 'CSRF 校验失败：请刷新页面重试' });

  const r2 = await fetch(`${baseUrl}/admin/api/ping`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'http://evil.example',
    },
    body: JSON.stringify({ a: 1 }),
  });
  assert.equal(r2.status, 403);
  assert.deepEqual(await r2.json(), { error: 'CSRF 校验失败：请刷新页面重试' });
});

test('csrfProtection rejects form submission when csrf token is missing', async (t) => {
  const { csrfProtection } = require('../src/middleware/csrf');
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use((req, _res, next) => {
    req.isAuthenticated = () => true;
    req.user = { id: 1, is_admin: 1, is_blocked: 0 };
    req.session = { csrfToken: 'known-token' };
    next();
  });
  app.post('/admin/api/form', csrfProtection, (_req, res) => res.json({ ok: true }));

  const { server, baseUrl } = await startServer(app);
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const resp = await fetch(`${baseUrl}/admin/api/form`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'x=1',
  });
  assert.equal(resp.status, 403);
  assert.deepEqual(await resp.json(), { error: 'CSRF token 无效，请刷新页面重试' });
});

test('admin api success path works with session login and csrf', async (t) => {
  await withMockedDatabaseForAdmin(async () => {
    const { setupAuth } = require('../src/middleware/auth');
    const adminApiRoutes = require('../src/routes/adminApi');
    const { csrfProtection } = require('../src/middleware/csrf');

    const app = express();
    app.use(express.json());
    app.use(session({
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

    const { server, baseUrl } = await startServer(app);
    t.after(() => new Promise((resolve) => server.close(resolve)));

    const loginResp = await fetch(`${baseUrl}/test-login`, { method: 'POST' });
    assert.equal(loginResp.status, 200);
    const cookie = (loginResp.headers.get('set-cookie') || '').split(';')[0];
    assert.ok(cookie.includes('connect.sid='));

    const usersResp = await fetch(`${baseUrl}/admin/api/users`, {
      headers: { Cookie: cookie },
    });
    assert.equal(usersResp.status, 200);
    const usersData = await usersResp.json();
    assert.equal(usersData.total, 1);

    const postResp = await fetch(`${baseUrl}/admin/api/default-traffic-limit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
        Origin: baseUrl,
        'X-CSRF-Token': 'session-test-csrf-token',
      },
      body: JSON.stringify({ limit: 1 }),
    });
    assert.equal(postResp.status, 200);
    assert.deepEqual(await postResp.json(), { ok: true });
  });
});
