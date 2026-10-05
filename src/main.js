import { createServer } from './api.js';
import { createPool, readTokens } from './config.js';

const tokens = readTokens();
const pool = createPool();
await pool.query('SELECT 1');
const server = createServer({ pool, tokens });
const port = Number(process.env.PORT || 3000);
server.listen(port, process.env.HOST || '127.0.0.1', () => {
  console.log(JSON.stringify({ event: 'listening', address: server.address() }));
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => server.close(async () => { await pool.end(); }));
}
