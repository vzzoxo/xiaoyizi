const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

async function startServer(app) {
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const addr = server.address();
  return { server, baseUrl: `http://127.0.0.1:${addr.port}` };
}

async function withMockedAdminSettingsRouter(mockDb, fn) {
  const routePath = require.resolve('../src/routes/admin/adminSettings');
  const dbPath = require.resolve('../src/services/database');
  const prevRoute = require.cache[routePath];
  const prevDb = require.cache[dbPath];

  delete require.cache[routePath];
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: mockDb };

  try {
    const router = require('../src/routes/admin/adminSettings');
    await fn(router);
  } finally {
    delete require.cache[routePath];
    if (prevRoute) require.cache[routePath] = prevRoute;
    else delete require.cache[routePath];
    if (prevDb) require.cache[dbPath] = prevDb;
    else delete require.cache[dbPath];
  }
}

test('GET /diary returns *_display fields', async (t) => {
  const mockDb = {
    getDiaryEntries: () => ({
      rows: [{
        id: 1,
        content: 'entry',
        mood: '',
        category: 'ops',
        created_at: '2026-02-27 16:30:45',
      }],
      total: 1,
    }),
    getDiaryStats: () => ({
      total: 1,
      todayCount: 1,
      firstEntry: '2026-02-27 16:30:45',
    }),
  };

  await withMockedAdminSettingsRouter(mockDb, async (router) => {
    const app = express();
    app.use('/admin/api', router);
    const { server, baseUrl } = await startServer(app);
    t.after(() => new Promise((resolve) => server.close(resolve)));

    const resp = await fetch(`${baseUrl}/admin/api/diary?page=1`);
    assert.equal(resp.status, 200);
    const data = await resp.json();
    assert.equal(data.rows.length, 1);
    assert.equal(data.rows[0].created_at_display, '2026-02-28 00:30');
    assert.equal(data.rows[0].created_date_display, '2026-02-28');
    assert.equal(data.rows[0].created_time_display, '00:30');
    assert.ok(data.rows[0].created_weekday_display);
    assert.equal(data.stats.firstEntryDisplay, '2026-02-28 00:30');
  });
});

test('GET /logs and /sub-stats include display fields', async (t) => {
  const mockDb = {
    getAuditLogs: () => ({
      rows: [{
        action: 'x',
        detail: 'y',
        username: 'u',
        created_at: '2026-02-27 16:30:45',
      }],
      total: 1,
    }),
    getSubAccessStats: () => ({
      total: 1,
      data: [{
        user_id: 1,
        username: 'u',
        pull_count: 5,
        ip_count: 2,
        last_access: '2026-02-27 16:30:45',
        avg_interval_sec: 12,
        risk_level: 'low',
      }],
    }),
    getSubAccessStatsV2: () => ({
      total: 1,
      overview: {
        total_requests: 5,
        allow_requests: 5,
        deny_requests: 0,
        allow_rate: 100,
        deny_rate: 0,
        user_count: 1,
        denied_user_count: 0,
        deny_reasons: [],
      },
      data: [{
        user_id: 1,
        username: 'u',
        request_count: 5,
        ok_count: 5,
        deny_count: 0,
        ok_rate: 100,
        deny_rate: 0,
        ip_count: 2,
        ua_count: 1,
        last_access: '2026-02-27 16:30:45',
        avg_interval_sec: 12,
        risk_level: 'low',
        top_deny_reason: '',
      }],
    }),
    getSubAccessUserDetail: () => ({
      ips: [{ ip: '1.1.1.1', count: 1, last_access: '2026-02-27 16:30:45' }],
      uas: [],
      timeline: [{ time: '2026-02-27 16:30:45', ip: '1.1.1.1', ua: 'x' }],
    }),
    getSubAccessUserDetailV2: () => ({
      summary: {
        request_count: 1,
        ok_count: 1,
        deny_count: 0,
        ip_count: 1,
        ua_count: 1,
        risk_level: 'low',
        last_access: '2026-02-27 16:30:45',
      },
      ips: [{ ip: '1.1.1.1', count: 1, ok_count: 1, deny_count: 0, last_access: '2026-02-27 16:30:45' }],
      uas: [],
      reasons: [],
      routes: [],
      timeline: [{ time: '2026-02-27 16:30:45', ip: '1.1.1.1', ua: 'x', result: 'allow', reason: 'ok', http_status: 200, route: 'sub' }],
    }),
  };

  await withMockedAdminSettingsRouter(mockDb, async (router) => {
    const app = express();
    app.use('/admin/api', router);
    const { server, baseUrl } = await startServer(app);
    t.after(() => new Promise((resolve) => server.close(resolve)));

    const logsResp = await fetch(`${baseUrl}/admin/api/logs?page=1`);
    const logs = await logsResp.json();
    assert.equal(logs.rows[0].created_at_display, '2026-02-28 00:30');

    const statsResp = await fetch(`${baseUrl}/admin/api/sub-stats?page=1`);
    const stats = await statsResp.json();
    assert.equal(stats.data[0].last_access_display, '2026-02-28 00:30');

    const detailResp = await fetch(`${baseUrl}/admin/api/sub-stats/1/detail`);
    const detail = await detailResp.json();
    assert.equal(detail.ips[0].last_access_display, '2026-02-28 00:30');
    assert.equal(detail.timeline[0].time_display, '2026-02-28 00:30');
  });
});
