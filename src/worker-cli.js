import { setTimeout as delay } from 'node:timers/promises';
import { createPool } from './config.js';
import { deliverOne } from './worker.js';

if (!process.env.ERP_URL) throw new Error('Set ERP_URL to the complete idempotent ERP endpoint.');
const pool = createPool();
const once = process.argv.includes('--once');
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { stopping = true; });
try {
  do {
    const result = await deliverOne({
      pool,
      erpUrl: process.env.ERP_URL,
      timeoutMs: Number(process.env.ERP_TIMEOUT_MS || 5000),
      leaseMs: Number(process.env.WORKER_LEASE_MS || 30000),
      retryDelayMs: Number(process.env.WORKER_RETRY_MS || 5000),
    });
    console.log(JSON.stringify(result));
    if (once || stopping) break;
    if (result.outcome === 'idle' || result.outcome === 'retry') await delay(1000);
  } while (!stopping);
} finally {
  await pool.end();
}
