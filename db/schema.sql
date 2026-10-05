BEGIN;

CREATE TABLE IF NOT EXISTS documents (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  intake_key text NOT NULL,
  intake_hash text NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  status text NOT NULL DEFAULT 'REVIEW'
    CHECK (status IN ('REVIEW', 'APPROVED', 'REJECTED', 'SYNCED')),
  extracted jsonb NOT NULL CHECK (jsonb_typeof(extracted) = 'object'),
  approved_snapshot jsonb,
  approved_by text,
  approved_at timestamptz,
  rejection_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, intake_key),
  UNIQUE (tenant_id, id),
  CHECK (
    (status IN ('APPROVED', 'SYNCED') AND approved_snapshot IS NOT NULL
      AND approved_by IS NOT NULL AND approved_at IS NOT NULL)
    OR (status IN ('REVIEW', 'REJECTED') AND approved_snapshot IS NULL
      AND approved_by IS NULL AND approved_at IS NULL)
  )
);

CREATE TABLE IF NOT EXISTS outbox (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  document_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  payload jsonb NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'READY' CHECK (status IN ('READY', 'LEASED', 'SYNCED')),
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz,
  claim_token uuid,
  last_error text,
  remote_response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  synced_at timestamptz,
  FOREIGN KEY (tenant_id, document_id) REFERENCES documents (tenant_id, id),
  UNIQUE (tenant_id, document_id, revision),
  CHECK ((status = 'LEASED' AND locked_until IS NOT NULL AND claim_token IS NOT NULL)
    OR (status IN ('READY', 'SYNCED') AND locked_until IS NULL AND claim_token IS NULL))
);

CREATE INDEX IF NOT EXISTS outbox_claim_idx ON outbox (available_at, created_at)
  WHERE status IN ('READY', 'LEASED');

CREATE TABLE IF NOT EXISTS audit_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id text NOT NULL,
  document_id uuid NOT NULL,
  revision integer NOT NULL,
  actor_id text NOT NULL,
  event_type text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, document_id) REFERENCES documents (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS audit_document_idx
  ON audit_events (tenant_id, document_id, id);

COMMIT;
