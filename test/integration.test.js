import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import pg from 'pg';
import { createServer } from '../src/api.js';
import { deliverOne } from '../src/worker.js';
import { startSyntheticErp } from './synthetic-erp.js';

const project = fileURLToPath(new URL('../', import.meta.url));
const schema = `gate_test_${randomUUID().replaceAll('-', '')}`;
const tokens = {
  'submitter-a': { tenantId: 'tenant-a', role: 'submitter', actorId: 'operator-a' },
  'reviewer-a': { tenantId: 'tenant-a', role: 'reviewer', actorId: 'approver-a' },
  'reviewer-b': { tenantId: 'tenant-b', role: 'reviewer', actorId: 'approver-b' },
};
const extracted = {
  supplier: 'Synthetic Paper Company',
  invoiceNumber: 'DEMO-2048',
  currency: 'USD',
  amountMinor: 12850,
  lines: [{ description: 'Demonstration supplies', quantity: 2, unitPriceMinor: 6425 }],
};
const report = {
  name: 'Document approval gate: PostgreSQL integration evidence',
  startedAt: new Date().toISOString(),
  environment: { node: process.version },
  scope: {
    database: 'Real PostgreSQL transactions, locks, constraints, and rollback',
    api: 'Real local HTTP requests through configured tenant-scoped bearer principals',
    erp: 'Local synthetic HTTP ERP; in-memory ledger explicitly implements Idempotency-Key deduplication',
    deliveryContract: 'At-least-once delivery; one remote business write requires ERP-side durable idempotency',
    fixtures: 'Synthetic invoices and identities',
  },
  scenarios: [],
};
let admin;
let pool;
let api;
let baseUrl;
const erps = [];
const serverErrors = [];
let scenarioCount = 0;

async function persistReport() {
  if (!process.env.APPROVAL_GATE_REPORT) return;
  const filename = resolve(process.env.APPROVAL_GATE_REPORT);
  await mkdir(dirname(filename), { recursive: true });
  await writeFile(filename, JSON.stringify(report, null, 2) + '\n');
}

function scenario(id, name, run) {
  scenarioCount += 1;
  test(name, { timeout: 15_000 }, async () => {
    const started = performance.now();
    try {
      const evidence = await run();
      report.scenarios.push({ id, name, result: 'passed', durationMs: Math.round(performance.now() - started), evidence });
    } catch (error) {
      report.scenarios.push({ id, name, result: 'failed', durationMs: Math.round(performance.now() - started), error: error.message, serverErrors: structuredClone(serverErrors) });
      throw error;
    } finally {
      await persistReport();
    }
  });
}

async function request(method, path, body, token = 'reviewer-a') {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  return { status: response.status, body: data };
}

async function intake({ payload = extracted, key = randomUUID(), token = 'submitter-a' } = {}) {
  const result = await request('POST', '/documents', { intakeKey: key, extracted: payload }, token);
  assert.equal(result.status, 201, JSON.stringify(result.body));
  return result.body.document;
}

async function approve(document) {
  const result = await request('POST', `/documents/${document.id}/approve`, { expectedRevision: document.revision });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body.document;
}

async function counts() {
  const { rows: [row] } = await pool.query(`SELECT
    (SELECT count(*)::int FROM documents) AS documents,
    (SELECT count(*)::int FROM outbox) AS outbox,
    (SELECT count(*)::int FROM audit_events) AS audit`);
  return row;
}

async function erp(options) {
  const remote = await startSyntheticErp(options);
  erps.push(remote);
  return remote;
}

before(async () => {
  assert.ok(process.env.DATABASE_URL, 'Set DATABASE_URL to a PostgreSQL 18 database with CREATE SCHEMA permission.');
  admin = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const { rows: [version] } = await admin.query(`SELECT current_setting('server_version') AS version,
    current_setting('server_version_num')::int AS number`);
  report.environment.postgresql = version.version;
  assert.ok(version.number >= 180000 && version.number < 190000, `This evidence suite targets PostgreSQL 18; received ${version.version}.`);
  await admin.query(`CREATE SCHEMA ${schema}`);
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 16, options: `-c search_path=${schema},public` });
  await pool.query(await readFile(resolve(project, 'db/schema.sql'), 'utf8'));
  api = createServer({ pool, tokens, onError(error) { serverErrors.push({ message: error.message, code: error.code }); } });
  await new Promise((accept, reject) => {
    api.once('error', reject);
    api.listen(0, '127.0.0.1', accept);
  });
  baseUrl = `http://127.0.0.1:${api.address().port}`;
});

