const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret';
const panelRoutes = require('../src/routes/panel');

test('panelRoutes do not expose mutating methods (POST/PUT/PATCH/DELETE)', () => {
  const disallowed = new Set(['post', 'put', 'patch', 'delete']);
  const allowed = new Set(['POST /api/tg-bind-token', 'POST /api/tg-unbind']);
  const offenders = [];

  for (const layer of panelRoutes.stack || []) {
    const route = layer.route;
    if (!route || !route.path || !route.methods) continue;
    for (const method of Object.keys(route.methods)) {
      if (disallowed.has(method.toLowerCase()) && route.methods[method]) {
        const signature = `${method.toUpperCase()} ${route.path}`;
        if (!allowed.has(signature)) offenders.push(signature);
      }
    }
  }

  assert.deepEqual(offenders, []);
});
