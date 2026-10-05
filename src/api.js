import http from 'node:http';
import {
  AppError, authorize, createDocument, getDocument, reviseDocument,
  approveDocument, rejectDocument,
} from './service.js';

const MAX_BODY_BYTES = 256 * 1024;

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let settled = false;
    const fail = error => {
      if (settled) return;
      settled = true;
      req.resume();
      reject(error);
    };
    req.on('error', () => fail(new AppError(400, 'INVALID_BODY', 'Request body was interrupted.')));
    req.on('data', chunk => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        fail(new AppError(413, 'PAYLOAD_TOO_LARGE', 'Request body must fit in 256 KiB.'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
        settled = true;
        resolve(value);
      } catch {
        fail(new AppError(400, 'INVALID_JSON', 'Request body must be a JSON object.'));
      }
    });
  });
}

function send(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(JSON.stringify(body));
}

/** tokens maps demo bearer keys to trusted {tenantId, role, actorId} principals. */
export function createServer({ pool, tokens, onError = console.error }) {
  if (!pool || !tokens || typeof tokens !== 'object') {
    throw new Error('createServer requires pool and a configured tokens map.');
  }
  return http.createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/health') {
        send(res, 200, { status: 'ok' });
        return;
      }
      const token = /^Bearer (\S+)$/i.exec(req.headers.authorization || '')?.[1];
      const principal = token && (tokens instanceof Map ? tokens.get(token)
        : Object.hasOwn(tokens, token) ? tokens[token] : undefined);
      authorize(principal);
      const path = new URL(req.url, 'http://localhost').pathname;
      if (req.method === 'POST' && path === '/documents') {
        const body = await readJson(req);
        const headerKey = req.headers['idempotency-key'];
        if (headerKey && body.intakeKey && headerKey !== body.intakeKey) {
          throw new AppError(400, 'INVALID_INTAKE_KEY', 'Header and body intake keys must match.');
        }
        const result = await createDocument({
          pool, principal, intakeKey: body.intakeKey ?? headerKey, extracted: body.extracted,
        });
        send(res, result.created ? 201 : 200, result);
        return;
      }
      const match = /^\/documents\/([^/]+)(?:\/(revise|approve|reject))?$/.exec(path);
      if (match && req.method === 'GET' && !match[2]) {
        send(res, 200, await getDocument({ pool, principal, id: match[1] }));
        return;
      }
      if (match && req.method === 'POST' && match[2]) {
        const body = await readJson(req);
        const handlers = { revise: reviseDocument, approve: approveDocument, reject: rejectDocument };
        // Trusted identity and route id are supplied separately from user JSON.
        const result = await handlers[match[2]]({
          pool, principal, id: match[1], expectedRevision: body.expectedRevision,
          extracted: body.extracted, reason: body.reason,
        });
        send(res, 200, result);
        return;
      }
      throw new AppError(404, 'NOT_FOUND', 'Route was not found.');
    } catch (error) {
      if (error instanceof AppError) {
        send(res, error.status, { error: { code: error.code, message: error.message } });
      } else {
        onError(error);
        send(res, 500, { error: { code: 'INTERNAL_ERROR', message: 'The operation failed. Retry the same request.' } });
      }
    }
  });
}
