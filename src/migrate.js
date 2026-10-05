import { readFile } from 'node:fs/promises';
import { createPool } from './config.js';

const pool = createPool();
try {
  await pool.query(await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8'));
  console.log('Database schema ready.');
} finally {
  await pool.end();
}
