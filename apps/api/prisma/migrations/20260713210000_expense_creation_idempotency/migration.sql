-- Idempotence transactionnelle des créations de dépenses (OCR, voix et saisie manuelle).
-- La clé brute possédée par le client n'entre jamais en base : uniquement deux SHA-256.

CREATE UNIQUE INDEX "uniq_expense_id_company"
  ON "expenses"("id", "companyId");

CREATE TABLE "expense_creation_requests" (
  "companyId" TEXT NOT NULL,
  "keyHash" CHAR(64) NOT NULL,
  "payloadHash" CHAR(64) NOT NULL,
  "expenseId" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "expense_creation_requests_pkey"
    PRIMARY KEY ("companyId", "keyHash"),
  CONSTRAINT "expense_creation_requests_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "companies"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "expense_creation_requests_expenseId_companyId_fkey"
    FOREIGN KEY ("expenseId", "companyId") REFERENCES "expenses"("id", "companyId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "expense_creation_requests_key_hash_check"
    CHECK ("keyHash"::TEXT ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "expense_creation_requests_payload_hash_check"
    CHECK ("payloadHash"::TEXT ~ '^[a-f0-9]{64}$')
);

CREATE INDEX "expense_creation_requests_expenseId_companyId_idx"
  ON "expense_creation_requests"("expenseId", "companyId");

-- Append-only pour le rôle runtime : aucune policy UPDATE/DELETE. Le trigger ferme aussi les
-- UPDATE privilégiés accidentels ; une purge légale reste une opération DBA explicite (DELETE).
CREATE FUNCTION reject_expense_creation_request_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'expense creation idempotency records are immutable'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER "expense_creation_requests_immutable"
BEFORE UPDATE ON "expense_creation_requests"
FOR EACH ROW EXECUTE FUNCTION reject_expense_creation_request_update();

ALTER TABLE "expense_creation_requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "expense_creation_requests" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_expense_creation_request_select ON "expense_creation_requests"
  FOR SELECT
  USING ("companyId" = current_setting('app.current_company_id', true));

CREATE POLICY tenant_expense_creation_request_insert ON "expense_creation_requests"
  FOR INSERT
  WITH CHECK ("companyId" = current_setting('app.current_company_id', true));
