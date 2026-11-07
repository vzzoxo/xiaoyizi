const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const crypto = require('crypto');
const Database = require('better-sqlite3');

if (!process.env.SESSION_SECRET) {
  process.env.SESSION_SECRET = 'test-session-secret';
}

function buildInitData(token, authDate, user) {
  const params = new URLSearchParams();
  params.set('auth_date', String(authDate));
  params.set('query_id', 'AAEAAAE');
  params.set('user', JSON.stringify(user));
  const entries = [...params.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const dataCheckString = entries.map(([k, v]) => `${k}=${v}`).join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
  const hash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  params.set('hash', hash);
  return params.toString();
}

async function startServer(app) {
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const addr = server.address();
  return {
    server,
    baseUrl: `http://127.0.0.1:${addr.port}`,
  };
}

async function withMockedRpsRoute(mockDb, fn) {
  const routePath = require.resolve('../src/routes/rpsGame');
  const dbPath = require.resolve('../src/services/database');
  const rateLimitPath = require.resolve('../src/middleware/rateLimit');
  const prevRoute = require.cache[routePath];
  const prevDb = require.cache[dbPath];
  const prevRateLimit = require.cache[rateLimitPath];

  delete require.cache[routePath];
  delete require.cache[rateLimitPath];
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: mockDb };

  try {
    const route = require('../src/routes/rpsGame');
    await fn(route);
  } finally {
    delete require.cache[routePath];
    delete require.cache[rateLimitPath];
    if (prevRoute) require.cache[routePath] = prevRoute; else delete require.cache[routePath];
    if (prevDb) require.cache[dbPath] = prevDb; else delete require.cache[dbPath];
    if (prevRateLimit) require.cache[rateLimitPath] = prevRateLimit; else delete require.cache[rateLimitPath];
  }
}

async function withMockedLuckyRoute(mockDb, fn) {
  const routePath = require.resolve('../src/routes/luckyWheel');
  const dbPath = require.resolve('../src/services/database');
  const rateLimitPath = require.resolve('../src/middleware/rateLimit');
  const prevRoute = require.cache[routePath];
  const prevDb = require.cache[dbPath];
  const prevRateLimit = require.cache[rateLimitPath];

  delete require.cache[routePath];
  delete require.cache[rateLimitPath];
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: mockDb };

  try {
    const route = require('../src/routes/luckyWheel');
    await fn(route);
  } finally {
    delete require.cache[routePath];
    delete require.cache[rateLimitPath];
    if (prevRoute) require.cache[routePath] = prevRoute; else delete require.cache[routePath];
    if (prevDb) require.cache[dbPath] = prevDb; else delete require.cache[dbPath];
    if (prevRateLimit) require.cache[rateLimitPath] = prevRateLimit; else delete require.cache[rateLimitPath];
  }
}

test('verifyTgInitData rejects stale initData and accepts fresh initData', async (t) => {
  const oldToken = process.env.TG_BOT_TOKEN;
  process.env.TG_BOT_TOKEN = 'tg-test-token';
  t.after(() => {
    if (oldToken == null) delete process.env.TG_BOT_TOKEN;
    else process.env.TG_BOT_TOKEN = oldToken;
  });

  await withMockedRpsRoute({}, async (route) => {
    const nowSec = Math.floor(Date.now() / 1000);
    const user = { id: 1001, username: 'alice' };
    const fresh = buildInitData(process.env.TG_BOT_TOKEN, nowSec, user);
    const stale = buildInitData(process.env.TG_BOT_TOKEN, nowSec - (route._test.TG_INITDATA_MAX_AGE_SEC + 5), user);

    assert.deepEqual(route._test.verifyTgInitData(fresh, nowSec * 1000), user);
    assert.equal(route._test.verifyTgInitData(stale, nowSec * 1000), null);
  });
});

test('weekKey uses Shanghai Monday boundary', async () => {
  const oldToken = process.env.TG_BOT_TOKEN;
  delete process.env.TG_BOT_TOKEN;

  try {
    delete require.cache[require.resolve('../src/services/tgbot')];
    const tg = require('../src/services/tgbot');

    assert.equal(tg._test.weekKey(new Date('2026-01-04T16:30:00Z')), '2026-01-05');
    assert.equal(tg._test.weekKey(new Date('2026-01-04T15:30:00Z')), '2025-12-29');
  } finally {
    delete require.cache[require.resolve('../src/services/tgbot')];
    if (oldToken == null) delete process.env.TG_BOT_TOKEN;
    else process.env.TG_BOT_TOKEN = oldToken;
  }
});

