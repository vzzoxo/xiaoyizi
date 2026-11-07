const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { errorHandler } = require('../src/middleware/errorHandler');

async function startServer(app) {
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const addr = server.address();
  return { server, baseUrl: `http://127.0.0.1:${addr.port}` };
}

test('errorHandler sanitizes non-numeric status for html response', async (t) => {
  const app = express();
  app.get('/boom', (_req, _res, next) => {
    const err = new Error('boom');
    err.status = '500</title><script>alert(1)</script>';
    next(err);
  });
  app.use(errorHandler);

  const { server, baseUrl } = await startServer(app);
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const resp = await fetch(`${baseUrl}/boom`);
  assert.equal(resp.status, 500);
  const body = await resp.text();
  assert.ok(body.includes('<title>500 · Pоrпнub</title>'));
  assert.equal(body.includes('<script>alert(1)</script>'), false);
});

test('errorHandler normalizes prefixed-numeric status for api response', async (t) => {
  const app = express();
  app.get('/admin/api/boom', (_req, _res, next) => {
    const err = new Error('boom');
    err.statusCode = '418<script>';
    next(err);
  });
  app.use(errorHandler);

  const { server, baseUrl } = await startServer(app);
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const resp = await fetch(`${baseUrl}/admin/api/boom`, {
    headers: { accept: 'application/json' },
  });
  assert.equal(resp.status, 418);
  const data = await resp.json();
  assert.equal(data.ok, false);
  assert.equal(data.code, 'INTERNAL_ERROR');
});