beforeEach(async () => {
  serverErrors.length = 0;
  await pool.query('TRUNCATE audit_events, outbox, documents RESTART IDENTITY CASCADE');
});

afterEach(async () => {
  await Promise.all(erps.splice(0).map(remote => remote.close()));
});

after(async () => {
  report.finishedAt = new Date().toISOString();
  report.summary = {
    expected: scenarioCount,
    passed: report.scenarios.filter(s => s.result === 'passed').length,
    failed: report.scenarios.filter(s => s.result === 'failed').length,
  };
  report.summary.result = report.summary.passed === report.summary.expected && report.summary.failed === 0 ? 'passed' : 'failed';
  await persistReport();
  if (api) {
    api.closeAllConnections();
    await new Promise(accept => api.close(accept));
  }
  if (pool) await pool.end();
  if (admin) {
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});

scenario('intake-concurrency', 'Concurrent duplicate intake creates one document; conflicting payload returns 409', async () => {
  const key = 'duplicate-intake';
  const attempts = await Promise.all(Array.from({ length: 12 }, () => request('POST', '/documents', { intakeKey: key, extracted }, 'submitter-a')));
  assert.equal(attempts.filter(a => a.status === 201).length, 1);
  assert.equal(attempts.filter(a => a.status === 200).length, 11);
  assert.equal(new Set(attempts.map(a => a.body.document.id)).size, 1);
  assert.equal(attempts.filter(a => a.body.created).length, 1);
  // Reordered JSON members preserve the same semantic intake payload.
  const reordered = Object.fromEntries(Object.entries(extracted).reverse());
  assert.equal((await request('POST', '/documents', { intakeKey: key, extracted: reordered })).status, 200);
  const collision = await request('POST', '/documents', { intakeKey: key, extracted: { ...extracted, amountMinor: 1 } });
  assert.equal(collision.status, 409);
  assert.deepEqual(await counts(), { documents: 1, outbox: 0, audit: 1 });
  return { concurrentRequests: 12, createdResponses: 1, replayResponses: 11, documents: 1, intakeAuditEvents: 1, conflictingPayloadStatus: 409 };
});

scenario('tenant-isolation', 'Tenant principals scope reads, revisions and approvals; body tenant IDs have no authority', async () => {
  const document = await intake({ key: 'tenant-local-key' });
  const denied = await Promise.all([
    request('GET', `/documents/${document.id}`, undefined, 'reviewer-b'),
    request('POST', `/documents/${document.id}/revise`, { expectedRevision: 1, extracted }, 'reviewer-b'),
    request('POST', `/documents/${document.id}/approve`, { expectedRevision: 1 }, 'reviewer-b'),
  ]);
  assert.deepEqual(denied.map(result => result.status), [404, 404, 404]);
  const own = await request('POST', '/documents', { intakeKey: 'tenant-local-key', extracted, tenantId: 'tenant-a' }, 'reviewer-b');
  assert.equal(own.status, 201);
  assert.equal(own.body.document.tenantId, 'tenant-b');
  assert.notEqual(own.body.document.id, document.id);
  assert.equal((await request('GET', `/documents/${document.id}`, undefined, null)).status, 401);
  assert.equal((await request('GET', `/documents/${document.id}`, undefined, 'unknown-token')).status, 401);
  assert.equal((await request('GET', `/documents/${document.id}`)).body.document.status, 'REVIEW');
  assert.equal((await counts()).outbox, 0);
  return { crossTenantRead: 404, crossTenantRevise: 404, crossTenantApprove: 404, principalTenantWins: 'tenant-b', sameIntakeKeyAcrossTenants: 'separate documents', missingOrUnknownToken: 401 };
});

scenario('reviewer-role', 'Submitter receives 403 for approval and rejection', async () => {
  const document = await intake();
  const approval = await request('POST', `/documents/${document.id}/approve`, { expectedRevision: 1 }, 'submitter-a');
  const rejection = await request('POST', `/documents/${document.id}/reject`, { expectedRevision: 1, reason: 'Synthetic review' }, 'submitter-a');
  assert.equal(approval.status, 403);
  assert.equal(rejection.status, 403);
  assert.deepEqual(await counts(), { documents: 1, outbox: 0, audit: 1 });
  return { submitterApprove: 403, submitterReject: 403, outboxRows: 0 };
});

scenario('stale-revision', 'Revised data requires review of the current revision', async () => {
  const document = await intake();
  const corrected = { ...extracted, amountMinor: 12950 };
  const revision = await request('POST', `/documents/${document.id}/revise`, { expectedRevision: 1, extracted: corrected }, 'submitter-a');
  assert.equal(revision.status, 200);
  assert.equal(revision.body.document.revision, 2);
  const stale = await request('POST', `/documents/${document.id}/approve`, { expectedRevision: 1 });
  assert.equal(stale.status, 409);
  assert.equal((await counts()).outbox, 0);
  const current = await approve(revision.body.document);
  assert.equal(current.approvedSnapshot.revision, 2);
  assert.deepEqual(current.approvedSnapshot.extracted, corrected);
  return { initialRevision: 1, currentRevision: 2, staleApprovalStatus: 409, approvedRevision: current.approvedSnapshot.revision, approvedAmountMinor: current.approvedSnapshot.extracted.amountMinor };
});

scenario('review-gates-delivery', 'An unapproved document produces no ERP request', async () => {
  await intake();
  const remote = await erp();
  const result = await deliverOne({ pool, erpUrl: remote.url });
  assert.equal(result.outcome, 'idle');
  assert.equal(remote.requests.length, 0);
  assert.equal(remote.ledger.size, 0);
  return { workerOutcome: result.outcome, erpRequests: 0, remoteBusinessWrites: 0 };
});

scenario('approval-atomic-success', 'Concurrent approval commits one frozen snapshot, approval audit and outbox message', async () => {
  const document = await intake();
  const approvals = await Promise.all(Array.from({ length: 8 }, () => request('POST', `/documents/${document.id}/approve`, { expectedRevision: 1 })));
  assert.ok(approvals.every(result => result.status === 200));
  assert.ok(approvals.every(result => result.body.document.status === 'APPROVED'));
  const snapshot = approvals[0].body.document.approvedSnapshot;
  assert.deepEqual(snapshot.extracted, extracted);
  assert.equal(snapshot.approvedBy, 'approver-a');
  assert.equal(snapshot.documentId, document.id);
  assert.equal(snapshot.tenantId, 'tenant-a');
  assert.equal(snapshot.revision, 1);
  for (const response of approvals) assert.deepEqual(response.body.document.approvedSnapshot, snapshot);
  const { rows: outbox } = await pool.query('SELECT * FROM outbox');
  const { rows: audit } = await pool.query("SELECT * FROM audit_events WHERE event_type = 'APPROVED'");
  assert.equal(outbox.length, 1);
  assert.equal(audit.length, 1);
  assert.deepEqual(outbox[0].payload, snapshot);
  assert.equal(audit[0].details.outboxId, outbox[0].id);
  assert.equal(audit[0].actor_id, 'approver-a');
  return { concurrentApprovals: 8, status: 'APPROVED', approvalAudits: 1, outboxRows: 1, outboxEqualsApprovedSnapshot: true, snapshot };
});

scenario('approval-atomic-rollback', 'Injected audit failure rolls back approval, frozen snapshot and outbox together', async () => {
  const document = await intake();
  await pool.query(`CREATE FUNCTION fail_approval_audit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.event_type = 'APPROVED' THEN RAISE EXCEPTION 'test: injected audit storage failure'; END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER fail_approval_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION fail_approval_audit()`);
  let failed;
  try {
    failed = await request('POST', `/documents/${document.id}/approve`, { expectedRevision: 1 });
    assert.equal(failed.status, 500);
    assert.deepEqual(serverErrors, [{ message: 'test: injected audit storage failure', code: 'P0001' }]);
    const { rows: [stored] } = await pool.query('SELECT * FROM documents WHERE id = $1', [document.id]);
    assert.equal(stored.status, 'REVIEW');
    assert.equal(stored.approved_snapshot, null);
    assert.equal(stored.approved_by, null);
    assert.equal(stored.approved_at, null);
    assert.deepEqual(await counts(), { documents: 1, outbox: 0, audit: 1 });
  } finally {
    await pool.query('DROP TRIGGER fail_approval_audit ON audit_events; DROP FUNCTION fail_approval_audit()');
  }
  await approve(document);
  assert.deepEqual(await counts(), { documents: 1, outbox: 1, audit: 2 });
  return { injectedFailure: 'PostgreSQL trigger raises during APPROVED audit insertion', sqlState: serverErrors[0].code, approvalHttpStatus: failed.status, afterRollback: { status: 'REVIEW', approvedSnapshot: null, outboxRows: 0, approvalAudits: 0 }, retryAfterFaultRemoved: 'APPROVED' };
});

scenario('frozen-after-approval', 'Approved document rejects edits and preserves the queued snapshot', async () => {
  const approved = await approve(await intake());
  const changed = await request('POST', `/documents/${approved.id}/revise`, { expectedRevision: 1, extracted: { ...extracted, amountMinor: 1 } });
  assert.equal(changed.status, 409);
  const stored = (await request('GET', `/documents/${approved.id}`)).body.document;
  assert.deepEqual(stored.approvedSnapshot, approved.approvedSnapshot);
  assert.deepEqual(stored.extracted, extracted);
  const { rows: [outbox] } = await pool.query('SELECT payload FROM outbox');
  assert.deepEqual(outbox.payload, approved.approvedSnapshot);
  return { editStatus: 409, documentRevision: stored.revision, queuedSnapshotPreserved: true };
});

scenario('concurrent-workers', 'Eight competing workers claim one approved delivery once', async () => {
  const approved = await approve(await intake());
  const remote = await erp({ mode: 'hold-first-response' });
  const work = Promise.all(Array.from({ length: 8 }, () => deliverOne({ pool, erpUrl: remote.url, timeoutMs: 2000 })));
  await remote.firstAccepted;
  remote.releaseFirst();
  const results = await work;
  assert.equal(results.filter(result => result.outcome === 'synced').length, 1);
  assert.equal(results.filter(result => result.outcome === 'idle').length, 7);
  assert.equal(remote.requests.length, 1);
  assert.equal(remote.ledger.size, 1);
  assert.deepEqual(remote.requests[0].payload, approved.approvedSnapshot);
  const { rows: [row] } = await pool.query('SELECT attempts, status FROM outbox');
  assert.deepEqual(row, { attempts: 1, status: 'SYNCED' });
  assert.equal((await request('GET', `/documents/${approved.id}`)).body.document.status, 'SYNCED');
  return { workers: 8, synced: 1, idle: 7, erpRequests: 1, remoteBusinessWrites: 1, outboxAttempts: row.attempts };
});

scenario('accepted-response-lost', 'ERP acceptance followed by connection loss or client timeout retries the same business write', async () => {
  const cases = [];
  for (const mode of ['disconnect-after-accept', 'timeout-after-accept']) {
    const approved = await approve(await intake());
    const remote = await erp({ mode });
    const timeoutMs = mode === 'timeout-after-accept' ? 100 : 1000;
    const first = await deliverOne({ pool, erpUrl: remote.url, timeoutMs, retryDelayMs: 0 });
    assert.equal(first.outcome, 'retry');
    assert.equal(remote.ledger.size, 1);
    assert.equal(remote.requests.length, 1);
    assert.equal((await request('GET', `/documents/${approved.id}`)).body.document.status, 'APPROVED');
    const { rows: [pending] } = await pool.query('SELECT status, attempts, last_error FROM outbox WHERE document_id = $1', [approved.id]);
    assert.equal(pending.status, 'READY');
    assert.equal(pending.attempts, 1);
    assert.ok(pending.last_error);
    const second = await deliverOne({ pool, erpUrl: remote.url, timeoutMs: 1000, retryDelayMs: 0 });
    assert.equal(second.outcome, 'synced');
    assert.equal(remote.requests.length, 2);
    assert.equal(remote.ledger.size, 1);
    assert.equal(remote.requests[0].idempotencyKey, remote.requests[1].idempotencyKey);
    assert.equal(remote.requests[0].duplicate, false);
    assert.equal(remote.requests[1].duplicate, true);
    assert.deepEqual(remote.requests[0].payload, approved.approvedSnapshot);
    assert.deepEqual(remote.requests[1].payload, approved.approvedSnapshot);
    const { rows: [finished] } = await pool.query('SELECT status, attempts FROM outbox WHERE document_id = $1', [approved.id]);
    assert.deepEqual(finished, { status: 'SYNCED', attempts: 2 });
    assert.equal((await request('GET', `/documents/${approved.id}`)).body.document.status, 'SYNCED');
    cases.push({ fault: mode, timeoutMs, firstWorkerOutcome: first.outcome, firstError: pending.last_error, retryWorkerOutcome: second.outcome, stableIdempotencyKey: remote.requests[0].idempotencyKey, remoteBusinessWrites: remote.ledger.size, httpAttempts: remote.requests.length, outboxAttempts: finished.attempts, finalStatus: finished.status, requests: structuredClone(remote.requests) });
  }
  return { contract: 'One business write per accepted document across both HTTP failure modes', cases };
});

scenario('rejection-gates-delivery', 'Reviewer rejection records its reason and produces no outbox or ERP request', async () => {
  const document = await intake();
  const reason = 'Synthetic invoice total needs correction';
  const rejection = await request('POST', `/documents/${document.id}/reject`, { expectedRevision: 1, reason });
  assert.equal(rejection.status, 200);
  assert.equal(rejection.body.document.status, 'REJECTED');
  assert.equal(rejection.body.document.rejectionReason, reason);
  assert.equal(rejection.body.document.approvedSnapshot, null);
  const { rows: audits } = await pool.query("SELECT actor_id, details FROM audit_events WHERE event_type = 'REJECTED'");
  assert.equal(audits.length, 1);
  assert.equal(audits[0].actor_id, 'approver-a');
  assert.equal(audits[0].details.reason, reason);
  const remote = await erp();
  assert.equal((await deliverOne({ pool, erpUrl: remote.url })).outcome, 'idle');
  assert.equal((await counts()).outbox, 0);
  assert.equal(remote.requests.length, 0);
  return { status: 'REJECTED', reason, rejectionAudits: 1, outboxRows: 0, erpRequests: 0 };
});

scenario('expired-lease-fencing', 'Expired claim is retried; the stale worker yields to the new claim', async () => {
  const document = await approve(await intake());
  const remote = await erp({ mode: 'hold-first-response' });
  const oldWorker = deliverOne({ pool, erpUrl: remote.url, timeoutMs: 5000, leaseMs: 30000 });
  await remote.firstAccepted;
  const { rowCount } = await pool.query("UPDATE outbox SET locked_until = now() - interval '1 second' WHERE status = 'LEASED'");
  assert.equal(rowCount, 1);
  let newResult;
  try {
    newResult = await deliverOne({ pool, erpUrl: remote.url, timeoutMs: 2000, leaseMs: 30000 });
    assert.equal(newResult.outcome, 'synced');
  } finally {
    remote.releaseFirst();
  }
  const oldResult = await oldWorker;
  assert.equal(oldResult.outcome, 'lease_lost');
  assert.equal(remote.ledger.size, 1);
  assert.equal(remote.requests.length, 2);
  assert.equal(remote.requests[0].idempotencyKey, remote.requests[1].idempotencyKey);
  const { rows: [finished] } = await pool.query('SELECT status, attempts FROM outbox');
  assert.deepEqual(finished, { status: 'SYNCED', attempts: 2 });
  assert.equal((await request('GET', `/documents/${document.id}`)).body.document.status, 'SYNCED');
  return { fault: 'Database lease expiry injected while first HTTP response is held', replacementWorker: newResult.outcome, staleWorker: oldResult.outcome, remoteBusinessWrites: remote.ledger.size, sameIdempotencyKey: true, outboxAttempts: finished.attempts, finalStatus: finished.status };
});

scenario('review-read-model', 'Review queue and delivery history stay within the authenticated tenant', async () => {
  const document = await intake();
  const foreign = await intake({ token: 'reviewer-b' });
  const own = await request('GET', '/documents');
  assert.equal(own.status, 200);
  assert.deepEqual(own.body.documents.map(row => row.id), [document.id]);
  assert.equal((await request('GET', `/documents/${foreign.id}/history`)).status, 404);
  assert.equal((await request('GET', '/documents', undefined, null)).status, 401);
  await request('POST', `/documents/${document.id}/revise`, { expectedRevision: 1, extracted: { ...extracted, amountMinor: 12580 } });
  const stale = await request('POST', `/documents/${document.id}/approve`, { expectedRevision: 1 });
  assert.equal(stale.status, 409);
  await request('POST', `/documents/${document.id}/approve`, { expectedRevision: 2 });
  const remote = await erp({ mode: 'disconnect-after-accept' });
  await deliverOne({ pool, erpUrl: remote.url });
  const pending = (await request('GET', `/documents/${document.id}/history`)).body;
  assert.equal(pending.delivery.status, 'READY');
  assert.equal(pending.delivery.attempts, 1);
  assert.equal(pending.delivery.payload.extracted.amountMinor, 12580);
  await deliverOne({ pool, erpUrl: remote.url });
  const final = (await request('GET', `/documents/${document.id}/history`)).body;
  assert.deepEqual(final.events.map(event => event.eventType), ['INTAKE', 'REVISED', 'APPROVED', 'ERP_RETRY', 'ERP_SYNCED']);
  assert.equal(final.delivery.attempts, 2);
  assert.equal(final.delivery.remoteResponse.httpStatus, 200);
  assert.equal(final.delivery.idempotencyKey, pending.delivery.idempotencyKey);
  return { ownQueueCount: own.body.documents.length, crossTenantHistoryStatus: 404, staleApprovalStatus: stale.status,
    frozenAmountMinor: final.delivery.payload.extracted.amountMinor, events: final.events.map(event => event.eventType),
    httpAttempts: remote.requests.length, remoteBusinessWrites: remote.ledger.size };
});
