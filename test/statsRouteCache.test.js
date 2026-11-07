const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

if (!process.env.SESSION_SECRET) {
  process.env.SESSION_SECRET = 'test-session-secret';
}

async function startServer(app) {
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const addr = server.address();
  return { server, baseUrl: `http://127.0.0.1:${addr.port}` };
}

async function withMockedStatsRoute(mocks, fn) {
  const routePath = require.resolve('../src/routes/stats');
  const prev = { route: require.cache[routePath] };
  const touched = [];

  for (const [target, exportsObj] of Object.entries(mocks)) {
    const resolved = require.resolve(target);
    touched.push([resolved, require.cache[resolved]]);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
  }
  delete require.cache[routePath];

  try {
    const router = require('../src/routes/stats');
    if (router._test?.resetStatsCache) router._test.resetStatsCache();
    await fn(router);
  } finally {
    delete require.cache[routePath];
    if (prev.route) require.cache[routePath] = prev.route;
    for (const [resolved, old] of touched) {
      if (old) require.cache[resolved] = old;
      else delete require.cache[resolved];
    }
  }
}

test('api stats reuses cached payload within ttl', async (t) => {
  let trafficCalls = 0;
  let globalCalls = 0;
  await withMockedStatsRoute({
    '../src/services/database': {
      getDb: () => ({
        prepare: (sql) => {
          if (sql.includes('FROM audit_log')) return { get: () => ({ patrols: 0, swaps: 0, fixes: 0 }) };
          if (sql.includes('FROM ops_diary')) return { all: () => [] };
          return { get: () => ({}), all: () => [] };
        },
      }),
      getUserTraffic: () => {
        trafficCalls += 1;
        return { total_up: 10, total_down: 20 };
      },
      getUserById: () => ({ id: 7, traffic_limit: 100 }),
      getGlobalTraffic: () => {
        globalCalls += 1;
        return { total_up: 30, total_down: 40 };
      },
      getAllNodes: () => [],
    },
    '../src/middleware/auth': {
      requireAuth: (req, _res, next) => {
        req.user = { id: 7, is_admin: 0 };
        next();
      },
      requireAdmin: (_req, res) => res.status(403).end(),
    },
    '../src/services/health': {
      getOnlineCache: () => ({ summary: { online: 5, nodes: 2 }, full: null }),
    },
    '../src/services/agent-ws': {
      getConnectedAgents: () => [],
    },
    '../src/utils/agentMap': { buildOnlineAgentSet: () => new Set() },
  }, async (router) => {
    const app = express();
    app.use('/', router);
    const { server, baseUrl } = await startServer(app);
    t.after(() => new Promise((resolve) => server.close(resolve)));

    const resp1 = await fetch(`${baseUrl}/api/stats`);
    const resp2 = await fetch(`${baseUrl}/api/stats`);
    assert.equal(resp1.status, 200);
    assert.equal(resp2.status, 200);
    assert.equal(trafficCalls, 1);
    assert.equal(globalCalls, 1);
  });
});

test('panel summary reuses merged payload within ttl', async (t) => {
  let trafficCalls = 0;
  let globalCalls = 0;
  let allNodesCalls = 0;
  let diaryCalls = 0;
  const dbMock = {
    getDb: () => ({
      prepare: (sql) => {
        if (sql.includes('FROM audit_log')) return { get: () => ({ patrols: 1, swaps: 2, fixes: 3 }) };
        if (sql.includes('FROM ops_diary')) return {
          all: () => {
            diaryCalls += 1;
            return [{ content: 'ok', mood: '', created_at: '2026-03-16 00:00:00' }];
          },
        };
        return { get: () => ({}), all: () => [] };
      },
    }),
    getUserTraffic: () => {
      trafficCalls += 1;
      return { total_up: 10, total_down: 20 };
    },
    getUserById: () => ({ id: 7, traffic_limit: 100 }),
    getGlobalTraffic: () => {
      globalCalls += 1;
      return { total_up: 30, total_down: 40 };
    },
    getAllNodes: () => {
      allNodesCalls += 1;
      return [];
    },
  };

  await withMockedStatsRoute({
    '../src/services/database': dbMock,
    '../src/middleware/auth': {
      requireAuth: (req, _res, next) => {
        req.user = { id: 7, is_admin: 0 };
        next();
      },
      requireAdmin: (_req, res) => res.status(403).end(),
    },
    '../src/services/health': {
      getOnlineCache: () => ({ summary: { online: 5, nodes: 2 }, full: null }),
    },
    '../src/services/agent-ws': {
      getConnectedAgents: () => [],
    },
    '../src/utils/agentMap': { buildOnlineAgentSet: () => new Set() },
  }, async (router) => {
    const app = express();
    app.use('/', router);
    const { server, baseUrl } = await startServer(app);
    t.after(() => new Promise((resolve) => server.close(resolve)));

    const resp1 = await fetch(`${baseUrl}/api/panel-summary`);
    const resp2 = await fetch(`${baseUrl}/api/panel-summary`);
    assert.equal(resp1.status, 200);
    assert.equal(resp2.status, 200);
    assert.equal(trafficCalls, 1);
    assert.equal(globalCalls, 1);
    assert.equal(allNodesCalls, 1);
    assert.equal(diaryCalls, 1);
  });
});
