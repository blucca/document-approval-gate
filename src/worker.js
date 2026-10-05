import { randomUUID } from 'node:crypto';
import { transaction, audit } from './service.js';

// This short statement commits the lease before the network request starts.
// PostgreSQL documents SKIP LOCKED specifically for queue-like consumers.
// https://www.postgresql.org/docs/18/sql-select.html#SQL-FOR-UPDATE-SHARE
async function claim(pool, leaseMs) {
  const token = randomUUID();
  const { rows } = await pool.query(
    `WITH next_job AS (
       SELECT id FROM outbox
       WHERE (status = 'READY' AND available_at <= clock_timestamp())
          OR (status = 'LEASED' AND locked_until <= clock_timestamp())
       ORDER BY available_at, created_at, id
       LIMIT 1 FOR UPDATE SKIP LOCKED
     )
     UPDATE outbox AS jobs SET status = 'LEASED', claim_token = $1,
       locked_until = clock_timestamp() + $2 * interval '1 millisecond',
       attempts = attempts + 1
     FROM next_job WHERE jobs.id = next_job.id RETURNING jobs.*`,
    [token, leaseMs],
  );
  return rows[0];
}

async function postToErp(job, erpUrl, timeoutMs) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const response = await fetch(erpUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': job.idempotency_key },
      body: JSON.stringify(job.payload),
      signal: abort.signal,
      redirect: 'error',
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`ERP returned HTTP ${response.status}`);
    }
    let text = '';
    if (response.body) {
      const chunks = [];
      let bytes = 0;
      for await (const chunk of response.body) {
        bytes += chunk.byteLength;
        if (bytes > 64 * 1024) throw new Error('ERP response exceeded 64 KiB');
        chunks.push(Buffer.from(chunk));
      }
      text = Buffer.concat(chunks).toString('utf8');
    }
    let body = text;
    try { body = text ? JSON.parse(text) : null; } catch { /* Preserve a short plain-text receipt. */ }
    return { httpStatus: response.status, body };
  } finally {
    clearTimeout(timer);
  }
}

function positiveMs(value, name, allowZero = false) {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new Error(`${name} must be ${allowZero ? 'a nonnegative' : 'a positive'} integer in milliseconds.`);
  }
}

/**
 * Delivers at most one job. Remote deduplication uses the persisted key across
 * retries and expired leases. The ERP endpoint must honor Idempotency-Key.
 * A process may stop after remote acceptance and before the local commit;
 * the next lease therefore replays the same frozen payload and key.
 */
export async function deliverOne({ pool, erpUrl, timeoutMs = 1000, leaseMs = 30000, retryDelayMs = 0 }) {
  const url = new URL(erpUrl);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('ERP_URL requires HTTP or HTTPS.');
  positiveMs(timeoutMs, 'timeoutMs');
  positiveMs(leaseMs, 'leaseMs');
  positiveMs(retryDelayMs, 'retryDelayMs', true);
  const job = await claim(pool, leaseMs);
  if (!job) return { outcome: 'idle' };
  const result = { outboxId: job.id, idempotencyKey: job.idempotency_key, attempts: job.attempts };
  const auditRow = { id: job.document_id, tenant_id: job.tenant_id, revision: job.revision };
  let receipt;
  let failure;
  try {
    receipt = await postToErp(job, url, timeoutMs);
  } catch (error) {
    failure = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
  }

  if (failure) {
    return transaction(pool, async client => {
      const updated = await client.query(
        `UPDATE outbox SET status = 'READY', claim_token = NULL, locked_until = NULL,
           available_at = clock_timestamp() + $4 * interval '1 millisecond', last_error = $3
         WHERE id = $1 AND claim_token = $2 AND status = 'LEASED' RETURNING id`,
        [job.id, job.claim_token, failure, retryDelayMs],
      );
      if (!updated.rowCount) return { ...result, outcome: 'lease_lost' };
      await audit(client, auditRow, 'erp-worker', 'ERP_RETRY', { outboxId: job.id, attempt: job.attempts, error: failure });
      return { ...result, outcome: 'retry', error: failure };
    });
  }

  return transaction(pool, async client => {
    const updated = await client.query(
      `UPDATE outbox SET status = 'SYNCED', claim_token = NULL, locked_until = NULL,
         synced_at = now(), remote_response = $3, last_error = NULL
       WHERE id = $1 AND claim_token = $2 AND status = 'LEASED' RETURNING id`,
      [job.id, job.claim_token, receipt],
    );
    if (!updated.rowCount) return { ...result, outcome: 'lease_lost' };
    const document = await client.query(
      `UPDATE documents SET status = 'SYNCED', updated_at = now()
       WHERE tenant_id = $1 AND id = $2 AND revision = $3 AND status = 'APPROVED' RETURNING id`,
      [job.tenant_id, job.document_id, job.revision],
    );
    if (document.rowCount !== 1) throw new Error('Approved document and outbox state diverged.');
    await audit(client, auditRow, 'erp-worker', 'ERP_SYNCED', { outboxId: job.id, attempt: job.attempts });
    return { ...result, outcome: 'synced' };
  });
}
