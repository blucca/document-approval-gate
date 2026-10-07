import { createHash, randomUUID } from 'node:crypto';

export class AppError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function transaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export function authorize(principal, roles = ['submitter', 'reviewer']) {
  if (!principal || typeof principal.tenantId !== 'string' || !principal.tenantId
      || typeof principal.actorId !== 'string' || !principal.actorId) {
    throw new AppError(401, 'UNAUTHORIZED', 'A configured bearer token is required.');
  }
  if (!roles.includes(principal.role)) {
    throw new AppError(403, 'FORBIDDEN', 'This action requires the reviewer role.');
  }
}

function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

function validateExtracted(extracted) {
  if (!extracted || typeof extracted !== 'object' || Array.isArray(extracted)) {
    throw new AppError(400, 'INVALID_EXTRACTED', 'extracted must be a JSON object.');
  }
  let serialized;
  try { serialized = JSON.stringify(extracted); } catch {
    throw new AppError(400, 'INVALID_EXTRACTED', 'extracted must be serializable JSON.');
  }
  if (Buffer.byteLength(serialized) > 256 * 1024) {
    throw new AppError(413, 'PAYLOAD_TOO_LARGE', 'extracted must fit in 256 KiB.');
  }
  return JSON.parse(serialized);
}

function validateRevision(revision) {
  if (!Number.isInteger(revision) || revision < 1) {
    throw new AppError(400, 'INVALID_REVISION', 'expectedRevision must be a positive integer.');
  }
}

function validateId(id) {
  if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw new AppError(404, 'NOT_FOUND', 'Document was not found.');
  }
}

