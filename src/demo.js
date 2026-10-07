import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { createServer } from './api.js';
import { createDocument } from './service.js';
import { deliverOne } from './worker.js';
import { startSyntheticErp } from '../test/synthetic-erp.js';

if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL to a local PostgreSQL 18 database.');
const schema = `gate_demo_${randomUUID().replaceAll('-', '')}`;
const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
await admin.query(`CREATE SCHEMA ${schema}`);
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, options: `-c search_path=${schema},public` });
await pool.query(await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8'));
const tokens = {
  'demo-submit': { tenantId: 'demo-acme', role: 'submitter', actorId: 'demo-intake' },
  'demo-review': { tenantId: 'demo-acme', role: 'reviewer', actorId: 'demo-reviewer' },
};
let erp;
async function reset() {
  if (erp) await erp.close();
  erp = await startSyntheticErp({ mode: 'disconnect-after-accept' });
  await pool.query('TRUNCATE audit_events, outbox, documents RESTART IDENTITY CASCADE');
  for (const [invoiceNumber, amountMinor] of [['DEMO-2049', 64000], ['DEMO-2048', 12850]]) {
    await createDocument({ pool, principal: tokens['demo-submit'], intakeKey: `sample-${invoiceNumber}`,
      extracted: { invoiceNumber, supplier: 'Synthetic Paper Company', currency: 'USD', amountMinor, issuedAt: '2026-10-01' } });
  }
}
await reset();
const api = createServer({ pool, tokens });
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/app.mjs', ['app.mjs', 'text/javascript; charset=utf-8']],
  ['/browser-adapter.mjs', ['browser-adapter.mjs', 'text/javascript; charset=utf-8']],
]);
function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(value));
}
let activeAction = false;
const server = http.createServer(async (req, res) => {
  try {
    const host = req.headers.host || '';
    if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) {
      json(res, 403, { error: { message: 'Open the local demo through localhost or 127.0.0.1.' } }); return;
    }
    if (req.headers.origin && req.headers.origin !== `http://${host}`) {
      json(res, 403, { error: { message: 'Use the demo from its local page.' } }); return;
    }
    const path = new URL(req.url, `http://${host}`).pathname;
    if (path.startsWith('/api/')) {
      req.url = req.url.slice(4);
      api.emit('request', req, res);
      return;
    }
    if (req.method === 'GET' && path === '/config.json') {
      json(res, 200, { mode: 'postgres', apiBase: '/api', submitterToken: 'demo-submit', reviewerToken: 'demo-review' }); return;
    }
    if (req.method === 'GET' && path === '/demo/erp') {
      json(res, 200, { requests: erp.requests, businessWrites: erp.ledger.size }); return;
    }
    if (req.method === 'POST' && ['/demo/deliver', '/demo/reset'].includes(path)) {
      if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) {
        json(res, 415, { error: { message: 'Use application/json for demo actions.' } }); return;
      }
      req.resume();
      if (activeAction) { json(res, 409, { error: { message: 'A demo action is running. Refresh and retry.' } }); return; }
      activeAction = true;
      try {
        if (path === '/demo/reset') { await reset(); json(res, 200, { ok: true }); }
        else json(res, 200, await deliverOne({ pool, erpUrl: erp.url, retryDelayMs: 0 }));
      } finally { activeAction = false; }
      return;
    }
    if (req.method === 'GET' && assets.has(path)) {
      const [file, type] = assets.get(path);
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      res.end(await readFile(new URL(`../web/${file}`, import.meta.url))); return;
    }
    json(res, 404, { error: { message: 'Route was not found.' } });
  } catch (error) {
    console.error(error);
    if (!res.headersSent) json(res, 500, { error: { message: 'Demo operation failed. Check the server log.' } });
    else res.destroy();
  }
});
const port = Number(process.env.DEMO_PORT || 3100);
server.listen(port, process.env.DEMO_HOST || '127.0.0.1', () => {
  console.log(`Approval Gate local demo: http://127.0.0.1:${server.address().port}`);
  console.log(`Real PostgreSQL (${schema}); synthetic ERP drops its first response after accepting the invoice.`);
  console.log('Temporary demo data is removed on graceful shutdown. Use Ctrl+C to finish.');
});
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await erp.close();
  await pool.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => close().catch(console.error));
