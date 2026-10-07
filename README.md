# Document Approval Gate

**An ERP accepts an invoice. The connection drops before the response arrives. What happens on retry?**

This runnable backend sample freezes the reviewed document revision, commits its delivery intent in PostgreSQL, and retries the same payload with the same idempotency key. A synthetic ERP demonstrates the outcome: **two HTTP attempts, one business write**.

Built for the approval-to-ERP boundary of a document-processing platform. Node.js, PostgreSQL 18, one runtime dependency (`pg`). MIT licensed. Self-initiated work by [Blucca](https://blucca.github.io/), an AI-led engineering practice.

## Try the complete invoice-to-ERP flow

**[Open the interactive sample](https://blucca.github.io/document-approval-gate/)** — correct $128.50 to $125.80, approve revision 2, lose the first ERP response, then recover its receipt with the same delivery key. The public page uses synthetic invoices and in-tab simulation; its banner identifies that mode throughout.

**Run the same review desk against real PostgreSQL and HTTP:**

```sh
git clone https://github.com/blucca/document-approval-gate.git
cd document-approval-gate
docker compose up --build
# Open http://127.0.0.1:3100
```

Docker Compose starts PostgreSQL 18 and the local demo, with the web port bound to loopback. The database is disposable. Press Ctrl+C, then `docker compose down` to clean up. The synthetic ERP keeps its deduplication ledger in process memory and deliberately drops its first response after recording the invoice. The second request recovers the original receipt. Real ERP integration uses the persistent idempotency contract below.

For an existing local PostgreSQL 18 database:

```sh
npm ci
DATABASE_URL=postgres://gate:local-demo-only@127.0.0.1:55432/gate npm run demo
```

This creates a fresh `gate_demo_*` schema, seeds two invoices, and removes that schema on graceful shutdown. **Reset demo** clears its invoices and ERP simulator. The page shows “Live local demo · real PostgreSQL + HTTP · synthetic ERP.” The first invoice exercises correction/approval/retry; the second supports rejection. Queue refresh picks up incoming n8n invoices. Demo keys are configured for this disposable local session.

**[Import the n8n caller](examples/n8n/)** to submit two synthetic invoices into this same review desk. It includes stable intake keys, Header Auth setup, review links, and actual n8n execution results.

## Executed results

[Recorded run](examples/observed-results.json) · **13/13 scenarios passed** on PostgreSQL 18.6 and Node 26.10.0. Real database transactions and local HTTP; synthetic invoices, configured demo identities, and a local ERP simulator.

| Behavior | Observed |
|---|---|
| 12 concurrent copies of one intake | 1 document; 11 replay responses |
| Same intake key, changed payload | HTTP 409 |
| Cross-tenant read, edit, approval | HTTP 404 |
| Submitter attempts approval | HTTP 403 |
| Review revision 1 after editing to revision 2 | HTTP 409 |
| Document awaiting review / rejected | 0 ERP requests |
| 8 concurrent approvals | 1 snapshot, approval event, and outbox row |
| Database fault during approval audit | Approval and outbox rolled back together |
| Edit after approval | HTTP 409; queued snapshot preserved |
| 8 competing delivery workers | 1 delivery; 7 idle |
| ERP accepts, then disconnects or times out | Same key on retry; 1 simulated business write |
| Expired lease and a late old worker | New claim completes; old claim yields |
| Review queue and history | Tenant-scoped; revised approval, retry and receipt visible |

The JSON record contains request traces, injected faults, environment versions, and source hashes. The ERP simulator implements in-memory deduplication; a deployed integration uses the persistent ERP contract below.

## Run the checks

Prerequisites: Node.js 22+ and a PostgreSQL 18 database. This command starts a disposable, loopback-only local database:

```sh
docker run --rm -d --name approval-gate-db \
  -e POSTGRES_USER=gate -e POSTGRES_PASSWORD=local-demo-only -e POSTGRES_DB=gate \
  -p 127.0.0.1:55432:5432 --tmpfs /var/lib/postgresql \
  public.ecr.aws/docker/library/postgres:18-alpine

export DATABASE_URL=postgres://gate:local-demo-only@127.0.0.1:55432/gate
npm ci
# Wait for: docker exec approval-gate-db pg_isready -U gate -d gate
npm test
```

Tests create and remove an isolated random schema; the database account needs `CREATE SCHEMA`. Set `APPROVAL_GATE_REPORT` to a file path to save a new JSON result. Stop the disposable database with `docker stop approval-gate-db`.

## Run the API

```sh
npm run migrate
export DEMO_TOKENS_JSON='{"demo-submit":{"tenantId":"acme","role":"submitter","actorId":"intake"},"demo-review":{"tenantId":"acme","role":"reviewer","actorId":"reviewer-1"}}'
npm start
```

Default bind: `127.0.0.1:3000`. Demo keys are local example identities. The application takes tenant and role from the trusted token map.

```sh
curl http://127.0.0.1:3000/documents \
  -H 'Authorization: Bearer demo-submit' -H 'Content-Type: application/json' \
  -d '{"intakeKey":"source-document-42","extracted":{"invoiceNumber":"DEMO-42","currency":"USD","amountMinor":12850}}'

# Use the returned document.id and the revision currently displayed to the reviewer.
curl http://127.0.0.1:3000/documents/DOCUMENT_ID/approve \
  -H 'Authorization: Bearer demo-review' -H 'Content-Type: application/json' \
  -d '{"expectedRevision":1}'
```

| Method / route | Body | Role |
|---|---|---|
| `POST /documents` | `intakeKey`, `extracted` JSON object | submitter / reviewer |
| `GET /documents` | —; latest 100 for the current tenant | submitter / reviewer |
| `GET /documents/:id` | — | submitter / reviewer |
| `GET /documents/:id/history` | —; audit events and current delivery | submitter / reviewer |
| `POST /documents/:id/revise` | `expectedRevision`, `extracted` | submitter / reviewer |
| `POST /documents/:id/approve` | `expectedRevision` | reviewer |
| `POST /documents/:id/reject` | `expectedRevision`, `reason` | reviewer |

An n8n extraction workflow can call the intake endpoint with a stable source-document key. The review application reads the current revision and submits an explicit decision. Customer-specific invoice validation runs before approval; this sample accepts extracted JSON as input.

## Delivery and state

```text
extracted document → REVIEW ── approve ──→ APPROVED ── ERP acceptance ──→ SYNCED
                       │                     │
                       ├─ revise → revision+1└─ snapshot + outbox + audit: one transaction
                       └─ reject → REJECTED
```

Revisions are editable in `REVIEW`. A decision freezes the document; subsequent corrections enter as a new document. Approved and synced revisions return the original decision on repeated approval.

```sh
ERP_URL=http://127.0.0.1:4000/invoices npm run worker -- --once
# Omit --once for continuous polling.
```

The worker posts the approved snapshot with an `Idempotency-Key` header. Short PostgreSQL leases use [`FOR UPDATE SKIP LOCKED`](https://www.postgresql.org/docs/18/sql-select.html#SQL-FOR-UPDATE-SHARE); a claim token prevents a late worker from overwriting a replacement claim. Network I/O happens after the claim statement commits. `ERP_TIMEOUT_MS`, `WORKER_LEASE_MS`, and `WORKER_RETRY_MS` control timing.

### Deployment contract

- Delivery is **at least once**. The ERP must atomically persist its idempotency key with the business write, retain it through the retry/recovery window, and return a successful response for a matching replay. Its 2xx response means durable acceptance; `SYNCED` records that acceptance.
- Customer implementation supplies authenticated tenant context, ERP credentials/routing, invoice rules, and the review interface. The sample demonstrates the backend boundary and uses configured demo tokens and a synthetic ERP.
- Operational rollout includes persistent PostgreSQL storage, retry escalation/reconciliation, monitoring, and the agreed handling of rejected/corrected documents. Audit rows record application events; access/retention controls belong to the deployment.

## Project map

`web/` shared review UI + browser simulator · `src/demo.js` disposable real-PG demo · `examples/n8n/` importable caller · `src/api.js` HTTP boundary · `src/service.js` review transactions · `src/worker.js` outbox delivery · `db/schema.sql` relational constraints · `test/` real PostgreSQL and synthetic-ERP fault checks.

**Have a document pipeline to ship?** [Send a brief](mailto:belgialucca@gmail.com?subject=Document%20approval%20integration): one document type, the destination system, the approval rule, and your target date. Scope, acceptance, price, and dates are agreed before payment.
