// The browser adapter models the public demo contract entirely in this tab.
// PostgreSQL transactions and HTTP transport are exercised by the local server.
const clone = value => structuredClone(value);
const uuid = () => crypto.randomUUID();
const now = () => new Date().toISOString();
function fail(status, code, message) {
  const error = new Error(message);
  Object.assign(error, { status, code });
  throw error;
}

export function createBrowserAdapter() {
  const documents = new Map();
  const histories = new Map();
  const deliveries = new Map();
  const receipts = new Map();
  const requests = [];
  let businessWrites = 0;

  function event(doc, eventType, actorId, details = {}) {
    histories.get(doc.id).push({ id: uuid(), eventType, revision: doc.revision, actorId, details, createdAt: now() });
  }
  function create(intakeKey, extracted) {
    const old = [...documents.values()].find(doc => doc.intakeKey === intakeKey);
    if (old) return { document: old, created: false };
    const doc = { id: uuid(), tenantId: 'browser-demo', intakeKey, revision: 1, status: 'REVIEW', extracted: clone(extracted), approvedSnapshot: null, approvedBy: null, approvedAt: null, rejectionReason: null, createdAt: now(), updatedAt: now() };
    documents.set(doc.id, doc);
    histories.set(doc.id, []);
    event(doc, 'INTAKE', 'demo-submit');
    return { document: doc, created: true };
  }
  function reset() {
    documents.clear(); histories.clear(); deliveries.clear(); receipts.clear(); requests.length = 0; businessWrites = 0;
    create('browser-demo-2048', { invoiceNumber: 'DEMO-2048', supplier: 'Synthetic Paper Company', amountMinor: 12850, currency: 'USD', issuedAt: '2026-10-01' });
    create('browser-demo-2049', { invoiceNumber: 'DEMO-2049', supplier: 'Synthetic Supply Company', amountMinor: 64000, currency: 'USD', issuedAt: '2026-10-02' });
  }
  reset();

  async function handle(path, { method = 'GET', body = {} } = {}) {
    if (path === '/documents' && method === 'GET') return { documents: [...documents.values()] };
    if (path === '/documents' && method === 'POST') return create(body.intakeKey, body.extracted);
    if (path === '/demo/reset' && method === 'POST') { reset(); return { ok: true }; }
    if (path === '/demo/erp' && method === 'GET') return { requests, businessWrites };
    if (path === '/demo/deliver' && method === 'POST') {
      const delivery = [...deliveries.values()].find(item => item.status === 'READY');
      if (!delivery) return { outcome: 'idle' };
      delivery.attempts += 1;
      const duplicate = receipts.has(delivery.idempotencyKey);
      if (!duplicate) {
        businessWrites += 1;
        receipts.set(delivery.idempotencyKey, { receiptId: `SYNTHETIC-ERP-${String(businessWrites).padStart(4, '0')}`, accepted: true, invoiceNumber: delivery.payload.extracted.invoiceNumber, revision: delivery.payload.revision });
      }
      const response = receipts.get(delivery.idempotencyKey);
      requests.push({ attempt: requests.length + 1, idempotencyKey: delivery.idempotencyKey, duplicate, payload: clone(delivery.payload), remoteBusinessWrites: businessWrites, response: clone(response) });
      const doc = documents.get(delivery.payload.documentId);
      const result = { outboxId: delivery.id, idempotencyKey: delivery.idempotencyKey, attempts: delivery.attempts };
      if (requests.length === 1) {
        delivery.lastError = 'Simulated connection closed after ERP acceptance';
        event(doc, 'ERP_RETRY', 'erp-worker', { outboxId: delivery.id, attempt: delivery.attempts, error: delivery.lastError });
        return { ...result, outcome: 'retry', error: delivery.lastError };
      }
      delivery.status = 'SYNCED';
      delivery.lastError = null;
      delivery.remoteResponse = { httpStatus: 200, body: clone(response) };
      doc.status = 'SYNCED';
      doc.updatedAt = now();
      event(doc, 'ERP_SYNCED', 'erp-worker', { outboxId: delivery.id, attempt: delivery.attempts });
      return { ...result, outcome: 'synced' };
    }
    const match = /^\/documents\/([^/]+)(?:\/(history|revise|approve|reject))?$/.exec(path);
    if (!match) fail(404, 'NOT_FOUND', 'Route was not found.');
    const [, id, action] = match;
    const doc = documents.get(id);
    if (!doc) fail(404, 'NOT_FOUND', 'Document was not found.');
    if (method === 'GET' && action === 'history') return { events: histories.get(id), delivery: deliveries.get(id) || null };
    if (method === 'GET' && !action) return { document: doc };
    if (method !== 'POST') fail(405, 'METHOD_NOT_ALLOWED', 'Use POST for document decisions.');
    if (body.expectedRevision !== doc.revision) fail(409, 'STALE_REVISION', `Current revision is ${doc.revision}; refresh before deciding.`);
    if (action === 'approve' && ['APPROVED', 'SYNCED'].includes(doc.status)) return { document: doc };
    if (doc.status !== 'REVIEW') fail(409, 'INVALID_STATE', 'This action requires REVIEW status. Corrections after a decision use a new document.');
    if (action === 'revise') {
      const previousRevision = doc.revision;
      doc.revision += 1;
      doc.extracted = clone(body.extracted);
      event(doc, 'REVISED', 'demo-submit', { previousRevision });
    } else if (action === 'approve') {
      doc.status = 'APPROVED'; doc.approvedAt = now(); doc.approvedBy = 'demo-review';
      doc.approvedSnapshot = clone({ documentId: id, tenantId: doc.tenantId, revision: doc.revision, extracted: doc.extracted, approvedBy: doc.approvedBy, approvedAt: doc.approvedAt });
      const outboxId = uuid();
      deliveries.set(id, { id: outboxId, status: 'READY', attempts: 0, idempotencyKey: `approval-gate:${outboxId}`, lastError: null, remoteResponse: null, payload: clone(doc.approvedSnapshot) });
      event(doc, 'APPROVED', 'demo-review', { outboxId });
    } else if (action === 'reject') {
      if (!body.reason?.trim()) fail(400, 'INVALID_REASON', 'Enter a reason for rejection.');
      doc.status = 'REJECTED'; doc.rejectionReason = body.reason;
      event(doc, 'REJECTED', 'demo-review', { reason: body.reason });
    } else fail(404, 'NOT_FOUND', 'Action was not found.');
    doc.updatedAt = now();
    return { document: doc };
  }
  return { request: async (path, options) => clone(await handle(path, options)) };
}