test('POST /api/rps-play enforces daily limit across route reloads', async (t) => {
  const oldToken = process.env.TG_BOT_TOKEN;
  process.env.TG_BOT_TOKEN = 'tg-test-token';

  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      telegram_id TEXT,
      traffic_limit INTEGER NOT NULL
    );
    CREATE TABLE tg_rps_daily (
      user_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      plays INTEGER NOT NULL DEFAULT 0,
      net_gb REAL NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, date)
    );
    CREATE TABLE traffic_user_total (
      user_id INTEGER PRIMARY KEY,
      total_up INTEGER DEFAULT 0,
      total_down INTEGER DEFAULT 0
    );
    CREATE TABLE tg_checkin (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      amount INTEGER NOT NULL
    );
  `);
  sqlite.prepare('INSERT INTO users (id, telegram_id, traffic_limit) VALUES (?, ?, ?)').run(1, '2001', 50 * 1073741824);
  sqlite.prepare('INSERT INTO traffic_user_total (user_id, total_up, total_down) VALUES (?, 0, 0)').run(1);

  const mockDb = {
    getDb: () => sqlite,
    getUserById: (id) => sqlite.prepare('SELECT * FROM users WHERE id = ?').get(id),
  };

  t.after(() => {
    sqlite.close();
    if (oldToken == null) delete process.env.TG_BOT_TOKEN;
    else process.env.TG_BOT_TOKEN = oldToken;
  });

  const initData = buildInitData(process.env.TG_BOT_TOKEN, Math.floor(Date.now() / 1000), { id: 2001, username: 'alice' });

  async function playOnce(baseUrl) {
    const resp = await fetch(`${baseUrl}/api/rps-play`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initData, choice: 0 }),
    });
    return resp.json();
  }

  await withMockedRpsRoute(mockDb, async (route) => {
    const app = express();
    app.use('/', route);
    const { server, baseUrl } = await startServer(app);
    t.after(() => new Promise((resolve) => server.close(resolve)));

    for (let i = 0; i < 20; i++) {
      const data = await playOnce(baseUrl);
      assert.equal(data.ok, true);
    }
  });

  await withMockedRpsRoute(mockDb, async (route) => {
    const app = express();
    app.use('/', route);
    const { server, baseUrl } = await startServer(app);
    t.after(() => new Promise((resolve) => server.close(resolve)));

    const blocked = await playOnce(baseUrl);
    assert.equal(blocked.ok, false);
    assert.match(blocked.error, /今日已玩 20 次/);

    const row = sqlite.prepare('SELECT plays FROM tg_rps_daily WHERE user_id = ?').get(1);
    assert.equal(row.plays, 20);
  });
});

test('POST /api/rps-play returns current profile when daily limit is reached', async (t) => {
  const oldToken = process.env.TG_BOT_TOKEN;
  process.env.TG_BOT_TOKEN = 'tg-test-token';

  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      telegram_id TEXT,
      traffic_limit INTEGER NOT NULL
    );
    CREATE TABLE tg_rps_daily (
      user_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      plays INTEGER NOT NULL DEFAULT 0,
      net_gb REAL NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, date)
    );
    CREATE TABLE traffic_user_total (
      user_id INTEGER PRIMARY KEY,
      total_up INTEGER DEFAULT 0,
      total_down INTEGER DEFAULT 0
    );
    CREATE TABLE tg_checkin (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      amount INTEGER NOT NULL
    );
  `);
  sqlite.prepare('INSERT INTO users (id, telegram_id, traffic_limit) VALUES (?, ?, ?)').run(1, '3001', 12 * 1073741824);
  sqlite.prepare('INSERT INTO traffic_user_total (user_id, total_up, total_down) VALUES (?, 3, 4)').run(1);
  sqlite.prepare('INSERT INTO tg_rps_daily (user_id, date, plays, net_gb) VALUES (?, ?, ?, ?)').run(1, '2026-03-13', 20, 5);

  const mockDb = {
    getDb: () => sqlite,
    getUserById: (id) => sqlite.prepare('SELECT * FROM users WHERE id = ?').get(id),
  };

  t.after(() => {
    sqlite.close();
    if (oldToken == null) delete process.env.TG_BOT_TOKEN;
    else process.env.TG_BOT_TOKEN = oldToken;
  });

  const initData = buildInitData(process.env.TG_BOT_TOKEN, Math.floor(Date.now() / 1000), { id: 3001, username: 'bob' });

  await withMockedRpsRoute(mockDb, async (route) => {
    sqlite.prepare('DELETE FROM tg_rps_daily').run();
    sqlite.prepare('INSERT INTO tg_rps_daily (user_id, date, plays, net_gb) VALUES (?, ?, ?, ?)').run(1, route._test.today(), 20, 5);
    const app = express();
    app.use('/', route);
    const { server, baseUrl } = await startServer(app);
    t.after(() => new Promise((resolve) => server.close(resolve)));

    const resp = await fetch(`${baseUrl}/api/rps-play`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initData, choice: 0 }),
    });
    const data = await resp.json();
    assert.equal(data.ok, false);
    assert.match(data.error, /今日已玩 20 次/);
    assert.equal(data.playsLeft, 0);
    assert.equal(data.remainingGB, 12);
    assert.equal(data.dayNetGb, 5);
  });
});

