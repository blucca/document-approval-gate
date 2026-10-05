import pg from 'pg';

export function createPool() {
  if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL to a PostgreSQL connection string.');
  return new pg.Pool({ connectionString: process.env.DATABASE_URL });
}

export function readTokens() {
  if (!process.env.DEMO_TOKENS_JSON) {
    throw new Error('Set DEMO_TOKENS_JSON to demo bearer keys mapped to {tenantId, role, actorId}.');
  }
  const tokens = JSON.parse(process.env.DEMO_TOKENS_JSON);
  if (!tokens || typeof tokens !== 'object' || Array.isArray(tokens) || !Object.keys(tokens).length) {
    throw new Error('DEMO_TOKENS_JSON requires a nonempty object.');
  }
  for (const [token, principal] of Object.entries(tokens)) {
    if (!token || /\s/.test(token) || !principal
      || typeof principal.tenantId !== 'string' || !principal.tenantId
      || typeof principal.actorId !== 'string' || !principal.actorId
      || !['submitter', 'reviewer'].includes(principal.role)) {
      throw new Error('Each demo token requires tenantId, actorId and submitter/reviewer role.');
    }
  }
  return tokens;
}
