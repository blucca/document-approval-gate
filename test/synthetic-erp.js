import { createServer } from 'node:http';

/**
 * Local test double for an ERP that durably deduplicates Idempotency-Key.
 * Its in-memory ledger models that provider contract within one test run.
 * Modes exercise a lost response and an overlapping expired-lease retry.
 */
export async function startSyntheticErp({ mode = 'success' } = {}) {
  const requests = [];
  const ledger = new Map();
  let releaseFirst;
  const firstResponseGate = new Promise(resolve => { releaseFirst = resolve; });
  let acceptedFirst;
  const firstAccepted = new Promise(resolve => { acceptedFirst = resolve; });
  const server = createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const idempotencyKey = request.headers['idempotency-key'];
      if (request.method !== 'POST' || request.url !== '/erp/documents' || !idempotencyKey) {
        response.writeHead(400).end(JSON.stringify({ error: 'Invalid ERP request' }));
        return;
      }
      const duplicate = ledger.has(idempotencyKey);
      if (duplicate && JSON.stringify(ledger.get(idempotencyKey).payload) !== JSON.stringify(payload)) {
        response.writeHead(409).end(JSON.stringify({ error: 'Idempotency payload conflict' }));
        return;
      }
      if (!duplicate) {
        ledger.set(idempotencyKey, {
          erpId: `synthetic-erp-${ledger.size + 1}`,
          payload,
        });
      }
      const observation = {
        attempt: requests.length + 1,
        idempotencyKey,
        duplicate,
        payload,
        remoteBusinessWrites: ledger.size,
      };
      requests.push(observation);
      const isFirst = requests.length === 1;
      if (isFirst) acceptedFirst();
      if (isFirst && mode === 'disconnect-after-accept') {
        observation.response = 'connection-dropped-after-ledger-write';
        response.destroy();
        return;
      }
      if (isFirst && mode === 'timeout-after-accept') {
        observation.response = 'response-withheld-until-client-timeout';
        await firstResponseGate;
        return;
      }
      if (isFirst && mode === 'hold-first-response') await firstResponseGate;
      observation.response = duplicate ? '200-idempotent-replay' : '200-created';
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ erpId: ledger.get(idempotencyKey).erpId }));
    } catch (error) {
      response.writeHead(500).end(JSON.stringify({ error: error.message }));
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    url: `http://127.0.0.1:${server.address().port}/erp/documents`,
    requests,
    ledger,
    firstAccepted,
    releaseFirst,
    async close() {
      releaseFirst();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    },
  };
}