test('POST /api/flip-draw returns current profile when daily limit is reached', async (t) => {
  const oldToken = process.env.TG_BOT_TOKEN;
  process.env.TG_BOT_TOKEN = 'tg-test-token';

  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      telegram_id TEXT,
      traffic_limit INTEGER NOT NULL
    );
    CREATE TABLE tg_flip_daily (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      card_index INTEGER NOT NULL,
      prize_label TEXT NOT NULL,
      amount_bytes INTEGER NOT NULL,
      amount_gb REAL NOT NULL DEFAULT 0
    );
    CREATE TABLE traffic_user_total (
      user_id INTEGER PRIMARY KEY,
      total_up INTEGER DEFAULT 0,
      total_down INTEGER DEFAULT 0
    );
  `);
  sqlite.prepare('INSERT INTO users (id, telegram_id, traffic_limit) VALUES (?, ?, ?)').run(1, '4001', 6 * 1073741824);
  sqlite.prepare('INSERT INTO traffic_user_total (user_id, total_up, total_down) VALUES (?, 0, 0)').run(1);

  const mockDb = {
    getDb: () => sqlite,
    getUserById: (id) => sqlite.prepare('SELECT * FROM users WHERE id = ?').get(id),
  };

  t.after(() => {
    sqlite.close();
    if (oldToken == null) delete process.env.TG_BOT_TOKEN;
    else process.env.TG_BOT_TOKEN = oldToken;
  });

  const initData = buildInitData(process.env.TG_BOT_TOKEN, Math.floor(Date.now() / 1000), { id: 4001, username: 'flip-user' });

  const routePath = require.resolve('../src/routes/flipGame');
  const dbPath = require.resolve('../src/services/database');
  const prevRoute = require.cache[routePath];
  const prevDb = require.cache[dbPath];
  delete require.cache[routePath];
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: mockDb };

  try {
    const route = require('../src/routes/flipGame');
    sqlite.prepare('INSERT INTO tg_flip_daily (user_id, date, card_index, prize_label, amount_bytes, amount_gb) VALUES (?, ?, ?, ?, ?, ?)').run(1, route._test.today(), 0, 'A', 1073741824, 1);
    sqlite.prepare('INSERT INTO tg_flip_daily (user_id, date, card_index, prize_label, amount_bytes, amount_gb) VALUES (?, ?, ?, ?, ?, ?)').run(1, route._test.today(), 1, 'B', 2147483648, 2);
    sqlite.prepare('INSERT INTO tg_flip_daily (user_id, date, card_index, prize_label, amount_bytes, amount_gb) VALUES (?, ?, ?, ?, ?, ?)').run(1, route._test.today(), 2, 'C', 0, 0);

    const app = express();
    app.use('/', route);
    const { server, baseUrl } = await startServer(app);
    t.after(() => new Promise((resolve) => server.close(resolve)));

    const resp = await fetch(`${baseUrl}/api/flip-draw`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initData, cardIndex: 3 }),
    });
    const data = await resp.json();
    assert.equal(data.ok, false);
    assert.match(data.error, /今日翻卡次数已用完/);
    assert.equal(data.playsLeft, 0);
    assert.equal(data.remainingGB, 6);
    assert.equal(data.netGb, 3);
  } finally {
    delete require.cache[routePath];
    if (prevRoute) require.cache[routePath] = prevRoute; else delete require.cache[routePath];
    if (prevDb) require.cache[dbPath] = prevDb; else delete require.cache[dbPath];
  }
});

test('POST /api/lucky-spin returns current profile when weekly chance is used', async (t) => {
  const oldToken = process.env.TG_BOT_TOKEN;
  process.env.TG_BOT_TOKEN = 'tg-test-token';

  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      telegram_id TEXT,
      traffic_limit INTEGER NOT NULL
    );
    CREATE TABLE tg_lucky (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      week TEXT NOT NULL,
      prize TEXT NOT NULL,
      amount INTEGER NOT NULL,
      UNIQUE(user_id, week)
    );
    CREATE TABLE traffic_user_total (
      user_id INTEGER PRIMARY KEY,
      total_up INTEGER DEFAULT 0,
      total_down INTEGER DEFAULT 0
    );
  `);
  sqlite.prepare('INSERT INTO users (id, telegram_id, traffic_limit) VALUES (?, ?, ?)').run(1, '5001', 30 * 1073741824);
  sqlite.prepare('INSERT INTO traffic_user_total (user_id, total_up, total_down) VALUES (?, 0, 0)').run(1);

  const mockDb = {
    getDb: () => sqlite,
    getUserById: (id) => sqlite.prepare('SELECT * FROM users WHERE id = ?').get(id),
  };

  t.after(() => {
    sqlite.close();
    if (oldToken == null) delete process.env.TG_BOT_TOKEN;
    else process.env.TG_BOT_TOKEN = oldToken;
  });

  const initData = buildInitData(process.env.TG_BOT_TOKEN, Math.floor(Date.now() / 1000), { id: 5001, username: 'wheel-user' });

  await withMockedLuckyRoute(mockDb, async (route) => {
    sqlite.prepare('INSERT INTO tg_lucky (user_id, week, prize, amount) VALUES (?, ?, ?, ?)').run(1, route._test.weekKey(), '大奖 50GB', 50 * 1073741824);

    const app = express();
    app.use('/', route);
    const { server, baseUrl } = await startServer(app);
    t.after(() => new Promise((resolve) => server.close(resolve)));

    const resp = await fetch(`${baseUrl}/api/lucky-spin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initData }),
    });
    const data = await resp.json();
    assert.equal(data.ok, false);
    assert.equal(data.canSpin, false);
    assert.equal(data.prizeGb, 50);
    assert.equal(data.remainingGB, 30);
    assert.match(data.error, /本周已经转过了/);
  });
});

test('POST /api/rps-play rate limits abnormal bursts', async (t) => {
  const oldToken = process.env.TG_BOT_TOKEN;
  const oldWindow = process.env.GAME_RPS_WINDOW_MS;
  const oldMax = process.env.GAME_RPS_MAX_REQ;
  process.env.TG_BOT_TOKEN = 'tg-test-token';
  process.env.GAME_RPS_WINDOW_MS = '60000';
  process.env.GAME_RPS_MAX_REQ = '2';

  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      telegram_id TEXT,
      traffic_limit INTEGER NOT NULL
    );
    CREATE TABLE tg_rps_daily (
      user_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      plays INTEGER NOT NULL DEFAULT 0,
      net_gb REAL NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, date)
    );
    CREATE TABLE traffic_user_total (
      user_id INTEGER PRIMARY KEY,
      total_up INTEGER DEFAULT 0,
      total_down INTEGER DEFAULT 0
    );
    CREATE TABLE tg_checkin (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      amount INTEGER NOT NULL
    );
  `);
  sqlite.prepare('INSERT INTO users (id, telegram_id, traffic_limit) VALUES (?, ?, ?)').run(1, '6001', 20 * 1073741824);
  sqlite.prepare('INSERT INTO traffic_user_total (user_id, total_up, total_down) VALUES (?, 0, 0)').run(1);

  const mockDb = {
    getDb: () => sqlite,
    getUserById: (id) => sqlite.prepare('SELECT * FROM users WHERE id = ?').get(id),
  };

  t.after(() => {
    sqlite.close();
    if (oldToken == null) delete process.env.TG_BOT_TOKEN; else process.env.TG_BOT_TOKEN = oldToken;
    if (oldWindow == null) delete process.env.GAME_RPS_WINDOW_MS; else process.env.GAME_RPS_WINDOW_MS = oldWindow;
    if (oldMax == null) delete process.env.GAME_RPS_MAX_REQ; else process.env.GAME_RPS_MAX_REQ = oldMax;
  });

  const initData = buildInitData(process.env.TG_BOT_TOKEN, Math.floor(Date.now() / 1000), { id: 6001, username: 'rate-user' });

  await withMockedRpsRoute(mockDb, async (route) => {
    const app = express();
    app.use('/', route);
    const { server, baseUrl } = await startServer(app);
    t.after(() => new Promise((resolve) => server.close(resolve)));

    for (let i = 0; i < 2; i++) {
      const resp = await fetch(`${baseUrl}/api/rps-play`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initData, choice: 0 }),
      });
      assert.equal(resp.status, 200);
    }

    const blocked = await fetch(`${baseUrl}/api/rps-play`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initData, choice: 0 }),
    });
    assert.equal(blocked.status, 429);
    assert.deepEqual(await blocked.json(), { ok: false, error: '操作过于频繁，请稍后再试' });
  });
});
