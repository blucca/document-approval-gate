# n8n invoice intake → review handoff

Import [workflow.json](workflow.json) into n8n to submit two synthetic invoices, read each document's current status, and produce two review links.

```text
Start → Synthetic invoices → Submit invoice for review → Read current status → Review handoff
```

The caller accepts extracted invoice JSON. Human review and ERP delivery run in Document Approval Gate; the workflow returns the document IDs and browser links needed for that handoff.

## Run with the local review demo

1. Start the [repository's local demo](../../README.md). Its default API base is `http://127.0.0.1:3100/api`; the review page is `http://127.0.0.1:3100`.
2. In n8n, choose **Import from File** and select `workflow.json`.
3. Open **Synthetic invoices** and configure `gateBaseUrl` and `reviewBaseUrl` at the top of its code. The API URL must be reachable **from the n8n runtime**; the review URL must be reachable **from your browser**. Container or cloud runtimes use the address of your Gate deployment. The standalone API's base is `http://127.0.0.1:3000`.
4. Create an **HTTP Header Auth** credential with header name `Authorization` and value `Bearer <your configured submitter token>`. Select it in **Submit invoice for review** and **Read current status**. The local demo's configured submitter token is `demo-submit`. The export stores credential configuration fields; enter token values through n8n's credential editor.
5. Click **Execute workflow**. **Review handoff** returns two items, including `documentId`, `intakeKey`, `revision`, `status`, invoice amount, and `reviewUrl`.
6. Open a review link, inspect or correct the invoice, and explicitly approve or reject its current revision. Follow delivery and the ERP receipt in the review interface.

The sample keys are `n8n-demo-invoice-42` and `n8n-demo-invoice-43`. Identical replays reuse their existing documents. Reusing a key with changed extracted JSON returns HTTP 409. Correct an existing invoice through the revision-aware review interface; give a new source document its own key. An existing approved or synced invoice keeps its state when the original intake is replayed.

## Connect an extraction workflow

Replace **Synthetic invoices** with your source/transformation node while retaining its label, or update the expressions referencing that label. Each item has this shape:

```json
{
  "gateBaseUrl": "https://your-gate.example/api",
  "reviewBaseUrl": "https://your-gate.example",
  "intakeKey": "mailbox-attachment-or-source-document-id",
  "extracted": {
    "invoiceNumber": "INV-42",
    "supplier": "Example Supplier",
    "currency": "USD",
    "amountMinor": 12850
  }
}
```

Use a stable source key across retries. `amountMinor` is the amount in the currency's minor units; the sample USD value is $128.50. Adapt the schema and validation to the agreed invoice rules. The Gate takes tenant and actor identity from its configured token map. ERP delivery uses the Gate worker and the destination's persistent idempotency contract.

## Run the caller's regression check

[case.json](case.json) executes the synthetic-invoice node and both HTTP nodes in the real n8n engine, using local mock responses. It verifies:

- Two POST requests, with both complete invoice bodies and their distinct intake keys.
- One GET for each returned document ID, including the two complete status responses.
- Two exact handoff items with the expected invoice, amount, revision, status, and review URL.

With Node.js 24+, an installed n8n runtime, and [n8n-check v0.1.6](https://github.com/blucca/n8n-check):

```sh
# From this repository's root; select your installed n8n binary.
n8n-check examples/n8n/workflow.json examples/n8n/case.json \
  --n8n /path/to/n8n --allow-network --out temp/n8n-intake-check
```

`--allow-network` selects a trusted local development run. The published [observed results](observed-results.json) include two runs on n8n 2.41.7:

- **HTTP contract mocks: 10/10 checks passed** in a loopback-only network namespace. n8n-check temporarily routes both HTTP nodes to its local mocks and clears their credential configuration; the source export stays unchanged.
- **Real local Gate: passed.** A fresh native CLI environment imported the local-demo Header Auth credential and this workflow, then executed its original Manual Trigger against the PostgreSQL-backed demo. Both invoices were created with their exact keys/fields, read back as `REVIEW` / revision `1`, and returned as distinct review links. The temporary import assigned credential references; the invoice and HTTP logic stayed unchanged.

All inputs and identities are synthetic. The [real PostgreSQL checks](../../README.md#executed-results) separately cover the approval and delivery boundary.

**A document pipeline to ship?** [Send a brief](mailto:belgialucca@gmail.com?subject=Document%20approval%20integration): document schema, destination ERP, approval rule, and target date. The current $2,400 first-phase offer covers an agreed approval-to-ERP integration; project scope and acceptance are confirmed against your brief.