export function documentJson(row) {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    intakeKey: row.intake_key,
    revision: row.revision,
    status: row.status,
    extracted: row.extracted,
    approvedSnapshot: row.approved_snapshot,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
    rejectionReason: row.rejection_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function selectDocument(client, tenantId, id, lock = false) {
  validateId(id);
  const { rows } = await client.query(
    `SELECT * FROM documents WHERE tenant_id = $1 AND id = $2 ${lock ? 'FOR UPDATE' : ''}`,
    [tenantId, id],
  );
  if (!rows.length) throw new AppError(404, 'NOT_FOUND', 'Document was not found.');
  return rows[0];
}

export async function audit(client, row, actorId, eventType, details = {}) {
  await client.query(
    `INSERT INTO audit_events (tenant_id, document_id, revision, actor_id, event_type, details)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [row.tenant_id, row.id, row.revision, actorId, eventType, details],
  );
}

export async function createDocument({ pool, principal, intakeKey, extracted }) {
  authorize(principal);
  if (typeof intakeKey !== 'string' || !intakeKey.trim() || intakeKey.length > 200) {
    throw new AppError(400, 'INVALID_INTAKE_KEY', 'intakeKey must contain 1–200 characters.');
  }
  extracted = validateExtracted(extracted);
  const hash = createHash('sha256').update(canonical(extracted)).digest('hex');
  return transaction(pool, async client => {
    const inserted = await client.query(
      `INSERT INTO documents (id, tenant_id, intake_key, intake_hash, extracted)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id, intake_key) DO NOTHING RETURNING *`,
      [randomUUID(), principal.tenantId, intakeKey, hash, extracted],
    );
    if (inserted.rows.length) {
      const row = inserted.rows[0];
      await audit(client, row, principal.actorId, 'INTAKE');
      return { document: documentJson(row), created: true };
    }
    const { rows: [existing] } = await client.query(
      'SELECT * FROM documents WHERE tenant_id = $1 AND intake_key = $2',
      [principal.tenantId, intakeKey],
    );
    if (existing.intake_hash !== hash) {
      throw new AppError(409, 'IDEMPOTENCY_CONFLICT', 'This intake key already identifies a different payload.');
    }
    return { document: documentJson(existing), created: false };
  });
}

export async function getDocument({ pool, principal, id }) {
  authorize(principal);
  return { document: documentJson(await selectDocument(pool, principal.tenantId, id)) };
}

export async function listDocuments({ pool, principal }) {
  authorize(principal);
  const { rows } = await pool.query(
    'SELECT * FROM documents WHERE tenant_id = $1 ORDER BY created_at DESC, id DESC LIMIT 100',
    [principal.tenantId],
  );
  return { documents: rows.map(documentJson) };
}

export async function getDocumentHistory({ pool, principal, id }) {
  authorize(principal);
  await selectDocument(pool, principal.tenantId, id);
  const [events, jobs] = await Promise.all([
    pool.query(`SELECT id, event_type AS "eventType", revision, actor_id AS "actorId", details,
      created_at AS "createdAt" FROM audit_events
      WHERE tenant_id = $1 AND document_id = $2 ORDER BY id`, [principal.tenantId, id]),
    pool.query(`SELECT id, status, attempts, idempotency_key AS "idempotencyKey",
      last_error AS "lastError", remote_response AS "remoteResponse", payload
      FROM outbox WHERE tenant_id = $1 AND document_id = $2 ORDER BY revision DESC LIMIT 1`,
    [principal.tenantId, id]),
  ]);
  return { events: events.rows, delivery: jobs.rows[0] ?? null };
}

function requireRevision(row, revision) {
  if (row.revision !== revision) {
    throw new AppError(409, 'STALE_REVISION', `Current revision is ${row.revision}; refresh before deciding.`);
  }
}

function requireReview(row) {
  if (row.status !== 'REVIEW') {
    throw new AppError(409, 'INVALID_STATE', 'This action requires REVIEW status. Corrections after a decision use a new document.');
  }
}

export async function reviseDocument({ pool, principal, id, expectedRevision, extracted }) {
  authorize(principal);
  validateRevision(expectedRevision);
  extracted = validateExtracted(extracted);
  return transaction(pool, async client => {
    const row = await selectDocument(client, principal.tenantId, id, true);
    requireRevision(row, expectedRevision);
    requireReview(row);
    const { rows: [updated] } = await client.query(
      `UPDATE documents SET extracted = $3, revision = revision + 1, status = 'REVIEW',
         approved_snapshot = NULL, approved_at = NULL, approved_by = NULL,
         rejection_reason = NULL, updated_at = now()
       WHERE tenant_id = $1 AND id = $2 RETURNING *`,
      [principal.tenantId, id, extracted],
    );
    await audit(client, updated, principal.actorId, 'REVISED', { previousRevision: row.revision });
    return { document: documentJson(updated) };
  });
}

export async function approveDocument({ pool, principal, id, expectedRevision }) {
  authorize(principal, ['reviewer']);
  validateRevision(expectedRevision);
  return transaction(pool, async client => {
    const row = await selectDocument(client, principal.tenantId, id, true);
    requireRevision(row, expectedRevision);
    // Repeating an accepted approval returns its original frozen decision.
    if (row.status === 'APPROVED' || row.status === 'SYNCED') {
      return { document: documentJson(row) };
    }
    requireReview(row);
    const approvedAt = new Date().toISOString();
    const snapshot = {
      documentId: id,
      tenantId: principal.tenantId,
      revision: row.revision,
      extracted: row.extracted,
      approvedBy: principal.actorId,
      approvedAt,
    };
    const { rows: [updated] } = await client.query(
      `UPDATE documents SET status = 'APPROVED', approved_snapshot = $3,
         approved_by = $4, approved_at = $5, updated_at = now()
       WHERE tenant_id = $1 AND id = $2 RETURNING *`,
      [principal.tenantId, id, snapshot, principal.actorId, approvedAt],
    );
    const outboxId = randomUUID();
    await client.query(
      `INSERT INTO outbox (id, tenant_id, document_id, revision, payload, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [outboxId, principal.tenantId, id, row.revision, snapshot, `approval-gate:${outboxId}`],
    );
    await audit(client, updated, principal.actorId, 'APPROVED', { outboxId });
    return { document: documentJson(updated) };
  });
}

export async function rejectDocument({ pool, principal, id, expectedRevision, reason }) {
  authorize(principal, ['reviewer']);
  validateRevision(expectedRevision);
  if (typeof reason !== 'string' || !reason.trim() || reason.length > 2000) {
    throw new AppError(400, 'INVALID_REASON', 'reason must contain 1–2000 characters.');
  }
  return transaction(pool, async client => {
    const row = await selectDocument(client, principal.tenantId, id, true);
    requireRevision(row, expectedRevision);
    requireReview(row);
    const { rows: [updated] } = await client.query(
      `UPDATE documents SET status = 'REJECTED', rejection_reason = $3, updated_at = now()
       WHERE tenant_id = $1 AND id = $2 RETURNING *`,
      [principal.tenantId, id, reason],
    );
    await audit(client, updated, principal.actorId, 'REJECTED', { reason });
    return { document: documentJson(updated) };
  });
}
